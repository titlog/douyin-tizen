/* MSE 引擎：整个会话一个 MediaSource，每条视频一个时间槽，切换 = 一次 seek。
 *
 * 为什么：换 src 每次都拆掉重建解码管线，按键到画面动起来 ~1.2 秒里有 ~0.65 秒是解码器冷启动，
 * 预热多少字节都省不掉。同一个 MediaSource 里 seek 到预先 append 好的槽，2026-09-30 设备上两轮
 * 26 次中位 226 / 251ms，零失败零丢帧（js/msespike.js，数据在 CLAUDE.md）。
 *
 * 数据：/aweme/v1/play/ 跳到 CDN 上的渐进式 MP4（moov 在头）。每条视频一个 mp4box 文件对象，把
 * 取到的字节转成 fMP4 分段，append 进这条的槽（第 k 槽从 k×SLOT 秒开始）：
 *   预热（prepare）：开头 → moov + 之后 HEAD 字节 → 分段 → append。
 *   正在放的那条：按播放头往后续取 CHUNK，保持缓冲领先 AHEAD 秒；播放头后面 BEHIND 秒以外的清掉。
 *   切走的那条：只留开头 KEEP_HEAD 秒（回到上一条时秒开），槽按最近使用循环复用。
 * 两条 SourceBuffer 各一个串行队列；换到另一条的数据之前先设 timestampOffset、再 append 那条的
 * 初始化段。横竖屏、分辨率、H.264 level 不同都能混在一个 SourceBuffer 里（设备实测），但
 * **videoWidth/Height 永远停在第一条** —— 元素的框由 Player 按这一条的尺寸摆。
 *
 * **几条的数据交错着 append，回到某一条时要把它最后一个 GOP 重放一遍**（2026-09-30 设备实测）。时间戳
 * 一跳，SourceBuffer 按规范当成不连续，之后的帧一直丢到下一个关键帧为止。mp4box 这一版没实现
 * rapAlignement，分段按样本号每 30 个切一刀，多半从 GOP 中间开始 —— 于是预热分两次取的那条，第二次的
 * 开头丢了，槽里留一个缺口，切过去放到第一块的末尾（3.35 秒）就停住，后面的数据 append 得再多也没用。
 * 探测里每条是一次整批塞进去的，从没交错过，所以没暴露。见 pump 里的 replay。
 *
 * 放不了的（非 avc1 / 非 mp4a、没有音轨或视频轨、moov 不在开头、比一个槽还长）抛带 unusable 的错，
 * Player 改走 src。
 */
