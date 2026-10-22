/* MSE 常驻管线探测（2026-09-30）。只在 `zsh tools/deploy.sh --mse` 打出来的构建里跑（SELFTEST="mse"）。
 *
 * 要回答的问题：现在每换一条就给 <video> 换 src，解码管线拆掉重建 —— 换源到出画面 ~1.2 秒里有
 * ~0.65 秒是解码器冷启动，整段放 blob: 一个字节不走网络也要 ~1.1 秒（CLAUDE.md）。如果整个会话只
 * 用一个 MediaSource、接下来几条的开头提前 append 进各自的时间槽（第 k 条从 k×SLOT 秒开始），
 * 切换就只是一次 seek，管线不重建。这台电视上这样的 seek 要多久、横竖屏混在一个 SourceBuffer 里
 * 会不会让解码器重建、HE-AAC（mp4a.40.29）音频过不过 MSE，都没人量过。
 *
 * 全在同一轮、同一个 <video> 上做（只有一个硬件解码器，不许第二个媒体元素）：
 *   1. 从推荐里挑 4 条（横竖交替），各取 moov + 之后 AFTER_MOOV 字节，mp4box.js 转成 fMP4 分段。
 *   2. 对照组：给元素换 src（CDN 最终地址，刚取过、边缘是热的）× 8 次。
 *   3. MSE：建一个 MediaSource，第 0 条 append 进去开播（冷启动）；播着的时候把其余几条 append 进
 *      各自的槽，量播放头有没有被卡；然后在槽之间 seek：横↔竖、同方向、同一条回到开头。
 * 每一步都从动作算到「播放头比起点多走 0.1 秒」—— 和 app 撤封面的判据一样。
 *
 * ⚠️ 自测构建：跑完电视上停在探测画面。装回正常构建：zsh tools/deploy.sh
 */
