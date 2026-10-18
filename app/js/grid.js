/* 网格页：上面是头部（头像、名字、一行数字、一段说明），下面是 3:4 竖卡片的网格，遥控器上下左右选，确认键从这一条开始放
 * （放着的时候上下键在这一页的视频里刷）。三种页共用这一套（2026-10-18 从作者主页抽出来）：
 *   作者主页  暂停时选中作者、确认键进来（2026-09-30 用户要求）
 *   「我」    顶上一排：观看历史 · 喜欢 · 收藏 · 退出登录，每排一个网格（2026-10-18）
 *   合集      暂停时选中「合集」、确认键进来：选集，焦点落在正在看的那一集（2026-10-18）
 * 页和页之间怎么走（一摞页，返回键一层层退）在 app.js，这里只管一页画什么、焦点在哪。
 *
 * 作者资料接口 2026-09-30 在全新匿名测试台（spike/desktop-harness，MODE=author）里问过：
 *   GET /aweme/v1/web/user/profile/other/  sec_user_id → user.{nickname, signature, following_count, follower_count,
 *       total_favorited, aweme_count, avatar_300x300}，匿名 status_code=0。
 * 各种列表的接口见 feed.js。
 */
var Grid = (function () {
    "use strict";

    /* 4 列（用户 09-30 看了 6 列嫌小）、3:4 竖卡片（用户要和抖音官方一致；接口给的封面第一个地址就是官方裁好的
     * 3:4 小图 cropcenter:323:430）。一屏只放得下一整行，所以焦点行钉在 ANCHOR：上面露一截上一行、下面露大半行下一行，
     * 上下键每次正好滚一行。网格从哪一行开始（top）每种页不一样：「我」上面还有一排。 */
    var COLS = 4, CW = 398, CH = 531, GAP = 36, LEFT = 110, ANCHOR = 120;
    var ROW = CH + GAP;
    /* 翻动时的帧（2026-09-30 用户说往下滚「有点卡顿」）：按键后 450ms 里 rAF 的间隔。合成层临时提起 / 放下、新露出来的
     * 部分要光栅化时，主线程的帧会被顶住，长间隔就是看得见的卡。自测 --grid 在同一轮里轮换 MODES，电视上各滚 24 次：
     *   旧     最长帧间隔中位 167ms，掉帧 264，长任务 3872ms —— 250ms 的滚动里卡住六分之一秒
     *   层     33ms，掉帧 37，长任务 341ms（整块网格 will-change: transform，常驻一个合成层）
     *   层+瞬  33ms，掉帧 22，长任务 0（再加焦点卡片放大不做过渡）—— 默认 */
    var MODES = {"旧": ["", ""], "层": ["layer", ""], "层+瞬": ["layer", "snap"]};
    var mode = "层+瞬";
    var probes = [], told = 0, longMs = 0;
    try {
        new PerformanceObserver(function (l) {
            var es = l.getEntries();
            for (var i = 0; i < es.length; i++) { longMs += es[i].duration; }
        }).observe({entryTypes: ["longtask"]});
    } catch (e) {}
    var $ = function (id) { return document.getElementById(id); };
    var cur = null;           // 正显示的那一页

    function count(n) {
        if (n >= 100000000) { return (n / 100000000).toFixed(1) + "亿"; }
        if (n >= 10000) { return (n / 10000).toFixed(1) + "万"; }
        return String(n || 0);
    }
    function first(list) { return list && list.url_list && list.url_list[0] || ""; }

    /* 一页。tabs 只有「我」有：顶上一排，焦点在那一排时 zone 是 "tabs"。每一排各一个视频流（feeds[key]，第一次切过去才建）。
     *   playName / backName：放这一页的视频时顶上那行写什么（「@谁 的作品 · 返回键回到 TA 的主页」）
     *   label(it)：卡片左下角那行（默认点赞数；合集写第几集）
     *   want：打开时焦点要落在哪一条（合集：正在看的那一集），没取到就接着往后取 */
    function make(kind, o) {
        return {kind: kind, title: o.title || "", avatar: o.avatar || "", stats: o.stats || "", sign: o.sign || "",
                top: o.tabs ? 380 : 300, tabs: o.tabs || null, tab: 0, zone: o.tabs ? "tabs" : "grid", feeds: {},
                makeFeed: o.makeFeed, label: o.label || null, empty: o.empty || null, foot: o.foot || null,
                playName: o.playName || "", backName: o.backName || "", want: o.want || "", wantTries: 0,
                sel: 0, on: -1, offset: 0, cards: [], loading: false, err: ""};
    }
    function key(p) { return p.tabs ? p.tabs[p.tab].key : "main"; }
    function feedOf(p) {
        var k = key(p);
        if (!p.feeds[k] && p.makeFeed) { p.feeds[k] = p.makeFeed(k) || null; }
        return p.feeds[k] || null;
    }

    function avatar(src) {
        var av = $("gp-avatar");
        av.style.visibility = "hidden";
        if (!src) { return; }
        av.onload = function () { av.style.visibility = "visible"; };
        av.src = src;
    }

    /* 头部有新消息了（资料接口回来了）：记在页上，正显示的话顺手画上。 */
    function header(p, o) {
        for (var k in o) { if (o.hasOwnProperty(k) && o[k] !== undefined) { p[k] = o[k]; } }
        if (cur !== p) { return; }
        $("gp-name").textContent = p.title;
        $("gp-stats").textContent = p.stats;
        $("gp-sign").textContent = p.sign;
        if (o.avatar) { avatar(p.avatar); }
    }

    /* 顶上那一排（「我」的四项、选集的分组）。分组多了一行放不下：横着挪，让亮着的那一项露出来。 */
    function drawTabs() {
        var p = cur, html = "";
        if (!p.tabs) { $("gp-tabs").innerHTML = ""; return; }
        for (var i = 0; i < p.tabs.length; i++) {
            html += "<span class=\"t" + (i === p.tab ? " on" : "") + (i === p.tab && p.zone === "tabs" ? " focus" : "") + "\">" + p.tabs[i].name + "</span>";
        }
        $("gp-tabs").innerHTML = "<div class=\"in\">" + html + "</div>";
        var inner = $("gp-tabs").firstChild, on = inner.childNodes[p.tab];
        var x = Math.max(0, Math.min(on.offsetLeft - 300, inner.scrollWidth - $("gp-tabs").offsetWidth));
        inner.style.transform = "translateX(" + (-x) + "px)";
    }
    /* 选集的一组最多画 limit 张（流本身会接着往后取，那是给接着放下一集用的）。 */
    function limit(p) { return p.tabs && p.tabs[p.tab].limit || 0; }
    function shown(p, f) {
        var list = f ? f.all() : [], lim = limit(p);
        return lim && list.length > lim ? list.slice(0, lim) : list;
    }

    /* 整页重画：新开一页、从放着的视频回来、换一排。卡片全部重建（图在浏览器缓存里）。 */
    function render(p) {
        cur = p;
        $("grid-page").className = "show " + p.kind;
        $("gp-name").textContent = p.title;
        $("gp-stats").textContent = p.stats;
        $("gp-sign").textContent = p.sign;
        avatar(p.avatar);
        $("gp-grid").innerHTML = "";
        $("gp-scroll").className = MODES[mode][0];
        $("gp-grid").className = MODES[mode][1];
        p.cards = [];
        p.on = -1;
        p.offset = -1;
        draw();
        var f = feedOf(p);
        if (f && !f.all().length) { more(); }
    }

    function more() {
        var me = cur;
        var f = me && feedOf(me);
        if (!f || me.loading || !f.hasMore() || limit(me) && f.all().length >= limit(me)) { return; }
        me.loading = true;
        me.err = "";
        draw();
        var t0 = Date.now();
        var k = key(me);
        f.loadMore().then(function (added) {
            me.loading = false;
            if (cur !== me || key(me) !== k) { return; }
            if (!me.cards.length) { Log.report("网格", me.kind + (me.tabs ? "·" + k : "") + " 第一页 " + (Date.now() - t0) + "ms，" + added + " 条"); }
            draw();
        }, function (e) {
            me.loading = false;
            if (cur !== me || key(me) !== k) { return; }
            me.err = e.message;
            Log.report("网格", me.kind + (me.tabs ? "·" + k : "") + " 列表取不到（" + (Date.now() - t0) + "ms）：" + e.message);
            draw();
        });
    }

    /* 把还没画的条目补成卡片（放这一页的视频时往下刷也会取新页），再写底下那行字。 */
    function draw() {
        var me = cur;
        var f = feedOf(me);
        var list = shown(me, f);
        var full = limit(me) && list.length >= limit(me);
        var grid = $("gp-grid");
        for (var i = me.cards.length; i < list.length; i++) {
            var it = list[i];
            var c = document.createElement("div");
            c.className = "card";
            c.style.left = (LEFT + (i % COLS) * (CW + GAP)) + "px";
            c.style.top = (me.top + Math.floor(i / COLS) * ROW) + "px";
            c.innerHTML = "<img><div class=\"shade\"></div><div class=\"d\"></div><div class=\"l\"></div>" + (it.top && me.kind === "author" ? "<div class=\"pin\">置顶</div>" : "");
            c.firstChild.src = it.thumb || it.cover;
            c.childNodes[2].textContent = it.desc;
            c.childNodes[3].textContent = me.label ? me.label(it) : "♥ " + count(it.likes);
            grid.appendChild(c);
            me.cards.push(c);
        }
        /* 合集：焦点要落在正在看的那一集上。一页 12 集，没取到就接着取（最多 15 页）。 */
        if (me.want) {
            for (var w = 0; w < list.length; w++) { if (list[w].id === me.want) { break; } }
            if (w < list.length) { me.sel = w; me.zone = "grid"; me.want = ""; }
            else if (f && f.hasMore() && !full && !me.loading && !me.err && me.wantTries++ < 15) { setTimeout(more, 0); }
            else if (!me.loading) { me.want = ""; }
        }
        var n = list.length;
        var msg = "";
        if (!f) { msg = me.empty ? me.empty(key(me), null) : ""; }
        else if (me.loading) { msg = "正在加载…"; }
        else if (me.err) { msg = (n ? "后面的加载失败（" + me.err + "），往下翻重试" : "加载失败（" + me.err + "），按确认键重试"); }
        else if (full && me.tab < me.tabs.length - 1) { msg = "后面的集在顶上那一排的「" + me.tabs[me.tab + 1].name + "」"; }
        else if (!f.hasMore()) {
            if (!n) { msg = me.empty ? me.empty(key(me), f) : "这里是空的"; }
            else { msg = me.foot ? me.foot(f, n) : "没有更多了"; }
        }
        var ft = $("gp-foot");
        ft.textContent = msg;
        ft.style.top = (n ? me.top + Math.ceil(n / COLS) * ROW + 10 : me.top + 120) + "px";
        focus(false);
    }

    function scroll(off) {
        if (!cur || off === cur.offset) { return false; }
        cur.offset = off;
        $("gp-scroll").style.transform = "translateY(" + (-off) + "px)";
        return true;
    }

    /* 焦点行钉在 ANCHOR（第一行时连头部一起露出来）。快翻到底了就取下一页 —— 只在观众往下走时取，画完一页不自己
     * 接着取（一页全是图文、有 has_more 的作者会一直问下去）。回这次滚没滚。焦点在「我」顶上那一排时没有卡片亮着。 */
    function focus(moved) {
        var me = cur;
        drawTabs();
        var n = me.cards.length;
        var on = me.zone === "grid" && n ? Math.min(me.sel, n - 1) : -1;
        if (on >= 0) { me.sel = on; }
        if (me.on !== on) {
            if (me.cards[me.on]) { me.cards[me.on].className = "card"; }
            if (on >= 0) { me.cards[on].className = "card on"; }
            me.on = on;
        }
        if (on < 0) { return scroll(0); }
        var r = Math.floor(on / COLS), rows = Math.ceil(n / COLS);
        /* 滚到底就不再往上推：最后一行和底下那行字贴着屏幕下沿，不留一大块空。 */
        var off = r === 0 ? 0 : Math.min(me.top + r * ROW - ANCHOR, Math.max(0, me.top + rows * ROW + 70 - 1080));
        var scrolled = scroll(off);
        if (moved && r >= rows - 2) { more(); }
        return scrolled;
    }

    function measure(scrolled) {
        var p = {mode: mode, scrolled: scrolled, frames: 0, maxGap: 0, drops: 0, first: -1, long: longMs};
        var t0 = performance.now(), last = t0;
        function tick(now) {
            var gap = now - last;
            if (!p.frames) { p.first = Math.round(performance.now() - t0); }     // now 是这一帧的起点，可能早于按键
            else {
                if (gap > p.maxGap) { p.maxGap = gap; }
                if (gap > 25) { p.drops += Math.round(gap / 16.7) - 1; }
            }
            p.frames++;
            last = now;
            if (now - t0 < 450) { requestAnimationFrame(tick); return; }
            p.maxGap = Math.round(p.maxGap);
            p.long = Math.round(longMs - p.long);
            probes.push(p);
            if (probes.length > 300) { probes.shift(); }
            /* 平时每滚 10 次报一行，看真实使用时卡不卡。 */
            var sc = probes.filter(function (q) { return q.scrolled; });
            if (sc.length - told >= 10) {
                var g = sc.slice(told);
                told = sc.length;
                var gaps = g.map(function (q) { return q.maxGap; }).sort(function (a, b) { return a - b; });
                Log.report("网格", "滚动 10 次（" + mode + "）：最长帧间隔 中位 " + gaps[5] + "ms 最大 " + gaps[9] + "ms，掉帧 共 " +
                           g.reduce(function (a, q) { return a + q.drops; }, 0) + "，长任务 共 " + g.reduce(function (a, q) { return a + q.long; }, 0) + "ms");
            }
        }
        requestAnimationFrame(tick);
    }

    /* 换一排（「我」顶上那一排）：这一排的视频流第一次切过来才建、才取。 */
    function setTab(t) {
        var me = cur;
        me.tab = t;
        me.sel = 0;
        me.want = "";
        me.err = "";
        $("gp-grid").innerHTML = "";
        me.cards = [];
        me.on = -1;
        draw();
        var f = feedOf(me);
        if (f && !f.all().length) { more(); }
    }

    /* 回 "left"：「我」顶上那一排最左边再往左 —— app.js 切到左边的标签。 */
    function move(dx, dy) {
        var me = cur;
        if (!me) { return ""; }
        if (me.zone === "tabs") {
            if (dy > 0) { if (me.cards.length) { me.zone = "grid"; measure(focus(true)); } return ""; }
            if (dy < 0) { return ""; }
            var t = me.tab + dx;
            if (t < 0) { return me.kind === "me" ? "left" : ""; }
            if (t < me.tabs.length) { setTab(t); }
            return "";
        }
        if (!me.cards.length) {
            if (dy < 0 && me.tabs) { me.zone = "tabs"; focus(false); }
            return "";
        }
        var n = me.cards.length, s = me.sel;
        if (dx) {
            var col = s % COLS + dx;
            if (col < 0 || col >= COLS || s + dx >= n) { return ""; }
            s += dx;
        } else {
            s += dy * COLS;
            if (s < 0) {
                if (me.tabs) { me.zone = "tabs"; focus(false); }
                return "";
            }
            if (s >= n) {
                /* 往下到了比这一行短的最后一行：落在最后一张上。已经在最后一行：去取下一页。 */
                if (Math.floor((n - 1) / COLS) > Math.floor(me.sel / COLS)) { s = n - 1; }
                else { more(); return ""; }
            }
        }
        me.sel = s;
        measure(focus(true));
        return "";
    }

    /* ---------- 三种页 ---------- */

    function author(item) {
        var p = make("author", {
            title: item.author, avatar: item.avatar, playName: "@" + item.author + " 的作品", backName: "TA 的主页",
            makeFeed: function () { return Feed.create("author", {secUid: item.secUid}); },
            empty: function () { return "TA 还没有能在这里放的作品"; },
            foot: function (f, n) { return f.gated() && !Account.loggedIn() ? "没登录只能看到前 " + n + " 个作品 · 在「我」扫码登录后能看全部" : "没有更多了"; }
        });
        p.secUid = item.secUid;
        var t0 = Date.now();
        Bridge.get("/aweme/v1/web/user/profile/other/", {
            sec_user_id: item.secUid, publish_video_strategy_type: "2", personal_center_strategy: "1",
            profile_other_record_enable: "1", land_to: "1"
        }).then(function (j) {
            var u = j.user || {};
            Log.report("作者", "资料 " + (Date.now() - t0) + "ms status_code=" + j.status_code + " @" + u.nickname + " 粉丝 " + u.follower_count +
                       " 获赞 " + u.total_favorited + " 作品 " + u.aweme_count);
            if (!u.nickname) { return; }
            header(p, {title: u.nickname, playName: "@" + u.nickname + " 的作品", sign: u.signature || "",
                       stats: "关注 " + count(u.following_count) + "　　粉丝 " + count(u.follower_count) +
                              "　　获赞 " + count(u.total_favorited) + "　　作品 " + count(u.aweme_count),
                       avatar: first(u.avatar_300x300) || first(u.avatar_larger) || undefined});
        }, function (e) { Log.report("作者", "资料取不到：" + e.message); });
        return p;
    }

    /* 「我」：顶上一排观看历史 · 喜欢 · 收藏 · 退出登录。「喜欢」要自己的 sec_uid，资料回来之前那一排写「正在加载」。 */
    var ME_TABS = [{key: "history", name: "观看历史"}, {key: "like", name: "喜欢"}, {key: "collect", name: "收藏"}, {key: "logout", name: "退出登录"}];
    function me() {
        var p = make("me", {
            title: "我", tabs: ME_TABS, backName: "列表",
            makeFeed: function (k) {
                if (k === "history" || k === "collect") { return Feed.create(k); }
                if (k === "like" && p.secUid) { return Feed.create("like", {secUid: p.secUid}); }
                return null;
            },
            empty: function (k, f) {
                if (k === "logout") { return "按确认键退出登录（要按两次）"; }
                if (k === "like" && !f) { return p.profileErr ? "取不到你的账号信息（" + p.profileErr + "）" : "正在加载…"; }
                return {history: "还没有观看历史", like: "还没有点过赞的视频", collect: "还没有收藏的视频"}[k] || "这里是空的";
            }
        });
        var t0 = Date.now();
        Account.profile().then(function (u) {
            p.secUid = u.sec_uid;
            Log.report("我", "资料 " + (Date.now() - t0) + "ms 喜欢 " + u.favoriting_count + " 作品 " + u.aweme_count);
            header(p, {title: u.nickname || "我", avatar: first(u.avatar_300x300) || first(u.avatar_thumb) || undefined,
                       stats: "获赞 " + count(u.total_favorited) + "　　关注 " + count(u.following_count) + "　　粉丝 " + count(u.follower_count) +
                              "　　喜欢 " + count(u.favoriting_count)});
            if (cur === p && key(p) === "like") { draw(); more(); }
        }, function (e) {
            p.profileErr = e.message;
            Log.report("我", "资料取不到：" + e.message);
            if (cur === p) { draw(); }
        });
        return p;
    }

    /* 合集（选集）：焦点落在正在看的那一集，卡片左下角写第几集。超过 RANGE 集的分组（顶上一排「1–48 · 49–96 · …」，像抖音
     * App 的选集），打开时在这一集所在的那一组 —— 从第 1 集一页 12 集往后找，462 集的合集取 15 页也只到第 174 集（2026-10-18
     * 设备自测撞上的）。每组一个流，从组的开头取（cursor 就是集数偏移）。 */
    var RANGE = 48;
    function mix(item) {
        var m = item.mix;
        var total = Math.max(m.total || 0, m.ep || 0);
        var tabs = null;
        if (total > RANGE) {
            tabs = [];
            for (var s = 0; s < total; s += RANGE) { tabs.push({key: "r" + s, name: (s + 1) + "–" + Math.min(total, s + RANGE), start: s, limit: RANGE}); }
        }
        var p = make("mix", {
            title: m.name, avatar: m.cover || item.thumb, want: item.id, tabs: tabs,
            stats: (total ? "共 " + total + " 集" : "合集") + (item.author ? "　　@" + item.author : ""), sign: m.desc,
            playName: "合集《" + m.name + "》", backName: "选集",
            makeFeed: function (k) {
                var start = 0;
                for (var i = 0; tabs && i < tabs.length; i++) { if (tabs[i].key === k) { start = tabs[i].start; } }
                return Feed.create("mix", {mixId: m.id, start: start});
            },
            label: function (it) { return it.mix && it.mix.ep ? "第 " + it.mix.ep + " 集" : ""; },
            empty: function () { return "这个合集里没有能在这里放的视频"; }
        });
        if (tabs) { p.tab = Math.min(tabs.length - 1, Math.floor(Math.max(0, m.ep - 1) / RANGE)); }
        p.zone = "grid";
        p.mixId = m.id;
        return p;
    }

    return {
        author: author,
        me: me,
        mix: mix,
        /* 新开一页 / 回到这一页（sel：焦点落在第几张，回来时是刚才放的那一条；-1 不动）。 */
        open: render,
        show: function (p, sel) {
            if (sel >= 0) { p.sel = sel; p.zone = "grid"; }
            /* 选集里接着放、放过了这一组的最后一集：回来时换到那一集所在的组，焦点落在它上面。 */
            var lim = limit(p), f = feedOf(p);
            if (lim && sel >= lim && f) {
                var it = f.all()[sel];
                if (it && it.mix && it.mix.ep) { p.tab = Math.min(p.tabs.length - 1, Math.floor((it.mix.ep - 1) / RANGE)); p.want = it.id; p.wantTries = 0; p.sel = 0; }
            }
            render(p);
        },
        close: function () {
            told = probes.filter(function (q) { return q.scrolled; }).length;
            cur = null;
            $("gp-grid").innerHTML = "";
        },
        move: move,
        /* 网格空着（加载失败）时确认键重试。 */
        retry: function () { if (cur && !cur.cards.length) { cur.err = ""; more(); } },
        feed: function () { return cur ? feedOf(cur) : null; },
        zone: function () { return cur ? cur.zone : ""; },
        tabKey: function () { return cur ? key(cur) : ""; },
        toTabs: function () { if (cur && cur.tabs) { cur.zone = "tabs"; focus(false); } },
        /* 底下那行字临时换一句（退出登录的「再按一次」）。 */
        say: function (msg) { $("gp-foot").textContent = msg; },
        /* 自测 --cold：直接把焦点放到第 i 张。 */
        select: function (i) { if (cur && i < cur.cards.length) { cur.sel = i; cur.zone = "grid"; focus(false); } },
        /* 自测 --grid：轮换做法、读每次翻动的帧。 */
        setMode: function (m) {
            mode = m;
            $("gp-scroll").className = MODES[m][0];
            $("gp-grid").className = MODES[m][1];
        },
        probes: function () { return probes; },
        name: function () { return cur ? cur.title : ""; },
        selected: function () { return cur && cur.zone === "grid" && cur.cards.length ? cur.sel : -1; },
        /* 给自测读的。 */
        state: function () {
            if (!cur) { return null; }
            var imgs = 0;
            for (var i = 0; i < cur.cards.length; i++) { var im = cur.cards[i].firstChild; if (im.complete && im.naturalWidth > 0) { imgs++; } }
            return {kind: cur.kind, name: cur.title, cards: cur.cards.length, imgs: imgs, sel: cur.sel, zone: cur.zone, tab: key(cur),
                    stats: $("gp-stats").textContent, avatar: $("gp-avatar").naturalWidth || 0, foot: $("gp-foot").textContent};
        }
    };
})();
