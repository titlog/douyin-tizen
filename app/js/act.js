/* 点赞、收藏（2026-10-18）：写请求，都经签名桥发。参数照官网前端代码（全新匿名浏览器存下的 bundle）：
 *   点赞  POST /aweme/v1/web/commit/item/digg/   正文 aweme_id、type（1 赞 / 0 取消）、item_type=0；
 *         官网把「status_code=0 但没有 is_digg」也当失败，这里照做
 *   收藏  POST /aweme/v1/web/aweme/collect/      正文 aweme_id、action（1 收藏 / 0 取消）、aweme_type=0
 * **2026-10-18 电视上实测两个都被拒，而且代价很大**：点赞回空正文、再试 HTTP 403；收藏回 status_code=8「用户未登录」——
 * **第一个点赞请求发出去之后，服务器当场作废了电视上的登录**（之前 history/read 是 0，之后是 8，要重新扫码）。官网发这两个时
 * 带 bd-ticket-guard-client-data 这套头，我们没有。所以 SIGNED 是 false 时**一个写请求都不发**（连 --like 自测也发不出去）：
 * 做出 ticket guard 的签名头之前别改它。界面上这两项也跟着不能选（app.js 的 chips）。
 * **服务器说成功了才改界面**（bilibili 那边的规矩：不先改本地状态再假装服务器接受了）。失败原样报 status_code 和 status_msg。
 * 自测构建里不发：它几秒一条地刷，不该替这个账号点赞。只有 --like 那一项自测（赞了马上取消）例外，见 selftest.js。
 */
var Act = (function () {
    "use strict";

    var enc = encodeURIComponent;
    var SIGNED = false;       // 请求带得上 bd-ticket-guard 头了才改成 true —— 不带就发，服务器作废登录（见上）
    var allowSelftest = false;
    function selftest() { return typeof SELFTEST !== "undefined" && !!SELFTEST && !allowSelftest; }

    function post(what, path, body, ok) {
        if (!SIGNED) { return Promise.reject(new Error("还没有 ticket guard 签名头，不发（发了服务器会作废登录）")); }
        if (selftest()) { return Promise.reject(new Error("自测构建不发写请求")); }
        var t0 = Date.now();
        return Bridge.post(path, {}, body).then(function (j) {
            var good = j.status_code === 0 && ok(j);
            Log.report("互动", what + " " + (Date.now() - t0) + "ms status_code=" + j.status_code + (j.status_msg ? " " + j.status_msg : "") +
                       (j.is_digg !== undefined ? " is_digg=" + j.is_digg : "") + " → " + (good ? "成功" : "失败"));
            if (!good) { throw new Error(j.status_msg || "status_code=" + j.status_code); }
            return j;
        }, function (e) {
            Log.report("互动", what + " 请求失败（" + (Date.now() - t0) + "ms）：" + e.message);
            throw e;
        });
    }

    return {
        ready: function () { return SIGNED; },
        like: function (item, on) {
            return post((on ? "点赞 " : "取消点赞 ") + item.id, "/aweme/v1/web/commit/item/digg/",
                        "aweme_id=" + enc(item.id) + "&type=" + (on ? 1 : 0) + "&item_type=0",
                        function (j) { return j.is_digg !== undefined; });
        },
        collect: function (item, on) {
            return post((on ? "收藏 " : "取消收藏 ") + item.id, "/aweme/v1/web/aweme/collect/",
                        "aweme_id=" + enc(item.id) + "&action=" + (on ? 1 : 0) + "&aweme_type=0",
                        function () { return true; });
        },
        /* 自测 --like 用：放开自测构建里的写请求。 */
        allowInSelftest: function () { allowSelftest = true; }
    };
})();
