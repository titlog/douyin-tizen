/* 诊断日志：别人电视上的问题传回给开发者（2026-10-21，照搬 bilibili-tizen 的 diag.js）。
 *
 * 8098 上的收集器（tools/collect.mjs）只有开发构建有。装了发布包的电视出了事，开发者这边一个字都看不到，
 * 能拿到的只有一张提示框的照片 —— bilibili 那边 issue #5 就是这样：一台 Tizen 3.0 每个视频都 403，
 * 屏幕上说不出是哪条路被哪台主机拒了。
 *
 * 所以每一行日志同时记进这里的一圈（记的时候就去掉身份），出了观众看得见的事（Diag.incident）、或者观众在
 * 「我」里按「上传诊断日志」时，把这一圈传上去。默认开，「我」里能关；关了就什么都不记、不存、不传。
 *
 * 永远不离开电视的：账号的 uid / sec_uid、昵称、作者名、视频文案、登录页上的字、设备指纹（webid、verifyFp、
 * msToken、a_bogus……）。调用处把前几样包进 Diag.priv()，上传时换成「…」；scrub() 里的规则兜住容易忘的形状
 * （url 参数、cookie 值、sec_uid 的样子）。视频 id 留着：「只有这一条放不了」没有它就复现不了。
 *
 * 接收端是 bilibili-tizen 的 server/diag-worker.mjs（两个应用共用，按 app 分开），读用那边的
 * tools/diag-logs.mjs --app douyin-tizen。这个文件随每个更新包下发，所以接收地址和去隐私的规则都能靠更新修；
 * config.js 不随更新下发，所以地址写在这里。ES5，和 app/js 里的一切一样。 */
