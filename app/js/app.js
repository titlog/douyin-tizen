/* 界面与遥控器。
 *
 * 顶部四个标签：精选 · 推荐 · 关注 · 我（像抖音 App 横滑切标签）。前三个是视频流，每个标签
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
        {key: "recommend", name: "推荐", feed: true},
        {key: "follow", name: "关注", feed: true, needLogin: true},
        {key: "me", name: "我", feed: false}
    ];
    var START_TAB = 1;

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
    var paintToken = 0;
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

    /* 信息层（作者、标题、进度）和标签栏一起出现、一起淡出；非视频页上标签栏常驻。 */
    function showInfo() {
        $("info").className = view === "feed" ? "show" : "";
        $("tabs").className = "show";
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

    /* 竖屏视频两侧的那层：封面画进 48×27 的 canvas，CSS 拉伸到全屏 —— 缩小就是模糊。
     *
     * **切换时画面上不许有 CSS 滤镜。** 2026-09-29 在设备上同一轮里轮换几种做法比较（排除
     * 网络波动），每种 5–6 个样本，按下到出画面的中位数：
     *   背景 CSS blur(40px)  2575ms    小画布 1256ms    没有背景 1233ms
     *   再盖一层 blur 封面   3673ms    （不模糊的封面层只多 ~100ms）
     * 模糊滤镜每换一次图就要在这块 GPU 上重新光栅化一张 2000 像素的图，和解码器抢时间。
     * 只画不读，跨域图片把 canvas 弄脏也无所谓。 */
    function paintBackground(url) {
        var bgCanvas = $("bgc");
        var ctx = bgCanvas.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
        var token = ++paintToken;
        if (!url) { return; }
        var img = new Image();
        img.onload = function () {
            if (token !== paintToken) { return; }        // 图到的时候观众已经切走了
            /* cover 式裁切：短边铺满。 */
            var cw = bgCanvas.width, ch = bgCanvas.height;
            var sc = Math.max(cw / img.width, ch / img.height);
            var w = img.width * sc, h = img.height * sc;
            ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
        };
        img.src = url;
    }

    function render(item) {
        $("author").textContent = item.author ? "@" + item.author : "";
        $("desc").textContent = item.desc;
        $("stats").textContent = "♥ " + count(item.likes) + "   💬 " + count(item.comments);
        paintBackground(item.cover);
        /* 解码器只有一个，出画面要 ~1.2 秒；屏幕必须在按键那一刻就变 —— 先盖上这一条的
         * 封面（不带模糊，见 paintBackground），出画面再撤。 */
        $("cover").lastChild.style.backgroundImage = item.cover ? "url(\"" + item.cover + "\")" : "none";
        $("cover").className = "show";
        $("bar").style.width = "0";
        $("paused").className = "";
        showInfo();
    }

    function show(item, startAt) {
        render(item);
        clearTimeout(preloadTimer);
        Player.play(item, TABS[tab].name, startAt);
    }

    /* 画面起来 1.5 秒后再预热下一条（只是 XHR，不碰解码器，见 player.js）：别和正在起播的
     * 这一条抢这台机器不快的链路。 */
    function schedulePreload() {
        clearTimeout(preloadTimer);
        preloadTimer = setTimeout(function () {
            if (view !== "feed" || !feed()) { return; }
            var nx = feed().peekNext();
            if (nx) {
                Player.preload(nx);
                if (nx.cover) { (new Image()).src = nx.cover; }
            }
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
            show(item);
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
        show(item);
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
            showInfo();
            return;
        }
        if (!T.feed) {
            if (Account.loggedIn()) { showMe(); } else { showLogin("用抖音 App 扫码登录"); }
            showInfo();
            return;
        }
        if (T.needLogin && !Account.loggedIn()) {
            showLogin("登录后看你关注的人");
            showInfo();
            return;
        }
        setView("feed");
        var cur = feed().current();
        if (cur) { show(cur, resumeAt[T.key] || 0); } else { Player.stop(); next("进入标签"); }
        showInfo();
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
        if (bootStartBridge) { bootStartBridge(); bootStartBridge = null; }
        if (!bootTold) {
            bootTold = true;
            var f = feed();
            Log.report("boot", "第一帧 " + (Date.now() - bootAt) + "ms（签名桥 " + (bootMarks.bridge || "还没好") +
                       " 登录态 " + (bootMarks.account || "还没好") + "）" + (f && f.fromCache() ? " 先放的是缓存（" + f.fromCache() + " 条）" : " 没有缓存，等了推荐接口"));
        }
        $("cover").className = "";
        schedulePreload();
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
            showInfo();
            break;
        case KEY.LEFT:
            if (Player.isPaused()) { Player.seek(-10); showInfo(); } else { moveTab(-1); }
            break;
        case KEY.RIGHT:
            if (Player.isPaused()) { Player.seek(10); showInfo(); } else { moveTab(1); }
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
        pos: function () { return feed() ? feed().position() : -1; }
    };
})();
