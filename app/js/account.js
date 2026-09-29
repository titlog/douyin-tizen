/* 这台电视上登录的是谁 —— 或者没有人。
 *
 * 会话就是引擎全局 jar 里 douyin.com 名下的 cookie：扫码登录时由官网自己的登录页种下
 * （见 login.js），签名桥框里发的请求自然带上。我们看不见也碰不到它（HttpOnly），只能问。
 *
 * **判据是 login_time 这个 cookie 在不在。** 前两个判据都在设备上被推翻了，而且推翻的方式
 * 一样：匿名时它们也给出「像登录了」的回答。
 *   ① query/user 的 user_uid 非空 —— 匿名电视照样回 19 位（登录态桌面 16 位），user_uid_type
 *      两边都是 0：那是访客 ID，不是账号。
 *   ② 关注流 status_code=0 —— 匿名电视照样回 0，还给了 11 条视频。
 * 登录态桌面浏览器里脚本可读的 cookie 有一个 login_time，名字就是它的用途；会话本身
 * （sessionid 一类）是 HttpOnly 的，读不到。签名桥的框就在 www.douyin.com 上，读 document.cookie
 * 就行，不用发请求。每次判断都把框里 cookie 的**名字**全部报上来（不碰值），匿名和登录后各
 * 一行对照 —— 前两次都是靠原样报出的原始值才看见判据错了。
 */
var Account = (function () {
    "use strict";

    var state = {known: false, loggedIn: false};

    /* 判据：观看历史（history/read）的 status_code。未登录时它回 8 +「用户未登录」，语义就是
     * 我们要的那个布尔值。notice/count 同时问一次当对照，cookie 名字也照旧列出来 —— 每一样
     * 都原样报，登录前后对照。只在启动和登录后各问一次：2026-09-29 在桌面浏览器里密集调
     * 接口做实验，把那个会话推进了滑块验证码。 */
    function check(why) {
        return Bridge.ready().then(function () {
            return Promise.all([
                Bridge.get("/aweme/v1/web/history/read/", {max_cursor: "0", count: "1"}).catch(function (e) { return {status_code: "错误:" + e.message}; }),
                Bridge.get("/aweme/v1/web/notice/count/", {}).catch(function (e) { return {status_code: "错误:" + e.message}; })
            ]);
        }).then(function (r) {
            var h = r[0], n = r[1];
            var names = Bridge.cookieNames();
            state = {known: true, loggedIn: h.status_code === 0};
            Log.report("account", why + " → history/read status_code=" + h.status_code + " " + (h.status_msg || "") +
                       " | notice/count status_code=" + n.status_code + " " + (n.status_msg || "") +
                       " → 判为" + (state.loggedIn ? "已登录" : "未登录") +
                       " | 框里可见的 cookie（" + names.length + " 个）：" + names.sort().join(","));
            return state;
        }, function (e) {
            /* 也算「已知」—— 不然等登录态的标签会一直等下去。 */
            Log.report("account", why + " → 签名桥没起来（" + e.message + "），按" + (state.loggedIn ? "已登录" : "未登录") + "处理");
            state = {known: true, loggedIn: state.loggedIn};
            return state;
        });
    }

    /* 退出：先让服务器作废会话，再清掉引擎的 jar（连匿名的 ttwid 一起 —— 重建签名桥时
     * 会重新拿），最后重建签名桥。websetting 权限缺失时清 jar 会失败，照实说。 */
    function logout() {
        return Bridge.plain("/passport/web/logout/").then(function (status) {
            Log.report("account", "登出接口 HTTP " + status);
            return new Promise(function (ok) {
                try {
                    tizen.websetting.removeAllCookies(function () { ok("已清"); }, function (e) { ok("失败 " + e.name); });
                } catch (e) { ok("不可用 " + e.message); }
            });
        }).then(function (jar) {
            Log.report("account", "清 cookie jar：" + jar);
            state = {known: true, loggedIn: false};
            return Bridge.reset();
        });
    }

    return {
        check: check,
        logout: logout,
        loggedIn: function () { return state.loggedIn; },
        known: function () { return state.known; }
    };
})();
