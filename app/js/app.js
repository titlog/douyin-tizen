/* 界面与遥控器。
 *
 * 顶部五个标签：直播 · 精选 · 关注 · 推荐 · 我（默认进推荐）（像抖音 App 横滑切标签）。直播、关注、推荐是上下刷的流，每个标签
 * 各记各的位置，切回来接着看；精选是 16:9 三列的网格，挑一条看（2026-10-22 用户要求，像手机上的精选），放的时候上下键接着刷，
 * 返回键回到网格；「我」登录了是观看历史 · 喜欢 · 收藏的网格（js/grid.js），没登录是扫码登录。
 * 未登录时「关注」也显示扫码登录。精选的网格最左边那一列再按左键到「直播」、最右边那一列再按右键到「关注」（标签栏不能选，这是
 * 离开精选的路）。直播放在精选左边（2026-10-22 用户要求）。
 * 直播（2026-10-22 用户要求）：上下键换直播间，暂停超过 20 秒再继续就从现在的画面重新开（直播窗口只有几秒，照 bilibili-tizen），
 * 不能快进快退；右边那一列只有主播头像（红圈、「直播」），能进主播的主页；直播间的弹幕 / 评论没接。
 *
 * 遥控器：
 *   下键 / 频道减 → 下一条        上键 / 频道加 → 上一条
 *   左右键 → 切标签（暂停时改为快退 / 快进 10 秒）
 *   快进 / 快退键 → 任何时候都快进 / 快退 10 秒
 *   确认 / 播放暂停键 → 暂停
 *   暂停时下键 → 选中右边那一列的头像，上下键往下走：头像 · 评论 · 合集（左下那一条；左右键也能在它和右边那列之间跳），
 *     确认键做，返回键 / 在头像上按上键取消。头像 → 作者主页，合集 → 选集（都是 js/grid.js 的网格页），评论 → 右边的评论侧栏（js/comments.js）
 *   网格页（作者主页、「我」、选集）：确认键从这一条开始放，放着的时候上下键在这一页里刷；返回键一层层退回来
 *   返回键按两次 → 退出
 * 竖屏视频居中、两侧纯黑；横屏视频铺满。视频上的信息照手机摆：左下 @作者、简介、合集，右边一列头像 · 赞 · 评论 · 收藏 · 分享。
 */