var Mse = (function () {
    "use strict";

    var SLOT = 20000;              // 秒。比最长的视频长就行，更长的走 src
    var NSLOTS = 6;                // 槽循环复用：时间戳不无限长，mp4box 的样本表也不无限多
    var FIRST = 1048576;           // 第一段：读出 moov 在哪；moov 小的话 moov 和开头几秒都在里面了
    var HEAD = 1572864;            // 预热：moov 之后取这么多（1080p 大约 4–8 秒）
    var HEAD_NOW = 524288;         // 现取（没预热过就要放）：先要够出画面的，剩下的边放边取
    /* 一个请求多久没收到新字节就算失败。原来是「整个请求 20 秒没取完」：网慢的时候，慢但字节一直在来的请求也会被掐掉
     * （2026-09-30）。整个请求另有 TOTAL_MS 的上限。 */
    var IDLE_MS = 15000, TOTAL_MS = 120000;
    var CHUNK = 2097152;
    var AHEAD = 30, BEHIND = 20, KEEP_HEAD = 8;

    var el = null, ms = null, sb = null, fam = null, openP = null;
    var items = {}, slots = [], cur = null, clock = 0, showGen = 0;
    var bad = {};                  // id → 为什么放不了。拆管线也留着，免得每次重建都再试一遍
    var q = {video: [], audio: []}, running = {video: null, audio: null}, last = {video: null, audio: null};
    var endedSent = false, quotaHits = 0, noRangeTold = false, gapJumps = 0;
    var lastSeek = "";                    // 最近一次跳转离前一个关键帧多远，自测 --seek 读
    var ops = [], lastT = -1, stallFrom = 0, stallTold = false, showAt = 0;   // 停顿诊断：最近 3 秒的队列操作
    var handlers = {};

    var CONTENT_RANGE = new RegExp("bytes (\\d+)-(\\d+)/(\\d+)");

    function R(msg) { Log.report("mse", msg); }
    function trace(what) {
        var now = Date.now();
        ops.push({at: now, what: what});
        while (ops.length && now - ops[0].at > 3000) { ops.shift(); }
    }
    function mb(n) { return (n / 1048576).toFixed(1) + "MB"; }
    function unusable(msg) { var e = new Error(msg); e.unusable = true; return e; }

    /* 顶层盒子里 moov 的位置；mdat 在前返回 null，字节不够返回 undefined。 */
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

    /* 文件多长：渐进式 MP4 的最后一个顶层盒子是 mdat，它的结尾就是文件结尾。Content-Range 读不到时用。 */
    function fileEnd(buf) {
        var dv = new DataView(buf), off = 0;
        while (off + 8 <= buf.byteLength) {
            var size = dv.getUint32(off);
            var type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
            if (size === 1 && off + 16 <= buf.byteLength) { size = dv.getUint32(off + 8) * 4294967296 + dv.getUint32(off + 12); }
            if (size < 8) { return 0; }
            if (type === "mdat") { return off + size; }
            off += size;
        }
        return 0;
    }

    // ---------- 网络 ----------

    /* 取 [from, to]。只认 206 且 Content-Range 对得上、字节数对得上 —— bilibili 那边吃过亏：403 的
     * HTML 错误页、CDN 掐线留下的半截，被当成媒体数据喂进解码器，报出来的是解码错误。
     * CDN 最终地址带签名，会过期：403/404 就回跳转接口重新拿一次。 */
    function get(e, url, from, to, retried) {
        return new Promise(function (ok, fail) {
            var x = e.xhr = new XMLHttpRequest();
            e.xhrAt = Date.now();
            e.xhrWant = to - from + 1;
            e.xhrGot = 0;
            e.xhrHost = "";
            e.xhrTtfb = -1;
            var idle = 0, idled = false;
            var arm = function () {
                clearTimeout(idle);
                idle = setTimeout(function () { idled = true; try { x.abort(); } catch (z) {} }, IDLE_MS);
            };
            var done = function () { clearTimeout(idle); e.lastGet = {ttfb: e.xhrTtfb, ms: Date.now() - e.xhrAt, host: e.xhrHost}; };
            x.open("GET", url);
            x.responseType = "arraybuffer";
            x.timeout = TOTAL_MS;
            x.setRequestHeader("Range", "bytes=" + from + "-" + to);
            x.onload = function () {
                e.xhr = null;
                if (!e.xhrHost && x.responseURL) { e.xhrHost = x.responseURL.split("/")[2]; }
                done();
                var n = x.response ? x.response.byteLength : 0;
                var cr = CONTENT_RANGE.exec(x.getResponseHeader("Content-Range") || "");
                if (x.status === 206 && n && cr && +cr[1] === from && n === +cr[2] - from + 1) {
                    ok({buf: x.response, url: x.responseURL, total: +cr[3]});
                    return;
                }
                /* 跨域响应的 Content-Range 脚本不一定读得到：读不到就按该回多少字节核对（文件多长由
                 * mdat 盒子算，见 prepare）。 */
                if (x.status === 206 && n && !cr && (!e.size || n === Math.min(to, e.size - 1) - from + 1)) {
                    if (!noRangeTold) { noRangeTold = true; R("读不到 Content-Range 头，改按字节数核对"); }
                    ok({buf: x.response, url: x.responseURL, total: 0});
                    return;
                }
                if ((x.status === 403 || x.status === 404) && !retried && url !== e.item.url) {
                    R("CDN 地址 HTTP " + x.status + "，回跳转接口重新拿 | " + Diag.priv(e.item.desc.slice(0, 12)));
                    get(e, e.item.url, from, to, true).then(function (r) { e.url = r.url; ok(r); }, fail);
                    return;
                }
                fail(new Error(x.status === 206 ? "回来的字节对不上（" + (x.response ? x.response.byteLength : 0) + "B，" + (cr ? cr[0] : "无 Content-Range") + "）" : "HTTP " + x.status));
            };
            /* 「卡住」那行用：字节还在来，还是一个都没到。 */
            x.onprogress = function (ev) {
                if (ev.loaded > e.xhrGot) { arm(); }
                if (e.xhrTtfb < 0 && ev.loaded > 0) { e.xhrTtfb = Date.now() - e.xhrAt; }
                e.xhrGot = ev.loaded;
                if (!e.xhrHost && x.responseURL) { e.xhrHost = x.responseURL.split("/")[2]; }
            };
            x.onerror = function () { e.xhr = null; done(); fail(new Error("连接失败")); };
            x.ontimeout = function () { e.xhr = null; done(); fail(new Error(TOTAL_MS / 1000 + " 秒没回完（收到 " + mb(e.xhrGot) + "/" + mb(e.xhrWant) + "）")); };
            x.onabort = function () {
                e.xhr = null;
                done();
                if (idled) { fail(new Error(IDLE_MS / 1000 + " 秒没收到新字节（收到 " + mb(e.xhrGot) + "/" + mb(e.xhrWant) + (e.xhrHost ? "，" + e.xhrHost : "，一直没有响应") + "）")); return; }
                var err = new Error("取消");
                err.aborted = true;
                fail(err);
            };
            arm();
            x.send();
        });
    }
    function abort(e) { if (e.xhr) { try { e.xhr.abort(); } catch (x) {} e.xhr = null; } }

    // ---------- MediaSource 与 append 队列 ----------

    function open() {
        if (openP) { return openP; }
        ms = new MediaSource();
        var mine = ms;
        openP = new Promise(function (ok, fail) {
            mine.addEventListener("sourceopen", function () { ok(); });
            setTimeout(function () { if (mine.readyState !== "open") { fail(new Error("MediaSource 5 秒没打开")); } }, 5000);
        });
        el.src = URL.createObjectURL(ms);
        return openP;
    }

    function createBuffers(vcodec, acodec) {
        var vt = "video/mp4; codecs=\"" + vcodec + "\"", at = "audio/mp4; codecs=\"" + acodec + "\"";
        if (!MediaSource.isTypeSupported(vt)) { throw unusable(vt + " 不支持"); }
        if (!MediaSource.isTypeSupported(at)) { at = "audio/mp4; codecs=\"mp4a.40.2\""; }
        ms.duration = NSLOTS * SLOT;
        sb = {video: ms.addSourceBuffer(vt), audio: ms.addSourceBuffer(at)};
        fam = {video: vcodec.slice(0, 4), audio: acodec.slice(0, 4)};
        ["video", "audio"].forEach(function (kind) {
            sb[kind].addEventListener("updateend", function () { finish(kind); });
            sb[kind].addEventListener("error", function () { fatal("SourceBuffer(" + kind + ") error"); });
        });
    }

    function enqueue(kind, op) {
        if (op.e) { op.e.pending++; }
        q[kind].push(op);
        pump(kind);
    }
    function settle(op) {
        if (op.e && --op.e.pending === 0) {
            var w = op.e.waiters;
            op.e.waiters = [];
            w.forEach(function (fn) { fn(); });
        }
    }
    function finish(kind) {
        var op = running[kind];
        running[kind] = null;
        if (op) { settle(op); }
        pump(kind);
    }
    function pump(kind) {
        var s = sb && sb[kind];
        if (!s || s.updating || running[kind] || !q[kind].length || !ms || ms.readyState !== "open") { return; }
        var op = q[kind][0];
        /* 这条被挤出槽了，或者之后 resync 过（跳转、切走又切回来）：这一段接不上了，丢掉。 */
        if (op.e && (op.e.dead || (!op.remove && op.gen !== op.e.gen))) { q[kind].shift(); settle(op); pump(kind); return; }
        var e = op.e;
        try {
            if (op.remove) {
                trace("删 " + kind + " " + op.remove[0].toFixed(0) + "–" + op.remove[1].toFixed(0));
                s.remove(op.remove[0], op.remove[1]);
            } else if (last[kind] !== e) {
                trace("初始化段 " + kind + " 槽" + e.slot);
                /* 换到另一条的数据：先把时间轴挪到它的槽、append 它的初始化段。updateend 之后再来
                 * 一次，那时 last 对上了，才 append 这个分段本身。
                 * 时间戳这一跳会让 SourceBuffer 丢帧丢到下一个关键帧（见文件顶部）。这一段要不是从关键帧
                 * 开始，就先把这条最后一个 GOP 里已经 append 过的段重放一遍：重放的开头也会被丢到它的
                 * 关键帧为止，但那之前的帧本来就在缓冲里；从关键帧起的帧和已有的重叠，替换成一样的。 */
                s.timestampOffset = e.base;
                s.appendBuffer(e.init[kind]);
                last[kind] = e;
                e.replay[kind] = !op.sync0 && e.gop[kind].length ? e.gop[kind] : null;
                return;
            } else if (e.replay[kind]) {
                var parts = e.replay[kind], buf = concat(parts);
                e.replay[kind] = null;
                trace("重放 " + kind + " 槽" + e.slot + " " + parts.length + " 段");
                s.appendBuffer(buf);
                e.replays++;
                e.replayBytes += buf.byteLength;
                return;
            } else {
                trace("段 " + kind + " 槽" + e.slot + (e === cur ? "（在放）" : ""));
                s.appendBuffer(op.buf);
                /* 这一条最后一个 GOP 里 append 过的段：从含关键帧的那段起。音频每帧都是关键帧，只留一段。 */
                if (op.sync) { e.gop[kind] = [op.buf]; } else { e.gop[kind].push(op.buf); }
            }
            q[kind].shift();
            running[kind] = op;
        } catch (err) {
            if (err.name === "QuotaExceededError" && (op.tries = (op.tries || 0) + 1) <= 3) {
                if (++quotaHits <= 5) { R("SourceBuffer 满了（" + kind + "），腾地方后重试 | 缓冲 " + ranges()); }
                makeRoom(kind);
                return;
            }
            q[kind].shift();
            settle(op);
            fatal("append 抛了 " + err.name + " " + err.message);
        }
    }

    function concat(parts) {
        if (parts.length === 1) { return parts[0]; }
        var n = 0, i, at = 0;
        for (i = 0; i < parts.length; i++) { n += parts[i].byteLength; }
        var out = new Uint8Array(n);
        for (i = 0; i < parts.length; i++) { out.set(new Uint8Array(parts[i]), at); at += parts[i].byteLength; }
        return out.buffer;
    }

    /* 满了：别的槽只留开头，正在放的那条只留播放头前后。删除插到队首。 */
    function makeRoom(kind) {
        var t = el.currentTime, ops = [];
        for (var id in items) {
            if (!items.hasOwnProperty(id)) { continue; }
            var e = items[id];
            if (e === cur) {
                if (t - 5 > e.base + KEEP_HEAD) { ops.push({remove: [e.base + KEEP_HEAD, t - 5]}); }
            } else if (e.slot >= 0) {
                ops.push({remove: [e.base + 3, e.base + SLOT]});
                e.trimmed = true;
            }
        }
        if (!ops.length) { setTimeout(function () { pump(kind); }, 500); return; }
        for (var i = ops.length - 1; i >= 0; i--) { q[kind].unshift(ops[i]); }
        pump(kind);
    }

    function fatal(why) {
        if (!ms) { return; }
        R("管线坏了：" + why + " | 缓冲 " + ranges() + " readyState=" + el.readyState + (el.error ? " error=" + el.error.code + " " + el.error.message : ""));
        if (handlers.fatal) { handlers.fatal(why); }
    }

    // ---------- 缓冲区查询 ----------

    function ranges() {
        var b = el.buffered, out = [];
        for (var i = 0; i < b.length; i++) { out.push(b.start(i).toFixed(1) + "–" + b.end(i).toFixed(1)); }
        return out.join(" ") || "空";
    }
    /* t 所在的缓冲段 [start, end]，不在任何一段里返回 null。 */
    function rangeAt(t) {
        var b = el.buffered;
        for (var i = 0; i < b.length; i++) {
            if (b.start(i) <= t + 0.05 && b.end(i) > t) { return {start: b.start(i), end: b.end(i)}; }
        }
        return null;
    }
    function firstIn(e) {
        var b = el.buffered;
        for (var i = 0; i < b.length; i++) {
            if (b.start(i) >= e.base - 0.5 && b.start(i) < e.base + SLOT) { return b.start(i); }
        }
        return -1;
    }

    function lastIn(e) {
        var b = el.buffered, end = -1;
        for (var i = 0; i < b.length; i++) {
            if (b.start(i) >= e.base - 0.5 && b.start(i) < e.base + SLOT) { end = Math.max(end, b.end(i)); }
        }
        return end;
    }

    // ---------- 每条视频 ----------

    function takeSlot(e) {
        var i, oldest = null;
        for (i = 0; i < NSLOTS; i++) { if (!slots[i]) { slots[i] = e; return i; } }
        for (i = 0; i < NSLOTS; i++) {
            if (slots[i] !== cur && (!oldest || slots[i].usedAt < oldest.usedAt)) { oldest = slots[i]; }
        }
        var k = oldest.slot;
        drop(oldest);
        slots[k] = e;
        return k;
    }
    function drop(e) {
        e.dead = true;
        abort(e);
        if (e.slot >= 0 && slots[e.slot] === e) {
            slots[e.slot] = null;
            if (sb) {
                enqueue("video", {remove: [e.base, e.base + SLOT]});
                enqueue("audio", {remove: [e.base, e.base + SLOT]});
            }
        }
        if (items[e.id] === e) { delete items[e.id]; }
        e.mp4 = null;
    }

    function onInfo(e, info) {
        var v = info.videoTracks[0], a = info.audioTracks[0];
        if (!v || !a) { throw unusable(!v ? "没有视频轨" : "没有音轨"); }
        if (!sb) { createBuffers(v.codec, a.codec); }
        else if (v.codec.slice(0, 4) !== fam.video || a.codec.slice(0, 4) !== fam.audio) {
            throw unusable("编码 " + v.codec + " / " + a.codec + " 和 SourceBuffer 的 " + fam.video + " / " + fam.audio + " 不是一族");
        }
        e.codec = v.codec + " / " + a.codec + " " + (a.audio ? a.audio.sample_rate + "Hz" : "");
        e.vw = v.video ? v.video.width : v.track_width;
        e.vh = v.video ? v.video.height : v.track_height;
        e.dur = info.duration / info.timescale;
        if (e.dur > SLOT - 60) { throw unusable("时长 " + Math.round(e.dur) + " 秒，比一个槽长"); }
        e.slot = takeSlot(e);
        e.base = e.slot * SLOT;
        var f = e.mp4;
        f.setSegmentOptions(v.id, "video", {nbSamples: 30, rapAlignement: false});
        f.setSegmentOptions(a.id, "audio", {nbSamples: 40, rapAlignement: false});
        var inits = f.initializeSegmentation();
        e.init = {};
        for (var i = 0; i < inits.length; i++) { e.init[inits[i].user] = inits[i].buffer; }
        e.info = info;
        e.tid = {video: v.id, audio: a.id};
        f.start();
    }

    function makeFile(e) {
        var f = e.mp4 = MP4Box.createFile();
        f.onError = function (m) { e.err = new Error("mp4box: " + m); };
        f.onReady = function (info) { try { onInfo(e, info); } catch (err) { e.err = err; } };
        /* 这一段是样本 [segFrom, sampleNum)。记下它是不是从关键帧开始、含不含关键帧（pump 的重放要用）。
         * 样本数据释放之后 is_sync 还在。 */
        f.onSegment = function (id, kind, buf, sampleNum) {
            if (e.dead) { return; }
            var smp = f.getTrackById(id).samples, from = e.segFrom[id] || 0, sync = false;
            for (var i = from; i < sampleNum && !sync; i++) { sync = !!smp[i].is_sync; }
            e.segFrom[id] = sampleNum;
            enqueue(kind, {e: e, buf: buf, gen: e.gen, sync0: !!(smp[from] && smp[from].is_sync), sync: sync});
            try { f.releaseUsedSamples(id, sampleNum); } catch (x) {}
        };
    }

    function feed(e, buf, at) {
        buf.fileStart = at;
        e.mp4.appendBuffer(buf);
        e.next = at + buf.byteLength;
        if (e.err) { var err = e.err; e.err = null; throw err; }
        if (e.next >= e.size && !e.done) { e.done = true; e.mp4.flush(); }
    }

    function drained(e) {
        return new Promise(function (ok) { if (!e.pending) { ok(); } else { e.waiters.push(ok); } });
    }

    /* 取开头、转封装、append 进槽。同一条只做一次，后来的调用拿同一个 Promise。 */
    function prepare(item, now) {
        var e = items[item.id];
        if (e) { e.usedAt = ++clock; return e.ready; }
        e = items[item.id] = {id: item.id, item: item, slot: -1, base: 0, pending: 0, waiters: [], gen: 0, usedAt: ++clock,
                              next: 0, size: 0, done: false, dead: false, xhr: null, t0: Date.now(), now: !!now,
                              segFrom: {}, gop: {video: [], audio: []}, replay: {video: null, audio: null}, replays: 0, replayBytes: 0};
        var head = now ? HEAD_NOW : HEAD;
        e.ready = open().then(function () {
            return get(e, item.url, 0, FIRST - 1);
        }).then(function (r) {
            e.firstGet = e.lastGet;
            e.url = r.url;
            e.size = r.total || fileEnd(r.buf);
            if (!e.size) { throw unusable("不知道文件多长（没有 Content-Range，开头也找不到 mdat）"); }
            if (r.buf.byteLength < Math.min(FIRST, e.size)) { throw new Error("第一段短了（" + r.buf.byteLength + "B）"); }
            var m = findMoov(r.buf);
            if (m === null) { throw unusable("moov 不在开头"); }
            if (!m) { throw unusable("开头 1MB 里读不到 moov 头"); }
            e.moov = m.end - m.start;
            makeFile(e);
            var t1 = Date.now();
            feed(e, r.buf, 0);
            e.remuxMs = Date.now() - t1;
            var want = Math.min(e.size, m.end + head);
            if (want <= e.next) { return; }
            return get(e, e.url, e.next, want - 1).then(function (r2) {
                if (e.dead) { return; }
                var t2 = Date.now();
                feed(e, r2.buf, e.next);
                e.remuxMs += Date.now() - t2;
            });
        }).then(function () {
            if (e.dead) { throw new Error("等的时候被挤出了槽"); }
            if (!e.info) { throw unusable("moov 没解析出来"); }
            return drained(e);
        }).then(function () {
            e.prepMs = Date.now() - e.t0;
            R("备好 槽" + e.slot + " " + e.vw + "x" + e.vh + " " + Math.round(e.dur) + "s " + e.codec + " | moov " + mb(e.moov) + "，取 " + mb(e.next) +
              "，转封装 " + e.remuxMs + "ms，共 " + e.prepMs + "ms" + (e.now ? "（现取）" : "") +
              (e.firstGet ? "，第一段 首字节 " + e.firstGet.ttfb + "ms 共 " + e.firstGet.ms + "ms " + e.firstGet.host : "") +
              " | " + gopStat(keysOf(e)) + " | 槽里 " + slotRanges(e) +
              (e.replays ? "，重放 " + e.replays + " 次 " + mb(e.replayBytes) : "") + " | " + Diag.priv(item.desc.slice(0, 12)));
            return e;
        });
        e.ready.catch(function (err) {
            if (err.unusable) { bad[item.id] = err.message; R("这条放不了：" + err.message + " | " + Diag.priv(item.desc.slice(0, 12))); }
            if (!e.dead) { drop(e); }
        });
        return e.ready;
    }

    /* 让 mp4box 从 t（秒，相对这条）之前的关键帧重新出分段，下一次续取从它要的字节开始。 */
    function resync(e, t) {
        abort(e);
        e.gen++;
        e.gaveUp = false;
        e.netFails = 0;
        e.retryAt = 0;
        var s = e.mp4.seek(Math.max(0, t), true);
        e.next = s.offset;
        e.done = e.next >= e.size;
        /* seek 之前攒了一半的分段扔掉，seek 之后的第一段从关键帧开始，不和之前的样本拼在一起。 */
        e.mp4.fragmentedTracks.forEach(function (ft) { ft.segmentStream = null; e.segFrom[ft.id] = ft.trak.nextSample; });
        e.gop = {video: [], audio: []};
        e.replay = {video: null, audio: null};
        e.mp4.processSamples(false);
    }

    /* 正在放的那条：缓冲领先不到 AHEAD 秒就往后续取。 */
    function pumpNet() {
        var e = cur;
        if (!e || e.dead || e.done || e.xhr || !e.info || e.gaveUp || Date.now() < (e.retryAt || 0)) { return; }
        var r = rangeAt(el.currentTime);
        if (r && r.end - el.currentTime > AHEAD) { return; }
        if (q.video.length > 30) { return; }
        var from = e.next, to = Math.min(e.size, from + CHUNK) - 1, g = e.gen;
        var t0 = Date.now();
        get(e, e.url, from, to).then(function (res) {
            if (g !== e.gen || e.dead) { return; }
            e.netFails = 0;
            e.lastFetch = mb(res.buf.byteLength) + "/" + (Date.now() - t0) + "ms";
            try { feed(e, res.buf, from); } catch (err) { fatal("续取的数据转不了：" + err.message); return; }
            pumpNet();
        }, function (err) {
            if (g !== e.gen || e.dead || err.aborted) { return; }
            e.netFails = (e.netFails || 0) + 1;
            R("续取失败（" + err.message + "）第 " + e.netFails + " 次 | " + Diag.priv(e.item.desc.slice(0, 12)));
            /* 连续三次就放弃这一条（交给 app 跳下一条），直到下一次 resync（跳转、切回来）才再试 ——
             * 心跳每 250ms 叫一次 pumpNet，不设这道闸就是无限重试、每次都报一遍错。 */
            if (e.netFails >= 3) { e.gaveUp = true; if (handlers.error) { handlers.error("续取连续失败：" + err.message); } return; }
            e.retryAt = Date.now() + 1500 * e.netFails;
        });
    }

    /* 视频轨关键帧的时间（秒，相对这条），升序。 */
    function keysOf(e) {
        if (e.keys) { return e.keys; }
        var smp = e.mp4.getTrackById(e.tid.video).samples, out = [];
        for (var i = 0; i < smp.length; i++) { if (smp[i].is_sync) { out.push(smp[i].cts / smp[i].timescale); } }
        out.sort(function (a, b) { return a - b; });
        return (e.keys = out);
    }
    function keyBefore(ks, t) {
        var lo = 0, hi = ks.length - 1, k = 0;
        while (lo <= hi) { var m = (lo + hi) >> 1; if (ks[m] <= t) { k = ks[m]; lo = m + 1; } else { hi = m - 1; } }
        return k;
    }
    function gopStat(ks) {
        if (ks.length < 2) { return "只有 " + ks.length + " 个关键帧"; }
        var d = [];
        for (var i = 1; i < ks.length; i++) { d.push(ks[i] - ks[i - 1]); }
        d.sort(function (a, b) { return a - b; });
        return "关键帧间隔 中位 " + d[d.length >> 1].toFixed(1) + "s 最长 " + d[d.length - 1].toFixed(1) + "s";
    }

    /* 切走的那条只留开头：回到上一条时秒开，又不占地方。续取马上停、队列里它还没 append 的段作废（gen），
     * 别再和新的这条交错着 append；删在 1 秒后。切回来时 trimmed 让 show 先 resync。 */
    function trimAway(e) {
        abort(e);
        e.gen++;
        e.trimmed = true;
        setTimeout(function () {
            if (e === cur || e.dead || !sb) { return; }
            enqueue("video", {remove: [e.base + KEEP_HEAD, e.base + SLOT]});
            enqueue("audio", {remove: [e.base + KEEP_HEAD, e.base + SLOT]});
        }, 1000);
    }

    /* 这条槽里的缓冲段，相对这条的时间。 */
    function slotRanges(e) {
        var b = el.buffered, out = [];
        for (var i = 0; i < b.length; i++) {
            if (b.end(i) > e.base && b.start(i) < e.base + SLOT) { out.push((b.start(i) - e.base).toFixed(1) + "–" + (b.end(i) - e.base).toFixed(1)); }
        }
        return out.join(" ") || "空";
    }

    /* 播放头停在一段缓冲的末尾、同一个槽里 10 秒内还有下一段：跳过去（MSE 不会自己跨缺口）。
     * 有了 pump 里的重放，缺口本不该出现 —— 真跳了会报出来，说明还有别的来源。 */
    function jumpGap(e, t) {
        var r = rangeAt(t);
        if (r && r.end - t > 0.3) { return false; }
        var b = el.buffered, s = -1;
        for (var i = 0; i < b.length; i++) {
            var st = b.start(i);
            if (st > t && st < Math.min(t + 10, e.base + SLOT) && (s < 0 || st < s)) { s = st; }
        }
        if (s < 0) { return false; }
        gapJumps++;
        R("跳过缺口 " + (t - e.base).toFixed(2) + " → " + (s - e.base).toFixed(2) + "（" + (s - t).toFixed(2) + " 秒，本次会话第 " + gapJumps + " 次）| 槽里 " + slotRanges(e));
        el.currentTime = s + 0.05;
        return true;
    }

    /* 心跳：续取、清掉播放头后面的、判断放完。 */
    function stallState(e) {
        var r = rangeAt(el.currentTime);
        return "t=" + (el.currentTime - e.base).toFixed(2) + " 前方缓冲 " + (r ? (r.end - el.currentTime).toFixed(2) : "0") + "s 槽里 " + slotRanges(e) + " readyState=" + el.readyState +
               " seeking=" + el.seeking + " | 续取 " + (e.done ? "取完了" : e.xhr ? "在途 " + (Date.now() - e.xhrAt) + "ms（要 " + mb(e.xhrWant) + "）" : e.gaveUp ? "放弃了" : "没在取") +
               "，上一块 " + (e.lastFetch || "-") + "，已取到 " + mb(e.next) + "/" + mb(e.size) + " | 队列 " + q.video.length + "/" + q.audio.length +
               " | 重放 " + e.replays + " 次 " + mb(e.replayBytes);
    }
    function stallReport(ms, e) {
        var from = Date.now() - ms - 1500, seen = {}, order = [];
        ops.forEach(function (o) {
            if (o.at < from) { return; }
            if (!seen[o.what]) { seen[o.what] = 0; order.push(o.what); }
            seen[o.what]++;
        });
        R("卡了 " + ms + "ms 结束：" + stallState(e) + " | 开始前 1.5 秒到现在的操作：" +
          (order.map(function (w) { return w + (seen[w] > 1 ? "×" + seen[w] : ""); }).join("，") || "无"));
    }

    setInterval(function () {
        var e = cur;
        if (!e || e.dead || !sb) { return; }
        pumpNet();
        var t = el.currentTime;
        var now = Date.now();
        if (!el.paused && t === lastT) {
            if (!stallFrom) { stallFrom = now - 250; stallTold = false; }
            if (!stallTold && now - stallFrom >= 500) {
                stallTold = true;
                R("卡住了：切过来 " + (stallFrom - showAt) + "ms 后开始，" + stallState(e));
            }
            if (now - stallFrom >= 500 && !el.seeking) { jumpGap(e, t); }
        } else {
            if (stallFrom && now - stallFrom >= 700) { stallReport(now - stallFrom, e); }
            stallFrom = 0;
            lastT = t;
        }
        if (t - BEHIND > (e.cutTo || e.base + KEEP_HEAD) + 15) {
            enqueue("video", {remove: [e.base + KEEP_HEAD, t - BEHIND]});
            enqueue("audio", {remove: [e.base + KEEP_HEAD, t - BEHIND]});
            e.cutTo = t - BEHIND;
        }
        /* 放完：字节都取完、都 append 了，播放头走到槽里最后一段缓冲的末尾。不拿 dur 硬比 —— 视频轨
         * 比音轨短一点时，缓冲的交集到不了 dur，那样会一直等到 12 秒看门狗。 */
        if (!endedSent && e.done && !e.pending && !el.seeking && !el.paused) {
            var r = rangeAt(t);
            if ((r && r.end >= lastIn(e) - 0.05 && t >= r.end - 0.3) || t >= e.base + e.dur - 0.2) {
                endedSent = true;
                if (handlers.ended) { handlers.ended(); }
            }
        }
    }, 250);

    return {
        SLOT: SLOT,
        init: function (video) {
            el = video;
            el.addEventListener("seeked", function () { pumpNet(); });
        },
        on: function (name, fn) { handlers[name] = fn; },
        usable: function (item) {
            return typeof MediaSource !== "undefined" && typeof MP4Box !== "undefined" && !bad[item.id] &&
                   !(item.dur && item.dur > (SLOT - 60) * 1000);
        },
        whyBad: function (item) { return bad[item.id] || ""; },
        attached: function () { return !!ms; },
        /* "槽里有" / "在途" / "" —— 「到画面」那行用。 */
        /* 这一条到现在收到的字节（播放器看门狗用：等数据的时候字节还在来就不算卡）。 */
        fetched: function (item) {
            var e = items[item.id];
            return e ? e.next + (e.xhr ? e.xhrGot || 0 : 0) : 0;
        },
        /* 自测 --cold：有几条在取（等链路空了再点下一条）。 */
        busy: function () {
            var n = 0;
            for (var k in items) { if (items.hasOwnProperty(k) && items[k].xhr) { n++; } }
            return n;
        },
        /* 播放器看门狗报「卡住」时附上：这一条在 MSE 里走到哪了。2026-09-30 作者主页里一条视频 12 秒没出画面被跳过，
         * MSE 一个字没报 —— 第一段请求（那时 20 秒超时）还在途。 */
        pending: function (item) {
            var e = items[item.id];
            if (!e) { return "MSE 里没有这一条"; }
            if (e.info && !e.pending) { return "已备好（槽" + e.slot + "）"; }
            return (e.info ? "开头已转好、还在 append" : "还没拿到 moov") + "，" + (e.xhr ? "请求在途 " + ((Date.now() - e.xhrAt) / 1000).toFixed(1) + "s，收到 " +
                   mb(e.xhrGot || 0) + "/" + mb(e.xhrWant) + (e.xhrHost ? "，" + e.xhrHost : "，还没有响应") : "没有请求在途") + "，已取 " + mb(e.next);
        },
        status: function (item) {
            var e = items[item.id];
            if (!e) { return ""; }
            return e.info && !e.pending && e.prepMs ? "槽里有（" + Math.round((Date.now() - e.t0) / 1000) + " 秒前开始备，用了 " + e.prepMs + "ms）" : "在途";
        },
        prepare: function (item) { return prepare(item, false); },

        /* 放这一条：备好（没预热过就现取）→ seek 到它的槽。返回 {e, target}；被后来的 show 顶掉返回 null。 */
        show: function (item, startAt) {
            var g = ++showGen, prev = cur;
            endedSent = false;
            var e0 = items[item.id];
            if (!(e0 && e0.info && !e0.pending)) { try { el.pause(); } catch (x) {} }
            return prepare(item, true).then(function (e) {
                if (g !== showGen) { return null; }
                if (prev && prev !== e) { trimAway(prev); }
                if (prev && stallFrom && Date.now() - stallFrom >= 700) { stallReport(Date.now() - stallFrom, prev); }
                cur = e;
                showAt = Date.now();
                stallFrom = 0;
                e.usedAt = ++clock;
                var t = startAt > 1 && startAt < e.dur - 3 ? startAt : 0;
                /* 从「我」回到同一条（Player.stop 只暂停了）：位置对得上就不 seek，接着放。
                 * 其余从中间接着放的不对齐关键帧（不像 seekTo）：退到前一个关键帧最多退 7 秒，5 秒处离开的
                 * 回来就是从头放（设备自测实测）。宁可多解码 ~1 秒，位置要对。 */
                if (prev === e && t && Math.abs(el.currentTime - e.base - t) < 1.5 && rangeAt(el.currentTime)) {
                    var p0 = el.play();
                    if (p0 && p0.catch) { p0.catch(function () {}); }
                    pumpNet();
                    return {e: e, target: el.currentTime};
                }
                var first = firstIn(e);
                var target = t ? e.base + t : (first >= 0 ? first : e.base);
                var r = rangeAt(target);
                if (e.trimmed || !r) {
                    resync(e, (r ? r.end : target) - e.base);
                    e.trimmed = false;
                }
                e.cutTo = 0;
                el.currentTime = target;
                var p = el.play();
                if (p && p.catch) { p.catch(function () {}); }
                pumpNet();
                return {e: e, target: target};
            });
        },
        /* 当前这条里跳到 t 秒（相对）。 */
        seekTo: function (t) {
            var e = cur;
            if (!e) { return; }
            var from = el.currentTime - e.base;
            t = Math.max(0, Math.min(e.dur - 0.5, t));
            /* 快进 / 快退对齐到离目标最近的关键帧（方向不能反：往后跳不能落到现在之前），±10 秒实际落在
             * ±6.5–13.5 秒。落在 GOP 中间的跳转，解码器
             * 要从前一个关键帧一路解到目标：2026-09-30 设备上同一轮每两次轮换，±120 秒跳转，对齐 16 次中位
             * 258ms、不对齐 16 次中位 966ms，不对齐时和「离前一个关键帧多远」一起涨（0.1s→258ms，
             * 2.7s→1283ms，6.6s→1488ms）。抖音的关键帧间隔 6.4–7 秒。
             * +0.01：浮点误差落到关键帧前面一点，就要把上一个 GOP 整个解一遍。 */
            var ks = keysOf(e), kb = keyBefore(ks, t), i = ks.indexOf(kb), ka = i + 1 < ks.length ? ks[i + 1] : kb;
            var k = t - kb <= ka - t ? kb : ka;
            lastSeek = "离前一个关键帧 " + (t - kb).toFixed(1) + "s，" + gopStat(ks);
            if ((t > from && k > from + 1) || (t < from && k < from - 1)) {
                lastSeek += "，对齐 " + t.toFixed(1) + "→" + k.toFixed(1);
                t = k + 0.01;
            }
            var target = e.base + t;
            if (!rangeAt(target)) { resync(e, target - e.base); }
            endedSent = false;
            el.currentTime = target;
            pumpNet();
        },
        current: function () { return cur; },
        lastSeek: function () { return lastSeek; },
        ranges: ranges,
        aheadEnd: function () { var r = rangeAt(el.currentTime); return r ? r.end : el.currentTime; },

        /* 拆掉整个管线（退回 src、离开视频页、管线坏了重建之前）。 */
        detach: function () {
            for (var id in items) { if (items.hasOwnProperty(id)) { items[id].dead = true; abort(items[id]); } }
            items = {};
            slots = [];
            cur = null;
            showGen++;
            q = {video: [], audio: []};
            running = {video: null, audio: null};
            last = {video: null, audio: null};
            sb = null;
            fam = null;
            ms = null;
            openP = null;
            try { el.pause(); } catch (x) {}
            el.removeAttribute("src");
            try { el.load(); } catch (x) {}
        }
    };
})();
