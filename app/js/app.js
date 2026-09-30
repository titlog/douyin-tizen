/* 界面与遥控器。
 *
 * 顶部四个标签：精选 · 关注 · 推荐 · 我（默认进推荐）（像抖音 App 横滑切标签）。前三个是视频流，每个标签
 * 各记各的位置，切回来接着看；「我」是登录 / 账号页。未登录时「关注」也显示扫码登录。
 *
 * 遥控器：
 *   下键 / 频道减 → 下一条        上键 / 频道加 → 上一条
 *   左右键 → 切标签（暂停时改为快退 / 快进 10 秒）
 *   快进 / 快退键 → 任何时候都快进 / 快退 10 秒
 *   确认 / 播放暂停键 → 暂停；在「我」页上是退出登录（按两次）
 *   返回键按两次 → 退出
 * 竖屏视频居中、两侧垫一层模糊的封面；横屏视频铺满。
 */
(function () {
    "use strict";

    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, RETURN: 10009,
        PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19, FF: 417, REW: 412,
        CH_UP: 427, CH_DOWN: 428
    };

    var TABS = [
        {key: "jingxuan", name: "精选", feed: true},
        {key: "follow", name: "关注", feed: true, needLogin: true},
        {key: "recommend", name: "推荐", feed: true},
        {key: "me", name: "我", feed: false}
    ];
    var START_TAB = 2;         // 默认进「推荐」

    var $ = function (id) { return document.getElementById(id); };
    var tab = -1;
    var feeds = {};
    var resumeAt = {};
    var view = "";            // "feed" | "login" | "me" | "empty" | "wait"
    var busy = false;
    var errorsInRow = 0;
    var preloadTimer = 0;
    var infoTimer = 0;
    var backAt = 0;
    var logoutAt = 0;
    var loginFor = "";        // 登录是从哪个标签发起的，成功后回到那里
    var switchInfo = null;    // 这一次切换：封面图什么时候到、比例多少（「封面」那行日志用）
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
     * 两轮都不比 cover 慢，默认改为 "early"。 */
    var PUSH_MODE = "early";
    var records = [];         // 每次切换的计时，自测 --ab 读
    var bootAt = Date.now();
    var bootMarks = {};
    var bootTold = false;
    var bootReady = null;     // 签名桥 + 登录态；「关注」「我」要等它
    var bootStartBridge = null;   // 有缓存时，第一帧出来就调它起签名桥

    function makeFeeds() {
        feeds = {};
        resumeAt = {};
        for (var i = 0; i < TABS.length; i++) { if (TABS[i].feed) { feeds[TABS[i].key] = Feed.create(TABS[i].key); } }
    }
    function feed() { return feeds[TABS[tab].key]; }

    function toast(msg, ms) {
        var t = $("toast");
        t.textContent = msg;
        t.className = "show";
        clearTimeout(toast.timer);
        toast.timer = setTimeout(function () { t.className = ""; }, ms || 2000);
    }

    /* 信息层（作者、标题、进度）每次换视频都出来；标签栏只在切标签、暂停时出来 —— 上下刷的
     * 时候顶部冒出导航是打扰（2026-09-29 用户反馈）。暂停期间和非视频页上标签栏常驻。 */
    function showInfo(withTabs) {
        $("info").className = view === "feed" ? "show" : "";
        $("tabs").className = withTabs || view !== "feed" || Player.isPaused() ? "show" : "";
        clearTimeout(infoTimer);
        infoTimer = setTimeout(function () {
            if (view === "feed" && !Player.isPaused()) { $("info").className = ""; $("tabs").className = ""; }
        }, 5000);
    }

    function markTabs() {
        var html = "";
        for (var i = 0; i < TABS.length; i++) {
            html += "<span class=\"tab" + (i === tab ? " on" : "") + "\">" + TABS[i].name + "</span>";
        }
        $("tabs").innerHTML = html;
    }

    function setView(v) {
        view = v;
        $("login").className = v === "login" ? "show" : "";
        $("me").className = v === "me" ? "show" : "";
        $("empty").className = v === "empty" ? "show" : "";
        if (v !== "feed") {
            $("cover").className = "";
            clearTimeout(pushTimer);
            resetSlide($("va"));
            resetSlide($("cover"));
            $("mask").className = "";
            $("info").className = "";
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
    function render(item, dir, push) {
        $("author").textContent = item.author ? "@" + item.author : "";
        $("desc").textContent = item.desc;
        $("stats").textContent = "♥ " + count(item.likes) + "   💬 " + count(item.comments);
        var sw = switchInfo = {at: Date.now(), item: item, coverMs: -1, ar: 0, playing: false, playingAt: 0, push: push};
        /* 推的时候旧画面还在，黑幕不能先盖上去 —— "cover"/"video" 在换源那一刻（show 里）再盖；
         * "early" 不用黑幕：滑进来的是一整屏黑底 + 封面，滑到位就把旧画面全盖住了。 */
        if (!push) { $("mask").className = "over"; }
        var box = fitBox(item.w, item.h);
        var cv = $("cover");
        var im = cv.lastChild;
        im.style.left = box.l + "px"; im.style.top = box.t + "px";
        im.style.width = box.w + "px"; im.style.height = box.h + "px";
        im.style.backgroundImage = "none";
        cv.className = push === "early" ? "show solid" : "show";
        resetSlide(cv);
        resetSlide(im);
        slideIn(push === "early" ? cv : im, dir);
        if (item.cover) {
            var img = new Image();
            img.onload = function () {
                if (switchInfo !== sw) { return; }         // 图到的时候观众已经切走了
                sw.coverMs = Date.now() - sw.at;
                sw.ar = img.width / img.height;
                if (!sw.playing) { im.style.backgroundImage = "url(\"" + item.cover + "\")"; }
            };
            img.src = item.cover;
        }
        $("bar").style.width = "0";
        $("paused").className = "";
        $("progress").className = "";
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
        clearTimeout(pushTimer);
        resetSlide(v);
        var ps = Player.state();
        var push = !!dir && ps.shown && !!ps.vw ? PUSH_MODE : "";
        render(item, dir, push);
        if (!push || push === "early") {
            Player.play(item, TABS[tab].name + (push ? "·推(early)" : ""), startAt);
            return;
        }
        if (push === "video") { slideOut(v, dir); }
        pushTimer = setTimeout(function () {
            $("mask").className = "over";
            resetSlide(v);
            Player.play(item, TABS[tab].name + "·推(" + PUSH_MODE + ")", startAt);
        }, 250);
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
            if (nx.cover) { (new Image()).src = nx.cover; }
        };
        preloadTimer = setTimeout(function () {
            warmOne(1);
            preloadTimer = setTimeout(function () { warmOne(2); }, 2000);
        }, 1500);
    }

    function next(cause) {
        if (busy || view !== "feed") { return; }
        busy = true;
        var f = feed();
        var myTab = tab;
        if (!f.peekNext()) { $("loading").className = "show"; }
        f.next().then(function (item) {
            busy = false;
            if (tab !== myTab || view !== "feed") { return; }   // 等的时候观众切走了
            $("loading").className = "";
            Log.report("播放", f.name + " #" + f.position() + " " + cause + " " + item.id + " " + (item.author || "") + " " +
                       item.desc.slice(0, 20) + " " + item.w + "x" + item.h + " " + Math.round(item.dur / 1000) + "s");
            show(item, 0, cause === "下键" || cause === "播完" ? "up" : "");
        }, function (e) {
            busy = false;
            if (tab !== myTab || view !== "feed") { return; }
            $("loading").className = "";
            Log.report("feed", f.name + " 取不到下一条：" + e.message);
            if (f.isEmpty()) {
                $("empty-msg").textContent = f.kind === "follow" ? "你关注的人最近没有新视频" : "这里暂时没有内容（" + e.message + "）";
                Player.stop();
                setView("empty");
            } else {
                toast(f.name + "加载失败，按下键重试", 4000);
            }
        });
    }

    function prev() {
        var item = feed().prev();
        if (!item) { toast("已经是第一条了"); return; }
        Log.report("播放", feed().name + " #" + feed().position() + " 上一条 " + item.id);
        show(item, 0, "down");
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
                    $("login-msg").textContent = "登录好像没有成功，3 秒后换一张二维码";
                    setTimeout(function () { if (view === "login") { startLogin(); } }, 3000);
                    return;
                }
                toast("登录成功", 2500);
                Feed.clearCache();
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
        startLogin();
    }

    function showMe() {
        Player.stop();
        setView("me");
        $("me-msg").textContent = "已登录抖音";
        $("me-hint").textContent = "推荐和关注用的是你的账号。按确认键退出登录";
    }

    function indexOf(key) {
        for (var i = 0; i < TABS.length; i++) { if (TABS[i].key === key) { return i; } }
        return START_TAB;
    }

    // ---------- 标签 ----------

    function enterTab(i, cause) {
        /* 只在已经出画面时记续播点：连按左右键会「路过」一个标签，那一瞬间它还在起播、
         * currentTime 是 0，照记就把原来的续播点冲掉了。 */
        if (tab >= 0 && view === "feed") {
            var st = Player.state();
            if (st.id && st.shown) { resumeAt[TABS[tab].key] = st.t; }
        }
        if (Login.active()) { Login.stop(); }
        tab = i;
        busy = false;
        markTabs();
        var T = TABS[tab];
        Log.report("标签", T.name + "（" + cause + "）");
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

    function logout() {
        $("me-hint").textContent = "正在退出…";
        Account.logout().then(function () {
            toast("已退出登录", 2500);
            Feed.clearCache();
            makeFeeds();
            enterTab(indexOf("me"), "退出登录");
        }, function (err) { $("me-hint").textContent = "退出失败：" + err.message; });
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
    Player.on("firstframe", function (how, lateMs) {
        $("cover").className = "";
        $("mask").className = "";
        var sw = switchInfo;
        if (sw && !sw.playing) {
            sw.playing = true;
            var ps = Player.state();
            var ar = function (x) { return x ? x.toFixed(2) : "?"; };
            /* 「到画面」那行从换源算起；"cover" 模式换源比按键晚 250ms，模式之间要比就得从按键算。 */
            var rec = {push: sw.push || "无", playing: sw.playingAt ? sw.playingAt - sw.at : -1, frame: Date.now() - sw.at,
                       meta: ps.meta, warm: ps.warm, dur: Math.round(sw.item.dur / 1000)};
            records.push(rec);
            if (records.length > 500) { records.shift(); }
            Log.report("封面", (sw.coverMs < 0 ? "出画面时图还没到" : "图 " + sw.coverMs + "ms 到") + "（" + (sw.item.coverKind || "缓存条目") + "），比例 封面 " + ar(sw.ar) +
                       " / 接口给的视频 " + ar(sw.item.h ? sw.item.w / sw.item.h : 0) + " / 实际解码 " + ar(ps.vh ? ps.vw / ps.vh : 0) +
                       " | 撤封面：" + how + "，比 playing 晚 " + lateMs + "ms" +
                       " | 按键→playing " + rec.playing + "ms →撤封面 " + rec.frame + "ms" + (sw.push ? " 推(" + sw.push + ")" : ""));
        }
    });
    Player.on("ended", function () { next("播完"); });
    Player.on("progress", function (t, d) {
        if (d) { $("bar").style.width = (t / d * 100).toFixed(2) + "%"; }
        $("time").textContent = d ? clock(t) + " / " + clock(d) : "";
    });
    Player.on("error", function (why) {
        if (view !== "feed") { return; }
        errorsInRow++;
        var it = feed().current();
        Log.report("播放", "放不了（" + why + "），连续第 " + errorsInRow + " 条 | " + (it ? it.id + " " + it.desc.slice(0, 16) : ""));
        if (errorsInRow >= 5) {
            Player.stop();
            toast("连续好几条都放不了，可能是网络问题。按下键重试", 8000);
            errorsInRow = 0;
            return;
        }
        toast("这条放不了，跳到下一条", 1500);
        setTimeout(function () { next("出错跳过"); }, 800);
    });

    function onKey(e) {
        var k = e.keyCode;
        if (k === KEY.RETURN) {
            if (Date.now() - backAt < 2000) {
                try { tizen.application.getCurrentApplication().exit(); } catch (err) {}
            } else {
                backAt = Date.now();
                toast("再按一次返回键退出");
            }
            e.preventDefault();
            return;
        }
        if (view !== "feed") {
            if (k === KEY.LEFT) { moveTab(-1); }
            else if (k === KEY.RIGHT) { moveTab(1); }
            else if (k === KEY.ENTER && view === "me") {
                if (Date.now() - logoutAt < 3000) { logout(); }
                else { logoutAt = Date.now(); $("me-hint").textContent = "再按一次确认键退出登录"; }
            } else if (k === KEY.ENTER && view === "empty") { retryTab(); }
            else if (k === KEY.ENTER && view === "login") { startLogin(); }
            else { return; }
            e.preventDefault();
            return;
        }
        switch (k) {
        case KEY.DOWN: case KEY.CH_DOWN:
            next("下键"); break;
        case KEY.UP: case KEY.CH_UP:
            prev(); break;
        case KEY.ENTER: case KEY.PLAY_PAUSE: case KEY.PLAY: case KEY.PAUSE:
            var p = Player.toggle();
            $("paused").className = p ? "show" : "";
            $("progress").className = p ? "show" : "";
            showInfo(p);
            break;
        case KEY.LEFT:
            if (Player.isPaused()) { Player.seek(-10); showInfo(true); } else { moveTab(-1); }
            break;
        case KEY.RIGHT:
            if (Player.isPaused()) { Player.seek(10); showInfo(true); } else { moveTab(1); }
            break;
        case KEY.REW:
            Player.seek(-10); showInfo(); break;
        case KEY.FF:
            Player.seek(10); showInfo(); break;
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
        Log.report("engine", navigator.userAgent);
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
            toast("连不上抖音：" + e.message, 15000);
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
    };

    /* 给自测读的：现在在哪个标签、哪种页面。 */
    window.__app = {
        tab: function () { return TABS[tab].key; },
        view: function () { return view; },
        pos: function () { return feed() ? feed().position() : -1; },
        /* 自测 --ab 用：轮换切换方式、读每次切换的计时。 */
        setPush: function (m) { PUSH_MODE = m; },
        records: function () { return records; }
    };
})();
