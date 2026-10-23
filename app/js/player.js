/* 一个 <video>，三种放法（2026-09-30 起；直播 2026-10-22）：
 *   "mse"：默认。整个会话一个 MediaSource，每条视频一个时间槽，切换 = seek（js/mse.js）。换 src 要
 *          ~1.2 秒拆建解码管线，seek 到预先 append 好的槽 ~0.25 秒（CLAUDE.md）。
 *   "src"：给元素换 src。MSE 放不了的条目（非 H.264、没有音轨、moov 不在开头……）走它；MSE 管线在
 *          一次会话里坏了 3 次，整场改走它。两种之间切换要拆掉 MediaSource，下一条 MSE 冷启动。
 *   "flv"：直播间。mpegts.js 把 FLV（H.265）转成 fMP4 交给它自己的 MediaSource，见 playFlv。
 * app.js 看到的接口都一样；时间、时长都换算成这一条自己的（MSE 的 currentTime 带着槽的偏移）。
 *
 * 以下是 src 放法的来历。
 *
 * 第一版是两个 <video> 轮换（当前 + 预载下一条），2026-09-29 设备上第一晚就证伪了：
 * 这台电视只有一个硬件解码器，备用元素一 load() 解出首帧（readyState=4），正在放的那条
 * 就在同一秒冻住 —— 每一条都在开播 2–3 秒后停在 readyState=1、前方缓冲 20–40 秒（字节
 * 都在，解码器被抢走了），而预载正排在开播后 1.5 秒。切换时 13–54ms 的「到画面」是用
 * 当前这条的死换来的。**别再加回第二个媒体元素。**
 *
 * 现在的预热只用 XHR：跟着 /aweme/v1/play/ 的 302 走一遍拿到 CDN 上的最终地址（省掉
 * 起播时的那一跳），顺带取开头 512KB 把边缘焐热。起播直接用最终地址；它失败就退回跳转
 * 接口重来一次（最终地址带签名，可能过期）。
 */