(function () {
    "use strict";

    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, RETURN: 10009,
        PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19, FF: 417, REW: 412,
        CH_UP: 427, CH_DOWN: 428
    };

    var TABS = [
        {key: "live", name: "直播", feed: true},
        {key: "jingxuan", name: "精选", feed: false, grid: true},
        {key: "follow", name: "关注", feed: true, needLogin: true},
        {key: "recommend", name: "推荐", feed: true},
        {key: "me", name: "我", feed: false}
    ];
    var START_TAB = 3;         // 默认进「推荐」

    var $ = function (id) { return document.getElementById(id); };
    var tab = -1;
    var feeds = {};
    var resumeAt = {};
    var view = "";            // "feed" | "login" | "grid" | "empty" | "wait"
    var busy = false;
    var errorsInRow = 0;
    var preloadTimer = 0;
    var infoTimer = 0;
    var backAt = 0;
    var logoutAt = 0;
    var loginFor = "";        // 登录是从哪个标签发起的，成功后回到那里
    var loginDiag = -1;       // 「我」的二维码页最底下那一排选中了哪一项（0 诊断日志开关、1 上传），-1 没选中
    /* 叠起来的网格页（作者主页、「我」、选集）：{page, feed, play, resume, at, root}。最上面那一页要么在显示网格（play=false，
     * view "grid"），要么在放它的视频（play=true，view "feed"，feed() 是它的）。从放着的视频里再打开一页就往上叠一层，
     * 下面那一层记着放到了哪（at）；返回键一层层退。「我」是标签自己的页（root），退不掉。 */
    var pages = [];
    var chip = -1;            // 暂停时下键选中的那一个（chips() 里的下标），-1 是没选中
    var acting = "";          // 正在等服务器回的点赞 / 收藏（"like:<id>"），等的时候再按不发第二次
    var switchInfo = null;    // 这一次切换：封面图什么时候到、比例多少（「封面」那行日志用）
    var playedId = "";        // 上一次上报「开始放」的是哪一条（从「我」、作者主页回来接着放同一条不再报）
    var watching = {id: "", frac: 0};   // 正在放的这条看到了百分之几（下一条上报时是 pre_item_seen）
    var slowTimer = 0;        // 切过来 SLOW_MS 还没出画面就转圈（网慢时第一段能取十几秒）
    var SLOW_MS = 2500;
    /* 预热方式。"blob"（整段下进内存）在 2026-09-29 的对照里只快一两百毫秒、而且多数视频
     * 32–216MB 太大用不上，见 CLAUDE.md；代码留着，默认用 "range"。 */
    var PRELOAD_MODE = "range";
    var pushTimer = 0;        // 往上推的动画结束后才换源
    /* "video"：旧视频元素自己滑走（真的推）；"cover"：旧视频原地继续播，新封面从下面盖上来，
     * 盖满（250ms）才换源；"early"：按键就换源，旧视频停在最后一帧，一整屏（黑底 + 新封面）
     * 从下面盖上来 —— 250ms 的动画和起播重叠，不再串行。
     * 设备实测移动 <video> 会让随后的起播慢 0.3–0.4 秒（见 CLAUDE.md）。"early" 要回答的是
     * 动画和建管线同时进行会不会也互相拖慢 —— 2026-09-30 两轮 --ab（同一轮里和 "cover" 逐条轮换）：
     * 按键→撤封面 early 1429 / cover 1750ms（换源→playing 1246 / 1261，没拖慢），另一轮 1522 / 1539。
     * 两轮都不比 cover 慢，默认改为 "early"。
     * "auto"（2026-09-30 起默认）：下一条走 MSE 就用 "cover"，走 src 用 "early"。MSE 下 early 按键那一刻就 seek，
     * 硬件视频层先冻在最后一帧、再黑一下，黑底封面才盖上来 —— 用户看到「又有最后一帧又黑屏」。"cover" 让旧视频
     * 原地接着播，新的一页（黑底 + 预热好的封面）从下面盖上来，盖到 ~99%（COVER_SEEK_MS）才 seek。
     * "video"（让 <video> 自己滑走、真的推）在 MSE 下试过：移动过元素之后 seek 慢 ~1.1 秒、起播后还卡 ~1 秒，
     * 按键→撤封面 video 1661 / early 589ms（同一轮各 15 次）。不许动 <video> 的位置。 */
    var PUSH_MODE = "auto";
    /* "cover"：整页盖到这时才 seek。原来 200ms（缓动曲线走到 ~99.5%）；2026-10-22 --abseek 同一轮逐条轮换两次，130ms（~95%）按键→画面动起来
     * 中位 453 / 507ms、462 / 574ms，都更快。代价是顶上 ~5% 那一条旧画面在 seek 之后冻住 / 变黑 ~120ms，要人眼确认。 */
    var COVER_SEEK_MS = 130;
    var coverPre = {};        // 预热时下好、解好的封面图（url → Image），推的时候直接贴，不再等 60–230ms
    var records = [];         // 每次切换的计时，自测 --ab 读
    var bootAt = Date.now();
    var bootMarks = {};
    var bootTold = false;
    var bootReady = null;     // 签名桥 + 登录态；「关注」「我」要等它
    var bootStartBridge = null;   // 有缓存时，第一帧出来就调它起签名桥

    var jxPage = null;        // 精选那一页（js/grid.js）：每次进这个标签都是它，焦点和列表都还在
    var liveLeftAt = 0, LIVE_STALE = 10 * 60000;    // 什么时候离开的直播；离开超过 10 分钟回来换一批直播间
    function makeFeeds() {
        feeds = {};
        resumeAt = {};
        for (var i = 0; i < TABS.length; i++) { if (TABS[i].feed) { feeds[TABS[i].key] = Feed.create(TABS[i].key); } }
        feeds.jingxuan = Feed.create("jingxuan");
        jxPage = null;
    }
    function topPage() { return pages.length ? pages[pages.length - 1] : null; }
    /* 正在放的视频流：最上面那一页在放就是它的，否则是标签的。 */
    function feed() { var e = topPage(); return e ? e.feed : feeds[TABS[tab].key]; }
    var KIND_NAME = {author: "作者", me: "我", mix: "合集", jingxuan: "精选"};
    function where() { var e = topPage(); return e ? KIND_NAME[e.page.kind] : TABS[tab].name; }     // 「到画面」那行里的出处

    /* 「播放」那行里报视频有多老。老视频走冷存储（v*-colds.douyinvod.com），但实测不慢（CLAUDE.md），报出来备查。 */
    function age(item) { return item.time ? " 发布 " + Math.floor((Date.now() / 1000 - item.time) / 86400) + " 天前" : ""; }

    function toast(msg, ms) {
        var t = $("toast");
        t.textContent = msg;
        t.className = "show";
        clearTimeout(toast.timer);
        toast.timer = setTimeout(function () { t.className = ""; }, ms || 2000);
    }
    /* 观众看得见的失败：提示，同时把最近的日志传给开发者（diag.js），理由就是这句话。新的失败出口用它，不用 toast()。 */
    function trouble(msg, ms) {
        toast(msg, ms);
        Diag.incident(msg);
    }

    /* 信息层（作者、标题、进度）每次换视频都出来；标签栏只在切标签、暂停时出来 —— 上下刷的
     * 时候顶部冒出导航是打扰（2026-09-29 用户反馈）。暂停期间和非视频页上标签栏常驻；作者主页、选集上没有标签栏
     * （它们是更深的一层），「我」、精选上有（它们就是标签自己的页）；评论侧栏开着时两个都收起来。 */
    function showInfo(withTabs) {
        var cm = Comments.isOpen();
        setInfo(view === "feed" && !cm);
        var e = topPage();
        var tabs = view === "grid" ? e.root : !cm && (withTabs || view !== "feed" || Player.isPaused());
        $("tabs").className = tabs ? "show" : "";
        clearTimeout(infoTimer);
        infoTimer = setTimeout(function () {
            if (view === "feed" && !Player.isPaused()) { setInfo(false); $("tabs").className = ""; }
        }, 5000);
    }
    /* 左下那块和右边那一列一起出来、一起淡出。 */
    function setInfo(on) {
        $("info").className = on ? "show" : "";
        $("rail").className = on ? "show" : "";
    }

    function markTabs() {
        /* 在放某一页的视频：没有标签可切，顶上写放的是什么、怎么回去。 */
        var e = topPage();
        if (e && e.play) {
            $("tabs").innerHTML = "<span class=\"tab on\"></span><span class=\"tab-hint\"></span>";
            $("tabs").firstChild.textContent = e.page.playName || (e.page.tabs ? e.page.tabs[e.page.tab].name : "");
            $("tabs").lastChild.textContent = "返回键回到" + e.page.backName;
            return;
        }
        var html = "";
        for (var i = 0; i < TABS.length; i++) {
            html += "<span class=\"tab" + (i === tab ? " on" : "") + "\">" + TABS[i].name + "</span>";
        }
        $("tabs").innerHTML = html;
    }

    // ---------- 暂停时能选中的：右边那一列（头像 · 点赞 · 评论 · 收藏）和左下的合集 ----------

    var CHIP_NAME = {author: "作者", like: "点赞", collect: "收藏", comment: "评论", mix: "合集"};
    /* 点赞、收藏能不能选：跟着 Act.ready()。2026-10-18 电视上 --like：点赞回空正文、再试 HTTP 403，收藏回 status_code=8
     * 「用户未登录」，而且第一个点赞请求之后服务器作废了电视上的登录 —— 官网发这两个请求时带 bd-ticket-guard-client-data 这套头
     * （另一个安全 SDK 算的，打包在官网主程序里，装不进签名桥），我们没有。数字照常显示（手机上赞过的照样是红心），这两项不能选。 */
    var actTest = false;      // 自测 --like 把这两项放出来（Act 自己还是不发）
    /* 顺序就是上下键走的顺序：右边那一列从上往下（和手机一样：头像、赞、评论、收藏），最后是左下的合集。分享只显示数字。 */
    function chips(it) {
        if (!it) { return []; }
        var c = it.secUid ? ["author"] : [];
        if (it.live) { return c; }                 // 直播间：只有主播头像（评论是直播间的弹幕，没接）
        var acts = Act.ready() || actTest;
        if (acts) { c.push("like"); }
        c.push("comment");
        if (acts) { c.push("collect"); }
        if (it.mix) { c.push("mix"); }
        return c;
    }
    function current() { return view === "feed" && feed() ? feed().current() : null; }

    /* 右边那一列的数字和左下的合集：赞过的心是红的、收过的星是黄的，选中的那个垫红底、左边冒出「确认键……」，
     * 等服务器回的时候半透明。 */
    function paintActs(it) {
        it = it || current();
        if (!it) { return; }
        var on = chip >= 0 ? chips(it)[chip] : "";
        var set = function (k, txt, lit, shown) {
            var el = $("act-" + k);
            var n = el.querySelector(".n"), tip = el.querySelector(".tip");
            if (n) { n.textContent = txt; } else if (txt !== null) { el.textContent = txt; }
            if (tip) { tip.textContent = on === k ? chipHint(k, it) : ""; }
            el.className = "act" + (lit ? " lit" : "") + (on === k ? " focus" : "") + (acting === k + ":" + it.id ? " busy" : "");
            el.style.display = shown === false ? "none" : "";
        };
        set("author", null, false, !!it.secUid || !!it.avatar);
        if (it.live) { $("act-author").className += " live"; }
        set("like", count(it.likes), it.digged, !it.live);
        set("comment", count(it.comments), false, !it.live);
        set("collect", it.collects ? count(it.collects) : "收藏", it.collected, !it.live);
        set("share", it.shares ? count(it.shares) : "分享", false, !it.live);
        set("mix", it.mix ? "合集 · " + it.mix.name + " · 第 " + it.mix.ep + " 集" + (it.mix.total ? " / 共 " + it.mix.total + " 集" : "") : "", false, !!it.mix);
    }
    /* 换一条时换头像。旧头像不许留到新图到之前（换 src 时 Chromium 先接着画旧图）：先藏起来，到了再亮；
     * 下一两条的头像预热时就下好了（schedulePreload），多半当场就有。 */
    function paintAvatar(it) {
        var av = $("rail-avatar");
        if (!it.avatar) { av.removeAttribute("src"); av.style.visibility = "hidden"; return; }
        if (av.getAttribute("src") === it.avatar) { return; }
        av.style.visibility = "hidden";
        av.onload = function () { av.style.visibility = ""; };
        av.onerror = function () { av.style.visibility = "hidden"; };
        av.src = it.avatar;
        if (av.complete && av.naturalWidth) { av.style.visibility = ""; }
    }
    function setChip(i) {
        chip = i;
        paintActs();
        hint();
    }
    function chipHint(k, it) {
        var e = topPage();
        if (k === "author") { return e && e.page.kind === "author" && e.page.secUid === it.secUid ? "确认键回到 TA 的主页" : "确认键进入 TA 的主页"; }
        if (k === "like") { return it.digged ? "确认键取消点赞" : "确认键点赞"; }
        if (k === "collect") { return it.collected ? "确认键取消收藏" : "确认键收藏"; }
        if (k === "comment") { return "确认键看评论"; }
        return e && e.page.kind === "mix" && e.page.mixId === it.mix.id ? "确认键回到选集" : "确认键打开合集《" + it.mix.name + "》选集";
    }
    /* 左下最底下那一行。选中右边那一列的时候，「确认键做什么」写在那个图标左边，这里只写怎么走。 */
    function hint() {
        var it = current();
        var h = "";
        if (it && Player.isPaused() && !Comments.isOpen()) {
            var c = chips(it), k = c[chip];
            h = !c.length ? "" : chip < 0 ? "下键选中 " + c.map(function (x) { return CHIP_NAME[x]; }).join(" · ") :
                (k === "mix" ? chipHint(k, it) + " · " : "") + "上下键换 · 返回键取消";
        }
        $("hint").textContent = h;
    }
    /* 选中时的方向键：上下键按 chips() 的顺序走（最上面那个再往上是取消）；左右键在右边那一列和左下的合集之间跳。 */
    function chipKey(k) {
        var c = chips(current()), at = c[chip];
        if (k === KEY.DOWN) { setChip(Math.min(c.length - 1, chip + 1)); }
        else if (k === KEY.UP) { setChip(chip - 1); }
        else if (k === KEY.LEFT) { if (at !== "mix" && c[c.length - 1] === "mix") { setChip(c.length - 1); } }
        else if (k === KEY.RIGHT) { if (at === "mix") { setChip(Math.max(0, c.length - 2)); } }
    }
    function doChip() {
        var it = current();
        var k = chips(it)[chip];
        if (k === "author") { openAuthor(); }
        else if (k === "like" || k === "collect") { toggleAct(k); }
        else if (k === "comment") { openComments(); }
        else if (k === "mix") { openMix(); }
    }

    /* 点赞 / 收藏：服务器说成功了才改（js/act.js）。没登录时说一句去哪登录。 */
    function toggleAct(kind) {
        var it = current();
        var verb = kind === "like" ? "点赞" : "收藏";
        if (!Account.loggedIn()) { toast("登录后才能" + verb + "：在「我」扫码登录", 3000); return; }
        var tag = kind + ":" + it.id;
        if (acting === tag) { return; }
        acting = tag;
        var on = kind === "like" ? !it.digged : !it.collected;
        paintActs();
        (kind === "like" ? Act.like(it, on) : Act.collect(it, on)).then(function () {
            if (kind === "like") { it.digged = on; it.likes = Math.max(0, it.likes + (on ? 1 : -1)); }
            else { it.collected = on; it.collects = Math.max(0, it.collects + (on ? 1 : -1)); }
            toast(on ? "已" + verb : "已取消" + verb);
        }, function (e) {
            toast(verb + "没成功：" + e.message, 3500);
        }).then(function () {
            if (acting === tag) { acting = ""; }
            paintActs();
            hint();
        });
    }

    function openComments() {
        var it = current();
        Log.report("评论", "打开 " + it.id + "（" + it.comments + " 条）");
        Comments.open(it);
        showInfo();
    }
    function closeComments() {
        Comments.close();
        showInfo(true);
        hint();
    }

    function setView(v) {
        view = v;
        $("login").className = v === "login" ? "show" : "";
        $("empty").className = v === "empty" ? "show" : "";
        if (v !== "grid") { $("grid-page").className = ""; }
        if (Comments.isOpen()) { Comments.close(); }
        chip = -1;
        if (v !== "feed") {
            $("cover").className = "";
            clearTimeout(pushTimer);
            pushTimer = 0;
            resetSlide($("va"));
            resetSlide($("cover"));
            $("mask").className = "";
            setInfo(false);
            $("loading").className = "";
            $("paused").className = "";
        }
    }

    function count(n) {
        if (n >= 100000000) { return (n / 100000000).toFixed(1) + "亿"; }
        if (n >= 10000) { return (n / 10000).toFixed(1) + "万"; }
        return String(n);
    }
    function clock(s) {
        s = Math.max(0, Math.floor(s));
        var m = Math.floor(s / 60);
        return m + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
    }

    /* 视频将要占的那块区域：用接口给的视频宽高算，不用封面图的 —— 封面比例常常和视频不一样，
     * 按封面摆放的话，视频一出画面区域就跳一下（2026-09-29 用户反馈「切视频闪一下」）。 */
    function fitBox(w, h) {
        if (!w || !h) { return {l: 0, t: 0, w: 1920, h: 1080}; }
        var sc = Math.min(1920 / w, 1080 / h);
        var W = Math.round(w * sc), H = Math.round(h * sc);
        return {l: Math.round((1920 - W) / 2), t: Math.round((1080 - H) / 2), w: W, h: H};
    }

    /* 切换那一刻：
     *   - 黑幕提到视频上面，挡住上一条残留的最后一帧（上一版把 <video> 设成 visibility:hidden
     *     再亮起来，那一藏一亮本身可疑，不再碰它）；
     *   - 封面按视频的区域摆放（cover 裁切），图到了才显示 —— 黑底封面层在图没到的那几百毫秒
     *     就是一块黑屏；
     *   - 竖屏视频两侧是纯黑（用户要求：封面拉伸出来的模糊彩色背景抢注意力）。
     * **切换时画面上不许有 CSS 滤镜**：一层 blur(40px) 实测让每次切换多一秒多（见 CLAUDE.md）。
     * 「封面」那行日志报图用了多久、封面比例和视频比例。 */
    function render(item, dir, push, startAt) {
        if (Comments.isOpen()) { closeComments(); }
        $("author").textContent = item.author ? "@" + item.author : "";
        chip = -1;
        paintActs(item);
        paintAvatar(item);
        $("hint").textContent = "";
        $("desc").textContent = item.desc;
        var sw = switchInfo = {at: Date.now(), item: item, coverMs: -1, ar: 0, playing: false, playingAt: 0, push: push, seekMs: push === "cover" ? COVER_SEEK_MS : 0};
        $("loading").className = "";
        clearTimeout(slowTimer);
        slowTimer = setTimeout(function () { if (switchInfo === sw && !sw.playing && view === "feed") { $("loading").className = "show"; } }, SLOW_MS);
        /* 推的时候旧画面还在，黑幕不能先盖上去 —— "cover"/"video" 在换源那一刻（show 里）再盖；
         * "early" 不用黑幕：滑进来的是一整屏黑底 + 封面，滑到位就把旧画面全盖住了。 */
        if (!push) { $("mask").className = "over"; }
        var box = fitBox(item.w, item.h);
        var cv = $("cover");
        var im = cv.lastChild;
        im.style.left = box.l + "px"; im.style.top = box.t + "px";
        im.style.width = box.w + "px"; im.style.height = box.h + "px";
        im.style.backgroundImage = "none";
        im.innerHTML = "";
        /* 推进来的是一整页（黑底 + 封面）：只滑封面图的话，竖屏视频两侧露着旧画面，到换源那一刻才被黑幕
         * 一下盖黑。 */
        var page = !!push;
        cv.className = page ? "show solid" : "show";
        resetSlide(cv);
        resetSlide(im);
        var pre = item.cover && coverPre[item.cover];
        /* 从头放、预热时软解出了第一帧：封面就用它（seek 之后硬件出的第一帧就是这一帧，撤封面不跳；见 mse.js 的 decodeFirst）。
         * 从中间接着放的不用 —— 那时出来的不是第一帧。 */
        var ff = !(startAt > 1) ? Player.frameOf(item) : {canvas: null, why: "从中间接着放"};
        sw.ff = ff.canvas ? "软解第一帧（" + ff.ms + "ms）" : "封面图（" + ff.why + "）";
        if (ff.canvas) {
            ff.canvas.className = "frame";
            im.appendChild(ff.canvas);
            sw.coverMs = 0;
            sw.ar = ff.canvas.width / ff.canvas.height;
        } else if (pre && pre.complete && pre.naturalWidth) {
            sw.coverMs = 0;
            sw.ar = pre.naturalWidth / pre.naturalHeight;
            im.style.backgroundImage = "url(\"" + item.cover + "\")";
        } else if (item.cover) {
            var img = new Image();
            img.onload = function () {
                if (switchInfo !== sw) { return; }         // 图到的时候观众已经切走了
                sw.coverMs = Date.now() - sw.at;
                sw.ar = img.width / img.height;
                if (!sw.playing) { im.style.backgroundImage = "url(\"" + item.cover + "\")"; }
            };
            img.src = item.cover;
        }
        slideIn(page ? cv : im, dir);
        $("bar").style.width = "0";
        $("paused").className = "";
        $("progress").className = "";
        /* 直播间没有进度：那一行常驻写「直播中 · N 人在看」。 */
        $("time").textContent = item.live ? "● 直播中" + (item.users ? " · " + item.users + " 人在看" : "") : "";
        $("time").className = item.live ? "show live" : "";
        showInfo();
    }

    /* 「往上推」：旧视频往外滑、新封面同时从另一头推进来，0.25 秒，动画结束才换源。
     *
     * 走过的两条路：① 只让新封面滑进来、旧画面直接被黑幕盖掉 —— 用户看到「整个屏幕闪一下、黑
     * 一下」；② 按键那一刻把旧视频的当前帧 drawImage 到画布上、让截图去滑 —— 13 次可读的截图中心
     * 亮度全是 0（2026-09-29 设备实测）：视频走硬件视频层，画布拿不到帧，滑走的是一块黑板。
     * 现在让 <video> 元素自己滑。代价是换源晚 0.25 秒（按键那一刻画面就在动）。硬件视频层会不会
     * 跟着 CSS transform 平滑移动，日志量不出来，只能看。只用 transform；**不许加滤镜**。 */
    function slideOut(el, dir) {
        el.style.transition = "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        el.style.transform = dir === "up" ? "translateY(-1080px)" : "translateY(1080px)";
    }
    function resetSlide(el) {
        el.style.transition = "none";
        el.style.transform = "none";
    }

    function slideIn(el, dir) {
        el.style.transition = "none";
        el.style.transform = dir === "up" ? "translateY(1080px)" : dir === "down" ? "translateY(-1080px)" : "none";
        if (!dir) { return; }
        void el.offsetHeight;                       // 先把起点提交，过渡才有起点
        el.style.transition = "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        el.style.transform = "translateY(0)";
    }

    function show(item, startAt, dir) {
        var v = $("va");
        clearTimeout(preloadTimer);
        /* 连按时上一次的推还没推完：直接收尾，别让两段动画叠在一起。 */
        var wasPushing = !!pushTimer;
        clearTimeout(pushTimer);
        pushTimer = 0;
        var ps = Player.state();
        var mode = PUSH_MODE === "auto" ? (Player.mseFor(item) ? "cover" : "early") : PUSH_MODE;
        var push = !!dir && ps.shown && !!ps.vw ? mode : "";
        /* "video" 连按：旧视频正在滑走，让它接着滑，别先弹回原位再滑一遍。 */
        var keepSliding = wasPushing && push === "video";
        if (!keepSliding) { resetSlide(v); }
        render(item, dir, push, startAt);
        if (!push || push === "early") {
            Player.play(item, where() + (push ? "·推(early)" : ""), startAt);
            return;
        }
        if (push === "video" && !keepSliding) { slideOut(v, dir); }
        pushTimer = setTimeout(function () {
            pushTimer = 0;
            /* "cover" 推上来的是整页黑底，已经盖满，不用黑幕。 */
            if (push !== "cover") { $("mask").className = "over"; }
            resetSlide(v);
            Player.play(item, where() + "·推(" + push + ")", startAt);
        }, push === "cover" ? COVER_SEEK_MS : 250);
    }

    /* 画面起来 1.5 秒后再预热下一条（只是 XHR，不碰解码器，见 player.js）：别和正在起播的
     * 这一条抢这台机器不快的链路。 */
    function schedulePreload() {
        clearTimeout(preloadTimer);
        /* 接下来两条都预热（只是 XHR，不碰解码器）：连着快速下划时第二条也是热的。第二条晚
         * 2 秒再发，别和第一条、也别和正在起播的这一条抢链路。 */
        var warmOne = function (n) {
            if (view !== "feed" || !feed()) { return; }
            var nx = feed().peek(n);
            if (!nx) { return; }
            Player.preload(nx, PRELOAD_MODE);
            if (nx.avatar) { new Image().src = nx.avatar; }     // 右边那一列的头像，切过去时当场就有
            if (nx.cover && !coverPre[nx.cover]) {
                var ci = new Image();
                ci.src = nx.cover;
                if (ci.decode) { ci.decode().catch(function () {}); }
                coverPre[nx.cover] = ci;
                var keys = Object.keys(coverPre);
                if (keys.length > 6) { delete coverPre[keys[0]]; }
            }
        };
        preloadTimer = setTimeout(function () {
            warmOne(1);
            preloadTimer = setTimeout(function () { warmOne(2); }, 2000);
        }, 1500);
    }

    /* 一页的视频放完了：作者主页说是 TA 的最后一个作品，选集说是最后一集。 */
    function lastMsg(f) {
        var e = topPage();
        if (e && e.page.kind === "author") { return "这是 TA 的最后一个作品" + (f.gated() && !Account.loggedIn() ? "（登录后能看更多）" : ""); }
        if (e && e.page.kind === "mix") {
            var it = f.current();
            return it && it.mix && it.mix.total > it.mix.ep ? "合集只更新到这一集" : "这是最后一集";
        }
        return f.name + "没有更多了";
    }

    function next(cause) {
        if (busy || view !== "feed") { return; }
        busy = true;
        var f = feed();
        var myTab = tab;
        if (!f.peekNext()) { $("loading").className = "show"; }
        f.next().then(function (item) {
            busy = false;
            if (tab !== myTab || view !== "feed" || feed() !== f) { return; }   // 等的时候观众切走了（或进出了网格页）
            $("loading").className = "";
            Log.report("播放", f.name + " #" + f.position() + " " + cause + " " + item.id + " " + Diag.priv(item.author || "") + " " +
                       Diag.priv(item.desc.slice(0, 20)) + " " + (item.live ? "直播 " + (item.users || "?") + " 人 " + item.url.split("?")[0].split("/").slice(2, 3)[0] :
                       item.w + "x" + item.h + " " + Math.round(item.dur / 1000) + "s" + age(item)) +
                       (item.mix ? " 合集第 " + item.mix.ep + " 集" : ""));
            show(item, 0, cause === "下键" || cause === "播完" ? "up" : "");
        }, function (e) {
            busy = false;
            if (tab !== myTab || view !== "feed" || feed() !== f) { return; }
            $("loading").className = "";
            Log.report("feed", f.name + " 取不到下一条：" + e.message);
            if (e.message === "没有更多了") {
                /* 自己放完了最后一条：停在这儿。不停的话 MSE 的播放头停在槽尾，12 秒后看门狗当成卡住。按键的只提示。 */
                if (cause === "播完" && !Player.isPaused()) { togglePause(); }
                toast(lastMsg(f), 3000);
            } else if (f.isEmpty()) {
                $("empty-msg").textContent = f.kind === "follow" ? "你关注的人最近没有新视频" : "这里暂时没有内容（" + e.message + "）";
                Player.stop();
                setView("empty");
                Diag.incident(f.name + "取不到内容：" + e.message);
            } else {
                trouble(f.name + "加载失败，按下键重试", 4000);
            }
        });
    }

    function prev() {
        var item = feed().prev();
        if (!item) { toast("已经是第一条了"); return; }
        Log.report("播放", feed().name + " #" + feed().position() + " 上一条 " + item.id);
        show(item, 0, "down");
    }

    var pausedAt = 0;
    function togglePause() {
        var it = current();
        /* 直播暂停久了，播放头早落在直播窗口外面：从现在的画面重新开（照 bilibili-tizen，20 秒）。 */
        if (it && it.live && Player.isPaused() && Date.now() - pausedAt > 20000) {
            Log.report("播放", "直播暂停了 " + Math.round((Date.now() - pausedAt) / 1000) + " 秒，重新连 " + it.room);
            show(it, 0, "");
            return;
        }
        var p = Player.toggle();
        if (p) { pausedAt = Date.now(); }
        $("paused").className = p ? "show" : "";
        $("progress").className = p && !(it && it.live) ? "show" : "";
        $("time").className = it && it.live ? "show live" : p ? "show" : "";
        chip = -1;
        showInfo(p);
        paintActs();
        hint();
    }

    // ---------- 网格页：作者主页、「我」、选集（js/grid.js） ----------

    /* 从放着的视频里打开一页（作者主页、选集）。下面那一层记住放到了哪，退回来接着放；这一页里要是有正在放的
     * 这一条（选集里的这一集），点它也从这里接着放。 */
    function pushPage(page, why) {
        var st = Player.state(), it = feed().current();
        var at = st.id && st.shown ? st.t : 0;
        var e = topPage();
        if (e) { e.at = at; } else { resumeAt[TABS[tab].key] = at; }
        Log.report("页面", why + "（从" + where() + " " + (it ? it.id : "") + " " + at.toFixed(1) + "s）");
        Player.stop();
        busy = false;
        pages.push({page: page, feed: null, play: false, resume: it ? {id: it.id, t: at} : null, at: 0, root: false});
        setView("grid");
        showInfo(true);
        Grid.open(page);
    }

    function openAuthor() {
        var it = feed().current(), e = topPage();
        if (!it || !it.secUid) { toast("这一条缺作者信息，换一条再试"); return; }
        if (e && e.page.kind === "author" && e.page.secUid === it.secUid) { backToGrid(); return; }   // 放的本来就是 TA 的作品
        pushPage(Grid.author(it), "进入 @" + Diag.priv(it.author) + " 的主页");
    }

    function openMix() {
        var it = feed().current(), e = topPage();
        if (e && e.page.kind === "mix" && e.page.mixId === it.mix.id) { backToGrid(); return; }       // 放的本来就是这个合集
        pushPage(Grid.mix(it), "打开合集《" + Diag.priv(it.mix.name) + "》第 " + it.mix.ep + " 集");
    }

    /* 网格上按确认：从这一条开始放这一页的视频。刚才放过、退回网格的那一条接着放。 */
    function playFromGrid() {
        var e = topPage();
        var i = Grid.selected();
        if (i < 0) {
            /* 精选一张卡片都没有（加载失败，或者服务器说没有更多了）：整个重来 —— Grid.retry 只是再取一页，has_more 是 0 时什么都不做。 */
            if (e.page.kind === "jingxuan") {
                Log.report("标签", "精选重试");
                feeds.jingxuan = Feed.create("jingxuan");
                jxPage = null;
                showJingxuan();
                return;
            }
            Grid.retry();
            return;
        }
        var f = Grid.feed();
        var it = f.jump(i);
        var at = e.resume && e.resume.id === it.id ? e.resume.t : 0;
        e.feed = f;
        e.play = true;
        Log.report("播放", where() + (e.page.tabs ? "·" + Grid.tabKey() : "") + " #" + i + " 网格点选 " + it.id + " " + Diag.priv(it.desc.slice(0, 20)) + " " + it.w + "x" + it.h + " " +
                   Math.round(it.dur / 1000) + "s" + age(it) + (it.mix ? " 合集第 " + it.mix.ep + " 集" : "") + (at ? " 接着 " + at.toFixed(1) + "s" : ""));
        setView("feed");
        markTabs();
        show(it, at, "");
    }

    /* 放着某一页的视频时按返回：回到那一页的网格，焦点在刚才放的那一条。 */
    function backToGrid() {
        var e = topPage();
        var st = Player.state();
        e.resume = st.id && st.shown ? {id: st.id, t: st.t} : null;
        e.play = false;
        Player.stop();
        busy = false;
        setView("grid");
        markTabs();
        showInfo(true);
        Grid.show(e.page, Math.max(0, e.feed.position()));
    }

    /* 网格上按返回：退掉这一页，回到下面那一层接着放（下面没有了就是标签自己的视频流）。 */
    function popPage() {
        var e = pages.pop();
        Log.report("页面", "离开" + KIND_NAME[e.page.kind] + "「" + Diag.priv(Grid.name()) + "」");
        Grid.close();
        var below = topPage();
        if (!below) { enterTab(tab, "从" + KIND_NAME[e.page.kind] + "返回"); return; }   // 接着原来那一条（进来时记了 resumeAt）
        setView("feed");
        markTabs();
        show(below.feed.current(), below.at || 0, "");
    }

    // ---------- 登录 / 账号 ----------

    function onLoginState(s) {
        if (view !== "login") { return; }
        if (s.phase === "qr") {
            var q = $("qr");
            q.onload = function () { Log.report("login", "二维码图片解码成功 " + q.naturalWidth + "x" + q.naturalHeight); };
            q.onerror = function () { Log.report("login", "二维码图片加载失败（src 长度 " + s.src.length + "，开头 " + s.src.slice(0, 22) + "）"); };
            q.src = s.src;
            $("qr").style.visibility = "visible";
            $("login-msg").textContent = "打开抖音 App，点左上角「扫一扫」";
        } else if (s.phase === "status" || s.phase === "error") {
            $("login-msg").textContent = s.msg;
        } else if (s.phase === "done") {
            $("login-msg").textContent = "登录成功，正在加载…";
            Account.check("登录后").then(function (st) {
                if (view !== "login") { return; }
                if (!st.loggedIn) {
                    Log.report("login", "框跳到了 robots.txt，但 query/user 仍然判为未登录");
                    Diag.incident("扫码之后仍然判为未登录");
                    $("login-msg").textContent = "登录好像没有成功，3 秒后换一张二维码";
                    setTimeout(function () { if (view === "login") { startLogin(); } }, 3000);
                    return;
                }
                toast("登录成功", 2500);
                Feed.clearCache();
                Account.forgetProfile();
                makeFeeds();
                enterTab(indexOf(loginFor === "me" ? "recommend" : loginFor), "登录成功");
            });
        }
    }

    function startLogin() {
        $("login-msg").textContent = "正在生成二维码…";
        $("qr").style.visibility = "hidden";
        Login.start(onLoginState);
    }

    function showLogin(title) {
        Player.stop();
        setView("login");
        $("login-title").textContent = title;
        loginFor = TABS[tab].key;
        loginDiag = -1;
        $("login-diag").className = loginFor === "me" ? "show" : "";
        paintLoginDiag();
        startLogin();
    }

    // ---------- 诊断日志（diag.js）：「我」页顶上那一排的两项，没登录时是二维码页最底下那一排，同一套字 ----------

    /* 按下去的回答是这行字变了，不弹提示。编号是到 GitHub 报问题时要附上的。 */
    function diagLine(k) {
        var st = Diag.status();
        if (!st.enabled) { return k === "diagup" ? "诊断日志关着，先把它打开" : "已关闭：什么都不记录，也不上传 · 确认键打开"; }
        var parts = [k === "diagup" ? "确认键把最近的运行日志传给开发者" : "出问题时把排查需要的运行信息传给开发者，不含个人隐私 · 确认键关掉",
                     "这台电视的编号 " + st.device];
        if (!st.configured) { parts.push("这个版本没有接收地址，不会上传"); }
        if (st.sending) { parts.push("正在上传…"); }
        else if (st.last) {
            parts.push(new Date(st.last.at).toTimeString().slice(0, 5) + (st.last.ok ? " 已上传（编号 " + st.last.id + "）" : " 没传上：" + st.last.why));
        }
        return parts.join(" · ");
    }
    var DIAG_UI = {
        name: function () { return "诊断日志：" + (Diag.enabled() ? "开" : "关"); },
        line: diagLine
    };
    function diagPress(k, repaint) {
        if (k === "diag") {
            Diag.setEnabled(!Diag.enabled());
            Log.report("diag", "诊断日志=" + (Diag.enabled() ? "开" : "关"));
        } else if (Diag.enabled()) {
            Diag.upload(repaint);
        }
        repaint();
    }
    function repaintGridDiag() {
        if (view === "grid" && Grid.zone() === "tabs" && /^diag/.test(Grid.tabKey())) { Grid.refresh(); }
    }
    function paintLoginDiag() {
        $("ld-toggle").textContent = DIAG_UI.name();
        $("ld-toggle").className = "t" + (loginDiag === 0 ? " focus" : "");
        $("ld-upload").className = "t" + (loginDiag === 1 ? " focus" : "");
        $("login-diag-msg").textContent = loginDiag < 0 ? "下键选中" : diagLine(loginDiag ? "diagup" : "diag");
    }
    function repaintLoginDiag() { if (view === "login") { paintLoginDiag(); } }

    /* 「我」：每次进这个标签都重新取（看过的、刚赞的要在里面），焦点先在顶上那一排的「观看历史」。 */
    function showMe() {
        Player.stop();
        pages = [{page: Grid.me(DIAG_UI), feed: null, play: false, resume: null, at: 0, root: true}];
        setView("grid");
        Grid.open(pages[0].page);
    }

    /* 精选：标签自己的网格页。同一页对象一直留着（焦点、取到的列表），视频流是 feeds.jingxuan（带缓存，启动先放缓存里的）。 */
    function showJingxuan() {
        Player.stop();
        if (!jxPage) { jxPage = Grid.jingxuan(function () { return feeds.jingxuan; }); }
        pages = [{page: jxPage, feed: null, play: false, resume: null, at: 0, root: true}];
        setView("grid");
        Grid.open(jxPage);
    }

    function indexOf(key) {
        for (var i = 0; i < TABS.length; i++) { if (TABS[i].key === key) { return i; } }
        return START_TAB;
    }

    // ---------- 标签 ----------

    function enterTab(i, cause) {
        /* 只在已经出画面时记续播点：连按左右键会「路过」一个标签，那一瞬间它还在起播、
         * currentTime 是 0，照记就把原来的续播点冲掉了。放的是网格页的视频时不记（那不是这个标签的）。 */
        if (tab >= 0 && view === "feed" && !pages.length) {
            var st = Player.state();
            if (st.id && st.shown) { resumeAt[TABS[tab].key] = st.t; }
        }
        if (Login.active()) { Login.stop(); }
        if (pages.length) { pages = []; Grid.close(); }
        if (tab >= 0 && TABS[tab].key === "live" && i !== tab) { liveLeftAt = Date.now(); }
        tab = i;
        busy = false;
        markTabs();
        var T = TABS[tab];
        /* 离开直播超过 LIVE_STALE 再回来：那一批直播间多半已经下播了（拉流地址也带着过期时间），接着放就是连着报错跳台、凑满五次还报
         * 「网络问题」。换一批新的。 */
        if (T.key === "live" && liveLeftAt && Date.now() - liveLeftAt > LIVE_STALE) {
            Log.report("标签", "离开直播 " + Math.round((Date.now() - liveLeftAt) / 60000) + " 分钟，换一批直播间");
            feeds.live = Feed.create("live");
            resumeAt.live = 0;
            liveLeftAt = 0;
        }
        Log.report("标签", T.name + "（" + cause + "）");
        if (T.grid) {
            showJingxuan();
            showInfo(true);
            return;
        }
        if ((!T.feed || T.needLogin) && !Account.known()) {
            /* 登录态还没查出来（启动时签名桥在后台起）：先转圈，查到了再进。单独一个 "wait"
             * 视图 —— 冒充 "feed" 的那一版让 1.5 秒后的预热去找「我」的视频流，抛了
             * Cannot read properties of undefined (reading 'peekNext')（设备实测）。 */
            Player.stop();
            setView("wait");
            $("loading").className = "show";
            var waitTab = tab;
            bootReady.then(function () { if (tab === waitTab) { enterTab(waitTab, "登录态已知"); } });
            showInfo(true);
            return;
        }
        if (!T.feed) {
            if (Account.loggedIn()) { showMe(); } else { showLogin("用抖音 App 扫码登录"); }
            showInfo(true);
            return;
        }
        if (T.needLogin && !Account.loggedIn()) {
            showLogin("登录后看你关注的人");
            showInfo(true);
            return;
        }
        setView("feed");
        var cur = feed().current();
        if (cur) { show(cur, resumeAt[T.key] || 0); } else { Player.stop(); next("进入标签"); }
        showInfo(cause !== "启动");
    }

    function moveTab(d) {
        var i = tab + d;
        if (i < 0 || i >= TABS.length) { return; }
        enterTab(i, d > 0 ? "右键" : "左键");
    }

    /* 空页上按确认：这个标签重新来过。 */
    function retryTab() {
        var key = TABS[tab].key;
        feeds[key] = Feed.create(key);
        enterTab(tab, "重试");
    }

    /* 「我」顶上那一排的「退出登录」：按两次确认键。 */
    function logoutPress() {
        if (Date.now() - logoutAt >= 3000) { logoutAt = Date.now(); Grid.say("再按一次确认键退出登录"); return; }
        Grid.say("正在退出…");
        Account.logout().then(function () {
            toast("已退出登录", 2500);
            Feed.clearCache();
            makeFeeds();
            enterTab(indexOf("me"), "退出登录");
        }, function (err) { Grid.say("退出失败：" + err.message); Diag.incident("退出登录失败：" + err.message); });
    }

    function exitPrompt() {
        if (Date.now() - backAt < 2000) {
            try { tizen.application.getCurrentApplication().exit(); } catch (err) {}
        } else {
            backAt = Date.now();
            toast("再按一次返回键退出");
        }
    }

    Player.on("playing", function () {
        errorsInRow = 0;
        if (switchInfo && !switchInfo.playingAt) { switchInfo.playingAt = Date.now(); }
        if (bootStartBridge) { bootStartBridge(); bootStartBridge = null; }
        if (!bootTold) {
            bootTold = true;
            var f = feed();
            Log.report("boot", "第一帧 " + (Date.now() - bootAt) + "ms（签名桥 " + (bootMarks.bridge || "还没好") +
                       " 登录态 " + (bootMarks.account || "还没好") + "）" + (f && f.fromCache() ? " 先放的是缓存（" + f.fromCache() + " 条）" : " 没有缓存，等了推荐接口"));
        }
        schedulePreload();
    });
    /* 播放头真的走起来了才撤封面、放下黑幕（见 player.js）。 */
    /* 滑进来的动画（250ms）没走完不撤封面：MSE 下切换只要 ~0.25 秒，首帧可能赶在动画前面，
     * 这时撤掉就是动画滑到一半突然没了。 */
    var SLIDE_MS = 250;
    Player.on("firstframe", function (how, lateMs) {
        var sw = switchInfo;
        var left = sw && sw.push ? SLIDE_MS + 10 - (Date.now() - sw.at) : 0;
        if (left > 0) {
            setTimeout(function () { if (switchInfo === sw) { uncover(sw, how + "（等动画 " + left + "ms）", lateMs); } }, left);
            return;
        }
        uncover(sw, how, lateMs);
    });
    function uncover(sw, how, lateMs) {
        $("cover").className = "";
        $("mask").className = "";
        clearTimeout(slowTimer);
        $("loading").className = "";
        if (sw && !sw.playing && sw.item.id !== playedId) {
            /* 和官网一样，一开始放就报（Feed.played：播放一次 + 观看历史），服务器才知道这台电视看过它。 */
            playedId = sw.item.id;
            /* 直播间不报、也不当「上一条」：它的编号（room…）不是作品 id，而 history/write 这个接口作废过登录（见 CLAUDE.md）。 */
            if (!sw.item.live) {
                Feed.played(sw.item, {id: watching.id, seen: watching.frac >= 0.95});
                watching = {id: sw.item.id, frac: 0};
            }
        }
        if (sw && !sw.playing) {
            sw.playing = true;
            var ps = Player.state();
            var ar = function (x) { return x ? x.toFixed(2) : "?"; };
            /* 「到画面」那行从换源算起；"cover" 模式换源比按键晚 250ms，模式之间要比就得从按键算。 */
            var rec = {push: sw.push || "无", playing: sw.playingAt ? sw.playingAt - sw.at : -1, frame: Date.now() - sw.at,
                       meta: ps.meta, warm: ps.warm, dur: Math.round(sw.item.dur / 1000), cover: sw.coverMs,
                       seekMs: sw.seekMs, late: lateMs, ff: /^软解/.test(sw.ff || "")};
            records.push(rec);
            if (records.length > 500) { records.shift(); }
            Log.report("封面", (sw.ff && /^软解/.test(sw.ff) ? sw.ff : (sw.coverMs < 0 ? "出画面时图还没到" : "图 " + sw.coverMs + "ms 到") + "（" + (sw.item.coverKind || "缓存条目") + "，" + (sw.ff || "") + "）") +
                       "，比例 封面 " + ar(sw.ar) +
                       " / 接口给的视频 " + ar(sw.item.h ? sw.item.w / sw.item.h : 0) + " / 实际解码 " + ar(ps.vh ? ps.vw / ps.vh : 0) +
                       " | 撤封面：" + how + "，比 playing 晚 " + lateMs + "ms" +
                       " | 按键→playing " + rec.playing + "ms →撤封面 " + rec.frame + "ms" + (sw.push ? " 推(" + sw.push + (sw.seekMs ? "，" + sw.seekMs + "ms 时 seek" : "") + ")" : "") + " " + (ps.engine || "") +
                       (ps.box >= 0 ? " | 改框→撤封面 " + ps.box + "ms" : ""));
        }
    }
    Player.on("ended", function () { next("播完"); });
    Player.on("progress", function (t, d) {
        var it = current();
        if (it && it.live) { return; }             // 那一行是「直播中 · N 人在看」，没有进度
        if (d && Player.state().id === watching.id) { watching.frac = Math.max(watching.frac, t / d); }
        if (d) { $("bar").style.width = (t / d * 100).toFixed(2) + "%"; }
        $("time").textContent = d ? clock(t) + " / " + clock(d) : "";
    });
    Player.on("error", function (why) {
        if (view !== "feed") { return; }
        errorsInRow++;
        var it = feed().current();
        Log.report("播放", "放不了（" + why + "），连续第 " + errorsInRow + " 条 | " + (it ? it.id + " " + Diag.priv(it.desc.slice(0, 16)) : ""));
        if (errorsInRow >= 5) {
            Player.stop();
            trouble("连续好几条都放不了，可能是网络问题。按下键重试", 8000);
            errorsInRow = 0;
            return;
        }
        toast(why === "太慢" ? "这条加载太慢，跳到下一条" : "这条放不了，跳到下一条", 1500);
        setTimeout(function () { next("出错跳过"); }, 800);
    });

    function onKey(e) {
        var k = e.keyCode;
        if (k === KEY.RETURN) {
            /* 返回键一层层退：评论侧栏 → 取消选中 → 从放着的视频回到网格 → 退掉这一页 → 退出应用（按两次）。
             * 「我」是标签自己的页，退不掉：网格里先回到顶上那一排，那一排上再按就是退出。 */
            var e0 = topPage();
            if (Comments.isOpen()) { closeComments(); }
            else if (chip >= 0) { setChip(-1); }
            else if (view === "login" && loginDiag >= 0) { loginDiag = -1; paintLoginDiag(); }
            else if (view === "feed" && e0 && e0.play) { backToGrid(); }
            else if (view === "grid" && !e0.root) { popPage(); }
            else if (view === "grid" && Grid.zone() === "grid" && e0.page.tabs) { Grid.toTabs(); }
            else { exitPrompt(); }
            e.preventDefault();
            return;
        }
        if (view === "grid") {
            if (k === KEY.LEFT) { if (Grid.move(-1, 0) === "left") { moveTab(-1); } }      // 「我」顶上那一排、精选最左边那一列回 "left"
            else if (k === KEY.RIGHT) { if (Grid.move(1, 0) === "right") { moveTab(1); } }        // 只有精选回 "right"
            else if (k === KEY.UP) { Grid.move(0, -1); }
            else if (k === KEY.DOWN) { Grid.move(0, 1); }
            else if (k === KEY.ENTER || k === KEY.PLAY || k === KEY.PLAY_PAUSE) {
                if (Grid.zone() === "tabs") {
                    var tk = Grid.tabKey();
                    if (tk === "logout") { logoutPress(); }
                    else if (tk === "diag" || tk === "diagup") { diagPress(tk, repaintGridDiag); }
                    else { Grid.move(0, 1); }
                }
                else { playFromGrid(); }
            }
            else { return; }
            e.preventDefault();
            return;
        }
        /* 「我」的二维码页：下键选中最底下那一排（诊断日志），选中时左右键在里面换、确认键做、上键 / 返回键取消。 */
        if (view === "login" && loginFor === "me" && (loginDiag >= 0 || k === KEY.DOWN)) {
            if (k === KEY.DOWN) { loginDiag = Math.max(loginDiag, 0); }
            else if (k === KEY.LEFT) { loginDiag = 0; }
            else if (k === KEY.RIGHT) { loginDiag = 1; }
            else if (k === KEY.UP) { loginDiag = -1; }
            else if (k === KEY.ENTER) { diagPress(loginDiag ? "diagup" : "diag", repaintLoginDiag); }
            else { return; }
            paintLoginDiag();
            e.preventDefault();
            return;
        }
        if (view !== "feed") {
            if (k === KEY.LEFT) { moveTab(-1); }
            else if (k === KEY.RIGHT) { moveTab(1); }
            else if (k === KEY.ENTER && view === "empty") { retryTab(); }
            else if (k === KEY.ENTER && view === "login") { startLogin(); }
            else { return; }
            e.preventDefault();
            return;
        }
        /* 评论侧栏开着：上下键翻、确认键展开回复、左键关掉；播放暂停键照样管视频。 */
        if (Comments.isOpen()) {
            if (k === KEY.UP) { Comments.move(-1); }
            else if (k === KEY.DOWN) { Comments.move(1); }
            else if (k === KEY.ENTER) { Comments.enter(); }
            else if (k === KEY.LEFT) { closeComments(); }
            else if (k === KEY.PLAY_PAUSE || k === KEY.PLAY || k === KEY.PAUSE) { togglePause(); if (Comments.isOpen()) { showInfo(); } }
            e.preventDefault();
            return;
        }
        /* 右边那一列（或左下的合集）选中了：方向键在里面走（chipKey），确认键做。 */
        if (chip >= 0) {
            if (k === KEY.UP || k === KEY.DOWN || k === KEY.LEFT || k === KEY.RIGHT) { chipKey(k); }
            else if (k === KEY.ENTER) { doChip(); }
            else if (k === KEY.PLAY_PAUSE || k === KEY.PLAY || k === KEY.PAUSE) { togglePause(); }
            e.preventDefault();
            return;
        }
        var inPage = !!topPage();
        var live = !!(current() && current().live);    // 直播不能快进快退，暂停时左右键照样切标签
        switch (k) {
        case KEY.DOWN:
            /* 暂停时下键是选中右边那一列（从头像开始）。频道减键照旧是下一条。 */
            if (Player.isPaused()) { if (current() && chips(current()).length) { setChip(0); } break; }
            next("下键"); break;
        case KEY.CH_DOWN:
            next("下键"); break;
        case KEY.UP:
            prev(); break;
        case KEY.CH_UP:
            prev(); break;
        case KEY.ENTER:
        case KEY.PLAY_PAUSE: case KEY.PLAY: case KEY.PAUSE:
            togglePause(); break;
        /* 在放网格页的视频时没有标签可切：左右键只把顶上那行「放的是什么 · 返回键回到哪」亮出来。 */
        case KEY.LEFT:
            if (Player.isPaused() && !live) { Player.seek(-10); showInfo(true); } else if (inPage) { showInfo(true); } else { moveTab(-1); }
            break;
        case KEY.RIGHT:
            if (Player.isPaused() && !live) { Player.seek(10); showInfo(true); } else if (inPage) { showInfo(true); } else { moveTab(1); }
            break;
        case KEY.REW:
            if (!live) { Player.seek(-10); } showInfo(); break;
        case KEY.FF:
            if (!live) { Player.seek(10); } showInfo(); break;
        default:
            return;
        }
        e.preventDefault();
    }

    function registerKeys() {
        var want = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaFastForward", "MediaRewind", "ChannelUp", "ChannelDown"];
        for (var i = 0; i < want.length; i++) {
            try { tizen.tvinputdevice.registerKey(want[i]); } catch (e) {}
        }
    }

    window.onload = function () {
        Diag.init({ report: Log.report });
        Log.report("engine", navigator.userAgent);
        /* 服务器还推不推看过的：这些天的累计（见 feed.js 的 watchedReport）。 */
        Log.report("看过", Feed.watchedReport());
        registerKeys();
        document.addEventListener("keydown", onKey);
        Player.init($("va"));
        makeFeeds();
        tab = START_TAB;
        markTabs();
        setView("feed");
        /* 签名桥和登录态在后台起；有缓存的话第一条视频不等它们。
         * 有缓存时还要再让一步：等第一帧出来再起签名桥（最多等 4 秒）。2026-09-29 设备实测：
         * 缓存条目和签名桥同时起步时，那一条光元数据就 2.3 秒、出画面 3.6 秒（平时 1.3–1.5）——
         * 框、三个 SDK、bdms 都在抢这台机器本来就不快的链路，而缓存里还有好几条，桥不急。 */
        var startBridge;
        bootReady = new Promise(function (r) { startBridge = r; }).then(function () {
            return Bridge.ready();
        }).then(function () {
            bootMarks.bridge = Date.now() - bootAt;
        }, function (e) {
            Log.report("bridge", "起不来：" + e.message);
            trouble("连不上抖音：" + e.message, 15000);
        }).then(function () {
            /* 桥失败时 check 也会把登录态标成「已知」，等它的标签不会一直等。 */
            return Account.check("启动");
        }).then(function () {
            bootMarks.account = Date.now() - bootAt;
        });
        if (feeds[TABS[START_TAB].key].fromCache()) {
            bootStartBridge = startBridge;
            setTimeout(startBridge, 4000);
        } else {
            startBridge();
        }
        enterTab(START_TAB, "启动");

        /* 自动更新（update.js，2026-10-20，照搬 bilibili）：先报这次跑的是哪份代码、为什么，每次开机一分钟后查，开着每六小时。
         * 自测构建不查：它会自己换视频、量时间，不该有一个后台下载混进去。 */
        if (typeof SELFTEST === "undefined" || !SELFTEST) {
            try { Update.init({ report: Log.report, notice: function (t) { toast(t, 4000); } }); }
            catch (e) { Log.report("update", "Update.init 抛异常：" + (e && e.message)); }
        }
        /* 这次启动 boot.js 扔掉了一个走不到首页的更新包。观众什么都看不到（照常跑安装包），开发者只能从这里知道。 */
        try {
            var bootNote = Boot.info().note || "";
            if (/标坏|选代码时出错/.test(bootNote)) { Diag.incident("更新包启动失败：" + bootNote); }
        } catch (e) {}
        /* 这次启动的代码是好的：onload 走完、之后两秒没有一个 js 错误。boot.js 见到这句才清掉 booting；
         * 没说这句的启动，下次打开把它跑的那个更新标坏、改跑安装包。不等第一条视频 —— 断网时视频出不来，
         * 那不是代码坏了，不该为此扔掉一个好版本。跑的是安装包时无害。 */
        setTimeout(function () {
            if (Log.errors()) {
                Log.report("update", "启动后两秒内出过 " + Log.errors() + " 次 js 错误，这次启动不算成功（跑的是更新的话，下次打开退回安装包）");
                return;
            }
            try { Boot.ok(); } catch (e) {}
        }, 2000);
    };

    /* 给自测读的：现在在哪个标签、哪种页面。 */
    window.__app = {
        tab: function () { return TABS[tab].key; },
        view: function () { return view; },
        /* 最上面那一页是哪种（"author" / "me" / "mix"），没有页是 ""；叠了几层。 */
        page: function () { var e = topPage(); return e ? e.page.kind : ""; },
        depth: function () { return pages.length; },
        inAuthor: function () { var e = topPage(); return !!e && e.page.kind === "author"; },
        chip: function () { return chip >= 0 ? chips(current())[chip] : ""; },
        /* 自测 --like 用：把点赞、收藏放出来。 */
        enableActs: function () { actTest = true; },
        pos: function () { return feed() ? feed().position() : -1; },
        current: current,
        /* README 截图脚本：拿到正在放的视频流，往它后面插一条指定的视频。 */
        feedNow: function () { return feed(); },
        /* 自测 --ab 用：轮换切换方式、读每次切换的计时。 */
        setPush: function (m) { PUSH_MODE = m; },
        setCoverSeek: function (ms) { COVER_SEEK_MS = ms; },
        records: function () { return records; },
        /* 自测 --diag 用：二维码页最底下那一排选中了哪一项。 */
        loginDiag: function () { return loginDiag; }
    };
})();
