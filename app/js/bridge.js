/* 通往抖音接口的唯一一条路。
 *
 * 抖音的 /aweme/v1/web/* 全部要 a_bogus 签名，而且服务器只认「页面真在 www.douyin.com
 * 上、Referer 也是它」的请求（CLAUDE.md 里有逐项剥变量的实测表）。widget 自己是
 * file:///，Referer 伪造不了。出口是：Tizen 的 widget 可以对跨域 iframe 执行脚本
 * （2026-09-29 设备实测）。于是在一个隐藏的框里装 www.douyin.com/robots.txt —— 那里
 * 最轻的一份文档，没有脚本、不会跳转 —— 把官网自己的签名 SDK 以 <script> 注入进去，
 * 之后所有接口都用框自己的 XMLHttpRequest 以相对路径发。签名由官网 SDK 挂钩 XHR 自动
 * 加上，我们不碰签名算法：它改了，SDK 跟着改。
 */
var Bridge = (function () {
    "use strict";

    var D = "https://www.douyin.com";
    var SDKS = [
        "https://lf-security.bytegoofy.com/obj/security-secsdk/runtime_bundler_34_v2.js",
        "https://lf-c-flwb.bytetos.com/obj/rc-client-security/c-webmssdk/1.0.0.20/webmssdk.es5.js",
        "https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/glue/1.0.0.64-fix.01/sdk-glue.js"
    ];
    /* bdms（加 a_bogus 的那个）官网给了三台主机，字节完全相同。只抄第一台的那一版在
     * 2026-09-29 17:45 撞上 p-pc-weboff.byteimg.com 整台超时（开发机上同样超时，不是电视的
     * 事），glue 对它重试两次就放弃，App 起不来。哪台主机是坏的是当天的天气 —— 排序，不丢弃。
     * bytetos 排第一：glue 和 webmssdk 就是从它加载的，能走到这一步它此刻就是活的。 */
    var BDMS = [
        "https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/stable/1.0.1.19-fix.01/bdms.js",
        "https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/stable/1.0.1.19-fix.01/bdms.js",
        "https://p-pc-weboff.byteimg.com/tos-cn-i-9r5gewecjs/bdms_1.0.1.19_fix.js"
    ];
    var CAPTCHA = [
        "https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/sec_sdk_build/4.0.28/captcha/index.js",
        "https://lf-rc2.yhgfb-cn-static.com/obj/rc-verifycenter/sec_sdk_build/4.0.28/captcha/index.js"
    ];
    var PATHS = ["^/webcast/", "^/aweme/v1/", "^/aweme/v2/", "/douplus/", "^/api/ad/v1/inspire",
                 "/v1/message/send", "^/live/", "^/captcha/", "^/ecom/", "^/luna/pc"];

    /* 官网每个请求都带的那一串。签名不校验它们，但一个「只带最少参数」的请求在风控眼里
     * 就是一个脚本 —— 让它长得像一台真实的设备。 */
    var COMMON = {
        device_platform: "webapp", aid: "6383", channel: "channel_pc_web",
        update_version_code: "170400", pc_client_type: "1", version_code: "170400",
        version_name: "17.4.0", cookie_enabled: "true", screen_width: "1920", screen_height: "1080",
        browser_language: "zh-CN", browser_platform: "Linux", browser_name: "Chrome",
        browser_version: "120.0.6099.5", browser_online: "true", engine_name: "Blink",
        engine_version: "120.0.6099.5", os_name: "Linux", os_version: "", cpu_core_num: "4",
        device_memory: "4", platform: "PC", downlink: "10", effective_type: "4g", round_trip_time: "50"
    };

    var frame = null;
    var marks = {};           // 就绪那一行的分段用时
    var readyPromise = null;
    var failures = 0;

    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function withTimeout(p, ms, what) {
        return Promise.race([p, wait(ms).then(function () { throw new Error(what + " 超时"); })]);
    }
    function qs(o) {
        var out = [];
        for (var k in o) { if (o.hasOwnProperty(k)) { out.push(encodeURIComponent(k) + "=" + encodeURIComponent(o[k])); } }
        return out.join("&");
    }

    /* 匿名访客的 ttwid。在 widget 主 realm 里做：主 realm 不受 CORS 约束，而框是真正的
     * 远程页面。注册之后回调在 douyin.com 名下种 cookie（SameSite=None），进引擎的全局
     * jar，框里的请求自然带上。它是不是必要的没单独测过 —— 便宜，照官网访客的样子做。 */
    function ttwid() {
        return withTimeout(new Promise(function (ok) {
            var x = new XMLHttpRequest();
            x.open("POST", "https://ttwid.bytedance.com/ttwid/union/register/");
            x.setRequestHeader("content-type", "application/json");
            x.onload = function () {
                var cb = "";
                try { cb = JSON.parse(x.responseText).redirect_url; } catch (e) {}
                if (!cb) { Log.report("bridge", "ttwid 注册失败 status=" + x.status); ok(); return; }
                var y = new XMLHttpRequest();
                y.open("GET", cb);
                y.withCredentials = true;
                y.onloadend = function () { ok(); };
                y.send();
            };
            x.onerror = function () { Log.report("bridge", "ttwid 注册连接失败"); ok(); };
            x.send(JSON.stringify({region: "cn", aid: 6383, needFid: false, service: "www.douyin.com",
                                   migrate_info: {ticket: "", source: "node"}, cbUrlProtocol: "https", union: true}));
        }), 8000, "ttwid").catch(function (e) { Log.report("bridge", e.message); });
    }

    function openFrame() {
        return withTimeout(new Promise(function (ok) {
            if (frame && frame.parentNode) { frame.parentNode.removeChild(frame); }
            frame = document.createElement("iframe");
            frame.className = "bridge";
            frame.onload = function () { ok(frame); };
            frame.src = D + "/robots.txt";
            document.body.appendChild(frame);
        }), 15000, "框加载");
    }

    function loadScriptIn(win, src) {
        return withTimeout(new Promise(function (ok, bad) {
            var s = win.document.createElement("script");
            /* 动态插入的脚本默认 async（谁先下完谁先执行）；false 让它们并行下载、按插入顺序执行 ——
             * secsdk → webmssdk → glue 的顺序和官网页面一致。 */
            s.async = false;
            s.src = src;
            s.onload = function () { ok(); };
            s.onerror = function () { bad(new Error("脚本加载失败 " + src.split("/").pop())); };
            (win.document.head || win.document.documentElement).appendChild(s);
        }), 10000, "脚本 " + src.split("/").pop());
    }

    function installSdk(win) {
        var tStart = Date.now();
        var chain = Promise.all(SDKS.map(function (src) { return loadScriptIn(win, src); })).then(function () {
            marks.sdk = Date.now() - tStart;
        });
        var bdmsConf = {aid: 6383, pageId: 6241, paths: PATHS, boe: false, ddrt: 8.5, ic: 8.5};
        return chain.then(function () {
            win._SdkGlueInit({
                self: {aid: 6383, pageId: 6241},
                bdms: bdmsConf,
                verifyCenter: {interceptPathList: {include: PATHS, exclude: ["^/aweme/v1/play/", "douyinvod\\.com"]},
                               commonOptions: {aid: 6383, pageId: 6241}, nocaptchaOptions: {enabled: true},
                               captchaOptions: {ele: "captcha_container", showMode: "mask"}}
            }, {
                verifyCenter: {srcList: CAPTCHA},
                bdms: {srcList: BDMS}
            });
            return pollBdms(win, 20);
        }).then(function (ok) {
            marks.bdms = Date.now() - tStart - marks.sdk;
            if (ok) { return "glue"; }
            /* glue 没把 bdms 装上。先说清楚框里 bdms 那个脚本到底有没有被请求过、多大、
             * 用了多久 —— 分开「glue 没去拉」「拉失败了」「拉到了没执行」—— 再由我们自己
             * 加载它、用同一份配置 init。 */
            Log.report("bridge", "glue 20 秒没装上 bdms，" + describeBdms(win) + "；改为自己按镜像顺序加载");
            var i = 0;
            function tryNext(lastErr) {
                if (typeof win.bdms !== "undefined") { win.bdms.init(bdmsConf); return "自己加载（第 " + i + " 台镜像）"; }
                if (i >= BDMS.length) { throw new Error("三台 bdms 镜像都加载不了（最近：" + (lastErr ? lastErr.message : "脚本执行后没有 window.bdms") + "）"); }
                var src = BDMS[i++];
                return loadScriptIn(win, src).then(function () { return tryNext(null); }, tryNext);
            }
            return tryNext(null);
        });
    }

    function pollBdms(win, seconds) {
        var tries = 0;
        function poll() {
            if (typeof win.bdms !== "undefined") { return Promise.resolve(true); }
            if (tries++ > seconds * 2) { return Promise.resolve(false); }
            return wait(500).then(poll);
        }
        return poll();
    }

    function describeBdms(win) {
        var parts = [];
        try {
            var es = win.performance.getEntriesByType("resource");
            for (var i = 0; i < es.length; i++) {
                if (/bdms|verifycenter|captcha/i.test(es[i].name)) {
                    parts.push(es[i].name.split("/").slice(2, 3)[0] + "/…/" + es[i].name.split("/").pop() +
                               " " + Math.round(es[i].duration) + "ms " + (es[i].transferSize || es[i].encodedBodySize || 0) + "B");
                }
            }
        } catch (e) { parts.push("读不到资源记录：" + e.message); }
        var tags = [];
        try {
            var ss = win.document.getElementsByTagName("script");
            for (var j = 0; j < ss.length; j++) { tags.push(String(ss[j].src).split("/").pop() || "(内联)"); }
        } catch (e) {}
        return "资源记录[" + (parts.join(" ; ") || "没有 bdms/验证码相关请求") + "] 框里的脚本标签[" + tags.join(",") + "]";
    }

    function init() {
        var t0 = Date.now();
        marks = {};
        return Promise.all([ttwid().then(function () { marks.ttwid = Date.now() - t0; }),
                            openFrame().then(function (f) { marks.frame = Date.now() - t0; return f; })]).then(function (r) {
            var win = r[1].contentWindow;
            try { void win.location.href; } catch (e) {
                throw new Error("框不可访问（" + e.name + "）—— 这台机器的 widget 不允许跨域 iframe 脚本");
            }
            return installSdk(win);
        }).then(function (how) {
            Log.report("bridge", "就绪 " + (Date.now() - t0) + "ms（框 " + marks.frame + " ttwid " + marks.ttwid +
                       " 三个 SDK 并行 " + marks.sdk + " glue 装 bdms " + marks.bdms + "；bdms 由 " + how + "）");
        });
    }

    function ready() {
        if (!readyPromise) {
            readyPromise = init().catch(function (e) { readyPromise = null; throw e; });
        }
        return readyPromise;
    }

    /* 拆掉重建。签名 SDK 的状态、框里的 cookie 视图都跟着重来 —— 连续几次拿到
     * blocked/空正文时用；一次失败不值得，可能只是那一次被风控抽中。 */
    function reset() {
        readyPromise = null;
        failures = 0;
        return ready();
    }

    /* quiet：上报一类的请求（播放一次、观看历史）。aweme/stats 正常就回 200 + 空正文（2026-09-30，页面在 douyin.com 上、
     * cookie 齐全的测试台里也一样），空正文算成功；失败也不计入「连续 3 次失败就重建框」—— 为了一个上报拆掉签名桥不值。 */
    function request(method, path, params, body, quiet) {
        return ready().then(function () {
            /* 外面再包一层 15 秒：2026-10-18 v1 的评论回复接口回 200 + 空正文 + bdturing-verify 头（人机验证），官网的验证 SDK
             * 收到它就把请求扣住、等验证码 —— 验证码弹在看不见的框里，onload、ontimeout、onerror 一个都不来，Promise 永远悬着
             * （电视上 --probe 和桌面测试台都是这样，见 comments.js）。悬着的请求在界面上就是「一直转圈」。 */
            return withTimeout(new Promise(function (ok, bad) {
                var win = frame.contentWindow;
                var all = {};
                var k;
                for (k in COMMON) { if (COMMON.hasOwnProperty(k)) { all[k] = COMMON[k]; } }
                for (k in params) { if (params.hasOwnProperty(k)) { all[k] = params[k]; } }
                var x = new win.XMLHttpRequest();
                x.open(method, path + "?" + qs(all));
                x.timeout = 12000;
                if (method === "POST") { x.setRequestHeader("content-type", "application/x-www-form-urlencoded"); }
                x.onload = function () {
                    var t = x.responseText || "";
                    /* 正文开头一起报：作品列表在签名不对时回 403「Blocked by ArgusSecurityPlugin Sign Invalid」。 */
                    if (x.status !== 200) { bad(new Error("HTTP " + x.status + (t ? " " + t.slice(0, 50) : ""))); return; }
                    /* 这两种都是 200：「blocked」是签名/环境没过，空正文是缺 cookie 一类 ——
                     * 桌面实测里这两个一直是分开的两种失败，分开报。 */
                    if (t === "blocked") { bad(new Error("blocked")); return; }
                    if (!t) { if (quiet) { ok({}); } else { bad(new Error("空正文")); } return; }
                    try { ok(JSON.parse(t)); } catch (e) { bad(new Error("不是 JSON：" + t.slice(0, 30))); }
                };
                x.ontimeout = function () { bad(new Error("12 秒无响应")); };
                x.onerror = function () { bad(new Error("连接失败")); };
                x.send(method === "POST" ? (body || "") : null);
            }), 15000, path.replace(/^\/aweme\/v\d\/web\//, ""));
        }).then(function (j) { if (!quiet) { failures = 0; } return j; }, function (e) {
            if (quiet) { throw e; }
            failures++;
            if (failures >= 3) {
                Log.report("bridge", "连续 " + failures + " 次失败（最近：" + e.message + "），重建框和签名 SDK");
                reset().catch(function (err) { Log.report("bridge", "重建失败：" + err.message); });
            }
            throw e;
        });
    }

    /* 在框里（www.douyin.com 源上）发一个不走签名参数的普通请求 —— 登出这类不在
     * /aweme/ 下的接口用。 */
    function plain(url) {
        return ready().then(function () {
            return new Promise(function (ok) {
                var x = new frame.contentWindow.XMLHttpRequest();
                x.open("GET", url);
                x.timeout = 8000;
                x.onloadend = function () { ok(x.status); };
                x.send();
            });
        });
    }

    return {
        ready: ready,
        reset: reset,
        get: function (path, params) { return request("GET", path, params); },
        post: function (path, params, body) { return request("POST", path, params, body); },
        report: function (path, body) { return request("POST", path, {}, body, true); },
        plain: plain,
        /* 框（www.douyin.com 源）里脚本看得见的 cookie 的名字 —— 只要名字，不碰值。 */
        cookieNames: function () {
            try {
                return frame.contentDocument.cookie.split(";").map(function (c) { return c.split("=")[0].trim(); }).filter(function (n) { return n; });
            } catch (e) { return []; }
        }
    };
})();
