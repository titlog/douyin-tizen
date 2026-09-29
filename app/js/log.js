/* 诊断上报。零售机上 dlog 是关的，应用自己把日志 POST 到开发机的 tools/collect.mjs。
 * 令牌桶限速（突发 20 行、之后每秒 1 行）—— 从 bilibili 那边抄来的护栏：任何循环类
 * bug 都不该有能力把日志和网络一起刷爆。 */
var Log = (function () {
    "use strict";

    var tokens = 20, refillAt = 0, dropped = 0, misses = 0, sleepUntil = 0;

    function report(kind, msg) {
        var line = kind + ": " + msg;
        if (typeof console !== "undefined") { try { console.log(line); } catch (e) {} }
        if (!REPORT_TO) { return; }
        var now = Date.now();
        /* 连撞五次就睡五分钟，而不是永久关闭 —— bilibili 那边 08-12 付过学费：电视唤醒时
         * 网络晚几秒，五次全撞在缝里，之后整晚一个字都不上报。 */
        if (misses >= 5) {
            if (!sleepUntil) { sleepUntil = now + 300000; return; }
            if (now < sleepUntil) { return; }
            sleepUntil = 0;
            misses = 4;
        }
        if (refillAt) { tokens = Math.min(20, tokens + (now - refillAt) / 1000); }
        refillAt = now;
        if (tokens < 1) { dropped++; return; }
        tokens -= 1;
        if (dropped) { line = "（限速丢弃了 " + dropped + " 行）" + line; dropped = 0; }
        try {
            var x = new XMLHttpRequest();
            x.open("POST", REPORT_TO + "/report", true);
            x.setRequestHeader("Content-Type", "text/plain");
            x.timeout = 3000;
            x.onload = function () { misses = 0; };
            x.onerror = x.ontimeout = function () { misses++; };
            x.send(JSON.stringify({event: "log", detail: {msg: line}}));
        } catch (e) {}
    }

    /* CSP 拦截是静默的：图片只显示成一个破图标，脚本没有任何异常。2026-09-29 电视上的二维码
     * 就是这样 —— 地址拿到了、元素可见、自测判「出二维码」PASS，屏幕上是个破图标。 */
    document.addEventListener("securitypolicyviolation", function (e) {
        report("csp", "拦了 " + e.violatedDirective + " ← " + String(e.blockedURI || "").slice(0, 40) + " | 生效的策略：" + String(e.originalPolicy || "").slice(0, 200));
    });

    /* Promise 回调里抛的异常到不了 onerror。2026-09-29 render() 被误删，异常就是在推荐流的 then
     * 里抛出、没人接 —— 第一条视频永远不出画面，日志里一个字都没有。 */
    window.addEventListener("unhandledrejection", function (e) {
        var r = e.reason;
        report("onerror", "未处理的 Promise 异常：" + (r && r.message ? r.message : String(r)) + (r && r.stack ? " | " + String(r.stack).split("\n").slice(1, 3).join(" ").replace(/\s+/g, " ").slice(0, 160) : ""));
    });

    window.onerror = function (m, src, line) {
        report("onerror", m + " @" + String(src || "").split("/").pop() + ":" + line);
    };

    return { report: report };
})();