var Player = (function () {
    "use strict";

    var WARM_BYTES = 524288;
    /* 长视频的 moov 比 WARM_BYTES 大：26 分钟那条是 1.27MB（2026-09-30 开发机上拆的），开头 512KB
     * 连元数据都没取全。补取：第一段回来后读出 moov 的长度，补取到 moov 末尾再多 WARM_AFTER_MOOV。
     * **量不出好处，默认关**（2026-09-30 `--ab`，按视频 id 奇偶分组、同一轮 50 条：元数据中位 补取 627ms /
     * 不补 613ms，分到长短 moov、两种切换方式里方向还来回翻 —— 是噪声）。和 "blob" 一样，代码留着。 */
    var MOOV_TOPUP = false;
    var WARM_AFTER_MOOV = 524288;
    var BLOB_MAX = 30 * 1048576;
    var moovAB = false;                  // 自测 --ab：补取 / 不补取按视频 id 奇偶分，同轮对照
    var USE_MSE = true;
    var engine = "";           // "mse" | "src" | ""（停着）
    var mseE = null;           // MSE：正在放的那条（Mse 的条目：base、dur、vw、vh、slot）
    var boxKey = "", boxAt = 0;   // MSE：元素的框上一次真的变了是什么时候（「封面」那行报改框到撤封面隔了多久）
    var mseFails = 0, mseOff = "";
    var el = null;
    var gen = 0;
    var handlers = {};
    var item = null;
    var switchAt = 0, told = true, usedWarm = "", fellBack = false;
    var marks = {};            // 这一次切换里各事件第一次出现的时刻（相对 switchAt）
    var playNote = "";         // 调用方附在「到画面」那行里的说明
    var pendingSeek = 0;       // 元数据到了再跳：切回标签时接着看
    var lastTime = -1, stuckSince = 0;
    var lastBytes = -1, srcProgress = 0;   // 看门狗：等数据时这一条收到的字节（MSE）/ progress 事件数（src）
    var STALL_MS = 12000, FIRST_CAP = 60000;
    var paused = false;
    var warm = {};             // item.id → {state: "在途"|"好了"|"失败", url, ms, bytes}

    function isLive(g) { return g === gen; }

    /* 文件开头那几个顶层盒子里 moov 的位置。moov 不在开头（mdat 在前）返回 null，
     * 字节不够读到 moov 头返回 undefined。 */
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
    function mb(n) { return (n / 1048576).toFixed(1) + "MB"; }

    /* MSE 下 videoWidth/Height 永远停在第一条（设备实测），元素按它 contain 摆放，换了比例的视频就变形。
     * 框直接摆成这一条该占的区域、object-fit: fill；src 下还原成 CSS 里的全屏 contain。
     * **seek 发出的同一刻就摆**（这时旧画面在整页封面下面，拉变形了也看不见），撤封面时新框已经生效了
     * 250–430ms。光这样还不够：封面完全不透明时新框根本送不出去，见 app.css 里 #cover 的 opacity。 */
    function place(e) {
        var s = el.style;
        var key = e && e.vw && e.vh ? e.vw + "x" + e.vh : "";
        if (key !== boxKey) { boxKey = key; boxAt = Date.now(); }
        if (!key) { s.left = s.top = s.width = s.height = s.objectFit = ""; return; }
        var sc = Math.min(1920 / e.vw, 1080 / e.vh), W = Math.round(e.vw * sc), H = Math.round(e.vh * sc);
        s.left = Math.round((1920 - W) / 2) + "px";
        s.top = Math.round((1080 - H) / 2) + "px";
        s.width = W + "px";
        s.height = H + "px";
        s.objectFit = "fill";
    }
    function rel() { return engine === "mse" && mseE ? Math.max(0, el.currentTime - mseE.base) : el.currentTime; }
    function relDur() { return engine === "mse" && mseE ? mseE.dur : (isFinite(el.duration) ? el.duration || 0 : 0); }     // 直播是 Infinity
    /* 直播间（feed.js 的 live）不走 Mse：那一套是给渐进式 MP4 的。有 FLV 地址走 playFlv，没有退回 src（<video> 直接放 m3u8）。 */
    function useMse(it) { return USE_MSE && !mseOff && !it.live && Mse.usable(it); }

    /* 直播：mpegts.js（vendor/mpegts.js）把 FLV 转成 fMP4 交给 MSE（2026-10-22，电视上 --live / --livemse 同一天量的）：
     *   <video> 直接放 m3u8   playing 之后播放头停在 0 不动 5–10 秒（缓冲里已经 12 秒、readyState=4）：平台播放器要先攒一大截才走，
     *                         <video> 没有开关；可跳范围是空的，往回退也做不了。<video> 直接放 FLV 也一样（8 秒没动）。
     *   AVPlay                能设 setBufferingParam（bilibili-tizen 就这么做），但我们的 CSP 是 object-src 'none'，它的 <object> 会被拦，
     *                         而 CSP 跟着安装包走、不跟自动更新走 —— 已经装着的电视都用不了。
     *   mpegts.js FLV → MSE   开始到画面动起来中位 1.0 秒（741–1050ms），之后 15 秒里 4 个直播间 3 个一次没停（默认配置；「低延迟」那套
     *                         中位 0.75 秒，但 4 个里 3 个停了 0.4–0.6 秒）。电视的 MSE 认 hvc1 / hev1，画面 1080p。
     * 每个直播间新建一个播放器（它自己的 MediaSource）：和点播的 Mse 管线共用这一个 <video>，换过去之前先把另一边拆掉。 */
    var flvP = null, flvTicks = 0, flvTimer = 0, flvItem = null, flvFailed = -1;
    /* 从点播进直播间先等这么久再动管线：连按左右键「路过」直播（精选 ↔ 推荐之间要经过它）的时候什么都不拆。2026-10-22 电视上自测连按三下
     * 右键（精选 → 直播 → 关注 → 推荐），点播管线被拆掉、直播的建起来又拆掉、点播的冷启动再从中间 seek —— 那一下 seek 卡了 12 秒，
     * 被看门狗跳过。路过不拆，回到推荐就是原地接着放。直播间之间换台（已经是 flv）不等。等的这段 pendingLive：管线还是点播的，
     * 它的事件、暂停键都不往直播间身上算。 */
    var FLV_DELAY = 350, pendingLive = false;
    function stopFlv() {
        if (!flvP) { return; }
        var p = flvP;
        flvP = null;
        try { p.pause(); } catch (e) {}
        try { p.unload(); } catch (e) {}
        try { p.detachMediaElement(); } catch (e) {}
        try { p.destroy(); } catch (e) {}
    }
    /* 一个直播间只报一次错：mpegts 的网络错和媒体错、元素自己的 error 可能前后脚都来，报两次 app 就连跳两个台。 */
    function failFlv(why) {
        if (engine !== "flv" || !flvItem || flvFailed === gen) { return; }
        flvFailed = gen;
        Log.report("直播", "放不了：" + why + " | " + flvItem.room + " " + flvItem.flv.split("?")[0].split("/").slice(2, 3)[0]);
        stopFlv();
        if (handlers.error) { handlers.error("直播：" + why); }
    }
    function playFlv(it) {
        pendingLive = false;
        if (engine === "mse") { Mse.detach(); mseE = null; }
        else if (engine === "src") { try { el.pause(); } catch (e) {} el.removeAttribute("src"); try { el.load(); } catch (e) {} }
        stopFlv();
        engine = "flv";
        place(null);
        usedWarm = "无";
        var lib, g = gen;
        try { lib = MpegtsLib.get(); } catch (e) {
            Log.report("直播", "mpegts.js 起不来（" + e.message + "），退回 <video> 直接放 m3u8");
            playSrc(it, 0);
            return;
        }
        flvItem = it;
        try {
            flvP = lib.createPlayer({type: "flv", isLive: true, url: it.flv}, {enableWorker: false});
            flvP.on(lib.Events.ERROR, function (type, detail, info) { if (g === gen) { failFlv("mpegts " + type + " " + detail + " " + (info && info.msg || "")); } });
            /* 看门狗看「字节还在不在来」。统计信息是定时器每 600ms 发的、不管有没有收到字节，只有 speed（最近一秒 KB/s）> 0 才算进展 ——
             * 只数事件的话，CDN 连接吊住、画面冻着，看门狗也永远不报。 */
            flvP.on(lib.Events.STATISTICS_INFO, function (st) { if (g === gen && st && st.speed > 0) { flvTicks++; } });
            flvP.attachMediaElement(el);
            flvP.load();
            if (!paused) {                       // 等的那 350ms 里按了暂停
                var p = flvP.play();
                if (p && p.catch) { p.catch(function () {}); }
            }
        } catch (e) {
            Log.report("直播", "mpegts 抛异常 " + e.message + "，退回 <video> 直接放 m3u8");
            stopFlv();
            playSrc(it, 0);
        }
    }

    function start(url) {
        el.src = url;
        el.preload = "auto";
        var g = gen;
        var p = el.play();
        if (p && p.catch) {
            p.catch(function (e) { if (isLive(g) && e.name !== "AbortError") { Log.report("播放", "play() 被拒 " + e.name + " " + e.message); } });
        }
    }

    /* 直播间在 "flv" 放法里放（playFlv）。没有 FLV 地址才退回 <video> 直接放 m3u8 —— 电视上 playing 之后要停 5–10 秒才走，可跳范围是空的、
     * 往回退做不了（2026-10-22 --live，那段实验代码删了）。元数据那一刻把可跳范围、缓冲、播放头报进「直播」那行。 */
    var liveWait = 0, liveStalls = [];
    function fmtRanges(r) {
        var out = [];
        try { for (var i = 0; i < r.length; i++) { out.push(r.start(i).toFixed(1) + "–" + r.end(i).toFixed(1)); } } catch (e) {}
        return out.join(" ") || "空";
    }
    function liveStart() {
        Log.report("直播", "元数据（<video>·m3u8）" + (Date.now() - switchAt) + "ms：可跳 " + fmtRanges(el.seekable) + "，缓冲 " + fmtRanges(el.buffered) +
                   "，播放头 " + el.currentTime.toFixed(1) + " | " + (item ? item.room : ""));
    }
    function wire() {
        el.addEventListener("loadedmetadata", function () {
            if (engine !== "src") { return; }
            if (item && item.live) { liveStart(); return; }
            if (pendingSeek && el.duration && pendingSeek < el.duration - 3) { el.currentTime = pendingSeek; }
            pendingSeek = 0;
        });
        /* 直播放着放着停住（等下一片）：每次多久、停的时候前方缓冲多少，攒着，换走时报一行。 */
        el.addEventListener("waiting", function () { if (item && item.live && told && !liveWait) { liveWait = Date.now(); } });
        el.addEventListener("playing", function () {
            if (liveWait) { liveStalls.push(Date.now() - liveWait); liveWait = 0; }
        });
        ["loadedmetadata", "loadeddata", "canplay", "seeked"].forEach(function (name) {
            el.addEventListener(name, function () { if (!told && !marks[name]) { marks[name] = Date.now() - switchAt; } });
        });
        el.addEventListener("playing", function () { shown(); });
        el.addEventListener("progress", function () { srcProgress++; });
    }

    /* 这一条出画面了（playing，或 MSE 下播放头已经在新槽里走起来）。 */
    function shown() {
        if (told || !item) { return; }
        if (engine === "mse") {
            /* seek 还没发出去（现取中），或者播放头还不在这一条的槽里：不是这一条的 playing。
             * 判「发没发」要看 marks.ready 有没有记过，不能看真假：回到同一条（Player.stop 只暂停了）不用 seek，管线当场就好，
             * 记下的是 0ms —— !marks.ready 当成没发，这一条永远不算出画面、封面一直盖着（2026-10-18 桌面测试台从选集退回来撞上的；
             * 电视上慢，那一下常常过了 1ms，所以设备自测没撞上）。 */
            if (!mseE || marks.ready === undefined || el.currentTime < mseE.base - 0.5 || el.currentTime >= mseE.base + Mse.SLOT) { return; }
        }
        told = true;
        var detail = engine === "mse" ? "MSE 槽" + mseE.slot + "，seek 发出 " + marks.ready + " seeked " + (marks.seeked || "?") :
                     "元数据 " + (marks.loadedmetadata || "?") + " 首帧数据 " + (marks.loadeddata || "?") + " 可播 " + (marks.canplay || "?");
        var dims = engine === "mse" ? mseE.vw + "x" + mseE.vh : el.videoWidth + "x" + el.videoHeight;
        Log.report("到画面", (Date.now() - switchAt) + "ms（" + detail + "）" + (playNote ? playNote + " " : "") + "预热=" + usedWarm +
                   (fellBack ? "（最终地址失败，退回跳转接口）" : "") + " " + dims + " | " + Diag.priv(item.author || "") + " " + Diag.priv(item.desc.slice(0, 16)));
        if (handlers.playing) { handlers.playing(item); }
        /* playing 不等于画面已经上屏：撤封面要等解码器真的在出帧。**requestVideoFrameCallback
         * 在这台电视上从不回调**（2026-09-29 设备实测：21 次全是 1 秒兜底 —— 视频走硬件视频层，
         * 不经过网页的合成器）。能用的信号是播放头真的往前走了：playing 时的 currentTime 之后
         * 再前进一帧多（0.04 秒）。兜底 0.8 秒。晚了多少报进「封面」那行。
         * 每 20ms 自己看一次，不只靠 timeupdate：它 ~250ms 才来一次，之前「比 playing 晚」的 ~250ms 里
         * 大半是在等这个事件（2026-09-30）。 */
        var g = gen, tp = Date.now(), t0 = el.currentTime, done = false, poll = 0;
        var fire = function (how) {
            if (done || g !== gen) { clearInterval(poll); return; }
            done = true;
            clearInterval(poll);
            el.removeEventListener("timeupdate", onTick);
            if (handlers.firstframe) { handlers.firstframe(how, Date.now() - tp); }
        };
        var onTick = function () { if (el.currentTime > t0 + 0.04) { fire("播放头走了（+" + (el.currentTime - t0).toFixed(3) + "s）"); } };
        poll = setInterval(onTick, 20);
        el.addEventListener("timeupdate", onTick);
        setTimeout(function () { fire("播放头 0.8 秒没走，兜底"); }, 800);
    }

    function wireRest() {
        /* 直播间主播下播：mpegts 读完流、MSE endOfStream，元素 ended —— 和 src 一样交给 app 换下一个。 */
        el.addEventListener("ended", function () { if (item && (engine === "src" || engine === "flv") && !pendingLive && handlers.ended) { handlers.ended(); } });
        el.addEventListener("error", function () {
            if (!item || pendingLive) { return; }        // 拆除时空 src 的回声；等着进直播间时是点播管线的事
            if (engine === "mse") { mseFatal("元素报错 " + (el.error ? el.error.code + " " + el.error.message : "?")); return; }
            /* 直播：元素的 src 是 mpegts 的 blob: 地址，不能走下面「最终地址失败、退回跳转接口」那条（会在 FLV 播放器还挂着时把 m3u8 塞给元素）。 */
            if (engine === "flv") { failFlv("元素报错 " + (el.error ? el.error.code + " " + el.error.message : "?")); return; }
            var code = el.error ? el.error.code : 0;
            /* 用的是预热拿到的最终地址、而且还没出过画面：可能是签名过期，退回跳转接口一次。 */
            if (!told && !fellBack && el.src.indexOf("/aweme/v1/play/") < 0) {
                fellBack = true;
                Log.report("播放", "最终地址失败 code=" + code + "，退回跳转接口 | " + Diag.priv(item.desc.slice(0, 16)));
                start(item.url);
                return;
            }
            if (handlers.error) { handlers.error("video error " + code); }
        });
        el.addEventListener("timeupdate", function () {
            if (item && handlers.progress) { handlers.progress(rel(), relDur()); }
        });
    }

    /* MSE 管线坏了（SourceBuffer 报错、元素报错）：拆掉重建，从这一条的当前位置接着放。一次会话坏到
     * 第 3 次就整场改走 src —— 别让一个坏掉的管线每条都重建一遍。 */
    function mseFatal(why) {
        var it = item, t = told ? rel() : 0, note = playNote;
        Mse.detach();
        mseE = null;
        engine = "";
        if (!it) { return; }
        mseFails++;
        if (mseFails >= 3) { mseOff = why; }
        Log.report("播放", "MSE 管线坏了（" + why + "），第 " + mseFails + " 次，" + (mseOff ? "这次会话改走 src" : "重建后接着放") + " | " + Diag.priv(it.desc.slice(0, 16)));
        play(it, note + "·重建", t);
    }

    function playSrc(it, startAt) {
        if (engine === "mse") { Mse.detach(); mseE = null; }
        stopFlv();
        engine = "src";
        place(null);
        pendingSeek = startAt > 1 ? startAt : 0;
        /* 整段下载的只留这一条：其余的 blob 立刻放掉（每条几 MB 到几十 MB）。回头看上一条时
         * 它会走普通地址。 */
        for (var id in warm) {
            if (warm.hasOwnProperty(id) && id !== it.id && warm[id].blob) {
                try { URL.revokeObjectURL(warm[id].url); } catch (e) {}
                delete warm[id];
            }
        }
        var w = warm[it.id];
        if (w && w.state === "好了") {
            usedWarm = (w.mode === "blob" ? "整段" : "开头") + "·好了（" + (w.bytes / 1048576).toFixed(1) + "MB，" +
                       Math.round((switchAt - w.at) / 1000) + " 秒前备好，用时 " + w.ms + "ms" + (w.moovNote ? "，" + w.moovNote : "") + "）";
            start(w.url);
        } else {
            usedWarm = w ? (w.mode === "blob" ? "整段" : "开头") + "·" + w.state : "无";
            start(it.url);
        }
    }

    function playMse(it, startAt) {
        if (engine === "flv") { stopFlv(); el.removeAttribute("src"); try { el.load(); } catch (e) {} }
        if (engine === "src") {
            try { el.pause(); } catch (e) {}
            el.removeAttribute("src");
            try { el.load(); } catch (e) {}
        }
        engine = "mse";
        usedWarm = Mse.status(it) || "无";
        var g = gen;
        Mse.show(it, startAt).then(function (r) {
            if (g !== gen || !r) { return; }
            mseE = r.e;
            marks.ready = Date.now() - switchAt;
            place(r.e);
            /* playing 事件是主信号；万一没来（元素一直没停过），播放头在新槽里走起来也算。 */
            var tick = function () {
                if (g !== gen || told) { return; }
                if (!el.paused && el.currentTime > r.target + 0.03) { shown(); }
                if (Date.now() - switchAt < 15000) { setTimeout(tick, 30); }
            };
            tick();
        }, function (err) {
            if (g !== gen) { return; }
            if (err.unusable) {
                Log.report("播放", "这条改走 src（" + err.message + "）| " + Diag.priv(it.desc.slice(0, 16)));
                playSrc(it, startAt);
                return;
            }
            Log.report("播放", "MSE 备不好这条：" + err.message + " | " + Diag.priv(it.desc.slice(0, 16)));
            if (handlers.error) { handlers.error("MSE：" + err.message); }
        });
    }

    function play(it, note, startAt) {
        if (item && item.live && told) {
            Log.report("直播", "离开 " + item.room + "：看了 " + Math.round((Date.now() - switchAt) / 1000) + " 秒，中途停了 " + liveStalls.length + " 次" +
                       (liveStalls.length ? "（" + liveStalls.join("/") + "ms）" : "") + "（" + (engine === "flv" ? "mpegts·FLV" : "<video>·m3u8") + "）");
        }
        liveWait = 0;
        liveStalls = [];
        gen++;
        playNote = note || "";
        item = it;
        switchAt = Date.now();
        marks = {};
        told = false;
        fellBack = false;
        paused = false;
        lastTime = -1;
        lastBytes = -1;
        srcProgress = 0;
        stuckSince = Date.now();
        clearTimeout(flvTimer);
        pendingLive = false;
        if (it.live && it.flv && engine === "mse") {
            try { el.pause(); } catch (e) {}
            pendingLive = true;
            var g = gen;
            flvTimer = setTimeout(function () { if (g === gen) { playFlv(it); } }, FLV_DELAY);
        } else if (it.live && it.flv) { playFlv(it); } else if (useMse(it)) { playMse(it, startAt); } else { playSrc(it, startAt); }
    }

    /* 播放头前面还有几秒缓冲（MSE 下只算这一条的槽里、播放头所在的那一段）。 */
    function ahead() {
        try {
            if (engine === "mse") { return Mse.aheadEnd() - el.currentTime; }
            for (var i = 0; i < el.buffered.length; i++) {
                if (el.buffered.start(i) <= el.currentTime && el.currentTime <= el.buffered.end(i)) { return el.buffered.end(i) - el.currentTime; }
            }
        } catch (e) {}
        return 0;
    }

    /* 卡死看门狗：心跳驱动，不靠 waiting 事件 —— bilibili 那边两次栽在「事件只发一次、
     * 正好被吞」上。播放头 12 秒不动且没暂停，就当这一条放不了。
     * **在等数据、字节还在来，不算卡**（2026-09-30）：作者主页里一条视频 12 秒没出画面被跳过 —— 第一段请求还在途。那一分钟
     * 网络整体慢（同一分钟推荐流一次 6.2 秒，平时 1.5–2.8）。还没出画面、或者前方缓冲不到 2 秒时，这一条收到了新字节就算有进展；
     * 字节也停了 STALL_MS 才算卡。解码器卡死（字节都在、前方缓冲几十秒、readyState=1）照旧 12 秒判掉：那时不在等数据。
     * 另设上限：切过来 FIRST_CAP 还没出画面就放弃，别让一条永远转圈。 */
    setInterval(function () {
        if (!item || paused) { stuckSince = 0; return; }
        if (engine === "flv" && flvFailed === gen) { return; }       // 这个直播间已经报过错了（failFlv），别再报一次
        if (el.currentTime !== lastTime) { lastTime = el.currentTime; stuckSince = Date.now(); return; }
        var waiting = !told || ahead() < 2;
        var bytes = !waiting ? -1 : engine === "flv" ? flvTicks : engine === "mse" || useMse(item) ? Mse.fetched(item) : srcProgress;
        if (waiting && bytes !== lastBytes) { lastBytes = bytes; stuckSince = Date.now(); }
        if (!stuckSince) { stuckSince = Date.now(); return; }
        var capped = !told && Date.now() - switchAt > FIRST_CAP;
        if (Date.now() - stuckSince > STALL_MS || capped) {
            stuckSince = 0;
            var why = capped ? "切过来 " + Math.round(FIRST_CAP / 1000) + " 秒还没出画面" : Math.round(STALL_MS / 1000) + " 秒没进展" + (waiting ? "（字节也停了）" : "");
            Log.report("卡住", why + " t=" + el.currentTime.toFixed(1) + " readyState=" + el.readyState +
                       " 前方缓冲=" + ahead().toFixed(1) + "s networkState=" + el.networkState + (useMse(item) ? " | " + Mse.pending(item) : ""));
            if (handlers.error) { handlers.error(capped ? "太慢" : "卡住"); }
        }
    }, 1000);

    return {
        init: function (video) {
            el = video;
            wire();
            wireRest();
            Mse.init(video);
            Mse.on("ended", function () { if (item && engine === "mse" && !pendingLive && handlers.ended) { handlers.ended(); } });
            Mse.on("error", function (why) { if (item && engine === "mse" && !pendingLive && handlers.error) { handlers.error(why); } });
            Mse.on("fatal", function (why) { if (engine === "mse" && !pendingLive) { mseFatal(why); } });
        },
        on: function (name, fn) { handlers[name] = fn; },

        play: play,
        /* 这一条会不会走 MSE（app 按它选切换动画）。 */
        mseFor: function (it) { return useMse(it); },
        /* 这一条软解好的第一帧（MSE 预热时解的，见 mse.js 的 decodeFirst）：{canvas, ms} 或 {canvas: null, why}。 */
        frameOf: function (it) { return useMse(it) ? Mse.frameOf(it) : {canvas: null, why: "不走 MSE"}; },

        /* 预热下一条。不创建任何媒体元素（第二个媒体元素会抢走唯一的解码器，见文件顶部）。
         *   "range"：走 302 拿最终地址 + 取开头 WARM_BYTES —— 焐热 CDN 边缘、省掉起播那一跳。
         *            MOOV_TOPUP 开着时，moov 比这长就对最终地址补取到 moov 末尾 + WARM_AFTER_MOOV（默认关，见上）。
         *   "blob" ：整段下进内存，起播直接放 blob: 地址，一个字节都不走网络。超过 BLOB_MAX 放弃，
         *            退回 range 的效果（起播用跳转接口）。
         * 两种哪个更快是 2026-09-29 的实验，自测构建里轮换比较，见 app.js 的 schedulePreload。 */
        preload: function (it, mode) {
            if (!it || it.live) { return; }        // 直播没有「开头」可焐；第二个媒体元素又不许有
            /* MSE：预热 = 取开头、转封装、append 进它的槽，切过去只剩一次 seek。只在 MSE 管线已经在用时
             * 做 —— src 放着的时候去建 MediaSource 会把元素抢走。 */
            if (engine === "mse" && useMse(it)) { Mse.prepare(it).catch(function () {}); return; }
            if (warm[it.id]) { return; }
            mode = mode || "range";
            var w = warm[it.id] = {state: "在途", at: 0, mode: mode};
            var t0 = Date.now();
            var x = new XMLHttpRequest();
            x.open("GET", it.url);
            x.timeout = mode === "blob" ? 60000 : 15000;
            if (mode === "blob") {
                x.responseType = "blob";
                x.onprogress = function (e) {
                    if (e.lengthComputable && e.total > BLOB_MAX) {
                        w.state = "太大（" + (e.total / 1048576).toFixed(0) + "MB）";
                        x.abort();
                    }
                };
            } else {
                x.responseType = "arraybuffer";
                x.setRequestHeader("Range", "bytes=0-" + (WARM_BYTES - 1));
            }
            var done = function () { w.state = "好了"; w.ms = Date.now() - t0; w.at = Date.now(); };
            x.onload = function () {
                if ((x.status === 206 || x.status === 200) && x.responseURL && x.responseURL.indexOf("/aweme/v1/play/") < 0) {
                    if (mode === "blob") {
                        w.bytes = x.response.size;
                        w.url = URL.createObjectURL(x.response);
                        w.blob = true;
                        done();
                        return;
                    }
                    w.bytes = x.response ? x.response.byteLength : 0;
                    w.url = x.responseURL;
                    var m = x.response ? findMoov(x.response) : undefined;
                    if (m === null) { w.moovNote = "moov 不在开头"; done(); return; }
                    if (!m) { done(); return; }
                    var want = m.end + WARM_AFTER_MOOV;
                    /* 对照组按视频 id 的奇偶分，不按预热次数轮换：每次切换正好发一次新预热，按次数轮换就和
                     * 逐条轮换的切换方式锁在一起 —— 2026-09-30 第一轮 --ab 就是这样，cover 全是补取、early
                     * 全是不补，两个实验分不开。 */
                    var topup = want > w.bytes && (moovAB ? parseInt(String(it.id).slice(-1), 10) % 2 === 0 : MOOV_TOPUP);
                    w.moovNote = "moov " + mb(m.end - m.start) + (want <= w.bytes ? "" : topup ? "，补取" : moovAB ? "，不补（对照）" : "");
                    if (!topup) { done(); return; }
                    /* 补取：直接问 CDN 上的最终地址，不再走那一跳。失败了也算「好了」—— 第一段已经到手。 */
                    var y = new XMLHttpRequest();
                    y.open("GET", w.url);
                    y.timeout = 15000;
                    y.responseType = "arraybuffer";
                    y.setRequestHeader("Range", "bytes=" + w.bytes + "-" + (want - 1));
                    y.onload = function () {
                        if (y.status === 206 && y.response) { w.moovNote += " " + mb(y.response.byteLength); w.bytes += y.response.byteLength; }
                        else { w.moovNote += "失败（HTTP " + y.status + "）"; }
                        done();
                    };
                    y.onerror = y.ontimeout = function () { w.moovNote += "失败（连接）"; done(); };
                    y.send();
                } else {
                    w.state = "失败（HTTP " + x.status + "）";
                    Log.report("预热", "失败 HTTP " + x.status + " | " + Diag.priv(it.desc.slice(0, 16)));
                }
            };
            x.onerror = x.ontimeout = function () { if (w.state === "在途") { w.state = "失败（连接）"; } };
            x.send();
        },

        toggle: function () {
            if (!item) { return paused; }
            /* 等着进直播间：元素上还是点播那条，el.play() 会把它在封面底下接着放。只记下来，playFlv 照着办。 */
            if (pendingLive) { paused = !paused; return paused; }
            /* play() 还没落定就被 pause() 抢先（再按一下、离开视频页、换下一条）是 AbortError，不是出了事；没人接它就是
             * 「未处理的 Promise 异常」、当出事上传（2026-10-23 一台电视快进着按暂停，一上午传了三次）。别的拒绝说一句。 */
            if (el.paused) {
                var p = el.play();
                if (p && p.catch) { p.catch(function (e) { if (e.name !== "AbortError") { Log.report("播放", "继续播放被拒 " + e.name + " " + e.message); } }); }
                paused = false;
            } else { el.pause(); paused = true; }
            return paused;
        },
        seek: function (delta) {
            if (!item) { return; }
            if (engine === "mse") { if (mseE) { Mse.seekTo(rel() + delta); } return; }
            if (!el.duration) { return; }
            el.currentTime = Math.max(0, Math.min(el.duration - 0.5, el.currentTime + delta));
        },
        /* 离开视频页（「我」、登录、空页）。MSE 下只暂停、管线留着：回到同一条直接接着放（不 seek），换一条
         * 也不用冷启动 —— 拆掉的那一版每次从「我」回来都要 ~2.5 秒（冷启动 + 从中间 seek）。那几个页面是
         * 不透明的整屏面板，停着的画面盖得住。release=true 才真拆（msespike 要独占解码器）。 */
        stop: function (release) {
            gen++;
            item = null;
            clearTimeout(flvTimer);
            pendingLive = false;
            if (engine === "mse" && !release) { try { el.pause(); } catch (e) {} return; }
            if (engine === "mse") { Mse.detach(); }
            stopFlv();                 // 直播不留着：暂停了它也一直在下（去「我」、网格页的时候）
            engine = "";
            mseE = null;
            place(null);
            try { el.pause(); } catch (e) {}
            el.removeAttribute("src");
            try { el.load(); } catch (e) {}
        },
        isPaused: function () { return paused; },
        /* 自测 --ab：预热的 moov 补取和不补取轮换。 */
        setMoovAB: function (on) { moovAB = !!on; },
        /* 给自测读的快照，不改任何状态。 */
        /* 时间、时长、尺寸都是这一条自己的：MSE 下 currentTime 带槽的偏移，videoWidth/Height 停在第一条。 */
        state: function () {
            var m = engine === "mse" && mseE;
            return { id: item ? item.id : "", t: rel(), vw: m ? mseE.vw : el.videoWidth, vh: m ? mseE.vh : el.videoHeight,
                     net: el.networkState, err: el.error ? el.error.code : 0,
                     src: m ? "mse:槽" + mseE.slot : String(el.currentSrc || el.src || "").slice(0, 40),
                     elPaused: el.paused, buffered: m ? Mse.aheadEnd() - mseE.base : (el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0),
                     dur: relDur(), readyState: el.readyState, engine: engine,
                     paused: el.paused, shown: told, sinceSwitch: Date.now() - switchAt,
                     meta: marks.loadedmetadata || 0, warm: usedWarm,
                     box: boxAt >= switchAt ? Date.now() - boxAt : -1 };   // 这次切换改了框的话，改了多久
        }
    };
})();
