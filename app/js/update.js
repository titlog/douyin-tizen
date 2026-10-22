/* 自动更新：有没有新版本、取下来、确认是我们签的、留给下次启动。下次启动跑不跑它由 boot.js 决定。
 *
 * 照搬 bilibili-tizen 的 update.js（2026-10-18 起在那边跑）。信任只来自一处：用私钥签过名的 manifest，
 * 公钥在 boot.js 里（ECDSA P-256、SHA-256）。manifest 写着更新包的 sha256 和大小，所以 manifest 的主机、
 * 更新包的主机都不必可信 —— GitHub、jsDelivr、被劫持的 DNS 在这个文件眼里一样：字节要么验得过，要么扔掉。
 * 引擎没有 crypto.subtle 的电视什么都验不了，所以永远不更新。
 *
 * 只在下次启动生效，绝不在跑着的时候换：在放着的视频底下换代码是这个应用不需要的一类 bug。开机一分钟后
 * 查一次，之后最多每六小时一次，查失败了早点再查（waitAfter）。不像 bilibili 那样避开「正在播放」：
 * 这里一直在播放。manifest 不到 1KB，更新包几百 KB、每个版本只下一次。
 *
 * 这个文件在每个更新包里，所以检查的逻辑本身能被更新修好；boot.js 和钥匙不能。tools/update-verify.mjs
 * 在 node 里跑下面这几个验证函数（Update._test）。 */
