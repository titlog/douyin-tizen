/* 视频流：一条只往前长的列表，加一个「现在看到第几条」的指针。每个标签一个实例。
 *
 * 三种流的接口都在 2026-09-29 从官网抓到、在官网页面里用它自己的签名问过：
 *   推荐  GET  /aweme/v1/web/tab/feed/       refresh_index 递增；count 写 10，实际每次只回 2–6 条
 *   精选  POST /aweme/v2/web/module/feed/    module_id=3003101，正文为空也行；每页 20 条，横屏长片居多
 *   关注  GET  /aweme/v1/web/follow/feed/    cursor 翻页；条目包在 data[].aweme 里；未登录没有内容
 * 队列在前方不足 LOOKAHEAD 条时就去补，不等看到最后一条才问 —— 一次往返加签名要一两秒，
 * 等到那时候问就是一两秒黑屏。
 */
var Feed = (function () {
    "use strict";

    var LOOKAHEAD = 4;
    /* 冷启动的一大半是在等签名桥和第一批推荐（~5 秒）。播放地址不签名，所以把「已取到、
     * 还没看」的条目存下来，下次打开先放它们，签名桥在后台起。存 12 小时 —— 推荐是
     * 几小时前的也无妨，而跳转接口对任何 video_id 都不过期。关注流不存（跟登录的人有关），
     * 登录 / 退出时 clearCache() 全清，免得新账号先放一串上一个人的推荐。 */
    var CACHE_TTL = 12 * 3600 * 1000;
    var CACHE_MAX = 12;
    function cacheKey(kind) { return "dy.feed." + kind + ".v1"; }
    function loadCache(kind) {
        try {
            var c = JSON.parse(localStorage.getItem(cacheKey(kind)) || "null");
            if (c && c.items && Date.now() - c.at < CACHE_TTL) { return c.items; }
        } catch (e) {}
        return [];
    }
    function saveCache(kind, list) {
        try { localStorage.setItem(cacheKey(kind), JSON.stringify({at: Date.now(), items: list.slice(0, CACHE_MAX)})); } catch (e) {}
    }

    function playUrl(uri) {
        /* 列表里 play_addr.url_list 前两项是 douyinvod.com 直链，从哪儿问都 403；这个跳转
         * 接口不签名、不要 Referer 和 cookie，302 到 zjcdn 返回 206（2026-09-29 实测）。 */
        return "https://www.douyin.com/aweme/v1/play/?video_id=" + encodeURIComponent(uri) + "&ratio=1080p&line=0";
    }

    function first(list) { return list && list.url_list && list.url_list[0] || ""; }

    /* 返回 null 表示这条不能放，why 里写原因（用来在日志里说清楚跳过了什么）。 */
    function normalise(a, why) {
        if (!a || !a.aweme_id) { why.push("空"); return null; }
        if (a.is_ads) { why.push("广告"); return null; }
        if (a.images && a.images.length) { why.push("图文"); return null; }
        if (a.cell_room || a.aweme_type === 101) { why.push("直播"); return null; }
        var v = a.video;
        if (!v || !v.play_addr || !v.play_addr.uri) { why.push("无地址"); return null; }
        var au = a.author || {};
        var st = a.statistics || {};
        return {
            id: a.aweme_id,
            desc: a.desc || "",
            author: au.nickname || "",
            avatar: first(au.avatar_thumb),
            cover: first(v.cover) || first(v.origin_cover),
            uri: v.play_addr.uri,
            url: playUrl(v.play_addr.uri),
            w: v.width || 0,
            h: v.height || 0,
            dur: v.duration || 0,
            likes: st.digg_count || 0,
            comments: st.comment_count || 0
        };
    }

    /* 每种流：怎么问下一页、怎么从应答里拿出条目。page 是这个实例自己的翻页状态。 */
    var KINDS = {
        recommend: {
            name: "推荐",
            cache: true,
            fetch: function (page) {
                return Bridge.get("/aweme/v1/web/tab/feed/", {
                    count: "10", refresh_index: String(page.n), video_type_select: "1",
                    pull_type: page.n === 1 ? "0" : "2", filterGids: "", tag_id: "", share_aweme_id: "", live_insert_type: ""
                }).then(function (j) { return {list: j.aweme_list || [], more: true}; });
            }
        },
        jingxuan: {
            name: "精选",
            cache: true,
            fetch: function (page) {
                return Bridge.post("/aweme/v2/web/module/feed/", {
                    module_id: "3003101", count: "20", refresh_index: String(page.n),
                    pull_type: page.n === 1 ? "0" : "2", refer_type: "10", filterGids: "", presented_ids: ""
                }, "").then(function (j) { return {list: j.aweme_list || [], more: j.has_more !== 0}; });
            }
        },
        follow: {
            name: "关注",
            fetch: function (page) {
                return Bridge.get("/aweme/v1/web/follow/feed/", {
                    cursor: String(page.cursor || 0), level: "1", count: "20", pull_type: page.n === 1 ? "0" : "2",
                    aweme_ids: "", room_ids: ""
                }).then(function (j) {
                    page.cursor = j.cursor || 0;
                    var list = [];
                    var data = j.data || [];
                    for (var i = 0; i < data.length; i++) { if (data[i] && data[i].aweme) { list.push(data[i].aweme); } }
                    return {list: list, more: !!j.has_more, status: j.status_code};
                });
            }
        }
    };

    function create(kind) {
        var K = KINDS[kind];
        var items = [];
        var seen = {};
        var pos = -1;
        var page = {n: 1, cursor: 0};
        var more = true;
        var inflight = null;
        var fetches = 0;
        var fromCache = 0;
        if (K.cache) {
            var cached = loadCache(kind);
            for (var c = 0; c < cached.length; c++) { seen[cached[c].id] = true; items.push(cached[c]); }
            fromCache = cached.length;
        }
        function persist() { if (K.cache) { saveCache(kind, items.slice(pos + 1)); } }

        function fetchMore() {
            if (inflight) { return inflight; }
            if (!more) { return Promise.resolve(0); }
            var n = ++fetches;
            var t0 = Date.now();
            inflight = K.fetch(page).then(function (r) {
                page.n++;
                more = r.more;
                var added = 0, dup = 0, why = [];
                for (var i = 0; i < r.list.length; i++) {
                    var it = normalise(r.list[i], why);
                    if (!it) { continue; }
                    if (seen[it.id]) { dup++; continue; }
                    seen[it.id] = true;
                    items.push(it);
                    added++;
                }
                Log.report("feed", K.name + " 第" + n + "次 " + (Date.now() - t0) + "ms 回 " + r.list.length + " 条，新增 " + added +
                           (dup ? "，重复 " + dup : "") + (why.length ? "，跳过 " + why.join("/") : "") +
                           (r.status ? "，status_code=" + r.status : "") + (more ? "" : "，没有更多了") +
                           " | 前方还有 " + (items.length - pos - 1));
                inflight = null;
                persist();
                return added;
            }, function (e) {
                inflight = null;
                Log.report("feed", K.name + " 第" + n + "次失败（" + e.message + "）");
                throw e;
            });
            return inflight;
        }

        /* 保证 pos 之后至少有 want 条。失败时退避重试，最多三轮 —— 全失败才交给调用方。 */
        function ensure(want) {
            if (items.length - pos - 1 >= want) { return Promise.resolve(); }
            var attempt = 0;
            function go() {
                if (!more) { return Promise.resolve(); }
                return fetchMore().then(function () {
                    if (items.length - pos - 1 >= want) { return; }
                    /* 一次回来全是重复/跳过也算「这一轮没长」，继续问，但计入尝试次数免得死循环。 */
                    if (++attempt >= 6) { return; }
                    return go();
                }, function (e) {
                    if (++attempt >= 3) { throw e; }
                    return new Promise(function (r) { setTimeout(r, 1500 * attempt); }).then(go);
                });
            }
            return go();
        }

        return {
            kind: kind,
            name: K.name,
            next: function () {
                return ensure(1).then(function () {
                    if (pos + 1 >= items.length) { throw new Error(items.length ? "没有更多了" : "这里是空的"); }
                    pos++;
                    persist();
                    ensure(LOOKAHEAD).catch(function () {});
                    return items[pos];
                });
            },
            prev: function () {
                if (pos <= 0) { return null; }
                pos--;
                return items[pos];
            },
            peekNext: function () { return items[pos + 1] || null; },
            current: function () { return items[pos] || null; },
            position: function () { return pos; },
            isEmpty: function () { return items.length === 0; },
            fromCache: function () { return fromCache; }
        };
    }

    return {
        create: create,
        clearCache: function () {
            for (var k in KINDS) { if (KINDS.hasOwnProperty(k)) { try { localStorage.removeItem(cacheKey(k)); } catch (e) {} } }
        }
    };
})();
