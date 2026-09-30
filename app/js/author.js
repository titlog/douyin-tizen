/* 作者主页（2026-09-30 用户要求）：暂停时下键选中作者、确认键进来。上面是头像、昵称、关注 / 粉丝 / 获赞 / 作品数、
 * 签名；下面是作品网格，遥控器上下左右选，确认键从这一条开始放 TA 的作品（上下键在 TA 的作品里刷）。
 * 返回键：放着的时候回到网格，网格上再按一次回到原来的标签、接着原来那一条。按键和页面切换在 app.js，
 * 这里只管这一页画什么、焦点在哪。
 *
 * 资料接口 2026-09-30 在全新匿名测试台（spike/desktop-harness，MODE=author）里问过：
 *   GET /aweme/v1/web/user/profile/other/  sec_user_id → user.{nickname, signature, following_count, follower_count,
 *       total_favorited, aweme_count, avatar_300x300}，匿名 status_code=0。
 * 作品列表见 feed.js 的 author（匿名只给第一页）。sec_uid 在推荐流条目的 author 里就有。
 */
var Author = (function () {
    "use strict";

    /* 4 列（用户 09-30 看了 6 列嫌小）、3:4 竖卡片（用户要和抖音官方一致；接口给的封面第一个地址就是官方裁好的
     * 3:4 小图 cropcenter:323:430）。一屏只放得下一整行，所以焦点行钉在 ANCHOR：上面露一截上一行、下面露大半行下一行，
     * 上下键每次正好滚一行。 */
    var COLS = 4, CW = 398, CH = 531, GAP = 36, LEFT = 110, TOP = 300, ANCHOR = 120;
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
    var cur = null;           // {secUid, name, feed, sel, offset, cards, loading, err, t0}

    function count(n) {
        if (n >= 100000000) { return (n / 100000000).toFixed(1) + "亿"; }
        if (n >= 10000) { return (n / 10000).toFixed(1) + "万"; }
        return String(n || 0);
    }
    function first(list) { return list && list.url_list && list.url_list[0] || ""; }

    function avatar(src) {
        var av = $("ap-avatar");
        if (!src) { return; }
        av.onload = function () { av.style.visibility = "visible"; };
        av.src = src;
    }

    function open(item) {
        var me = cur = {secUid: item.secUid, name: item.author, feed: Feed.create("author", {secUid: item.secUid}),
                        sel: 0, on: -1, offset: 0, cards: [], loading: false, err: "", t0: Date.now()};
        $("ap-name").textContent = item.author;
        $("ap-stats").textContent = "";
        $("ap-sign").textContent = "";
        $("ap-avatar").style.visibility = "hidden";
        avatar(item.avatar);
        $("ap-grid").innerHTML = "";
        $("ap-scroll").className = MODES[mode][0];
        $("ap-grid").className = MODES[mode][1];
        scroll(0);
        var t0 = Date.now();
        Bridge.get("/aweme/v1/web/user/profile/other/", {
            sec_user_id: me.secUid, publish_video_strategy_type: "2", personal_center_strategy: "1",
            profile_other_record_enable: "1", land_to: "1"
        }).then(function (j) {
            var u = j.user || {};
            Log.report("作者", "资料 " + (Date.now() - t0) + "ms status_code=" + j.status_code + " @" + u.nickname + " 粉丝 " + u.follower_count +
                       " 获赞 " + u.total_favorited + " 作品 " + u.aweme_count);
            if (cur !== me || !u.nickname) { return; }
            me.name = u.nickname;
            $("ap-name").textContent = u.nickname;
            $("ap-stats").textContent = "关注 " + count(u.following_count) + "　　粉丝 " + count(u.follower_count) +
                                        "　　获赞 " + count(u.total_favorited) + "　　作品 " + count(u.aweme_count);
            $("ap-sign").textContent = u.signature || "";
            avatar(first(u.avatar_300x300) || first(u.avatar_larger));
        }, function (e) { Log.report("作者", "资料取不到：" + e.message); });
        more();
    }

    function more() {
        var me = cur;
        if (!me || me.loading || !me.feed.hasMore()) { return; }
        me.loading = true;
        me.err = "";
        draw();
        var t0 = Date.now();
        me.feed.loadMore().then(function (added) {
            me.loading = false;
            if (cur !== me) { return; }
            if (!me.cards.length) { Log.report("作者", "网格第一页 " + (Date.now() - me.t0) + "ms，" + added + " 条"); }
            draw();
        }, function (e) {
            me.loading = false;
            if (cur !== me) { return; }
            me.err = e.message;
            Log.report("作者", "作品列表取不到（" + (Date.now() - t0) + "ms）：" + e.message);
            draw();
        });
    }

    /* 把还没画的条目补成卡片（放 TA 的作品时往下刷也会取新页），再写底下那行字。 */
    function draw() {
        var me = cur;
        var list = me.feed.all();
        var grid = $("ap-grid");
        for (var i = me.cards.length; i < list.length; i++) {
            var it = list[i];
            var c = document.createElement("div");
            c.className = "card";
            c.style.left = (LEFT + (i % COLS) * (CW + GAP)) + "px";
            c.style.top = (TOP + Math.floor(i / COLS) * ROW) + "px";
            c.innerHTML = "<img><div class=\"shade\"></div><div class=\"d\"></div><div class=\"l\"></div>" + (it.top ? "<div class=\"pin\">置顶</div>" : "");
            c.firstChild.src = it.thumb || it.cover;
            c.childNodes[2].textContent = it.desc;
            c.childNodes[3].textContent = "♥ " + count(it.likes);
            grid.appendChild(c);
            me.cards.push(c);
        }
        var n = list.length;
        var msg = "";
        if (me.loading) { msg = "正在加载…"; }
        else if (me.err) { msg = (n ? "后面的作品加载失败（" + me.err + "），往下翻重试" : "加载失败（" + me.err + "），按确认键重试"); }
        else if (!me.feed.hasMore()) {
            if (!n) { msg = "TA 还没有能在这里放的作品"; }
            else if (me.feed.gated() && !Account.loggedIn()) { msg = "没登录只能看到前 " + n + " 个作品 · 在「我」扫码登录后能看全部"; }
            else { msg = "没有更多了"; }
        }
        var ft = $("ap-foot");
        ft.textContent = msg;
        ft.style.top = (n ? TOP + Math.ceil(n / COLS) * ROW + 10 : TOP + 120) + "px";
        focus(false);
    }

    function scroll(off) {
        if (cur) { cur.offset = off; }
        $("ap-scroll").style.transform = "translateY(" + (-off) + "px)";
    }

    /* 焦点行钉在 ANCHOR（第一行时连头部一起露出来）。快翻到底了就取下一页 —— 只在观众往下走时取，画完一页不自己
     * 接着取（一页全是图文、有 has_more 的作者会一直问下去）。回这次滚没滚。 */
    function focus(moved) {
        var me = cur;
        var n = me.cards.length;
        if (!n) { return false; }
        if (me.sel >= n) { me.sel = n - 1; }
        if (me.on !== me.sel) {
            if (me.cards[me.on]) { me.cards[me.on].className = "card"; }
            me.cards[me.sel].className = "card on";
            me.on = me.sel;
        }
        var r = Math.floor(me.sel / COLS), rows = Math.ceil(n / COLS);
        /* 滚到底就不再往上推：最后一行和底下那行字贴着屏幕下沿，不留一大块空。 */
        var off = r === 0 ? 0 : Math.min(TOP + r * ROW - ANCHOR, Math.max(0, TOP + rows * ROW + 70 - 1080));
        var scrolled = off !== me.offset;
        if (scrolled) { scroll(off); }
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
                Log.report("作者", "滚动 10 次（" + mode + "）：最长帧间隔 中位 " + gaps[5] + "ms 最大 " + gaps[9] + "ms，掉帧 共 " +
                           g.reduce(function (a, q) { return a + q.drops; }, 0) + "，长任务 共 " + g.reduce(function (a, q) { return a + q.long; }, 0) + "ms");
            }
        }
        requestAnimationFrame(tick);
    }

    function move(dx, dy) {
        var me = cur;
        if (!me || !me.cards.length) { return; }
        var n = me.cards.length, s = me.sel;
        if (dx) {
            var col = s % COLS + dx;
            if (col < 0 || col >= COLS || s + dx >= n) { return; }
            s += dx;
        } else {
            s += dy * COLS;
            if (s < 0) { return; }
            if (s >= n) {
                /* 往下到了比这一行短的最后一行：落在最后一张上。已经在最后一行：去取下一页。 */
                if (Math.floor((n - 1) / COLS) > Math.floor(me.sel / COLS)) { s = n - 1; }
                else { more(); return; }
            }
        }
        me.sel = s;
        measure(focus(true));
    }

    return {
        open: open,
        move: move,
        /* 从放 TA 的作品回到网格：焦点落在刚才放的那一条上，补画放的时候新取到的页。 */
        show: function () {
            if (!cur) { return; }
            cur.sel = Math.max(0, cur.feed.position());
            draw();
        },
        close: function () {
            told = probes.filter(function (q) { return q.scrolled; }).length;
            cur = null;
            $("ap-grid").innerHTML = "";
        },
        /* 网格空着（加载失败）时确认键重试。 */
        retry: function () { if (cur && !cur.cards.length) { more(); } },
        feed: function () { return cur ? cur.feed : null; },
        /* 自测 --cold：直接把焦点放到第 i 张。 */
        select: function (i) { if (cur && i < cur.cards.length) { cur.sel = i; focus(false); } },
        /* 自测 --grid：轮换做法、读每次翻动的帧。 */
        setMode: function (m) {
            mode = m;
            $("ap-scroll").className = MODES[m][0];
            $("ap-grid").className = MODES[m][1];
        },
        probes: function () { return probes; },
        name: function () { return cur ? cur.name : ""; },
        selected: function () { return cur && cur.cards.length ? cur.sel : -1; },
        /* 给自测读的。 */
        state: function () {
            if (!cur) { return null; }
            var imgs = 0;
            for (var i = 0; i < cur.cards.length; i++) { var im = cur.cards[i].firstChild; if (im.complete && im.naturalWidth > 0) { imgs++; } }
            return {name: cur.name, cards: cur.cards.length, imgs: imgs, sel: cur.sel, stats: $("ap-stats").textContent,
                    avatar: $("ap-avatar").naturalWidth || 0, foot: $("ap-foot").textContent};
        }
    };
})();