var Update = (function () {
    "use strict";

    /* Our own domain first: in mainland China raw.githubusercontent.com is
     * DNS-poisoned and jsDelivr comes and goes. It relays GitHub (see
     * server/diag-worker.mjs in bilibili-tizen) and needs no trust — the
     * manifest is signed and names the bundle's sha256. */
    var MANIFESTS = [
        "https://diag.titdev.nl/v1/update/douyin-tizen/manifest.json",
        "https://raw.githubusercontent.com/titlog/douyin-tizen/master/update/manifest.json",
        "https://cdn.jsdelivr.net/gh/titlog/douyin-tizen@master/update/manifest.json"
    ];
    var FIRST_DELAY = 60000;
    var EVERY = 6 * 3600 * 1000;
    var RETRY = 15 * 60000;              /* 查失败之后；连着失败每次翻倍 */
    var TIMEOUT = 20000;
    var K_LAST = "dy.update.last";       /* 上一次查完的 {at, result, error, fails} */
    var K_SOURCE = "dy.update.source";   /* 只有开发构建认，见 manifestUrls() */
    var K_SEEN = "dy.update.seen";       /* 「已更新到 x」提示过的版本 */

    var report = function () {};
    var timer = 0;
    var checking = false;
    var lastError = "";

    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
    function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    function now() { return new Date().getTime(); }

    function subtle() {
        try { return (window.crypto && window.crypto.subtle) || null; } catch (e) { return null; }
    }

    /* ---- 验证：纯函数，node 跑的就是这几个 ---- */

    function fromBase64(s) {
        var bin = atob(s), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
        return out;
    }
    function hex(buf) {
        var b = new Uint8Array(buf), s = "";
        for (var i = 0; i < b.length; i++) { s += (b[i] < 16 ? "0" : "") + b[i].toString(16); }
        return s;
    }
    function utf8(bytes) { return new TextDecoder("utf-8").decode(bytes); }

    /* 结果是 true / false；只有引擎不认这把钥匙时才 reject。 */
    function verifySignature(sub, pubB64, payload, sigB64) {
        return sub.importKey("spki", fromBase64(pubB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
            .then(function (key) {
                var sig;
                try { sig = fromBase64(sigB64); } catch (e) { return false; }
                return sub.verify({ name: "ECDSA", hash: { name: "SHA-256" } }, key, sig,
                                  new TextEncoder().encode(payload));
            });
    }

    function sha256Hex(sub, bytes) {
        return sub.digest("SHA-256", bytes).then(hex);
    }

    /* 为什么不下这个 manifest，要下就是 ""。每种原因各说各的：「不更新」和「这台电视上坏过」要的反应相反，
     * 一句「跳过」会把是哪种藏起来。 */
    function judge(m, ctx) {
        if (!m || !m.version || !m.sha256 || !m.urls || !m.urls.length) { return "manifest 里缺字段（version / sha256 / urls）"; }
        if (Boot.cmp(m.version, ctx.running) <= 0) { return "版本不更高（线上 " + m.version + "，正在跑 " + ctx.running + "）"; }
        if ((m.shell || 1) > ctx.shell) { return "线上 " + m.version + " 要新的安装包（shell " + m.shell + "，这台 " + ctx.shell + "），得重装"; }
        if (ctx.bad[m.version]) { return m.version + " 在这台电视上启动失败过，不再下载"; }
        if (ctx.downloaded === m.version) { return m.version + " 已经下载好了，下次打开生效"; }
        return "";
    }

    /* manifest.json → {manifest: m} 或 {why}。`payload` 是钥匙签的那串原文；先验签名，后解析，绝不反过来。 */
    function readManifest(sub, pubB64, bytes) {
        var doc = parse(utf8(bytes));
        if (!doc || typeof doc.manifest !== "string" || typeof doc.sig !== "string") {
            return Promise.resolve({ why: "manifest 格式不对" });
        }
        return verifySignature(sub, pubB64, doc.manifest, doc.sig).then(function (ok) {
            if (!ok) { return { why: "manifest 签名不对" }; }
            var m = parse(doc.manifest);
            return m ? { manifest: m } : { why: "manifest 签过名但读不出来" };
        });
    }

    /* 更新包的字节对照签过名的 manifest → {bundle, text} 或 {why}。 */
    function readBundle(sub, m, bytes) {
        if (m.size && bytes.byteLength !== m.size) {
            return Promise.resolve({ why: "bundle 大小不对（" + bytes.byteLength + "B，manifest 说 " + m.size + "B）" });
        }
        return sha256Hex(sub, bytes).then(function (h) {
            if (h !== m.sha256) { return { why: "bundle sha256 不对" }; }
            var text = utf8(bytes), b = parse(text);
            if (!b || b.version !== m.version || !b.files || !b.scripts) { return { why: "bundle 内容和 manifest 对不上" }; }
            return { bundle: b, text: text };
        });
    }

    /* ---- 网络 ---- */

    function host(u) { var m = /^https?:\/\/([^\/]+)/.exec(u); return m ? m[1] : u; }

    function getBytes(url, onOk, onFail) {
        var xhr = new XMLHttpRequest();
        try { xhr.open("GET", url, true); } catch (e) { onFail("open 失败"); return; }
        xhr.responseType = "arraybuffer";
        xhr.timeout = TIMEOUT;
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300 && xhr.response) { onOk(new Uint8Array(xhr.response)); }
            else { onFail("HTTP " + xhr.status); }
        };
        xhr.onerror = function () { onFail("连不上（状态 0，TLS / DNS / 断网分不出来）"); };
        xhr.ontimeout = function () { onFail((TIMEOUT / 1000) + " 秒没回"); };
        try { xhr.send(); } catch (e) { onFail("send 抛异常"); }
    }

    /* 第一个回答的地址；后面的只在失败之后才问。 */
    function getFirst(urls, onOk, onFail) {
        var i = 0, why = [];
        function next() {
            if (i >= urls.length) { onFail(why.join("；")); return; }
            var u = urls[i++];
            getBytes(u, function (b) { onOk(b, u); }, function (w) { why.push(host(u) + " " + w); next(); });
        }
        next();
    }

    /* 开发构建（deploy.sh 往 config.js 写了上报地址）可以把检查指到别处，在电视上测更新用
     * （deploy.sh 的 DOUYIN_UPDATE_MANIFEST）。发布包 REPORT_TO 是空的，只能查仓库。 */
    function manifestUrls() {
        var dev = typeof REPORT_TO !== "undefined" && !!REPORT_TO;
        if (dev) {
            if (typeof UPDATE_MANIFEST !== "undefined" && UPDATE_MANIFEST) { return [UPDATE_MANIFEST]; }
            if (get(K_SOURCE)) { return [get(K_SOURCE)]; }
        }
        return MANIFESTS;
    }

    /* ---- 状态 ---- */

    function stored() { return parse(get(Boot.keys.meta)); }
    function downloaded() {
        var m = stored(), running = Boot.info().running;
        return m && Boot.cmp(m.version, running) > 0 ? m.version : "";
    }

    /* 先写更新包、后写 meta：boot.js 先读 meta，所以有 meta 就一定有写完整的更新包。 */
    function keep(m, text) {
        del(Boot.keys.meta);
        del(Boot.keys.bundle);
        if (!put(Boot.keys.bundle, text)) { del(Boot.keys.bundle); return false; }
        if (!put(Boot.keys.meta, JSON.stringify({ version: m.version, shell: m.shell || 1, sha256: m.sha256, size: m.size, at: now() }))) {
            del(Boot.keys.bundle);
            return false;
        }
        return true;
    }

    /* 查完一次留下的记录：查到了什么，连着失败了几次。 */
    function record(prev, result, isError, t) {
        var fails = isError ? (prev && prev.error ? (prev.fails || 1) + 1 : 1) : 0;
        return { at: t, result: result, error: !!isError, fails: fails };
    }

    /* 照上一次的记录，离下一次查还有多久。查成了等六小时；没成的等 15 分钟，连着失败每次翻倍，封顶也是六小时。
     * bilibili 那边起初失败了也等满六小时：Wi-Fi 还没连上就开机的电视，一分钟那次查失败，之后整晚开机都不查 ——
     * 2026-10-18 客厅那台就是这样错过了一小时后的新版本。最多等一个间隔：记录在将来是时钟往回调了，不是多等的理由。 */
    function waitAfter(last, t) {
        if (!last || !last.at) { return 0; }
        var gap = last.error ? Math.min(EVERY, RETRY * Math.pow(2, Math.max(0, (last.fails || 1) - 1))) : EVERY;
        return Math.max(0, Math.min(gap, last.at + gap - t));
    }

    function finish(result, isError, done) {
        checking = false;
        lastError = isError ? result : "";
        var rec = record(parse(get(K_LAST)), result, isError, now());
        put(K_LAST, JSON.stringify(rec));
        report("update", result + (isError
            ? "；" + Math.round(waitAfter(rec, rec.at) / 60000) + " 分钟后再查（连着第 " + rec.fails + " 次没成）" : ""));
        if (done) { done(result); }
    }

    function check(done) {
        if (checking) { if (done) { done("正在查"); } return; }
        var sub = subtle();
        if (!sub || typeof TextEncoder === "undefined" || typeof TextDecoder === "undefined") {
            finish("这台电视的引擎没有 crypto.subtle / TextEncoder，验不了签名，不更新", true, done);
            return;
        }
        if (!Boot.PUBKEY) { finish("boot.js 里没有公钥，不更新", true, done); return; }
        checking = true;
        var t0 = now();
        /* 某一步里抛异常，不接住的话 checking 一直挂着，这次运行之后每次检查都回答「正在查」。 */
        function safe(fn) {
            return function () {
                try { return fn.apply(null, arguments); }
                catch (e) { finish("检查时出错：" + (e && (e.message || e.name)), true, done); }
            };
        }
        getFirst(manifestUrls(), safe(function (bytes, murl) {
            readManifest(sub, Boot.PUBKEY, bytes).then(safe(function (r) {
                if (r.why) { finish(r.why + "（" + host(murl) + "）", true, done); return; }
                var m = r.manifest, info = Boot.info();
                var why = judge(m, { running: info.running, shell: Boot.SHELL, bad: parse(get(Boot.keys.bad)) || {}, downloaded: downloaded() });
                if (why) { finish("不用下载：" + why + "（清单来自 " + host(murl) + "）", false, done); return; }
                getFirst(m.urls, safe(function (bb, burl) {
                    readBundle(sub, m, bb).then(safe(function (rb) {
                        if (rb.why) { finish(rb.why + "（" + host(burl) + "）", true, done); return; }
                        if (!keep(m, rb.text)) {
                            finish("存不下：localStorage 放不下 " + Math.round(rb.text.length / 1024) + "K 字的更新包，跳过", true, done);
                            return;
                        }
                        finish("已下载 " + m.version + "，下次打开生效（正在跑 " + info.running + "，" +
                               Math.round(bb.byteLength / 1024) + "KB 来自 " + host(burl) + "，" + (now() - t0) + "ms）", false, done);
                    }), function (e) { finish("算 sha256 出错：" + (e && (e.message || e.name)), true, done); });
                }), function (why2) { finish("取不到 bundle：" + why2, true, done); });
            }), function (e) { finish("验签名出错：" + (e && (e.message || e.name)), true, done); });
        }), function (why) { finish("取不到 manifest：" + why, true, done); });
    }

    /* ---- 排期 ---- */

    function schedule(ms) {
        clearTimeout(timer);
        timer = setTimeout(tick, Math.max(1000, ms));
    }
    /* 下一次照上一次的记录排；读不回记录就等 EVERY，免得一个拒绝写入的存储让这里空转。 */
    function rearm() { schedule(waitAfter(parse(get(K_LAST)), now()) || EVERY); }
    function tick() {
        var wait = waitAfter(parse(get(K_LAST)), now());
        if (wait > 0) { schedule(wait); return; }
        check(rearm);
    }

    return {
        /* app.js 的 window.onload 里调。opts.report(kind, text) 是日志；opts.notice(text) 是屏幕上的提示，
         * 只在第一次跑一个新下载的版本时用一次。先说这次是怎么启动的 —— boot.js 自己没法报。 */
        init: function (opts) {
            opts = opts || {};
            if (opts.report) { report = opts.report; }
            var info = Boot.info(), sub = !!subtle();
            report("update", "这次跑的是" + (info.running === info.packaged ? "安装包 " + info.packaged : "更新 " + info.running + "（安装包 " + info.packaged + "）") +
                   (info.note ? "；" + info.note : "") + (sub ? "" : "；引擎没有 crypto.subtle，不能更新"));
            if (info.running && info.running !== info.packaged && get(K_SEEN) !== info.running) {
                put(K_SEEN, info.running);
                if (opts.notice) { opts.notice("已更新到 " + info.running); }
            }
            schedule(opts.firstDelay || FIRST_DELAY);
        },
        check: function (done) { check(function (r) { rearm(); if (done) { done(r); } }); },
        status: function () {
            var info = Boot.info(), last = parse(get(K_LAST)) || {};
            return {
                packaged: info.packaged, running: info.running, downloaded: downloaded(),
                supported: !!subtle(), checking: checking,
                lastCheck: last.at || 0, lastResult: last.result || "", lastError: lastError || (last.error ? last.result : ""),
                note: info.note
            };
        },
        _test: { verifySignature: verifySignature, sha256Hex: sha256Hex, judge: judge, readManifest: readManifest, readBundle: readBundle,
                 record: record, waitAfter: waitAfter, RETRY: RETRY, EVERY: EVERY }
    };
})();
