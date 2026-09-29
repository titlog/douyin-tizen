/* 扫码登录：让官网自己的登录页替我们登录。
 *
 * 登录接口（login.douyin.com/passport/web/get_qrcode 等）除了 a_bogus 还要登录 SDK 自己算的
 * sign / qs / p_* 和一段服务器下发的 challenge 脚本；不带就回 4031「存在安全风险，已阻止」。
 * 这些都打包在官网主程序里，自己复现不现实。而官网的页面大多不许嵌入（主站 SPA 带
 * X-Frame-Options: DENY + frame-ancestors 白名单；sso.douyin.com/login/ 已弃用，无条件跳回
 * 主站）。**唯一能嵌入的是 www.douyin.com/login_page**（2026-09-29 模拟电视实测：没有 XFO，
 * 框里的官网代码自己调 get_qrcode 成功，二维码是一张 data: PNG）。
 *
 * 所以：隐藏框开 login_page，service 指向 robots.txt —— 扫码确认后它跳到 service，而主站
 * 页面会被拦，robots.txt 不会。我们只把框里的二维码图片搬到电视上放大，读面板文字告诉
 * 观众进展。出码、签名、轮询、种会话 cookie 全是官网自己的代码做的。
 * 框用 sandbox 挡住它改顶层页面（官网页面在框里可能想把整个 App 跳走）。
 */
var Login = (function () {
    "use strict";

    var SERVICE = "https://www.douyin.com/robots.txt";
    var URL_ = "https://www.douyin.com/login_page?service=" + encodeURIComponent(SERVICE);

    var frame = null;
    var timer = 0;
    var cb = null;
    var lastQr = "", lastText = "", lastBody = "", t0 = 0, refreshedAt = 0, done = false;
    var panel = null;          // 二维码往上四层的容器：状态提示（已扫码、已失效）出现在这里

    function stop() {
        clearInterval(timer);
        timer = 0;
        if (frame && frame.parentNode) { frame.parentNode.removeChild(frame); }
        frame = null;
    }

    function tick() {
        var d, href;
        try { d = frame.contentDocument; href = frame.contentWindow.location.href; } catch (e) {
            cb({phase: "error", msg: "登录页不可访问（" + e.name + "）"});
            stop();
            return;
        }
        if (!d) { return; }
        /* 确认之后官网把框跳到 service。到了 robots.txt 就说明会话 cookie 已经种下了。 */
        if (href.indexOf("/robots.txt") >= 0) {
            if (!done) {
                done = true;
                Log.report("login", "框落到 robots.txt，用时 " + Math.round((Date.now() - t0) / 1000) + " 秒");
                stop();
                cb({phase: "done"});
            }
            return;
        }
        if (href.indexOf("chrome-error") === 0 || href === "about:blank" && Date.now() - t0 > 15000) {
            Log.report("login", "登录页落到 " + href.slice(0, 40) + "，重开");
            open();
            return;
        }
        var imgs = d.querySelectorAll("img[src^=\"data:image\"]");
        var qr = null;
        for (var i = 0; i < imgs.length; i++) {
            var r = imgs[i].getBoundingClientRect();
            if (r.width >= 100 && Math.abs(r.width - r.height) < 10) { qr = imgs[i]; }
        }
        if (qr && qr.src !== lastQr) {
            lastQr = qr.src;
            Log.report("login", "二维码到了（" + Math.round((Date.now() - t0) / 1000) + " 秒）");
            cb({phase: "qr", src: qr.src});
        }
        if (qr) { panel = qr; for (var k = 0; k < 4 && panel.parentElement; k++) { panel = panel.parentElement; } }
        /* 整页正文只记日志 —— 里面本来就有「验证码登录」「获取验证码」，拿它匹配「验证」会误报。 */
        var body = d.body ? d.body.innerText.replace(/\s+/g, " ") : "";
        if (body !== lastBody) {
            lastBody = body;
            Log.report("login", "整页文字：" + body.slice(0, 140));
            /* 新设备验证这类我们处理不了的，原样给观众看，让他们在手机上照做。 */
            if (/身份验证|安全验证|验证身份/.test(body)) { cb({phase: "status", msg: body.slice(0, 60)}); }
        }
        var text = panel && panel.isConnected !== false ? panel.innerText.replace(/\s+/g, " ") : "";
        if (text !== lastText) {
            lastText = text;
            var msg = "";
            if (/失效|过期|刷新/.test(text)) {
                msg = "二维码过期了，正在换一张…";
                clickRefresh(d);
            } else if (/扫码成功|已扫码|确认/.test(text)) {
                msg = "已扫码，请在手机上点「确认登录」";
            }
            if (msg) { cb({phase: "status", msg: msg}); }
        }
    }

    /* 过期时点框里的「刷新」。找不到就整个重开 —— 但 20 秒内只重开一次，免得循环。 */
    function clickRefresh(d) {
        if (Date.now() - refreshedAt < 20000) { return; }
        refreshedAt = Date.now();
        var all = d.querySelectorAll("*");
        for (var i = all.length - 1; i >= 0; i--) {
            var el = all[i];
            if (el.children.length === 0 && /刷新/.test(el.textContent || "")) {
                try { el.click(); Log.report("login", "点了框里的「刷新」"); return; } catch (e) {}
            }
        }
        Log.report("login", "框里找不到「刷新」，重开登录页");
        open();
    }

    function open() {
        stop();
        lastQr = ""; lastText = ""; lastBody = ""; panel = null; done = false;
        t0 = Date.now();
        frame = document.createElement("iframe");
        frame.className = "login-frame";
        frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
        frame.src = URL_;
        document.body.appendChild(frame);
        timer = setInterval(tick, 800);
    }

    return {
        /* onState({phase: "qr", src} | {phase: "status", msg} | {phase: "done"} | {phase: "error", msg}) */
        start: function (onState) { cb = onState; open(); },
        stop: stop,
        active: function () { return !!frame; }
    };
})();
