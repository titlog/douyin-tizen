/* 一个 <video>，外加一个不碰解码器的预热。
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
    var el = null;
    var gen = 0;
    var handlers = {};
    var item = null;
    var switchAt = 0, told = true, usedWarm = "", fellBack = false;
    var marks = {};            // 这一次切换里各事件第一次出现的时刻（相对 switchAt）
    var playNote = "";         // 调用方附在「到画面」那行里的说明
    var pendingSeek = 0;       // 元数据到了再跳：切回标签时接着看
    var lastTime = -1, stuckSince = 0;
    var paused = false;
    var warm = {};             // item.id → {state: "在途"|"好了"|"失败", url, ms, bytes}

    function isLive(g) { return g === gen; }

    function start(url) {
        el.src = url;
        el.preload = "auto";
        var g = gen;
        var p = el.play();
        if (p && p.catch) {
            p.catch(function (e) { if (isLive(g) && e.name !== "AbortError") { Log.report("播放", "play() 被拒 " + e.name + " " + e.message); } });
        }
    }

    function wire() {
        el.addEventListener("loadedmetadata", function () {
            if (pendingSeek && el.duration && pendingSeek < el.duration - 3) { el.currentTime = pendingSeek; }
            pendingSeek = 0;
        });
        ["loadedmetadata", "loadeddata", "canplay"].forEach(function (name) {
            el.addEventListener(name, function () { if (!told && !marks[name]) { marks[name] = Date.now() - switchAt; } });
        });
        el.addEventListener("playing", function () {
            if (told) { return; }
            told = true;
            Log.report("到画面", (Date.now() - switchAt) + "ms（元数据 " + (marks.loadedmetadata || "?") + " 首帧数据 " + (marks.loadeddata || "?") +
                       " 可播 " + (marks.canplay || "?") + "）" + (playNote ? playNote + " " : "") + "预热=" + usedWarm + (fellBack ? "（最终地址失败，退回跳转接口）" : "") +
                       " " + el.videoWidth + "x" + el.videoHeight + " | " + (item.author || "") + " " + item.desc.slice(0, 16));
            if (handlers.playing) { handlers.playing(item); }
        });
        el.addEventListener("ended", function () { if (item && handlers.ended) { handlers.ended(); } });
        el.addEventListener("error", function () {
            if (!item) { return; }                       // 拆除时空 src 的回声
            var code = el.error ? el.error.code : 0;
            /* 用的是预热拿到的最终地址、而且还没出过画面：可能是签名过期，退回跳转接口一次。 */
            if (!told && !fellBack && el.src.indexOf("/aweme/v1/play/") < 0) {
                fellBack = true;
                Log.report("播放", "最终地址失败 code=" + code + "，退回跳转接口 | " + item.desc.slice(0, 16));
                start(item.url);
                return;
            }
            if (handlers.error) { handlers.error("video error " + code); }
        });
        el.addEventListener("timeupdate", function () {
            if (item && handlers.progress) { handlers.progress(el.currentTime, el.duration || 0); }
        });
    }

    /* 卡死看门狗：心跳驱动，不靠 waiting 事件 —— bilibili 那边两次栽在「事件只发一次、
     * 正好被吞」上。播放头 12 秒不动且没暂停，就当这一条放不了。 */
    setInterval(function () {
        if (!item || paused) { stuckSince = 0; return; }
        if (el.currentTime !== lastTime) { lastTime = el.currentTime; stuckSince = Date.now(); return; }
        if (!stuckSince) { stuckSince = Date.now(); return; }
        if (Date.now() - stuckSince > 12000) {
            stuckSince = 0;
            var ahead = 0;
            try { ahead = el.buffered.length ? el.buffered.end(el.buffered.length - 1) - el.currentTime : 0; } catch (e) {}
            Log.report("卡住", "12 秒没进展 t=" + el.currentTime.toFixed(1) + " readyState=" + el.readyState +
                       " 前方缓冲=" + ahead.toFixed(1) + "s networkState=" + el.networkState);
            if (handlers.error) { handlers.error("卡住 12 秒"); }
        }
    }, 1000);

    return {
        init: function (video) { el = video; wire(); },
        on: function (name, fn) { handlers[name] = fn; },

        play: function (it, note, startAt) {
            gen++;
            playNote = note || "";
            pendingSeek = startAt > 1 ? startAt : 0;
            item = it;
            switchAt = Date.now();
            marks = {};
            told = false;
            fellBack = false;
            paused = false;
            lastTime = -1;
            stuckSince = Date.now();
            var w = warm[it.id];
            if (w && w.state === "好了") {
                usedWarm = "好了（" + Math.round((switchAt - w.at) / 1000) + " 秒前备好，用时 " + w.ms + "ms）";
                start(w.url);
            } else {
                usedWarm = w ? w.state : "无";
                start(it.url);
            }
        },

        /* 预热下一条：走 302 拿最终地址 + 取开头 WARM_BYTES。不创建任何媒体元素。 */
        preload: function (it) {
            if (!it || warm[it.id]) { return; }
            var w = warm[it.id] = {state: "在途", at: 0};
            var t0 = Date.now();
            var x = new XMLHttpRequest();
            x.open("GET", it.url);
            x.responseType = "arraybuffer";
            x.setRequestHeader("Range", "bytes=0-" + (WARM_BYTES - 1));
            x.timeout = 15000;
            x.onload = function () {
                if ((x.status === 206 || x.status === 200) && x.responseURL && x.responseURL.indexOf("/aweme/v1/play/") < 0) {
                    w.state = "好了"; w.url = x.responseURL; w.ms = Date.now() - t0; w.at = Date.now();
                    w.bytes = x.response ? x.response.byteLength : 0;
                } else {
                    w.state = "失败（HTTP " + x.status + "）";
                    Log.report("预热", "失败 HTTP " + x.status + " | " + it.desc.slice(0, 16));
                }
            };
            x.onerror = x.ontimeout = function () { w.state = "失败（连接）"; };
            x.send();
        },

        toggle: function () {
            if (!item) { return paused; }
            if (el.paused) { el.play(); paused = false; } else { el.pause(); paused = true; }
            return paused;
        },
        seek: function (delta) {
            if (!item || !el.duration) { return; }
            el.currentTime = Math.max(0, Math.min(el.duration - 0.5, el.currentTime + delta));
        },
        stop: function () {
            gen++;
            item = null;
            try { el.pause(); } catch (e) {}
            el.removeAttribute("src");
            try { el.load(); } catch (e) {}
        },
        isPaused: function () { return paused; },
        /* 给自测读的快照，不改任何状态。 */
        state: function () {
            return { id: item ? item.id : "", t: el.currentTime, dur: el.duration || 0, readyState: el.readyState,
                     paused: el.paused, shown: told, sinceSwitch: Date.now() - switchAt };
        }
    };
})();