(function () {
    "use strict";
    if (typeof SELFTEST === "undefined" || (SELFTEST !== "mse" && SELFTEST !== "splice" && SELFTEST !== "livemse")) { return; }

    var SLOT = 1000;
    var FIRST = 1048576;               // 第一段：够读出 moov 在哪、多长
    var AFTER_MOOV = 3 * 1048576;      // moov 之后再取这么多（1080p 大约 8–25 秒）
    var WATCH = 2500;                  // 动起来之后看多久再做下一步
    var SEEK_WATCH = 4000;             // seek 之后停久一点：第二轮要人眼看画面变没变形
    /* 第一轮（10:46）已经量过换 src 的对照组（中位 1180ms，8 次），第二轮只看 MSE 里的画面比例。 */
    var BASELINE = false;
    var v = null, note = null;
    var actAt = 0, marks = {};

    function R(msg) { Log.report("mse", msg); }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function say(msg) { if (note) { note.textContent = msg; } }
    function mb(n) { return (n / 1048576).toFixed(1) + "MB"; }
    function orient(c) { return c.vw > c.vh ? "横" : "竖"; }
    function median(a) {
        if (!a.length) { return -1; }
        var s = a.slice().sort(function (x, y) { return x - y; });
        return s[Math.floor(s.length / 2)];
    }
    function quality() {
        var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
        return q ? q.droppedVideoFrames : 0;
    }
    function ev(name) { return marks[name] === undefined ? "-" : marks[name]; }

    function loadScript(src) {
        return new Promise(function (ok, fail) {
            var s = document.createElement("script");
            s.src = src;
            s.onload = ok;
            s.onerror = function () { fail(new Error("装不上 " + src)); };
            document.head.appendChild(s);
        });
    }

    function range(url, from, to) {
        return new Promise(function (ok, fail) {
            var x = new XMLHttpRequest();
            x.open("GET", url);
            x.responseType = "arraybuffer";
            x.timeout = 30000;
            x.setRequestHeader("Range", "bytes=" + from + "-" + to);
            x.onload = function () {
                if (x.status === 206 && x.response) { ok({buf: x.response, url: x.responseURL}); } else { fail(new Error("HTTP " + x.status)); }
            };
            x.onerror = x.ontimeout = function () { fail(new Error("连接失败")); };
            x.send();
        });
    }

    /* 顶层盒子里 moov 的位置；mdat 在前返回 null，字节不够返回 undefined。和 player.js 的同名函数一样。 */
    function findMoov(buf) {
        var dv = new DataView(buf), off = 0;
        while (off + 8 <= buf.byteLength) {
            var size = dv.getUint32(off);
            var type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
            if (size === 1 && off + 16 <= buf.byteLength) { size = dv.getUint32(off + 8) * 4294967296 + dv.getUint32(off + 12); }
            if (type === "moov") { return {start: off, end: off + size}; }
            if (type === "mdat" || size < 8) { return null; }
            off += size;
        }
        return undefined;
    }

    function concat(a, b) {
        var u = new Uint8Array(a.byteLength + b.byteLength);
        u.set(new Uint8Array(a), 0);
        u.set(new Uint8Array(b), a.byteLength);
        return u.buffer;
    }

    /* 渐进式 MP4 的开头 → fMP4：每条轨一个初始化段 + 若干媒体段。mp4box 只吐完整的样本，
     * 截在半截的最后一个样本自然丢掉。 */
    function remux(buf, c) {
        var f = MP4Box.createFile();
        var err = "";
        c.init = {};
        c.segs = {video: [], audio: []};
        c.codec = {};
        f.onError = function (e) { err = String(e); };
        f.onReady = function (info) {
            for (var i = 0; i < info.tracks.length; i++) {
                var t = info.tracks[i];
                var kind = t.video ? "video" : t.audio ? "audio" : "";
                if (!kind || c.codec[kind]) { continue; }
                c.codec[kind] = t.codec;
                if (kind === "video") { c.vw = t.video.width; c.vh = t.video.height; }
                if (kind === "audio") { c.rate = t.audio.sample_rate; c.ch = t.audio.channel_count; }
                f.setSegmentOptions(t.id, kind, {nbSamples: kind === "video" ? 30 : 40, rapAlignement: false});
                if (kind === "video") { c.vid = t.id; }
                if (kind === "audio") { c.aid = t.id; }
            }
            var inits = f.initializeSegmentation();
            for (var j = 0; j < inits.length; j++) { c.init[inits[j].user] = inits[j].buffer; }
            f.start();
        };
        f.onSegment = function (id, user, b) { c.segs[user].push(b); };
        buf.fileStart = 0;
        f.appendBuffer(buf);
        f.flush();
        if (err) { throw new Error("mp4box: " + err); }
        /* 第一帧的显示时间（有 B 帧时不是 0）、取到的这段视频放到哪：剪接要把第一帧对准接缝，下一次剪接要在这段放完之前。 */
        var tv = f.getTrackById(c.vid), ta = f.getTrackById(c.aid);
        c.vFirst = tv.samples[0].cts / tv.samples[0].timescale;
        c.aFirst = ta.samples[0].cts / ta.samples[0].timescale;
        var ft = null;
        for (var q = 0; q < f.fragmentedTracks.length; q++) { if (f.fragmentedTracks[q].id === c.vid) { ft = f.fragmentedTracks[q]; } }
        var lastS = ft && ft.trak.nextSample > 0 ? tv.samples[ft.trak.nextSample - 1] : null;
        c.headEnd = lastS ? (lastS.cts + lastS.duration) / lastS.timescale : 0;
        /* --splice：第一个样本（关键帧）的原始数据给 WebCodecs 试解。分段做完再单独读（和分段同时开「抽样本」，第一个 GOP 进不了
         * SourceBuffer —— 桌面上缓冲从第二个关键帧才开始）。 */
        try { var k0 = f.getSample(tv, 0); if (k0 && k0.data) { c.key = {data: new Uint8Array(k0.data), sync: k0.is_sync}; } } catch (x) {}
        var cc = tv.mdia.minf.stbl.stsd.entries[0].avcC;
        c.desc = cc ? avcCBytes(cc) : null;
        if (!c.init.video || !c.segs.video.length) { throw new Error("没转出视频分段"); }
        if (!c.init.audio || !c.segs.audio.length) { throw new Error("没转出音频分段"); }
    }

    /* mp4box 解析出来的 avcC 盒子 → WebCodecs 要的 description（AVCDecoderConfigurationRecord 原样）。 */
    function avcCBytes(a) {
        var out = [1, a.AVCProfileIndication, a.profile_compatibility, a.AVCLevelIndication, 0xFC | a.lengthSizeMinusOne, 0xE0 | a.SPS.length];
        var put = function (ps) { out.push(ps.length >> 8, ps.length & 255); for (var i = 0; i < ps.nalu.length; i++) { out.push(ps.nalu[i]); } };
        a.SPS.forEach(put);
        out.push(a.PPS.length);
        a.PPS.forEach(put);
        if (a.ext) { for (var i = 0; i < a.ext.length; i++) { out.push(a.ext[i]); } }
        return new Uint8Array(out);
    }

    function prepare(item) {
        var t0 = Date.now(), c = {item: item};
        return range(item.url, 0, FIRST - 1).then(function (r) {
            c.url = r.url;
            var m = findMoov(r.buf);
            if (!m) { throw new Error(m === null ? "moov 不在开头" : "1MB 里没读完 moov 头"); }
            c.moov = m.end - m.start;
            var want = m.end + AFTER_MOOV;
            if (want <= r.buf.byteLength) { return r.buf; }
            return range(r.url, r.buf.byteLength, want - 1).then(function (r2) { return concat(r.buf, r2.buf); });
        }).then(function (buf) {
            c.bytes = buf.byteLength;
            c.fetchMs = Date.now() - t0;
            var t1 = Date.now();
            remux(buf, c);
            c.remuxMs = Date.now() - t1;
            return c;
        });
    }

    /* 和 app.js 的 fitBox 一样：视频在 1920×1080 里 contain 摆放时占的那块。 */
    function fitBox(w, h) {
        var sc = Math.min(1920 / w, 1080 / h);
        var W = Math.round(w * sc), H = Math.round(h * sc);
        return {l: Math.round((1920 - W) / 2), t: Math.round((1080 - H) / 2), w: W, h: H};
    }
    /* 第一轮发现：同一个 SourceBuffer 里换了尺寸，videoWidth/Height 一直停在第一条的 1920x1080，
     * 一次 resize 都没有。元素按它 contain 摆放 = 全屏，竖屏的帧可能被拉宽。修正：元素的框直接
     * 摆成这一条该占的区域、object-fit: fill —— 不管平台自己留不留黑边，框的比例都是对的。 */
    function place(c, fix) {
        var b = fix ? fitBox(c.vw, c.vh) : {l: 0, t: 0, w: 1920, h: 1080};
        v.style.left = b.l + "px"; v.style.top = b.t + "px";
        v.style.width = b.w + "px"; v.style.height = b.h + "px";
        v.style.objectFit = fix ? "fill" : "contain";
        return b;
    }

    function videoType(c) { return "video/mp4; codecs=\"" + c.codec.video + "\""; }
    function audioType(c) {
        var t = "audio/mp4; codecs=\"" + c.codec.audio + "\"";
        return MediaSource.isTypeSupported(t) ? t : "audio/mp4; codecs=\"mp4a.40.2\"";
    }

    /* 从推荐里挑 4 条，横竖各两条，排成 横 竖 横 竖。 */
    function pick() {
        var feed = Feed.create("recommend");
        var got = {"横": [], "竖": []}, tried = 0;
        function enough() { return got["横"].length >= 2 && got["竖"].length >= 2; }
        function step() {
            if (enough() || tried >= 20) { return Promise.resolve(); }
            tried++;
            return feed.next().then(function (item) {
                var o = item.w > item.h ? "横" : "竖";
                if (got[o].length >= 2) { return step(); }
                say("准备视频（" + (got["横"].length + got["竖"].length + 1) + "/4）");
                return prepare(item).then(function (c) {
                    if (!MediaSource.isTypeSupported(videoType(c))) { R("跳过：" + videoType(c) + " 不支持"); return step(); }
                    got[orient(c)].push(c);
                    R("备好 " + orient(c) + " " + c.vw + "x" + c.vh + " " + c.codec.video + " / " + c.codec.audio + " " + c.rate + "Hz " + c.ch + "ch" +
                      "（audio isTypeSupported=" + MediaSource.isTypeSupported("audio/mp4; codecs=\"" + c.codec.audio + "\"") + "）" +
                      " | moov " + mb(c.moov) + "，取 " + mb(c.bytes) + " " + c.fetchMs + "ms，转封装 " + c.remuxMs + "ms，分段 视频 " + c.segs.video.length +
                      " 音频 " + c.segs.audio.length + " | " + item.desc.slice(0, 14));
                    return step();
                }, function (e) { R("跳过（" + e.message + "）| " + item.desc.slice(0, 14)); return step(); });
            }, function (e) { R("推荐取不到更多：" + e.message); });
        }
        return step().then(function () {
            var out = [], L = got["横"], P = got["竖"];
            for (var i = 0; i < 2; i++) { if (L[i]) { out.push(L[i]); } if (P[i]) { out.push(P[i]); } }
            return out;
        });
    }

    /* 从 t0 起，等播放头走到 from + 0.1 秒以后。返回用时，超时 -1。 */
    function untilMoved(t0, from, limit) {
        return new Promise(function (ok) {
            function tick() {
                if (!v.paused && v.currentTime >= from + 0.1) { ok(Date.now() - t0); return; }
                if (Date.now() - t0 > limit) { ok(-1); return; }
                setTimeout(tick, 10);
            }
            tick();
        });
    }

    /* 对照组：现在 app 的做法，换 src。 */
    function baseline(clips) {
        var res = [], i = 0, order = [0, 1, 2, 3, 0, 1, 2, 3];
        function one() {
            if (i >= order.length) { return Promise.resolve(res); }
            var k = order[i++] % clips.length, c = clips[k];
            say("对照：换 src（" + i + "/" + order.length + "）");
            actAt = Date.now();
            marks = {};
            v.src = c.url;
            var p = v.play();
            if (p && p.catch) { p.catch(function () {}); }
            return untilMoved(actAt, 0, 10000).then(function (ms) {
                if (ms >= 0) { res.push(ms); }
                R("换 src → " + orient(c) + ": 动起来 " + ms + "ms（元数据 " + ev("loadedmetadata") + " 首帧数据 " + ev("loadeddata") + " playing " + ev("playing") +
                  "）" + v.videoWidth + "x" + v.videoHeight);
                return wait(WATCH);
            }).then(one);
        }
        return one();
    }

    var mediaSource = null, sb = {};

    function append(s, buf) {
        return new Promise(function (ok, fail) {
            function done() { off(); ok(); }
            function bad() { off(); fail(new Error("SourceBuffer error")); }
            function off() { s.removeEventListener("updateend", done); s.removeEventListener("error", bad); }
            s.addEventListener("updateend", done);
            s.addEventListener("error", bad);
            try { s.appendBuffer(buf); } catch (e) { off(); fail(e); }
        });
    }
    function appendTrack(c, k, kind) {
        var s = sb[kind];
        s.timestampOffset = k * SLOT;
        var p = append(s, c.init[kind]);
        c.segs[kind].forEach(function (b) { p = p.then(function () { return append(s, b); }); });
        return p;
    }
    function appendClip(clips, k) {
        var t = Date.now();
        return Promise.all([appendTrack(clips[k], k, "video"), appendTrack(clips[k], k, "audio")]).then(function () { return Date.now() - t; });
    }

    /* 第 k 个槽在 video.buffered（音视频的交集）里从哪开始。 */
    function slotStart(k) {
        var b = v.buffered;
        for (var i = 0; i < b.length; i++) {
            if (b.start(i) >= k * SLOT - 1 && b.start(i) < (k + 1) * SLOT) { return b.start(i); }
        }
        return -1;
    }
    function ranges() {
        var b = v.buffered, out = [];
        for (var i = 0; i < b.length; i++) { out.push(b.start(i).toFixed(2) + "–" + b.end(i).toFixed(2)); }
        return out.join(" ");
    }

    /* 播着的时候跑 work，量播放头最长停了多久。 */
    function stallDuring(work) {
        var worst = 0, last = v.currentTime, since = Date.now();
        var timer = setInterval(function () {
            if (v.currentTime !== last) { last = v.currentTime; since = Date.now(); } else { worst = Math.max(worst, Date.now() - since); }
        }, 50);
        return work().then(function (r) {
            clearInterval(timer);
            return {result: r, stall: worst};
        }, function (e) { clearInterval(timer); throw e; });
    }

    function seekTo(clips, from, k, res, fix, label) {
        var target = slotStart(k);
        if (target < 0) { R("槽 " + k + " 里没有缓冲（" + ranges() + "）"); return Promise.resolve(); }
        var c = clips[k];
        var kind = from === k ? "同一条回开头" : orient(clips[from]) + "→" + orient(c);
        say(label + "：" + orient(c) + "屏 " + c.vw + "x" + c.vh + " · " +
            (fix ? "框已按比例修正 → 应该不变形" + (c.vw < c.vh ? "，居中竖条、两侧黑" : c.vw * 9 < c.vh * 16 ? "，两侧窄黑边" : "，铺满") : "框不修正（全屏）→ 看它变不变形"));
        var d0 = quality();
        actAt = Date.now();
        marks = {};
        var b = place(c, fix);
        v.currentTime = target;
        return untilMoved(actAt, target, 8000).then(function (t) {
            var dims = v.videoWidth + "x" + v.videoHeight;
            res.push({ms: t, kind: kind, fix: fix});
            return wait(SEEK_WATCH).then(function () {
                R(label + " seek " + from + "→" + k + "（" + kind + "，框" + (fix ? "修正 " + b.w + "x" + b.h + " fill" : "全屏 contain") + "）: 动起来 " + t + "ms（seeked " + ev("seeked") +
                  " playing " + ev("playing") + " waiting " + ev("waiting") + " resize " + ev("resize") + "）元素报的尺寸 " + dims + "（实际 " + c.vw + "x" + c.vh + "）丢帧 +" +
                  (quality() - d0) + " readyState=" + v.readyState);
            });
        });
    }

    function mseRun(clips) {
        var out = {seeks: []};
        say("MSE 冷启动");
        v.pause();
        v.removeAttribute("src");
        v.load();
        return wait(500).then(function () {
            mediaSource = new MediaSource();
            mediaSource.addEventListener("sourceclose", function () { R("MediaSource 关了（sourceclose）"); });
            actAt = Date.now();
            marks = {};
            out.t0 = actAt;
            v.src = URL.createObjectURL(mediaSource);
            return new Promise(function (ok) { mediaSource.addEventListener("sourceopen", ok); });
        }).then(function () {
            out.open = Date.now() - out.t0;
            mediaSource.duration = SLOT * (clips.length + 1);
            sb.video = mediaSource.addSourceBuffer(videoType(clips[0]));
            sb.audio = mediaSource.addSourceBuffer(audioType(clips[0]));
            return appendClip(clips, 0);
        }).then(function (appendMs) {
            out.append0 = appendMs;
            if (slotStart(0) < 0) { throw new Error("第 0 条 append 完了缓冲还是空的（视频 " + sb.video.buffered.length + " 段，音频 " + sb.audio.buffered.length + " 段）"); }
            v.currentTime = slotStart(0);
            var p = v.play();
            if (p && p.catch) { p.catch(function (e) { R("play() 被拒 " + e.name); }); }
            return untilMoved(out.t0, slotStart(0), 10000);
        }).then(function (t) {
            out.cold = t;
            R("MSE 冷启动: 动起来 " + t + "ms（sourceopen " + out.open + "ms，append 第 0 条 " + out.append0 + "ms，元数据 " + ev("loadedmetadata") +
              " 首帧数据 " + ev("loadeddata") + " playing " + ev("playing") + "）" + v.videoWidth + "x" + v.videoHeight + " 缓冲 " + ranges());
            if (t < 0) { throw new Error("MSE 冷启动就没动起来，readyState=" + v.readyState + " error=" + (v.error ? v.error.code + " " + v.error.message : "无")); }
            return wait(1000);
        }).then(function () {
            say("播着的时候把其余几条塞进去");
            return stallDuring(function () {
                var p = Promise.resolve([]);
                for (var k = 1; k < clips.length; k++) {
                    (function (k) { p = p.then(function (a) { return appendClip(clips, k).then(function (t) { a.push(t); return a; }); }); })(k);
                }
                return p;
            });
        }).then(function (r) {
            out.appendMs = r.result;
            out.appendStall = r.stall;
            R("播放中预塞 " + (clips.length - 1) + " 条：各用 " + r.result.join(" / ") + "ms，这期间播放头最长停 " + r.stall + "ms | 缓冲 " + ranges());
            return wait(1000);
        }).then(function () {
            /* 第二轮：框修正 / 不修正逐步交替，每种都轮到竖屏和横屏。[槽, 修正] */
            var seq = clips.length === 4 ?
                [[1, false], [2, true], [3, true], [0, false], [1, true], [2, false], [3, false], [0, true], [3, true], [1, false], [2, true], [0, true]] :
                [[1, false], [0, true], [1, true], [0, false], [1, false], [0, true]];
            var cur = 0, p = Promise.resolve();
            seq.forEach(function (s, i) {
                if (s[0] >= clips.length) { return; }
                p = p.then(function () { var from = cur; cur = s[0]; return seekTo(clips, from, s[0], out.seeks, s[1], "第 " + (i + 1) + "/" + seq.length + " 步"); });
            });
            return p;
        }).then(function () { return out; });
    }

    // ---------- --splice（2026-10-22）：切换能不能不 seek ----------
    /* 目标：切换时画面直接动起来，不先停在一张图上。现在按键 → 封面滑上来（250ms）→ 第 200ms 才 seek →
     * 解码器 110–380ms 后出新画面 → 撤封面，按键到动起来中位 ~490ms；封面图（origin_cover）也不一定是第一帧，撤的那一下会跳。
     * 手机上丝滑是因为下一条早在另一个解码器里解好了第一帧；这台电视只有一个。两个问题：
     *   A. WebCodecs 能不能（用软件）把下一条的第一帧解出来画进 canvas，当成和视频第一帧一模一样的封面 —— 而且别抢正在放的那条的解码器。
     *   B. 剪接：不 seek，把正在放的这条在播放头之后 δ 秒处截断（remove），下一条接着 append 在那里（timestampOffset 对准）。解码器不停，
     *      播到接缝就是下一条。要量：δ 最小多少还接得上（平台可能已经把 δ 之后的数据读进了硬件），接缝处播放头停了多久、丢了多少帧，
     *      横竖屏 / 分辨率在接缝处换了会不会让解码器重建。
     *   C. 同一轮里的对照：现在的做法，seek 到预先 append 好的槽。 */
    function luma(ctx, w, h) {
        try {
            var d = ctx.getImageData(0, 0, w, h).data, sum = 0, n = 0;
            for (var i = 0; i < d.length; i += 4 * 97) { sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; n++; }
            return Math.round(sum / n);
        } catch (e) { return "读不了（" + e.name + "）"; }
    }
    function copyCfg(c, pref) {
        var o = {codec: c.codec.video, codedWidth: c.vw, codedHeight: c.vh};
        if (c.desc) { o.description = c.desc; }
        if (pref) { o.hardwareAcceleration = pref; }
        return o;
    }
    function wcSupport(c) {
        var prefs = ["prefer-software", "no-preference", "prefer-hardware"], res = {}, p = Promise.resolve();
        prefs.forEach(function (pref) {
            p = p.then(function () {
                return VideoDecoder.isConfigSupported(copyCfg(c, pref)).then(function (r) { res[pref] = !!r.supported; }, function (e) { res[pref] = "抛 " + e.name; });
            });
        });
        return p.then(function () { return res; });
    }
    /* 正在放的时候解 c 的第一帧，画进 1920 宽的 canvas。量解码多久、画面是不是真的有内容、这期间播放头停没停。 */
    function wcDecode(c, pref) {
        var cv = document.createElement("canvas"), b = fitBox(c.vw, c.vh);
        cv.width = b.w; cv.height = b.h;
        var ctx = cv.getContext("2d"), t0 = Date.now(), got = -1, drawn = -1, err = "", dims = "";
        var rs0 = 4, d0 = quality();
        var rsTimer = setInterval(function () { rs0 = Math.min(rs0, v.readyState); }, 20);
        return stallDuring(function () {
            return new Promise(function (ok) {
                var dec = new VideoDecoder({
                    output: function (fr) {
                        got = Date.now() - t0;
                        dims = fr.codedWidth + "x" + fr.codedHeight;
                        try { ctx.drawImage(fr, 0, 0, b.w, b.h); drawn = Date.now() - t0; } catch (e) { err = "画不上：" + e.message; }
                        fr.close();
                    },
                    error: function (e) { err = err || e.message; }
                });
                try {
                    dec.configure(copyCfg(c, pref));
                    dec.decode(new EncodedVideoChunk({type: "key", timestamp: 0, data: c.key.data}));
                } catch (e) { err = "抛 " + e.message; }
                var done = function () { try { dec.close(); } catch (x) {} ok(); };
                dec.flush().then(done, function (e) { err = err || "flush 失败 " + e.message; done(); });
                setTimeout(function () { err = err || "3 秒没出帧"; done(); }, 3000);
            });
        }).then(function (r) {
            clearInterval(rsTimer);
            return {pref: pref, frame: got, drawn: drawn, dims: dims, luma: got >= 0 ? luma(ctx, b.w, b.h) : "-", err: err,
                    stall: r.stall, rsMin: rs0, dropped: quality() - d0};
        });
    }
    function wcProbe(clips) {
        if (typeof VideoDecoder === "undefined") {
            R("WebCodecs：没有 VideoDecoder（VideoFrame=" + typeof VideoFrame + "，EncodedVideoChunk=" + typeof EncodedVideoChunk + "）");
            return Promise.resolve();
        }
        var c = clips[1];
        if (!c.key || !c.desc) { R("WebCodecs：第 1 条没拿到关键帧 / avcC（key=" + !!c.key + " desc=" + !!c.desc + "），不试解"); return Promise.resolve(); }
        var sup = {};
        return wcSupport(c).then(function (r) {
            sup = r;
            R("WebCodecs：" + c.codec.video + " " + c.vw + "x" + c.vh + "，第一个样本关键帧=" + c.key.sync + " " + c.key.data.length + "B，avcC " + c.desc.length + "B | isConfigSupported " +
              Object.keys(r).map(function (k) { return k + "=" + r[k]; }).join(" "));
            /* 先软件；硬件那一档放最后 —— 它要是抢了唯一的解码器，播放头会停，下面看得出来。 */
            var order = ["prefer-software", "no-preference", "prefer-hardware"].filter(function (k) { return r[k] === true; }), p = Promise.resolve();
            order.forEach(function (pref) {
                p = p.then(function () {
                    say("WebCodecs 试解第一帧（" + pref + "）");
                    return wcDecode(c, pref).then(function (x) {
                        R("WebCodecs 解第一帧（" + x.pref + "）：出帧 " + x.frame + "ms，画进 canvas " + x.drawn + "ms，" + x.dims + "，亮度 " + x.luma + (x.err ? "，错误：" + x.err : "") +
                          " | 这期间正在放的那条：播放头最长停 " + x.stall + "ms，readyState 最低 " + x.rsMin + "，丢帧 +" + x.dropped);
                        return wait(2500);
                    });
                });
            });
            return p;
        });
    }

    function appendSeq(s, init, segs) {
        var p = append(s, init);
        segs.forEach(function (b) { p = p.then(function () { return append(s, b); }); });
        return p;
    }
    function removeFrom(s, t) {
        return new Promise(function (ok, fail) {
            var end = mediaSource.duration;
            if (!(end > t)) { ok(); return; }
            function done() { off(); ok(); }
            function bad() { off(); fail(new Error("remove 出错")); }
            function off() { s.removeEventListener("updateend", done); s.removeEventListener("error", bad); }
            s.addEventListener("updateend", done);
            s.addEventListener("error", bad);
            try { s.remove(t, end); } catch (e) { off(); fail(e); }
        });
    }
    /* 在播放头之后 delta 秒处把 c 接上去。量 remove + append 用了多久（必须在播放头到接缝之前做完）、接缝前后播放头每 15ms 一个样本：
     * 最长停多久、有没有一下跳过去、2 秒后是不是已经在 c 的数据里走了。 */
    function spliceOnce(c, delta, label) {
        var now = v.currentTime, tS = now + delta, off = tS - c.vFirst, t0 = Date.now(), d0 = quality(), waits = 0, rsMin = 4;
        var onWait = function () { waits++; };
        v.addEventListener("waiting", onWait);
        say(label + "：" + delta + " 秒后接上 " + orient(c) + "屏 " + c.vw + "x" + c.vh + "（" + c.item.desc.slice(0, 12) + "）");
        var samples = [], timer = setInterval(function () { samples.push([Date.now(), v.currentTime]); rsMin = Math.min(rsMin, v.readyState); }, 15);
        var applied = 0, margin = 0;
        var aCut = Math.min(tS, off + c.aFirst);
        return Promise.all([removeFrom(sb.video, tS), removeFrom(sb.audio, aCut)]).then(function () {
            sb.video.timestampOffset = off;
            sb.audio.timestampOffset = off;
            return Promise.all([appendSeq(sb.video, c.init.video, c.segs.video), appendSeq(sb.audio, c.init.audio, c.segs.audio)]);
        }).then(function () {
            applied = Date.now() - t0;
            margin = Math.round((tS - v.currentTime) * 1000);
            place(c, true);
            return new Promise(function (ok) {
                (function until() { if (v.currentTime >= tS + 2 || Date.now() - t0 > (delta + 6) * 1000) { ok(); } else { setTimeout(until, 50); } })();
            });
        }).then(function () {
            clearInterval(timer);
            v.removeEventListener("waiting", onWait);
            /* 接缝前 0.3 秒到之后 1.5 秒这一段里：播放头最长不动多久、单步最大跳多少。 */
            var worst = 0, jump = 0, since = 0, lastT = -1;
            samples.forEach(function (sm) {
                if (sm[1] < tS - 0.3 || sm[1] > tS + 1.5) { lastT = sm[1]; since = sm[0]; return; }
                if (sm[1] !== lastT) { if (lastT >= 0) { jump = Math.max(jump, sm[1] - lastT); } lastT = sm[1]; since = sm[0]; }
                else { worst = Math.max(worst, sm[0] - since); }
            });
            var ok = v.currentTime >= tS + 1.9;
            var r = {delta: delta, applied: applied, margin: margin, stall: worst, jump: Math.round(jump * 1000), waits: waits, dropped: quality() - d0, rsMin: rsMin, ok: ok,
                     turn: label.indexOf("→") >= 0 ? label.slice(label.indexOf("（") + 1, label.indexOf("）")) : ""};
            R(label + " δ=" + delta + "s：remove+append " + applied + "ms（做完时离接缝还有 " + margin + "ms）| 接缝前后播放头最长停 " + worst + "ms，单步最大跳 " + r.jump +
              "ms，waiting " + waits + " 次，丢帧 +" + r.dropped + "，readyState 最低 " + rsMin + " | " + (ok ? "过了接缝 2 秒" : "没走过接缝（现在 " + (v.currentTime - tS).toFixed(2) + "s）") +
              " | 缓冲 " + ranges());
            return r;
        });
    }
    function spliceRun(clips) {
        var deltas = [1.5, 1.0, 0.6, 0.4, 0.25, 0.6, 0.4, 0.25, 0.4, 0.25], out = [], cur = 0, p = Promise.resolve();
        deltas.forEach(function (d, i) {
            p = p.then(function () {
                var k = (cur + 1) % clips.length, from = clips[cur], c = clips[k];
                cur = k;
                return spliceOnce(c, d, "剪接 " + (i + 1) + "/" + deltas.length + "（" + orient(from) + "→" + orient(c) + "）").then(function (r) {
                    out.push(r);
                    /* 这一段取到的视频放到 headEnd 秒；留够下一次剪接（最长 δ 1.5 秒 + 量 2 秒）。 */
                    return wait(Math.max(1500, Math.min(4000, (c.headEnd - 2 - 3.6) * 1000)));
                }, function (e) { R("剪接 " + (i + 1) + " 出错：" + e.message); out.push({delta: d, ok: false, err: e.message}); return wait(2000); });
            });
        });
        return p.then(function () { return out; });
    }
    /* C：现在 app 的做法。把 k 条 append 进各自的槽（离当前时间轴远远的），再 seek 过去。 */
    function seekBaseline(clips) {
        var res = [], p = Promise.resolve();
        [1, 2, 3, 1].forEach(function (k, i) {
            p = p.then(function () {
                if (k >= clips.length) { return; }
                var c = clips[k], base = (k + 5) * SLOT;
                sb.video.timestampOffset = base - c.vFirst;
                sb.audio.timestampOffset = base - c.vFirst;
                return Promise.all([appendSeq(sb.video, c.init.video, c.segs.video), appendSeq(sb.audio, c.init.audio, c.segs.audio)]).then(function () {
                    say("对照：seek 到第 " + k + " 条的槽");
                    var d0 = quality(), t0 = Date.now(), target = base;
                    place(c, true);
                    v.currentTime = target;
                    return untilMoved(t0, target, 8000).then(function (ms) {
                        res.push(ms);
                        R("对照 seek " + (i + 1) + "（→" + orient(c) + "）：动起来 " + ms + "ms，丢帧 +" + (quality() - d0));
                        return wait(2500);
                    });
                });
            });
        });
        return p.then(function () { return res; });
    }
    function spliceMain(clips) {
        var sp = [], sk = [];
        say("MSE 起播第 0 条");
        v.pause();
        v.removeAttribute("src");
        v.load();
        return wait(500).then(function () {
            mediaSource = new MediaSource();
            v.src = URL.createObjectURL(mediaSource);
            return new Promise(function (ok) { mediaSource.addEventListener("sourceopen", ok); });
        }).then(function () {
            mediaSource.duration = SLOT * 10;
            sb.video = mediaSource.addSourceBuffer(videoType(clips[0]));
            sb.audio = mediaSource.addSourceBuffer(audioType(clips[0]));
            var c = clips[0];
            /* 偏移不能是负的：有 B 帧时第一帧的解码时间戳比显示时间早 vFirst，偏移 -vFirst 让它成了负数，Chromium 把整个第一个 GOP 扔掉
             * （桌面上缓冲从第二个关键帧 6.83 秒才开始）。从 0 放，播放头从第一帧的显示时间起。 */
            sb.video.timestampOffset = 0;
            sb.audio.timestampOffset = 0;
            return Promise.all([appendSeq(sb.video, c.init.video, c.segs.video), appendSeq(sb.audio, c.init.audio, c.segs.audio)]);
        }).then(function () {
            place(clips[0], true);
            v.currentTime = clips[0].vFirst;
            var pp = v.play();
            if (pp && pp.catch) { pp.catch(function (e) { R("play() 被拒 " + e.name); }); }
            return untilMoved(Date.now(), clips[0].vFirst, 10000);
        }).then(function (ms) {
            var tr = function (x) { var o = []; for (var i = 0; i < x.buffered.length; i++) { o.push(x.buffered.start(i).toFixed(2) + "–" + x.buffered.end(i).toFixed(2)); } return o.join(" "); };
            R("起播：动起来 " + ms + "ms " + ranges() + "（视频 " + tr(sb.video) + "，音频 " + tr(sb.audio) + "，分段 视频 " + clips[0].segs.video.length + " 音频 " + clips[0].segs.audio.length + "）");
            if (ms < 0) { throw new Error("起播就没动起来"); }
            return wait(3000);
        }).then(function () { return wcProbe(clips); })
          .then(function () { return spliceRun(clips); })
          .then(function (r) { sp = r; return seekBaseline(clips); })
          .then(function (r) {
            sk = r;
            var good = sp.filter(function (x) { return x.ok && x.stall < 200 && x.margin > 0; });
            var byD = {};
            sp.forEach(function (x) { (byD[x.delta] = byD[x.delta] || []).push(x.ok ? "停" + x.stall + "跳" + x.jump + "丢" + x.dropped + (x.margin > 0 ? "" : "·晚") : "✗"); });
            R("结论：剪接 " + sp.length + " 次，接得顺（过了接缝、播放头停 <200ms、做完在接缝之前）" + good.length + " 次 | 按 δ：" +
              Object.keys(byD).map(function (d) { return d + "s[" + byD[d].join(" ") + "]"; }).join(" ") +
              " | remove+append 中位 " + median(sp.filter(function (x) { return x.applied; }).map(function (x) { return x.applied; })) + "ms" +
              " | 对照 seek 动起来 " + sk.join(",") + "ms");
            say("结束。装回正常构建：zsh tools/deploy.sh");
        });
    }

    // ---------- --livemse（2026-10-22）：直播走 mpegts.js（FLV → MSE）行不行 ----------
    /* 直播 tab 第一版让 <video> 直接放 m3u8：电视上 playing 之后播放头停在 0 不动 5–10 秒（缓冲里已经 12 秒、readyState=4），平台
     * 播放器要先攒一大截才走，<video> 没有开关；可跳范围是空的，往回退也做不了（--live）。bilibili 那边是 AVPlay + setBufferingParam，
     * 可我们的 CSP 有 object-src 'none'，AVPlay 的 <object> 会被拦，而 CSP 不跟自动更新走。所以试 mpegts.js：网页里把 FLV（HEVC，
     * 编码号 12）转成 fMP4 交给 MSE，什么时候开始放我们说了算。量：开始到播放头走 0.1 秒多久、之后 15 秒停几次 / 最长多久、丢帧、
     * 前方缓冲（追不追得上直播）。每个直播间都是新建一个播放器（新的 MediaSource），和 app 里换直播间一样。 */
    var mpegts = null;
    function liveRooms() {
        var f = Feed.create("live"), out = [];
        function step() {
            if (out.length >= 5) { return Promise.resolve(out); }
            return f.next().then(function (it) { out.push(it); return step(); }, function () { return out; });
        }
        return step();
    }
    function flvOf(it) { return it.flv; }
    function playFlv(it, cfg, label) {
        var t0 = Date.now(), d0 = quality(), p = null, err = "";
        say(label + "：" + it.author + " · " + it.desc.slice(0, 14));
        try {
            p = mpegts.createPlayer({type: "flv", isLive: true, url: flvOf(it)}, cfg);
            p.on(mpegts.Events.ERROR, function (a, b, c) { err = err || (a + " " + b + " " + (c && c.msg || "")); });
            p.attachMediaElement(v);
            p.load();
            var pp = p.play();
            if (pp && pp.catch) { pp.catch(function () {}); }
        } catch (e) { err = "抛 " + e.message; }
        return untilMoved(t0, 0, 15000).then(function (ms) {
            var from = Date.now(), worst = 0, since = 0, stops = 0, last = v.currentTime;
            return new Promise(function (ok) {
                var tm = setInterval(function () {
                    var now = Date.now();
                    if (v.currentTime === last && !v.paused) { if (!since) { since = now; stops++; } } else { if (since) { worst = Math.max(worst, now - since); } since = 0; }
                    last = v.currentTime;
                    if (now - from >= (ms >= 0 ? 15000 : 1)) {
                        clearInterval(tm);
                        if (since) { worst = Math.max(worst, now - since); }
                        var ahead = v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
                        var r = {ms: ms, worst: worst, stops: stops, dropped: quality() - d0, ahead: ahead, err: err};
                        R(label + "：动起来 " + ms + "ms，15 秒里停 " + stops + " 次、最长 " + worst + "ms，丢帧 +" + r.dropped + "，前方缓冲 " + ahead.toFixed(1) + "s，" +
                          v.videoWidth + "x" + v.videoHeight + (err ? "，错误：" + err : "") + " | " + flvOf(it).split("?")[0].split("/").slice(2, 3)[0]);
                        try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch (e) { R("销毁时抛 " + e.message); }
                        ok(r);
                    }
                }, 100);
            });
        });
    }
    function liveMain() {
        var rooms = [], res = [];
        return liveRooms().then(function (r) {
            rooms = r;
            R("mpegts " + (typeof mpegts !== "undefined" ? mpegts.version : "没装上") + "：isSupported=" + mpegts.isSupported() + " 特性 " + JSON.stringify(mpegts.getFeatureList()) +
              " | hvc1 MSE=" + MediaSource.isTypeSupported("video/mp4; codecs=\"hvc1.1.6.L120.90\"") + " hev1=" + MediaSource.isTypeSupported("video/mp4; codecs=\"hev1.1.6.L120.90\"") +
              " | 直播间 " + rooms.length + " 个");
            /* 先试一次原生：<video src=flv>，8 秒。 */
            say("原生 <video> 放 FLV");
            var t0 = Date.now();
            v.src = flvOf(rooms[0]);
            var pp = v.play();
            if (pp && pp.catch) { pp.catch(function () {}); }
            return untilMoved(t0, 0, 8000).then(function (ms) {
                R("原生 <video src=flv>：动起来 " + ms + "ms，error=" + (v.error ? v.error.code : "无") + " readyState=" + v.readyState);
                v.pause(); v.removeAttribute("src"); v.load();
                return wait(1000);
            });
        }).then(function () {
            /* 两种配置轮换：A 默认（有暂存缓冲）；B 关掉暂存、追直播延迟（mpegts.js 推荐的直播低延迟配置）。 */
            var cfgs = [{name: "默认", c: {enableWorker: false}},
                        {name: "低延迟", c: {enableWorker: false, enableStashBuffer: false, stashInitialSize: 128 * 1024, liveBufferLatencyChasing: true,
                                             liveBufferLatencyMaxLatency: 3, liveBufferLatencyMinRemain: 1, lazyLoad: false, autoCleanupSourceBuffer: true}}];
            var p = Promise.resolve(), i = 0;
            rooms.concat(rooms.slice(0, 3)).forEach(function (it) {
                var k = i++, cf = cfgs[k % 2];
                p = p.then(function () {
                    return playFlv(it, cf.c, "第 " + k + " 个（" + cf.name + "）").then(function (r) { r.cfg = cf.name; res.push(r); return wait(500); });
                });
            });
            return p;
        }).then(function () {
            ["默认", "低延迟"].forEach(function (n) {
                var g = res.filter(function (r) { return r.cfg === n; });
                R("结论 " + n + "（" + g.length + " 次）：动起来 中位 " + median(g.map(function (r) { return r.ms; })) + "ms，最长停顿 中位 " + median(g.map(function (r) { return r.worst; })) +
                  "ms，停 共 " + g.reduce(function (a, r) { return a + r.stops; }, 0) + " 次 | " + g.map(function (r) { return r.ms + "/" + r.worst + "/" + r.stops; }).join(" "));
            });
            say("结束。装回正常构建：zsh tools/deploy.sh");
        });
    }

    function takeOver() {
        Player.stop(true);
        var old = document.getElementById("va");
        if (old) { old.style.display = "none"; }
        ["cover", "mask", "info", "rail", "tabs", "loading", "paused", "progress"].forEach(function (id) {
            var e = document.getElementById(id);
            if (e) { e.style.display = "none"; }
        });
        /* 遥控器只留返回键（退出）：app 的按键处理会去给已经停掉的元素换源、抢解码器。 */
        window.addEventListener("keydown", function (e) {
            if (e.keyCode !== 10009) { e.stopImmediatePropagation(); e.preventDefault(); }
        }, true);
        v = document.createElement("video");
        v.style.cssText = "position:absolute;left:0;top:0;width:1920px;height:1080px;object-fit:contain;z-index:8";
        document.body.appendChild(v);
        note = document.createElement("div");
        note.style.cssText = "position:absolute;left:40px;top:30px;z-index:9;font-size:40px;color:#fff;background:rgba(0,0,0,0.6);padding:10px 24px;border-radius:12px";
        document.body.appendChild(note);
        ["loadedmetadata", "loadeddata", "canplay", "playing", "seeking", "seeked", "waiting", "resize"].forEach(function (name) {
            v.addEventListener(name, function () { if (marks[name] === undefined) { marks[name] = Date.now() - actAt; } });
        });
        v.addEventListener("error", function () { R("元素报错 " + (v.error ? v.error.code + " " + v.error.message : "?")); });
    }

    function run() {
        var clips = [], base = [], m = null;
        /* 先让 app 正常起来（签名桥、登录态都在后台起），出了第一帧再接管唯一的那个解码器。 */
        var t0 = Date.now();
        function waitApp() {
            var s = Player.state();
            if ((s.id && s.shown) || Date.now() - t0 > 40000) { return Promise.resolve(); }
            return wait(300).then(waitApp);
        }
        waitApp().then(function () {
            takeOver();
            R("开始：MediaSource=" + (typeof MediaSource) + " avc1.640028=" + MediaSource.isTypeSupported("video/mp4; codecs=\"avc1.640028\"") +
              " mp4a.40.2=" + MediaSource.isTypeSupported("audio/mp4; codecs=\"mp4a.40.2\"") + " mp4a.40.29=" + MediaSource.isTypeSupported("audio/mp4; codecs=\"mp4a.40.29\""));
            say("装 mp4box");
            return typeof MP4Box !== "undefined" ? null : loadScript("js/vendor/mp4box.js");
        }).then(function () {
            if (SELFTEST !== "livemse") { return pick(); }
            mpegts = MpegtsLib.get();       // vendor/mpegts.js 包了一层函数，只露 MpegtsLib
            return liveMain().then(function () { throw {done: true}; });
        }).then(function (c) {
            clips = c;
            if (clips.length < 2) { throw new Error("只备好 " + clips.length + " 条，不够比"); }
            if (SELFTEST === "splice") {
                R("顺序：" + clips.map(function (x, i) { return i + "=" + orient(x) + x.vw + "x" + x.vh + "（第一帧 " + x.vFirst.toFixed(3) + "s，取到 " + x.headEnd.toFixed(1) + "s）"; }).join(" "));
                return spliceMain(clips).then(function () { throw {done: true}; });
            }
            R("顺序：" + clips.map(function (x, i) { return i + "=" + orient(x) + x.vw + "x" + x.vh; }).join(" "));
            return BASELINE ? baseline(clips) : [];
        }).then(function (b) {
            base = b;
            return mseRun(clips);
        }).then(function (r) {
            m = r;
            var ok = m.seeks.filter(function (s) { return s.ms >= 0; });
            var by = function (f) { return median(ok.filter(f).map(function (s) { return s.ms; })); };
            var turn = function (s) { return s.kind === "横→竖" || s.kind === "竖→横"; };
            R("结论：" + (base.length ? "换 src → 动起来 中位 " + median(base) + "ms（" + base.length + " 次，全部=" + base.join(",") + "）| " : "") +
              "MSE 冷启动 " + m.cold + "ms | seek → 动起来 中位 " + median(ok.map(function (s) { return s.ms; })) + "ms（" + m.seeks.length + " 次，没动起来 " +
              (m.seeks.length - ok.length) + "；横竖互换 " + by(turn) + " / 其余 " + by(function (s) { return !turn(s); }) +
              "；框修正 " + by(function (s) { return s.fix; }) + " / 不修正 " + by(function (s) { return !s.fix; }) +
              "，全部=" + m.seeks.map(function (s) { return s.ms + (s.fix ? "修" : ""); }).join(",") + "）| 播放中预塞时播放头最长停 " + m.appendStall + "ms");
            say("结束。装回正常构建：zsh tools/deploy.sh");
        }).catch(function (e) {
            if (e && e.done) { return; }
            R("中止：" + e.message);
            say("中止：" + e.message);
        });
    }

    window.addEventListener("load", function () { setTimeout(run, 500); });
})();
