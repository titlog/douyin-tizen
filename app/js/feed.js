/* 视频流：一条只往前长的列表，加一个「现在看到第几条」的指针。每个标签一个实例。
 *
 * 三种流的接口都在 2026-09-29 从官网抓到、在官网页面里用它自己的签名问过：
 *   推荐  GET  /aweme/v1/web/tab/feed/       refresh_index 递增；count 写 10，实际每次只回 2–6 条
 *   精选  POST /aweme/v2/web/module/feed/    module_id=3003101，正文为空也行；每页 20 条，横屏长片居多
 *   关注  GET  /aweme/v1/web/follow/feed/    cursor 翻页；条目包在 data[].aweme 里；未登录没有内容
 *   作者  GET  /aweme/v1/web/aweme/post/     sec_user_id + max_cursor 翻页（作者主页，2026-09-30 在匿名测试台问过）
 * 队列在前方不足 LOOKAHEAD 条时就去补，不等看到最后一条才问 —— 一次往返加签名要一两秒，
 * 等到那时候问就是一两秒黑屏。
 */
var Feed = (function () {
    "use strict";

    var LOOKAHEAD = 4;
    var coverTold = false;
    /* 冷启动的一大半是在等签名桥和第一批推荐（~5 秒）。播放地址不签名，所以把「已取到、
     * 还没看」的条目存下来，下次打开先放它们，签名桥在后台起。存 12 小时 —— 推荐是
     * 几小时前的也无妨，而跳转接口对任何 video_id 都不过期。关注流不存（跟登录的人有关），
     * 登录 / 退出时 clearCache() 全清，免得新账号先放一串上一个人的推荐。 */
    var CACHE_TTL = 12 * 3600 * 1000;
    var CACHE_MAX = 12;
    /* v2（2026-09-30）：条目多了 secUid（作者主页要它）。v1 的条目没有，更新后头几条选不中作者（设备自测抓到的），整个丢掉。 */
    function cacheKey(kind) { return "dy.feed." + kind + ".v2"; }
    function loadCache(kind) {
        try {
            localStorage.removeItem("dy.feed." + kind + ".v1");
            var c = JSON.parse(localStorage.getItem(cacheKey(kind)) || "null");
            if (c && c.items && Date.now() - c.at < CACHE_TTL) { return c.items; }
        } catch (e) {}
        return [];
    }
    function saveCache(kind, list) {
        try { localStorage.setItem(cacheKey(kind), JSON.stringify({at: Date.now(), items: list.slice(0, CACHE_MAX)})); } catch (e) {}
    }

    /* 电视上看过的（2026-09-30 用户：推荐里同一条刷到三次）。原因是我们从来不告诉服务器看过什么 —— 官网一开始放就发
     * aweme/stats（播放一次）和 history/write（观看历史，登录时），见 played()。服务器那边多久生效量不出来，所以本地也记一份：
     * 推荐 / 精选里再出现看过的直接跳过，feed 那行报「看过 N」—— 上报之后这个数降没降，就是服务器认没认的证据。
     * 作者主页、关注不过滤：在那里重看是有意的。localStorage 活得过重装（设备实测）。 */
    var WATCHED_KEY = "dy.watched.v1", WATCHED_MAX = 2000;
    var watched = null;           // id → true
    var watchedList = [];
    function loadWatched() {
        if (watched) { return; }
        watched = {};
        try { watchedList = JSON.parse(localStorage.getItem(WATCHED_KEY) || "[]"); } catch (e) { watchedList = []; }
        for (var i = 0; i < watchedList.length; i++) { watched[watchedList[i]] = true; }
    }
    function markWatched(id) {
        loadWatched();
        if (watched[id]) { return; }
        watched[id] = true;
        watchedList.push(id);
        if (watchedList.length > WATCHED_MAX) { delete watched[watchedList.shift()]; }
        try { localStorage.setItem(WATCHED_KEY, JSON.stringify(watchedList)); } catch (e) {}
    }
    function isWatched(id) { loadWatched(); return !!watched[id]; }

    var reportsTold = 0;
    /* 一条开始放了：照官网的样子告诉服务器（2026-09-30 从官网的 JS 里读出来的）：
     *   POST /aweme/v2/web/aweme/stats/     正文 aweme_type、item_id、source=0、play_delta=1（官网在「videoPlay」时发）
     *   POST /aweme/v1/web/history/write/   正文 aweme_id、author_id（作者 uid）、pre_item_id（上一条）、pre_item_seen（上一条
     *                                       看到 95% 以上为 1）—— 只在登录时发，未登录官网也不发（它会回 8）
     * 自测构建不报也不记：它刷得飞快，几十条「秒划」记进账号的观看历史会带偏推荐。 */
    function played(item, pre) {
        if (typeof SELFTEST !== "undefined" && SELFTEST) { return; }
        markWatched(item.id);
        var enc = encodeURIComponent;
        /* 两个都回 status_code（电视上 stats 回 0；桌面测试台里 stats 回 200 + 空正文，记成「空」）。
         * 观看历史要等登录态查清楚：启动时第一条视频比它先到，那时 loggedIn() 还是 false（设备上第一版就把第一条漏了）。 */
        var code = function (j) { return j.status_code === undefined ? "空" : j.status_code; };
        var stats = Bridge.report("/aweme/v2/web/aweme/stats/", "aweme_type=" + (item.type || 0) + "&item_id=" + enc(item.id) + "&play_delta=1&source=0");
        var history = Account.whenKnown().then(function () {
            if (!Account.loggedIn()) { return null; }
            return Bridge.report("/aweme/v1/web/history/write/", "aweme_id=" + enc(item.id) + "&author_id=" + enc(item.uid || "") +
                                 "&pre_item_id=" + enc(pre.id || "") + "&pre_item_seen=" + (pre.seen ? 1 : 0));
        });
        Promise.all([stats, history].map(function (p) { return p.then(function (j) { return j ? code(j) : null; }, function (e) { return "错误:" + e.message; }); })).then(function (codes) {
            /* 前三条全报，之后只报出问题的。 */
            var bad = codes[0] !== "空" && codes[0] !== 0 || codes[1] !== null && codes[1] !== 0;
            if (reportsTold < 3 || bad) {
                reportsTold++;
                Log.report("上报", item.id + " stats=" + codes[0] + (codes[1] !== null ? " history/write=" + codes[1] : "（未登录，不写观看历史）") +
                           " | 上一条 " + (pre.id || "无") + " 看完=" + (pre.seen ? 1 : 0));
            }
        });
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
        /* 封面挑比例和视频最接近的那张：cover 几乎全是 4:3（设备实测 20 次里 19 次），从它裁出来
         * 的图和视频首帧对不上，交接那一下像画面抖了。origin_cover 常常是原比例。 */
        var covers = [["cover", v.cover], ["origin_cover", v.origin_cover], ["dynamic_cover", v.dynamic_cover]];
        var want = v.width && v.height ? v.width / v.height : 0;
        var best = null, bestDiff = 9, dims = [];
        for (var c = 0; c < covers.length; c++) {
            var cv = covers[c][1];
            if (!cv || !first(cv)) { continue; }
            var ar = cv.width && cv.height ? cv.width / cv.height : 0;
            dims.push(covers[c][0] + "=" + (cv.width || "?") + "x" + (cv.height || "?"));
            var diff = want && ar ? Math.abs(Math.log(ar / want)) : 5;
            if (diff < bestDiff) { bestDiff = diff; best = covers[c]; }
        }
        if (!coverTold) { coverTold = true; Log.report("feed", "封面字段 " + dims.join(" ") + " | 视频 " + v.width + "x" + v.height + " → 用 " + (best ? best[0] : "无")); }
        return {
            id: a.aweme_id,
            desc: a.desc || "",
            author: au.nickname || "",
            secUid: au.sec_uid || "",     // 作者主页要它；这一版之前存进缓存的条目没有
            uid: au.uid || "",            // 写观看历史（history/write 的 author_id）要它
            type: a.aweme_type || 0,
            avatar: first(au.avatar_thumb),
            thumb: first(v.cover),        // 作者主页网格用：url_list[0] 是官方裁好的 3:4 小图（cropcenter:323:430）
            top: !!a.is_top,
            time: a.create_time || 0,     // 发布时间（秒）：日志里报视频有多老（老视频走冷存储），--cold 挑一年以前的
            cover: best ? first(best[1]) : "",
            coverKind: best ? best[0] : "",
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
            skipWatched: true,
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
            skipWatched: true,
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
        },
        /* 一个作者的全部作品，置顶的排在最前。max_cursor 是上一页最后一条的发布时间 ×1000。
         * **匿名只给第一页**（18–20 条）：第二页不管怎么改参数（need_time_list、from_user_page、自己拿最后一条的
         * create_time 当游标……五种）都只回 {"status_code":0}，没有 aweme_list 也没有 has_more（2026-09-30 测试台，
         * 那个作者官网写着 122 个作品）。记成 gated，界面上提示登录。**登录后能翻**：电视上登录态，第二页回 17 条、
         * 补齐那个作者全部 35 个作品（2026-09-30 设备自测）。
         * 还要 uifid：SDK 从 UIFID_TEMP 这个 cookie 取，它是推荐流应答里服务器种的；没有就 403「Blocked by
         * ArgusSecurityPlugin Uifid Not Found」（推荐流、作者资料不查它）。电视上存得下（设备上框里看得见它）。 */
        author: {
            name: "作者",
            fetch: function (page, opts) {
                return Bridge.get("/aweme/v1/web/aweme/post/", {
                    sec_user_id: opts.secUid, max_cursor: String(page.cursor || 0), locate_query: "false",
                    show_live_replay_strategy: "1", need_time_list: page.n === 1 ? "1" : "0", time_list_query: "0",
                    whale_cut_token: "", cut_version: "1", count: "18", publish_video_strategy_type: "2"
                }).then(function (j) {
                    page.cursor = j.max_cursor || 0;
                    if (!j.aweme_list && page.n > 1) { page.gated = true; }
                    return {list: j.aweme_list || [], more: !!j.has_more, status: j.status_code, gated: page.gated};
                });
            }
        }
    };

    function create(kind, opts) {
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
            for (var c = 0; c < cached.length; c++) {
                seen[cached[c].id] = true;
                if (!(K.skipWatched && isWatched(cached[c].id))) { items.push(cached[c]); }
            }
            fromCache = cached.length;
        }
        function persist() { if (K.cache) { saveCache(kind, items.slice(pos + 1)); } }

        function fetchMore() {
            if (inflight) { return inflight; }
            if (!more) { return Promise.resolve(0); }
            var n = ++fetches;
            var t0 = Date.now();
            inflight = K.fetch(page, opts || {}).then(function (r) {
                page.n++;
                more = r.more;
                var added = 0, dup = 0, old = 0, why = [];
                for (var i = 0; i < r.list.length; i++) {
                    var it = normalise(r.list[i], why);
                    if (!it) { continue; }
                    if (seen[it.id]) { dup++; continue; }
                    if (K.skipWatched && isWatched(it.id)) { seen[it.id] = true; old++; continue; }
                    seen[it.id] = true;
                    items.push(it);
                    added++;
                }
                Log.report("feed", K.name + " 第" + n + "次 " + (Date.now() - t0) + "ms 回 " + r.list.length + " 条，新增 " + added +
                           (dup ? "，重复 " + dup : "") + (old ? "，电视上看过 " + old : "") + (why.length ? "，跳过 " + why.join("/") : "") +
                           (r.status ? "，status_code=" + r.status : "") + (more ? "" : "，没有更多了") +
                           (r.gated ? "（第 " + n + " 次只回了 status_code，" + (Account.loggedIn() ? "已登录" : "未登录") + "）" : "") +
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
            /* 作者主页网格：从第 i 条开始放。 */
            jump: function (i) {
                pos = i;
                persist();
                ensure(LOOKAHEAD).catch(function () {});
                return items[pos];
            },
            /* 网格往下翻：至少再多一条（失败重试、整页被跳过都由 ensure 兜着）。回新增了几条。 */
            loadMore: function () {
                var have = items.length;
                return ensure(have - pos).then(function () { return items.length - have; });
            },
            all: function () { return items; },
            hasMore: function () { return more; },
            gated: function () { return !!page.gated; },
            peekNext: function () { return items[pos + 1] || null; },
            peek: function (n) { return items[pos + n] || null; },
            current: function () { return items[pos] || null; },
            position: function () { return pos; },
            isEmpty: function () { return items.length === 0; },
            fromCache: function () { return fromCache; }
        };
    }

    return {
        create: create,
        played: played,
        clearCache: function () {
            for (var k in KINDS) { if (KINDS.hasOwnProperty(k)) { try { localStorage.removeItem(cacheKey(k)); } catch (e) {} } }
        }
    };
})();