var Diag = (function () {
    "use strict";

    var ENDPOINT = "https://diag.titdev.nl/v1/upload";   /* bilibili-tizen/server/README.md */
    var APP = "douyin-tizen";

    var K_RING = "dy.diag.ring", K_DEVICE = "dy.diag.device", K_SENT = "dy.diag.sent", K_OFF = "dy.diag.off";

    /* 600 行大约是一条视频从起播到放弃的全部，加上之前那次启动；字数上限让 localStorage 占用在 300KB 上下
     * （UTF-16），和同一份配额里的更新包（约 490KB）、推荐缓存都离得远。 */
    var MAX_LINES = 600, MAX_CHARS = 160000, MAX_LINE = 4000;
    var SETTLE = 8000;          /* 出事之后等一会儿，让解释它的那几行（重试、换路）也进来 */
    var AUTO_GAP = 180000;      /* 自动上传最多三分钟一份…… */
    var AUTO_PER_DAY = 12;      /* ……一天十二份：卡在循环里的电视不能变成水龙头 */
    var MANUAL_GAP = 10000;
    var PERSIST_EVERY = 15000;
    var RETRY_AFTER = 60000;    /* 没传上的，下次启动这么久之后再传一次 */

    var OPEN = "\uE000", CLOSE = "\uE001";   /* 私用区的两个字符：日志里不会自然出现 */

    var report = function () {};
    var ring = [], chars = 0, loaded = false;
    var persistTimer = null, settleTimer = null, reasons = [], sending = false;
    var last = null;            /* {at, ok, id, why, manual} —— 这次启动最近一次上传，「我」里那行字用 */

    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
    function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    function now() { return new Date().getTime(); }

    /* 这里没有 settings.js（属于这台电视的设置只有这一个），开关直接记在 localStorage。 */
    function enabled() { return get(K_OFF) !== "1"; }

    /* 从源码装的构建和发布包一样传（2026-10-23，照 bilibili 1.4.1）。以前开发构建（REPORT_TO 非空）什么都不传，理由是
     * 收集器什么都有 —— 只在这个项目自己的电脑上成立：别人从源码装的出了事，一行都到不了谁手里（bilibili #7）。
     * 还是不传的：自测构建（出的事是造的），DIAG_TO 是 "off"（deploy.sh 照 DOUYIN_DIAG_TO=off 写，这个项目自己的电脑配置里写着）。
     * DIAG_TO 是别的地址就传到那里（--diag：本机冒充的接收端）。比这个文件老的安装包里 config.js 可能没有 DIAG_TO，所以用 typeof。 */
    function endpoint() {
        /* 桌面浏览器（测试台、README 截图）不是谁的电视，接收端只收电视的：UA 里没有 Tizen 就不传。2026-10-22 抖音的桌面测试台
         * 没拦接收端，跑写到一半的代码报的 js 错误传上去两条，看着像两台新电视。到现在为止的真电视，3.0 到 9.0，UA 都是
         * 「SMART-TV; LINUX; Tizen x.y」。 */
        if (!/Tizen/.test(typeof navigator !== "undefined" && navigator.userAgent || "")) { return ""; }
        var override = typeof DIAG_TO !== "undefined" ? DIAG_TO : "";
        if (override === "off") { return ""; }
        if (override) { return override; }
        var selftest = typeof SELFTEST !== "undefined" && !!SELFTEST;
        return selftest ? "" : ENDPOINT;
    }

    /* ---------------- 什么能传出去 ---------------- */

    function priv(s) {
        return OPEN + String(s == null ? "" : s).replace(/[\uE000\uE001]/g, "") + CLOSE;
    }
    function plain(s) { return String(s == null ? "" : s).replace(/[\uE000\uE001]/g, ""); }

    var NET = [
        /* 调用处包起来的。没合上的一段算到行尾：slice() 切掉了结尾的记号，也不能把后面漏出去。 */
        [/\uE000[^\uE001]*(?:\uE001|$)/g, "…"],
        [/[\uE000\uE001]/g, ""],
        /* 账号：sec_uid 有固定的开头（MS4wLjABAAAA，base64 的 protobuf 头），uid 是一串数字。 */
        [/MS4wLjABAAAA[\w-]+/g, "…"],
        [/\b((?:sec_uid|sec_user_id|user_id|uid|author_id|nickname|unique_id|short_id) ?[=:：] ?)[^\s&|；;，,）)"']+/g, "$1…"],
        /* 签名和设备指纹参数，任何进了日志的 url 里都去掉。 */
        [/([?&](?:a_bogus|X-Bogus|msToken|verifyFp|fp|webid|uifid|device_id|iid|ttwid|s_v_web_id|passport_csrf_token|sessionid|sid_tt|sid_guard|uid_tt|odin_tt|ticket|csrf_token)=)[^&\s"'<>]*/g, "$1…"],
        /* cookie 的值（名字留着：account 那行报「框里可见的 cookie」只报名字，判登录态要它）。 */
        [/\b(ttwid|s_v_web_id|sessionid|sessionid_ss|sid_tt|sid_guard|uid_tt|odin_tt|passport_csrf_token|passport_assist_user|msToken|UIFID|UIFID_TEMP|__ac_nonce|__ac_signature|bd_ticket_guard_client_data|_bd_ticket_crypt_cookie)=[^;&\s]+/g, "$1=…"],
        /* IP 地址：CDN 的 403 页（Client_ip）、报错里引的响应头
         * （x-debug-rmt-addr）、地址里的 oi=（整数形式）。别的点分四段也去掉，只留地址的主机（CDN 节点）和斜杠后面的版本号（Chrome/120.0.0.0）。 */
        [/((?:client[_-]?ip|x-debug-rmt-addr|x-forwarded-for|x-real-ip|remote[_-]?addr)["']?\s*[:=]\s*["']?)[^\s"'<>,;&]+/gi, "$1…"],
        [/(\boi ?[=:：] ?)\d+/g, "$1…"],
        [/(:\/\/|\/)?\b\d{1,3}(?:\.\d{1,3}){3}\b/g, function (m, kept) { return kept ? m : "…"; }],
        /* 32 位以上的十六进制串：令牌、指纹，读日志的人用不上。 */
        [/\b[0-9a-f]{32,}\b/g, "…"]
    ];

    function scrub(s) {
        var out = String(s == null ? "" : s);
        for (var i = 0; i < NET.length; i++) { out = out.replace(NET[i][0], NET[i][1]); }
        return out;
    }

    /* ---------------- 那一圈 ---------------- */

    function pad(n) { return n < 10 ? "0" + n : String(n); }
    function stamp() {
        var d = new Date();
        return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
               pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }

    function load() {
        if (loaded) { return; }
        loaded = true;
        var kept = parse(get(K_RING));
        if (kept && kept.length) {
            ring = kept.slice(-MAX_LINES);
            for (var i = 0; i < ring.length; i++) { chars += String(ring[i]).length; }
        }
    }

    function persist() {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        if (!enabled()) { return; }
        put(K_RING, JSON.stringify(ring));
    }

    function push(line) {
        load();
        if (line.length > MAX_LINE) { line = line.slice(0, MAX_LINE) + "…（这一行太长，截在 " + MAX_LINE + " 字）"; }
        ring.push(line);
        chars += line.length;
        while (ring.length > 1 && (ring.length > MAX_LINES || chars > MAX_CHARS)) { chars -= ring.shift().length; }
        if (!persistTimer) { persistTimer = setTimeout(persist, PERSIST_EVERY); }
    }

    function record(kind, detail) {
        if (!enabled()) { return; }
        try { push(stamp() + " " + scrub(kind + ": " + detail)); } catch (e) {}
    }

    /* ---------------- 上传 ---------------- */

    var ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";   /* 没有 0/O、1/I/L、U：要从屏幕上念出来 */
    function deviceId() {
        var id = get(K_DEVICE);
        if (id && /^[A-Z2-9]{8}$/.test(id)) { return id; }
        id = "";
        var bytes = null;
        try { bytes = new Uint8Array(8); window.crypto.getRandomValues(bytes); } catch (e) { bytes = null; }
        for (var i = 0; i < 8; i++) {
            var r = bytes ? bytes[i] : Math.floor(Math.random() * 256);
            id += ALPHABET.charAt(r % ALPHABET.length);
        }
        put(K_DEVICE, id);
        return id;
    }
    function shown(id) { return id.slice(0, 4) + "-" + id.slice(4); }

    function today() {
        var d = new Date();
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }
    function sentState() {
        var s = parse(get(K_SENT)) || {};
        if (s.day !== today()) { s = { day: today(), n: 0, at: 0, manualAt: s.manualAt || 0 }; }
        return s;
    }

    function post(url, body, cb) {
        var finished = false;
        function end(status, text) { if (!finished) { finished = true; cb(status, text); } }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("POST", url, true);
            /* text/plain 让它是个简单请求：会发预检的引擎上也不发。 */
            xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
            xhr.timeout = 20000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) { end(xhr.status, xhr.responseText); }
            };
            xhr.ontimeout = function () { end(0, "超时"); };
            xhr.onerror = function () { end(0, "连不上"); };
            xhr.send(body);
        } catch (e) { end(0, "发不出去：" + (e && e.message)); }
    }

    function versions() {
        try { return Boot.info(); } catch (e) { return { packaged: "", running: "" }; }
    }

    /* reason：为什么传这一份，用观众看到的那句话。 */
    function send(reason, manual, done, retry) {
        done = done || function () {};
        /* 手动按的要在「我」那行字里有个回答，所以每一种结局 —— 包括这里就拒了的 —— 都记进 last。 */
        function refuse(why) {
            if (manual) { last = { at: now(), ok: false, why: why, manual: true }; }
            done({ ok: false, why: why });
        }
        if (!enabled()) { refuse("诊断日志关着"); return; }
        var url = endpoint();
        if (!url) { refuse("这个版本没有接收地址"); return; }
        if (sending) { refuse("正在上传上一份"); return; }
        var t = now(), s = sentState();
        if (manual) {
            if (t - (s.manualAt || 0) < MANUAL_GAP) { refuse("刚传过，过几秒再按"); return; }
            s.manualAt = t;
        } else {
            /* 补传（retryMissed）自己等过了三分钟，也不占这三分钟：紧跟着它出的事不能被拦下 —— 被拦下的不会再补
             * （10-25 bilibili 那台电视上，补传后一秒造的那次出事就是这样没传）。一天的份数照算。 */
            if (!retry && t - (s.at || 0) < AUTO_GAP) {
                report("diag", "没传（三分钟内自动传过一份）：" + reason);
                done({ ok: false, why: "三分钟内传过" });
                return;
            }
            if (s.n >= AUTO_PER_DAY) {
                report("diag", "没传（今天已经自动传了 " + s.n + " 份）：" + reason);
                done({ ok: false, why: "今天传够了" });
                return;
            }
            s.n++;
            if (!retry) { s.at = t; }
        }
        put(K_SENT, JSON.stringify(s));

        load();
        var v = versions();
        var body = JSON.stringify({
            v: 1, app: APP, device: deviceId(),
            version: v.packaged || "", running: v.running || "",
            reason: scrub(reason).slice(0, 300), manual: !!manual,
            tvAt: t, tz: new Date().getTimezoneOffset(),
            ua: String(navigator.userAgent || "").slice(0, 300),
            lines: ring.slice()
        });
        persist();
        sending = true;
        var lines = ring.length;
        post(url, body, function (status, text) {
            /* 老电视的根证书未必认得接收端的证书，而最需要诊断的恰恰是老电视。https 在网络层失败就用 http
             * 再试一次，日志里写走的是哪条 —— 只有这样才知道这条退路到底用不用得上。 */
            if (status === 0 && /^https:/.test(url)) {
                post("http:" + url.slice(6), body, function (s2, t2) { finish(s2, t2, "http（https " + text + "）"); });
                return;
            }
            finish(status, text, /^https:/.test(url) ? "https" : "http");
        });
        function finish(status, text, via) {
            sending = false;
            var res = parse(text) || {};
            if (status >= 200 && status < 300 && res.id) {
                last = { at: now(), ok: true, id: res.id, manual: !!manual };
                report("diag", "传了 " + lines + " 行，编号 " + res.id + "，走 " + via + "（" + reason + "）");
                done({ ok: true, id: res.id });
            } else {
                var why = status ? "HTTP " + status + (res.error ? " " + res.error : "") : String(text || "连不上");
                last = { at: now(), ok: false, why: why, manual: !!manual };
                report("diag", "没传上：" + why + "，走 " + via + "（" + reason + "）");
                done({ ok: false, why: why });
            }
        }
    }

    /* ---------------- 没传上的，补传一次 ----------------
     *
     * 以前上传失败就算了：那一圈里记一行「没传上」，再也不试。10-25 接收端答了八个小时的 404（域名被另一个 Worker 占了），
     * 那段时间所有电视出的事全丢了。现在每次启动看一眼那一圈：最近的一行上传记录是「没传上」—— 这一版写的、更老的版本写的
     * 都算，所以更新之前漏过的电视也会补 —— 就把那一圈再传一次，启动一分钟之后（不和第一个视频抢网）。没传上那次的内容
     * 还在里面，除非之后又记了 600 行。接收端拒收的（400、413）不补，同样的内容再传还是被拒。补传又没传上，会再记一行
     * 「没传上」，下次启动接着补；一天十二份的上限照样管着。 */
    var MISSED = /diag: 没传上：(.*?)，走 https?(?:（[^（）]*）)?（([\s\S]*)）$/;
    function missed() {
        load();
        for (var i = ring.length - 1; i >= 0; i--) {
            if (/ diag: 传了 \d+ 行/.test(ring[i])) { return null; }
            var m = MISSED.exec(ring[i]);
            if (m) { return /^HTTP 4(?:00|13)\b/.test(m[1]) ? null : { why: m[1], reason: m[2].replace(/^补传：/, "") }; }
        }
        return null;
    }
    function retryMissed() {
        if (!enabled() || !endpoint()) { return; }
        var m = missed();
        if (!m) { return; }
        report("diag", "上次没传上（" + m.why + "），补传一次");
        send("补传：" + m.reason, false, null, true);
    }

    function incident(reason) {
        if (!enabled() || !endpoint()) { return; }
        reasons.push(String(reason || "?").slice(0, 120));
        if (settleTimer) { return; }
        settleTimer = setTimeout(function () {
            settleTimer = null;
            var why = reasons.join(" / ");
            reasons = [];
            send(why, false);
        }, SETTLE);
    }

    if (typeof document !== "undefined" && document.addEventListener) {
        /* Tizen 多半是挂起而不是杀进程；藏起来的页面可能再也跑不到那个 15 秒的定时器。 */
        try {
            document.addEventListener("visibilitychange", function () {
                if (document.hidden) { persist(); }
            });
            window.addEventListener("pagehide", persist);
        } catch (e) {}
    }

    return {
        priv: priv,
        plain: plain,
        scrub: scrub,
        record: record,
        incident: incident,
        /* app.js 的 window.onload 里调：日志通道，再记一行分界，留下来的那一圈看得出哪次启动从哪开始。 */
        init: function (opts) {
            if (opts && opts.report) { report = opts.report; }
            if (enabled()) {
                push(stamp() + " diag: —— 新的一次启动 ——");
                /* 也要过了三分钟的间隔，不然补传只会被它拦下。 */
                setTimeout(retryMissed, Math.max(RETRY_AFTER, (sentState().at || 0) + AUTO_GAP - now()));
            }
        },
        upload: function (done) { send("在「我」里手动上传", true, done); },
        enabled: enabled,
        setEnabled: function (on) {
            if (on) { del(K_OFF); return; }
            put(K_OFF, "1");
            ring = []; chars = 0; reasons = [];
            if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
            if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
            del(K_RING);
        },
        status: function () {
            return { enabled: enabled(), configured: !!endpoint(), device: shown(deviceId()),
                     lines: (load(), ring.length), sending: sending || !!settleTimer, last: last,
                     pending: !!missed() };
        },
        _test: { NET: NET, endpoint: endpoint, ring: function () { return ring.slice(); },
                 SETTLE: SETTLE, AUTO_GAP: AUTO_GAP, AUTO_PER_DAY: AUTO_PER_DAY, RETRY_AFTER: RETRY_AFTER }
    };
})();
