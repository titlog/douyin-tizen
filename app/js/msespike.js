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
    if (typeof SELFTEST === "undefined" || SELFTEST !== "mse") { return; }

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
        if (!c.init.video || !c.segs.video.length) { throw new Error("没转出视频分段"); }
        if (!c.init.audio || !c.segs.audio.length) { throw new Error("没转出音频分段"); }
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
        }).then(pick).then(function (c) {
            clips = c;
            if (clips.length < 2) { throw new Error("只备好 " + clips.length + " 条，不够比"); }
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
            R("中止：" + e.message);
            say("中止：" + e.message);
        });
    }

    window.addEventListener("load", function () { setTimeout(run, 500); });
})();
