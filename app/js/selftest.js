/* 设备上的自动走查。只在 `zsh tools/deploy.sh --selftest` 打出来的构建里开（SELFTEST=true）。
 *
 * 派发和遥控器一样的 keydown 事件，把「刷」的每个动作走一遍，每步上报 PASS/FAIL。
 * 判据全部来自播放头本身（currentTime 在不在走），不看界面说了什么 —— 第一版的卡死就是
 * 界面一切正常、播放头停在 2 秒。
 *
 * ⚠️ 自测构建会自己换视频、自己暂停。看片之前装回正常构建：zsh tools/deploy.sh
 */
(function () {
    "use strict";
    if (typeof SELFTEST === "undefined" || !SELFTEST) { return; }

    var KEY = { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, ENTER: 13, FF: 417, RETURN: 10009 };
    var fails = 0, steps = 0;

    function key(code) {
        var e = document.createEvent("Event");
        e.initEvent("keydown", true, true);
        e.keyCode = code;
        document.dispatchEvent(e);
    }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function st() { return Player.state(); }
    function check(name, ok, detail) {
        steps++;
        if (!ok) { fails++; }
        Log.report("SELFTEST", (ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
    }
    /* 等到出画面（换了 id 且 shown），最多 ms。 */
    function waitShown(prevId, ms) {
        var t0 = Date.now();
        function poll() {
            var s = st();
            if (s.id && s.id !== prevId && s.shown) { return Promise.resolve(Date.now() - t0); }
            if (Date.now() - t0 > ms) { return Promise.resolve(-1); }
            return wait(200).then(poll);
        }
        return poll();
    }
    /* 等这一条出画面。挑的那条可能正好是进来前看的那条（设备自测撞上过），不能用「换了 id」判。 */
    function waitId(id, ms) {
        var t0 = Date.now();
        function poll() {
            var s = st();
            if (s.id === id && s.shown) { return Promise.resolve(Date.now() - t0); }
            if (Date.now() - t0 > ms) { return Promise.resolve(-1); }
            return wait(200).then(poll);
        }
        return poll();
    }
    /* 播放头在 ms 内前进了多少秒。 */
    function advance(ms) {
        var a = st();
        return wait(ms).then(function () { var b = st(); return b.id === a.id ? b.t - a.t : -999; });
    }

    /* 最长的一段「同一条、已出画面、没暂停、播放头不动」有多长。短视频播完自动换下一条
     * 不算卡 —— 第一版自测把 6 秒长的视频播完读成了失败。 */
    function longestStall(ms) {
        var t0 = Date.now(), worst = 0, since = 0, last = st();
        function poll() {
            if (Date.now() - t0 >= ms) { return Promise.resolve(Math.max(worst, since ? Date.now() - since : 0)); }
            return wait(250).then(function () {
                var s = st();
                var frozen = s.id === last.id && s.shown && !s.paused && s.t === last.t;
                if (frozen) { if (!since) { since = Date.now(); } } else if (since) { worst = Math.max(worst, Date.now() - since); since = 0; }
                last = s;
                return poll();
            });
        }
        return poll();
    }
    /* 需要一条稳定的视频来测连续播放、暂停、快进时，先刷到一条一分钟以上的。 */
    function ensureLong() {
        var n = 0;
        function go() {
            var s = st();
            if (s.shown && s.dur > 60 && s.dur - s.t > 40) { return Promise.resolve(true); }
            if (n++ >= 8) { return Promise.resolve(false); }
            var before = s.id;
            key(KEY.DOWN);
            return waitShown(before, 15000).then(function () { return wait(500); }).then(go);
        }
        return go();
    }

    /* 等登录页上的二维码真的出现（img 有 src 且可见）。 */
    function waitQr(ms) {
        var t0 = Date.now();
        function poll() {
            var q = document.getElementById("qr");
            /* 要真的解码出来（naturalWidth > 0）—— 只看 src 和可见性，会把破图标判成 PASS。 */
            if (q && q.src && q.style.visibility === "visible" && q.complete && q.naturalWidth > 0) { return Promise.resolve(Date.now() - t0); }
            if (Date.now() - t0 > ms) { return Promise.resolve(-1); }
            return wait(300).then(poll);
        }
        return poll();
    }

    function tabsShown() { return document.getElementById("tabs").className === "show"; }
    /* 切标签（2026-10-22 起视频页上左右键是快进快退）：先到顶上的标签栏 —— 视频页暂停后上键，网格页一路往上，二维码 / 空页上键 ——
     * 再按 n 次左 / 右，最后下键回来。 */
    function viaTabs(code, n) {
        if (!window.__app.tabFocus()) {
            var v = window.__app.view();
            if (v === "feed") { if (!st().paused) { key(KEY.ENTER); } key(KEY.UP); }
            else if (v === "grid") { for (var i = 0; i < 10 && !window.__app.tabFocus(); i++) { key(KEY.UP); } }
            else { key(KEY.UP); }
        }
        for (var j = 0; j < (n || 1); j++) { key(code); }
        key(KEY.DOWN);
    }

    /* 作者主页：暂停 → 下键选中作者 → 确认进主页 → 网格里挑第二条放 → 下键到第三条 → 返回回网格 → 返回回到原来那一条。
     * **返回键只在作者主页里按** —— 普通视频页上连按两次返回就退出应用了，所以每次按之前先看自己在哪。 */
    function authorSteps() {
        var from = st(), fromTab = window.__app.tab();
        var t0;
        function inAuthorNow() { return window.__app.inAuthor(); }
        key(KEY.ENTER);
        return wait(800).then(function () {
            key(KEY.DOWN);
            return wait(500);
        }).then(function () {
            var s1 = st();
            var av = document.getElementById("act-author");
            var focused = /\bfocus\b/.test(av.className) && av.offsetWidth > 0;
            check("暂停时下键选中右边的头像（不换视频）", focused && s1.paused && s1.id === from.id,
                  "头像=" + (focused ? "亮了" : "没亮") + "（图 " + document.getElementById("rail-avatar").naturalWidth + "px）" + "，暂停=" + s1.paused + "，同一条=" + (s1.id === from.id) +
                  "，旁边「" + av.textContent + "」，提示=" + document.getElementById("hint").textContent);
            if (!focused) { throw new Error("没选中作者，后面的作者主页步骤不跑了"); }
            key(KEY.ENTER);
            t0 = Date.now();
            function poll() {
                var a = Grid.state();
                if (a && a.cards > 0 && a.imgs > 0 && (a.stats || Date.now() - t0 > 8000)) { return Promise.resolve(Date.now() - t0); }
                if (Date.now() - t0 > 20000) { return Promise.resolve(-1); }
                return wait(300).then(poll);
            }
            return poll();
        }).then(function (ms) {
            var a = Grid.state() || {};
            /* 看得见的结果：卡片的封面真的解码出来了、头部有数字。 */
            check("确认进作者主页、出网格", window.__app.view() === "grid" && ms >= 0 && !!a.stats,
                  ms + "ms，@" + a.name + "，" + a.cards + " 张卡片、封面解码 " + a.imgs + "，头像 " + a.avatar + "px，「" + a.stats + "」" + (a.foot ? "，底下「" + a.foot + "」" : ""));
            if (!a.cards) { throw new Error("网格没出来：" + JSON.stringify(a)); }
            if (a.cards < 3) { return null; }
            key(KEY.RIGHT);
            return wait(400).then(function () {
                var want = Grid.feed().all()[1].id;
                key(KEY.ENTER);
                return waitId(want, 15000).then(function (ms2) {
                    return longestStall(5000).then(function (stall) {
                        check("网格里挑一条能播", st().id === want && ms2 >= 0 && stall < 3000 && window.__app.view() === "feed",
                              "出画面 " + ms2 + "ms，是挑的那条=" + (st().id === want) + "，最长停顿 " + stall + "ms");
                    });
                });
            }).then(function () {
                var want = Grid.feed().all()[2].id;
                key(KEY.DOWN);
                return waitId(want, 15000).then(function (ms3) {
                    return longestStall(4000).then(function (stall) {
                        check("在 TA 的作品里下一条", st().id === want && ms3 >= 0 && stall < 3000,
                              "出画面 " + ms3 + "ms，是 TA 的第 3 个=" + (st().id === want) + "，最长停顿 " + stall + "ms");
                    });
                });
            });
        }).then(function () {
            if (!inAuthorNow() || window.__app.view() !== "feed") { return; }
            key(KEY.RETURN);
            return wait(800).then(function () {
                var a = Grid.state() || {};
                check("返回键回到网格、焦点在刚才那条", window.__app.view() === "grid" && a.sel === 2, "视图=" + window.__app.view() + "，焦点 #" + a.sel);
            });
        }).then(function () {
            /* 一直往下翻：快到底了会取下一页。匿名时第二页只回 {"status_code":0}（测试台实测）；登录后给不给，就看这一步。 */
            if (window.__app.view() !== "grid") { return; }
            var n0 = Grid.state().cards, i = 0;
            function down() {
                if (i++ >= 5) { return Promise.resolve(); }
                key(KEY.DOWN);
                return wait(700).then(down);
            }
            return down().then(function () { return wait(4000); }).then(function () {
                var a = Grid.state(), f = Grid.feed();
                var ok = a.cards > n0 || (!f.hasMore() && !(f.gated() && Account.loggedIn()));
                check("网格往下翻取下一页", ok, "卡片 " + n0 + " → " + a.cards + "，还有更多=" + f.hasMore() + "，第二页只回了 status_code=" + f.gated() +
                      "，" + (Account.loggedIn() ? "已登录" : "未登录") + "，焦点 #" + a.sel + "，底下「" + a.foot + "」");
            });
        }).then(function () {
            if (window.__app.view() !== "grid") { return; }
            key(KEY.RETURN);
            return waitShown("", 15000).then(function (ms) {
                return wait(1500).then(function () { return advance(2500); }).then(function (adv) {
                    var s2 = st();
                    check("再按返回回到原来那一条接着放", !inAuthorNow() && window.__app.tab() === fromTab && s2.id === from.id && s2.t >= from.t - 1 && adv > 1.5,
                          "出画面 " + ms + "ms，标签=" + window.__app.tab() + "，同一条=" + (s2.id === from.id) + "，离开时 " + from.t.toFixed(1) + "s，现在 " + s2.t.toFixed(1) + "s，2.5 秒前进 " + adv.toFixed(1) + "s");
                });
            });
        });
    }

    function switchStep(label, code) {
        var before = st().id;
        key(code);
        /* 上下刷时顶部导航不出来（用户要求：只在暂停和左右键时出来）。 */
        var tabsAfterKey = tabsShown();
        return waitShown(before, 15000).then(function (ms) {
            return longestStall(6000).then(function (stall) {
                check(label, ms >= 0 && stall < 3000 && !tabsAfterKey, "出画面 " + ms + "ms，之后 6 秒里最长停顿 " + stall + "ms，导航" + (tabsAfterKey ? "出来了（不该）" : "没出来"));
            });
        });
    }

    function run() {
        Log.report("SELFTEST", "开始");
        return waitShown("", 40000).then(function (ms) {
            check("启动出画面", ms >= 0, "从自测开始等了 " + ms + "ms");
            /* 起都没起来，后面每一步都只会重复同一个失败 —— 停下，别拿它刷日志。 */
            if (ms < 0) {
                var z = st();
                throw new Error("启动就没出画面，后面的步骤不跑了。播放器：" + JSON.stringify(z) + " 视图=" + window.__app.view() +
                                " 遮罩=" + document.getElementById("mask").className + " 封面=" + document.getElementById("cover").className);
            }
            return ensureLong();
        }).then(function () { return advance(20000); }).then(function (adv) {
            check("长视频连续播 20 秒", adv > 17, "前进 " + adv.toFixed(1) + "s（旧版两个 <video> 时这里是 ~2s 后冻住）");
        }).then(function () { return switchStep("下一条 #1", KEY.DOWN); })
          .then(function () { return switchStep("下一条 #2", KEY.DOWN); })
          .then(function () { return switchStep("下一条 #3", KEY.DOWN); })
          .then(function () { return switchStep("上一条", KEY.UP); })
          .then(ensureLong)
          .then(function () {
            key(KEY.ENTER);
            var tabsOnPause = tabsShown();
            return wait(1000).then(function () { return advance(3000); }).then(function (adv) {
                check("暂停后不走、导航出来", Math.abs(adv) < 0.3 && st().paused && tabsOnPause, "3 秒前进 " + adv.toFixed(2) + "s，导航" + (tabsOnPause ? "出来了" : "没出来（该出来）"));
                key(KEY.ENTER);
                return wait(1000).then(function () { return advance(3000); });
            }).then(function (adv) {
                check("继续后在走", adv > 2, "3 秒前进 " + adv.toFixed(1) + "s");
            });
        }).then(function () {
            /* 暂停着跳到没缓冲的地方，再连按两下：play() 要等数据才落定，先被 pause() 打断，拒绝没人接就是「未处理的 Promise 异常」、
             * 当出事上传（2026-10-23 一台电视快进着按暂停）。有数据时打断不了：这台电视上暂停着 play() 紧跟 pause()，play() 照样成功
             * （第一版这一步就这么测的，对照答「成功」）。所以对照也在同一刻做：元素上 play() 紧跟 pause() 得是 AbortError，「不报错」才算数。 */
            var rejected = [], control = "没落定", ready = -1;
            function onRejection(e) { rejected.push(e.reason && e.reason.name ? e.reason.name : String(e.reason)); }
            key(KEY.ENTER);
            return wait(800).then(function () {
                var s = st(), to = Math.max(s.t, s.buffered) + 12;
                if (to > s.dur - 4) { return "这条剩下的都缓冲了（" + s.t.toFixed(0) + "/" + s.dur.toFixed(0) + "s），没处可跳"; }
                Player.seek(to - s.t);
                return wait(150).then(function () {
                    window.addEventListener("unhandledrejection", onRejection);
                    ready = st().readyState;
                    key(KEY.ENTER);
                    key(KEY.ENTER);
                    var v = document.getElementById("va");
                    var pr = v.play();
                    v.pause();
                    if (!pr || !pr.catch) { control = "play() 不返回 Promise"; }
                    else { pr.catch(function (e) { control = e.name; return control; }).then(function (r) { if (r === undefined) { control = "成功"; } }); }
                    return wait(1500);
                }).then(function () { window.removeEventListener("unhandledrejection", onRejection); return ""; });
            }).then(function (skip) {
                check("跳到没缓冲的地方连按两下不报错", !skip && !rejected.length && st().paused && control === "AbortError",
                      skip || "未处理的 Promise 异常 " + rejected.length + " 个" + (rejected.length ? "（" + rejected.join("、") + "）" : "") + "，暂停=" + st().paused +
                      "，按的时候 readyState=" + ready + "，对照（元素上 play() 紧跟 pause()）：" + control);
                key(KEY.ENTER);
                return wait(1000).then(function () { return advance(3000); });
            }).then(function (adv) {
                check("再按一下接着走", adv > 2, "3 秒前进 " + adv.toFixed(1) + "s");
            });
        }).then(ensureLong).then(function () {
            var a = st().t;
            key(KEY.FF);
            return wait(1500).then(function () {
                var b = st().t;
                /* 快进对齐到最近的关键帧（mse.js 的 seekTo），±10 秒实际落在 ±6.5–13.5 秒；播着量，再加上等的 1.5 秒（2026-10-22 电视上 +14.1 判错过）。 */
                check("快进键 +10 秒", b - a > 6 && b - a < 15.5, a.toFixed(1) + " → " + b.toFixed(1));
            });
        }).then(function () {
            /* 左右键：暂停时快进（这里），播着的时候也是快进（下面）；切标签在暂停后上键的标签栏里（2026-10-22 起）。 */
            key(KEY.ENTER);
            return wait(800).then(function () {
                var a = st().t;
                key(KEY.RIGHT);
                return wait(1500).then(function () {
                    var b = st().t;
                    /* 暂停着量：只有关键帧对齐那一截，6.5–13.5 秒（电视上 +6.9 判错过）。 */
                    check("暂停时右键是快进", b - a > 6 && b - a < 14 && window.__app.tab() === "recommend", a.toFixed(1) + " → " + b.toFixed(1) + "，标签=" + window.__app.tab());
                    /* 暂停后上键：焦点到顶上的标签栏（标签亮成红底块），下键回来，还是这一条、还暂停着。 */
                    key(KEY.UP);
                    return wait(500);
                }).then(function () {
                    var on = document.querySelector("#tabs .tab.focus");
                    var ok1 = window.__app.tabFocus() && tabsShown() && on && on.textContent === "推荐";
                    key(KEY.DOWN);
                    return wait(400).then(function () {
                        check("暂停后上键到标签栏、下键回来", ok1 && !window.__app.tabFocus() && st().paused && window.__app.tab() === "recommend",
                              "标签栏选中「" + (on ? on.textContent : "无") + "」，回来后 焦点在标签栏=" + window.__app.tabFocus() + " 暂停=" + st().paused);
                        key(KEY.ENTER);
                        return wait(1500);
                    });
                });
            });
        }).then(function () {
            /* 播着的时候左右键也是快进快退（2026-10-22 起），不再切标签。 */
            var a = st().t;
            key(KEY.RIGHT);
            return wait(1500).then(function () {
                var b = st().t;
                check("播着的时候右键也是快进", b - a > 6 && b - a < 15.5 && window.__app.tab() === "recommend" && !st().paused,
                      a.toFixed(1) + " → " + b.toFixed(1) + "，标签=" + window.__app.tab() + "，进度条" + (document.getElementById("progress").className === "show" ? "亮着" : "没亮"));
                return wait(1000);
            });
        }).then(function () {
            /* 连按三下：只该落在第三条上并且播起来，中间两条不许留下残影或把会话弄乱。 */
            var before = st().id;
            key(KEY.DOWN);
            return wait(300).then(function () { key(KEY.DOWN); return wait(300); })
                .then(function () { key(KEY.DOWN); return waitShown(before, 20000); })
                .then(function () { return wait(3000); })
                .then(function () { return longestStall(6000); })
                .then(function (stall) { check("连按三下后能播", stall < 3000 && (st().shown || st().sinceSwitch < 3000), "6 秒里最长停顿 " + stall + "ms，位置 #" + window.__app.pos()); });
        }).then(function () {
            /* 刷十条：模拟真正的「刷」，每条看 5 秒。 */
            var i = 0, slow = [], bad = 0;
            function one() {
                if (i++ >= 10) { return Promise.resolve(); }
                var before = st().id;
                key(KEY.DOWN);
                return waitShown(before, 15000).then(function (ms) {
                    if (ms < 0) { bad++; } else { slow.push(ms); }
                    return wait(5000);
                }).then(one);
            }
            return one().then(function () {
                slow.sort(function (x, y) { return x - y; });
                var med = slow.length ? slow[Math.floor(slow.length / 2)] : -1;
                check("连刷十条", bad === 0, "出画面中位数 " + med + "ms，最慢 " + (slow[slow.length - 1] || -1) + "ms，失败 " + bad + " | 全部=" + slow.join(","));
            });
        }).then(function () {
            /* 标签顺序：直播 · 精选 · 关注 · 推荐 · 我。预期跟着登录态走：已登录时「关注」能播、「我」是
             * 观看历史那些（焦点在顶上那一排，左键回推荐）；未登录时两个都出二维码。 */
            var recId = st().id, recT = st().t;
            var logged = Account.loggedIn();
            viaTabs(KEY.RIGHT);                      // 推荐 → 我
            return (logged ? wait(1500).then(function () { return 0; }) : waitQr(20000)).then(function (ms) {
                if (logged) {
                    check("已登录时「我」是观看历史那些", window.__app.tab() === "me" && window.__app.view() === "grid" && window.__app.page() === "me", "视图=" + window.__app.view() + "，页=" + window.__app.page());
                } else {
                    check("未登录时「我」出二维码", window.__app.tab() === "me" && window.__app.view() === "login" && ms >= 0, "视图=" + window.__app.view() + "，二维码 " + ms + "ms");
                }
                var row = logged ? document.getElementById("gp-tabs").textContent : (document.getElementById("login-diag").className === "show" ? document.getElementById("login-diag").textContent : "");
                check("「我」里有诊断日志的开关和上传", /诊断日志：[开关]/.test(row) && row.indexOf("上传诊断日志") >= 0, "那一排：" + row);
                key(KEY.LEFT);                       // 回推荐：管线只是暂停着（Player.stop），该是原地接着放
                return waitShown("", 15000).then(function (ms) {
                    var s1 = st();
                    check("从「我」回到推荐接着放", ms >= 0 && s1.id === recId && s1.t >= recT - 1,
                          "出画面 " + ms + "ms，同一条=" + (s1.id === recId) + "，离开时 " + recT.toFixed(1) + "s，现在 " + s1.t.toFixed(1) + "s");
                    return wait(1500);
                });
            }).then(function () {
                viaTabs(KEY.LEFT);                   // 到关注
                return logged ? waitShown(recId, 20000) : waitQr(20000);
            }).then(function (ms) {
                if (logged) {
                    return longestStall(6000).then(function (stall) {
                        check("已登录时「关注」能播", window.__app.tab() === "follow" && ms >= 0 && stall < 3000, "出画面 " + ms + "ms，最长停顿 " + stall + "ms");
                    });
                }
                check("未登录时「关注」出二维码", window.__app.tab() === "follow" && window.__app.view() === "login" && ms >= 0, "视图=" + window.__app.view() + "，二维码 " + ms + "ms");
            }).then(function () {
                viaTabs(KEY.LEFT);                   // 到精选：三列网格，挑着看（2026-10-22）
                return waitFor(function () { var g = Grid.state(); return g && g.kind === "jingxuan" && g.cards > 0 && g.imgs >= Math.min(g.cards, 3); }, 20000);
            }).then(function (ms) {
                var g = Grid.state() || {};
                check("「精选」是网格、封面出来了", window.__app.tab() === "jingxuan" && window.__app.view() === "grid" && ms >= 0,
                      ms + "ms，" + g.cards + " 张卡片、封面 " + g.imgs + "，焦点 #" + g.sel);
                var before = st().id;
                key(KEY.RIGHT);                      // 挑第二张
                return wait(400).then(function () { key(KEY.ENTER); return waitShown(before, 20000); });
            }).then(function (ms) {
                return longestStall(6000).then(function (stall) {
                    check("精选里挑一条能播", window.__app.view() === "feed" && ms >= 0 && stall < 3000,
                          "出画面 " + ms + "ms，最长停顿 " + stall + "ms，顶上「" + document.getElementById("tabs").textContent + "」");
                });
            }).then(function () { return switchStep("精选里下一条", KEY.DOWN); })
              .then(function () {
                key(KEY.RETURN);                     // 回到网格，焦点在刚才放的那条（第三张，最右边那一列）
                return wait(800);
            }).then(function () {
                var g = Grid.state() || {};
                check("返回键回到精选网格、焦点跟着刚才那条", window.__app.view() === "grid" && g.sel === 2, "视图=" + window.__app.view() + "，焦点 #" + g.sel);
                /* 直播在精选左边（2026-10-22）：第三张往左两下到最左边那一列，再左就是直播。<video> 不直接放 m3u8，走 mpegts.js 放 FLV（H.265）。 */
                var before = st().id;
                key(KEY.LEFT); key(KEY.LEFT); key(KEY.LEFT);
                return waitShown(before, 25000);
            }).then(function (ms) {
                return longestStall(6000).then(function (stall) {
                    var it = window.__app.current() || {};
                    check("「直播」能播", window.__app.tab() === "live" && ms >= 0 && stall < 3000 && !!it.live,
                          "出画面 " + ms + "ms，最长停顿 " + stall + "ms，" + (it.users || "?") + " 人在看，" + st().engine + "，" + st().vw + "x" + st().vh);
                });
            }).then(function () { return switchStep("直播里下一个直播间", KEY.DOWN); })
              .then(function () {
                /* 直播 → 标签栏上右三下：精选、关注、推荐。 */
                viaTabs(KEY.RIGHT, 3);
                return waitShown("", 15000);
            }).then(function () {
                return wait(2500).then(function () {
                    var s2 = st();
                    check("切回「推荐」接着那一条", window.__app.tab() === "recommend" && s2.id === recId && s2.t >= recT - 1,
                          "同一条=" + (s2.id === recId) + "，离开时 " + recT.toFixed(1) + "s，现在 " + s2.t.toFixed(1) + "s");
                });
            });
        }).then(ensureLong).then(authorSteps).then(function () {
            Log.report("SELFTEST", fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
        }, function (e) {
            Log.report("SELFTEST", "中止：" + e.message + "（" + fails + "/" + steps + " 步失败）");
        });
    }

    /* --soak：长时间连刷 + 登录页挂机，回答两个只有时间能回答的问题：刷久了会不会被风控拦下，
     * 二维码过期后会不会自动换新。 */
    function soak() {
        var MIN = 60000, total = 20 * MIN, every = 10000;
        var t0 = Date.now(), n = 0, fails = 0, times = [], lastReport = Date.now();
        Log.report("SOAK", "开始：连刷 20 分钟（每 10 秒一条），然后登录页挂 6 分钟");
        function summary(tag) {
            var sorted = times.slice().sort(function (a, b) { return a - b; });
            var med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -1;
            Log.report("SOAK", tag + " " + Math.round((Date.now() - t0) / MIN) + " 分钟：刷了 " + n + " 条，没出画面 " + fails +
                       " 次，出画面中位 " + med + "ms，最慢 " + (sorted[sorted.length - 1] || -1) + "ms");
            times = [];
        }
        function one() {
            if (Date.now() - t0 >= total) { summary("刷完"); return Promise.resolve(); }
            if (Date.now() - lastReport >= 5 * MIN) { lastReport = Date.now(); summary("阶段"); }
            var before = st().id;
            key(KEY.DOWN);
            n++;
            return waitShown(before, 15000).then(function (ms) {
                if (ms < 0) { fails++; } else { times.push(ms); }
                return wait(every);
            }).then(one);
        }
        return waitShown("", 40000).then(one).then(function () {
            viaTabs(KEY.RIGHT);                      // 推荐 → 我（没登录是二维码）
            return wait(1500);
        }).then(function () {
            var seen = {}, count = 0, t1 = Date.now();
            function watch() {
                var q = document.getElementById("qr");
                var src = q && q.style.visibility === "visible" ? q.src : "";
                if (src && !seen[src]) { seen[src] = true; count++; Log.report("SOAK", "第 " + count + " 张二维码（登录页第 " + Math.round((Date.now() - t1) / 1000) + " 秒）"); }
                if (Date.now() - t1 >= 6 * MIN) {
                    Log.report("SOAK", "登录页挂了 6 分钟：一共 " + count + " 张二维码，结束时二维码" + (src ? "可见" : "不可见") + "，页面=" + window.__app.view() + "，提示=" + document.getElementById("login-msg").textContent);
                    return Promise.resolve();
                }
                return wait(2000).then(watch);
            }
            return watch();
        }).then(function () { Log.report("SOAK", "结束"); }, function (e) { Log.report("SOAK", "中止：" + e.message); });
    }

    /* --qr：启动后直接去「我」，只看二维码有没有真的显示出来。30 秒出结果。 */
    function qrOnly() {
        return waitShown("", 40000).then(function () {
            viaTabs(KEY.RIGHT);                      // 推荐右边就是「我」
            return waitQr(30000);
        }).then(function (ms) {
            var q = document.getElementById("qr");
            check("「我」的二维码真的显示出来", ms >= 0, "等了 " + ms + "ms，naturalWidth=" + (q ? q.naturalWidth : "-") + " complete=" + (q ? q.complete : "-"));
            Log.report("SELFTEST", fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
        });
    }

    /* --diag：诊断日志的上传在电视上走一遍 —— 观众在「我」里按的那一下，和出事时自动的那一下，传到 DOUYIN_DIAG_TO
     * （默认是这台电脑上的 bilibili-tizen/tools/diag-local.mjs）。开关关掉再打开，最后放回原样。登录了走「我」页顶上那一排，
     * 没登录走二维码页最底下那一排。 */
    function diagRun() {
        var logged, wasOn = Diag.enabled(), manualId = "";
        function line() {
            return logged ? (Grid.state() || {}).foot || "" : document.getElementById("login-diag-msg").textContent;
        }
        function at() { return logged ? Grid.tabKey() : ["", "diag", "diagup"][window.__app.loginDiag() + 1]; }
        function until(test, ms) {
            var t0 = Date.now();
            function poll() {
                var v = test();
                if (v) { return Promise.resolve(v); }
                if (Date.now() - t0 > ms) { return Promise.resolve(null); }
                return wait(300).then(poll);
            }
            return poll();
        }
        return waitShown("", 40000).then(function () {
            return until(function () { return Account.known(); }, 20000);     // 登录态查清楚之前「我」是转圈
        }).then(function () {
            if (!wasOn) { Diag.setEnabled(true); }
            logged = Account.loggedIn();
            viaTabs(KEY.RIGHT);                      // 推荐右边就是「我」
            return wait(2000);
        }).then(function () {
            if (logged) { key(KEY.RIGHT); key(KEY.RIGHT); key(KEY.RIGHT); }     // 观看历史 → 喜欢 → 收藏 → 诊断日志
            else { key(KEY.DOWN); }
            return wait(500);
        }).then(function () {
            var st = Diag.status();
            check("「我」里选中诊断日志，写着这台电视的编号", at() === "diag" && line().indexOf("这台电视的编号 " + st.device) >= 0 && st.configured,
                  (logged ? "「我」页" : "二维码页") + "，选中 " + at() + "，那行字：" + line() + (st.configured ? "" : "（这个构建没有接收地址：deploy.sh --diag 应该写进了 DIAG_TO）"));
            key(KEY.RIGHT);
            return wait(300);
        }).then(function () {
            key(KEY.ENTER);
            return until(function () {
                var m = /已上传（编号 ([a-z2-9]{8})）/.exec(line());
                return m ? m[1] : /没传上/.test(line()) ? "×" : null;
            }, 25000);
        }).then(function (id) {
            check("按「上传诊断日志」，那行字写出编号", at() === "diagup" && id && id !== "×", "那行字：" + line());
            manualId = id || "";
            key(KEY.LEFT);
            return wait(300);
        }).then(function () {
            key(KEY.ENTER);
            return wait(300);
        }).then(function () {
            var name = logged ? document.getElementById("gp-tabs").textContent : document.getElementById("ld-toggle").textContent;
            check("关掉：不记录、缓冲清空", !Diag.enabled() && line().indexOf("已关闭") === 0 && Diag.status().lines === 0 && name.indexOf("诊断日志：关") >= 0,
                  "enabled=" + Diag.enabled() + "，缓冲 " + Diag.status().lines + " 行，那行字：" + line());
            key(KEY.ENTER);
            return wait(300);
        }).then(function () {
            check("再打开", Diag.enabled() && line().indexOf("这台电视的编号") >= 0, "那行字：" + line());
            /* 三分钟内自动传过一份的话（上一轮 --diag），这一次会被限流挡掉 —— 自测构建里把那个时间清掉。 */
            try { var sent = JSON.parse(localStorage.getItem("dy.diag.sent") || "{}"); sent.at = 0; localStorage.setItem("dy.diag.sent", JSON.stringify(sent)); } catch (e) {}
            Diag.incident("自测：造的一次出事");
            return until(function () {
                var last = Diag.status().last || {};
                return !last.manual && (last.id || last.ok === false) ? last : null;
            }, 30000);
        }).then(function (last) {
            check("出一次事，8 秒后自动上传", last && last.ok && last.id !== manualId, last ? (last.ok ? "编号 " + last.id : "没传上：" + last.why) : "30 秒了还没有结果");
            if (Diag.enabled() !== wasOn) { Diag.setEnabled(wasOn); }
            if (logged) { key(KEY.LEFT); key(KEY.LEFT); key(KEY.LEFT); key(KEY.LEFT); }   // 退到观看历史，再左键回推荐
            else { key(KEY.UP); key(KEY.LEFT); }
            return waitShown("", 15000);
        }).then(function (ms) {
            check("回到推荐接着放", window.__app.tab() === "recommend" && ms >= 0, "标签 " + window.__app.tab() + "，出画面 " + ms + "ms");
            Log.report("SELFTEST", fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
        }, function (e) {
            Log.report("SELFTEST", "中止：" + e.message + "（" + fails + "/" + steps + " 步失败）");
        });
    }

    function median(a) {
        if (!a.length) { return -1; }
        var s = a.slice().sort(function (x, y) { return x - y; });
        return s[Math.floor(s.length / 2)];
    }

    /* --ab：只刷，同一轮里逐条轮换两种切换动画（跨两轮比较会被网络骗，见 CLAUDE.md），比从按键算起的
     * playing / 撤封面，以及推的那一刻封面图是不是当场就有（预热时下好、解好的）。
     *   "cover"：旧视频原地接着播，新的一页盖上来，盖到 ~99% 才 seek；"early"：按键就 seek。
     * 2026-09-29/30 比过的 cover / early、moov 补取 / 不补，结论在 CLAUDE.md。 */
    function ab() {
        var N = 30, i = 0, from = 0, ARMS = ["cover", "early"];
        function one() {
            if (i >= N) { return Promise.resolve(); }
            window.__app.setPush(ARMS[i % 2]);
            i++;
            var before = st().id;
            key(KEY.DOWN);
            return waitShown(before, 15000).then(function () { return wait(6000); }).then(one);
        }
        return waitShown("", 40000).then(function () {
            Log.report("AB", "开始：连刷 " + N + " 条，每条看 6 秒；" + ARMS.join(" / ") + " 逐条轮换");
            return wait(4000);
        }).then(function () {
            from = window.__app.records().length;
            return one();
        }).then(function () {
            var rs = window.__app.records().slice(from);
            ARMS.forEach(function (m) {
                var g = rs.filter(function (r) { return r.push === m; });
                var warm = g.filter(function (r) { return r.warm.indexOf("槽里有") >= 0 || r.warm.indexOf("好了") >= 0; });
                var coverNow = g.filter(function (r) { return r.cover === 0; });
                Log.report("AB", "切换 " + m + "：" + g.length + " 次（预热好了 " + warm.length + "，封面当场就有 " + coverNow.length + "），按键→playing 中位 " +
                           median(g.map(function (r) { return r.playing; })) + "ms，按键→撤封面 中位 " + median(g.map(function (r) { return r.frame; })) +
                           "ms | 全部=" + g.map(function (r) { return r.frame; }).join(","));
            });
            window.__app.setPush("auto");
            Log.report("AB", "结束");
        }, function (e) { Log.report("AB", "中止：" + e.message); });
    }

    /* --seek：在一条长视频里来回跳 ±120 秒，量从跳转到播放头走起来多久。跳转对齐到关键帧（mse.js 的
     * seekTo）之前中位 966ms，之后 258ms。 */
    function seekRun() {
        var N = 24, i = 0, res = [], v = document.getElementById("va");
        function findLong() {
            var n = 0;
            function go() {
                var s = st();
                if (s.shown && s.engine === "mse" && s.dur > 400 && s.t < 120) { return Promise.resolve(true); }
                if (n++ >= 20) { return Promise.resolve(false); }
                var before = s.id;
                key(KEY.DOWN);
                return waitShown(before, 15000).then(function () { return wait(800); }).then(go);
            }
            return go();
        }
        function one() {
            if (i >= N) { return Promise.resolve(); }
            var delta = i % 2 ? -120 : 120;
            i++;
            var a = st(), t0 = Date.now(), seekedMs = -1, landed = -1;
            var onSeeked = function () { if (seekedMs < 0) { seekedMs = Date.now() - t0; } };
            v.addEventListener("seeked", onSeeked);
            Player.seek(delta);
            /* 「动起来」= seek 结束后播放头又走了 0.1 秒。seeked 事件在这台电视上偶尔不来，不靠它。 */
            function poll() {
                var s = st();
                if (s.id !== a.id) { return Promise.resolve(-2); }
                if (!v.seeking) {
                    if (landed < 0) { landed = s.t; } else if (s.t > landed + 0.1) { return Promise.resolve(Date.now() - t0); }
                }
                if (Date.now() - t0 > 10000) { return Promise.resolve(-1); }
                return wait(50).then(poll);
            }
            return poll().then(function (ms) {
                v.removeEventListener("seeked", onSeeked);
                Log.report("SEEK", "第 " + i + " 次 " + (delta > 0 ? "+" : "") + delta + "s → " + st().t.toFixed(0) +
                           "s：seeked " + seekedMs + "ms，动起来 " + ms + "ms | " + Mse.lastSeek());
                if (ms === -2) { i = N; return; }
                res.push({seeked: seekedMs, moved: ms});
                return wait(4000);
            }).then(one);
        }
        return waitShown("", 40000).then(findLong).then(function (ok) {
            if (!ok) { throw new Error("刷了 20 条没找到 400 秒以上的视频"); }
            Log.report("SEEK", "开始：" + N + " 次 ±120 秒跳转");
            return one();
        }).then(function () {
            var g = res.filter(function (r) { return r.moved >= 0; });
            Log.report("SEEK", g.length + "/" + res.length + " 次成功，动起来 中位 " + median(g.map(function (r) { return r.moved; })) +
                       "ms | 全部=" + g.map(function (r) { return r.moved; }).join(","));
            Log.report("SEEK", "结束");
        }, function (e) { Log.report("SEEK", "中止：" + e.message); });
    }

    /* --author：启动后直接走作者主页那几步，1 分钟出结果。 */
    function authorOnly() {
        return waitShown("", 40000).then(function () { return wait(3000); }).then(ensureLong).then(authorSteps).then(function () {
            Log.report("SELFTEST", fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
        }, function (e) {
            Log.report("SELFTEST", "中止：" + e.message + "（" + fails + "/" + steps + " 步失败）");
        });
    }

    /* --grid：作者主页网格上下翻，同一轮里轮换三种做法（js/author.js 的 MODES），比按键后 450ms 里的帧间隔、掉帧。
     * 先热身一趟（登录态下会取第二页、封面都到齐），之后只在前 5 行里上下翻，不再触发取页。约 2 分钟。 */
    function gridRun() {
        var ARMS = ["旧", "层", "层+瞬"], ROUNDS = 9;
        function keys(code, n) {
            var i = 0;
            function go() { if (i++ >= n) { return Promise.resolve(); } key(code); return wait(700).then(go); }
            return go();
        }
        function waitImgs(min, ms) {
            var t0 = Date.now();
            function poll() {
                var a = Grid.state();
                if (a && a.cards >= min && a.imgs >= a.cards) { return Promise.resolve(true); }
                if (Date.now() - t0 > ms) { return Promise.resolve(false); }
                return wait(300).then(poll);
            }
            return poll();
        }
        function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
        return waitShown("", 40000).then(function () { return wait(3000); }).then(ensureLong).then(function () {
            key(KEY.ENTER);
            return wait(800);
        }).then(function () {
            key(KEY.DOWN);
            return wait(500);
        }).then(function () {
            key(KEY.ENTER);
            return waitImgs(17, 20000);
        }).then(function (ok) {
            if (!ok) { throw new Error("网格不到 5 行或封面没到齐：" + JSON.stringify(Grid.state())); }
            return keys(KEY.DOWN, 6).then(function () { return keys(KEY.UP, 6); }).then(function () { return waitImgs(17, 10000); });
        }).then(function () {
            Grid.probes().length = 0;
            var r = 0;
            function round() {
                if (r >= ROUNDS) { return Promise.resolve(); }
                Grid.setMode(ARMS[r++ % ARMS.length]);
                return keys(KEY.DOWN, 4).then(function () { return keys(KEY.UP, 4); }).then(round);
            }
            return round();
        }).then(function () {
            var ps = Grid.probes();
            ARMS.forEach(function (m) {
                var g = ps.filter(function (p) { return p.mode === m && p.scrolled; });
                Log.report("GRID", m + "：滚动 " + g.length + " 次，最长帧间隔 中位 " + median(g.map(function (p) { return p.maxGap; })) +
                           "ms，掉帧 共 " + sum(g.map(function (p) { return p.drops; })) + "（有掉帧的 " + g.filter(function (p) { return p.drops; }).length +
                           " 次），按键→第一帧 中位 " + median(g.map(function (p) { return p.first; })) + "ms，长任务 共 " + sum(g.map(function (p) { return p.long; })) +
                           "ms | 最长间隔 全部=" + g.map(function (p) { return p.maxGap; }).join(","));
            });
            Grid.setMode("层+瞬");
            if (window.__app.view() === "grid") { key(KEY.RETURN); }
            Log.report("GRID", "结束");
        }, function (e) { Log.report("GRID", "中止：" + e.message); });
    }

    /* --cold：老视频走冷存储（v*-colds.douyinvod.com）—— 是不是第一次取很慢、会被 12 秒看门狗跳掉（2026-09-30 的怀疑）。
     * 在作者主页里往下翻到一年以前的视频，挨个点开量：出画面用了多久、第一段首字节 / 用时 / 主机（「mse: 备好」那行）。
     * 设备实测 8 条（408–498 天前）全走 colds，首字节 0.6–1.5 秒，出画面中位 1.8 秒、最慢 3.4 秒 —— 不慢，怀疑不成立。
     * **每条只能量一次**：取过一次 CDN 边缘就热了。挑的条目隔 3 个、从旧往新挑 —— 放一条时会预热它后面两条，
     * 别让预热把下一条焐热；每条之后等所有请求停了再点下一条，别抢链路。
     * 看门狗照正式版的规则（字节在来不算卡、60 秒上限），判的是「修好了没有」：旧规则下 >12 秒的都会被跳掉。 */
    function coldRun() {
        var OLD_DAYS = 365, WANT = 8, AUTHORS = 4;
        var res = [], tried = 0;
        function keys(code, n) {
            var i = 0;
            function go() { if (i++ >= n) { return Promise.resolve(); } key(code); return wait(600).then(go); }
            return go();
        }
        function old(it) { return it.time && Date.now() / 1000 - it.time > OLD_DAYS * 86400 && !it.top; }
        function quiet(ms) {
            var t0 = Date.now();
            function poll() { if (!Mse.busy() || Date.now() - t0 > ms) { return Promise.resolve(); } return wait(500).then(poll); }
            return poll();
        }
        /* 从现在这条的作者进主页，往下翻到够 WANT 条老视频或者翻不动。回挑出来的下标（从旧往新、隔 3 个）。 */
        function findOld() {
            tried++;
            key(KEY.ENTER);
            return wait(800).then(function () { key(KEY.DOWN); return wait(500); }).then(function () {
                key(KEY.ENTER);
                return wait(4000);
            }).then(function () {
                var presses = 0;
                function page() {
                    var f = Grid.feed();
                    if (!f) { return Promise.resolve(); }
                    var n = f.all().filter(old).length;
                    if (n >= WANT * 3 || (!f.hasMore() && presses > 0) || presses >= 60) { return Promise.resolve(); }
                    presses += 6;
                    return keys(KEY.DOWN, 6).then(function () { return wait(1500); }).then(page);
                }
                return page();
            }).then(function () {
                var all = Grid.feed() ? Grid.feed().all() : [];
                var idx = [];
                for (var i = all.length - 1; i >= 0 && idx.length < WANT; i--) {
                    if (old(all[i]) && (!idx.length || idx[idx.length - 1] - i >= 3)) { idx.push(i); }
                }
                Log.report("COLD", "@" + Grid.name() + " 翻到 " + all.length + " 条，一年以前的 " + all.filter(old).length + " 条，挑 " + idx.length + " 条");
                return idx;
            });
        }
        function one(i) {
            var it = Grid.feed().all()[i];
            var days = Math.floor((Date.now() / 1000 - it.time) / 86400);
            return quiet(30000).then(function () {
                Grid.select(i);
                key(KEY.ENTER);
                var t0 = Date.now();
                function poll() {
                    var s = st();
                    if (s.id === it.id && s.shown) { return Promise.resolve(Date.now() - t0); }
                    if (s.id && s.id !== it.id) { return Promise.resolve(-2); }       // 被判放不了、跳到了别的
                    if (Date.now() - t0 > 75000) { return Promise.resolve(-1); }
                    return wait(250).then(poll);
                }
                return poll();
            }).then(function (ms) {
                var r = {i: i, days: days, ms: ms};
                res.push(r);
                Log.report("COLD", "#" + i + " 发布 " + days + " 天前 " + (ms >= 0 ? "出画面 " + ms + "ms" : ms === -2 ? "被跳过" : "75 秒没出画面") +
                           " | " + Mse.pending(it));
                return (ms >= 0 ? longestStall(4000) : Promise.resolve(-1)).then(function (stall) {
                    r.stall = stall;
                    if (window.__app.inAuthor() && window.__app.view() === "feed") { key(KEY.RETURN); }
                    return wait(1000);
                });
            });
        }
        function author() {
            return findOld().then(function (idx) {
                var k = 0;
                function next() { if (k >= idx.length) { return Promise.resolve(); } return one(idx[k++]).then(next); }
                return next();
            }).then(function () {
                if (window.__app.view() === "grid") { key(KEY.RETURN); }
                if (res.length >= WANT || tried >= AUTHORS) { return; }
                /* 这位作者老视频不够：回推荐换下一条的作者。 */
                return wait(3000).then(function () { var before = st().id; key(KEY.DOWN); return waitShown(before, 15000); })
                    .then(function () { return wait(2000); }).then(author);
            });
        }
        return waitShown("", 40000).then(function () { return wait(3000); }).then(ensureLong).then(author).then(function () {
            var ok = res.filter(function (r) { return r.ms >= 0; });
            var ms = ok.map(function (r) { return r.ms; });
            Log.report("COLD", "结束：" + res.length + " 条一年以前的视频，出画面 " + ok.length + " 条，中位 " + median(ms) + "ms 最慢 " + (ms.length ? Math.max.apply(null, ms) : -1) +
                       "ms，超过 12 秒的 " + ms.filter(function (x) { return x > 12000; }).length + " 条（旧看门狗下会被跳过）| 全部=" +
                       res.map(function (r) { return r.days + "天:" + (r.ms >= 0 ? r.ms : r.ms === -2 ? "跳过" : "超时"); }).join(","));
        }, function (e) { Log.report("COLD", "中止：" + e.message); });
    }

    function waitFor(fn, ms) {
        var t0 = Date.now();
        function poll() {
            var v = false;
            try { v = fn(); } catch (e) {}
            if (v) { return Promise.resolve(Date.now() - t0); }
            if (Date.now() - t0 > ms) { return Promise.resolve(-1); }
            return wait(250).then(poll);
        }
        return poll();
    }
    /* 暂停、下键选中右边那一列的头像、再下键往下走到 name 那一个（合集在最后，左下那一条）。走不到就是没有。 */
    function pickChip(name) {
        if (!st().paused) { key(KEY.ENTER); }
        return wait(800).then(function () {
            if (window.__app.chip() !== "author" && !window.__app.chip()) { key(KEY.DOWN); }
            var n = 0;
            function step() {
                if (window.__app.chip() === name) { return Promise.resolve(true); }
                if (n++ >= 6) { return Promise.resolve(false); }
                key(KEY.DOWN);
                return wait(250).then(step);
            }
            return wait(300).then(step);
        });
    }

    /* 评论侧栏：打开、出评论、往下翻、展开一条的回复、返回键关掉。只读。 */
    function commentSteps() {
        var it = window.__app.current();
        return pickChip("comment").then(function (ok) {
            if (!ok) { check("选中「评论」", false, "那一排是 " + window.__app.chip()); return; }
            key(KEY.ENTER);
            return waitFor(function () { var c = Comments.state(); return c && !c.loading && (c.comments > 0 || c.foot); }, 20000).then(function (ms) {
                var c = Comments.state() || {};
                check("评论侧栏出评论", ms >= 0 && (c.comments > 0 || it.comments === 0), ms + "ms，" + c.title + "，" + c.comments + " 条，底下「" + c.foot + "」" + (c.err ? "，错误 " + c.err : ""));
                if (!c.comments) { return; }
                key(KEY.DOWN); key(KEY.DOWN); key(KEY.DOWN);
                return wait(800).then(function () {
                    var c2 = Comments.state();
                    check("评论里下键往下走", c2.sel === 3, "焦点第 " + c2.sel + " 行");
                    if (c2.withReplies < 0) { Log.report("SELFTEST", "这一页评论没有带回复的，跳过展开回复"); return; }
                    Comments.select(c2.withReplies);
                    key(KEY.ENTER);
                    return waitFor(function () { var c3 = Comments.state(); return c3.replies > 0 || /失败/.test(document.getElementById("cm-list").textContent); }, 20000).then(function (ms2) {
                        var c3 = Comments.state();
                        check("确认键展开回复", c3.replies > 0, ms2 + "ms，回复 " + c3.replies + " 条" + (c3.replies ? "" : "，" + document.getElementById("cm-list").textContent.match(/回复加载失败[^）]*）/)));
                    });
                });
            }).then(function () {
                key(KEY.RETURN);
                return wait(500).then(function () {
                    check("返回键关掉评论侧栏", !Comments.isOpen() && window.__app.chip() === "comment" && st().paused, "侧栏开着=" + Comments.isOpen() + "，选中=" + window.__app.chip());
                    key(KEY.RETURN);            // 取消选中
                    key(KEY.ENTER);             // 接着放
                    return wait(1000);
                });
            });
        });
    }

    /* 合集：选中「合集」→ 选集（焦点在这一集）→ 点它接着放 → 下键下一集 → 返回回选集 → 返回回到原来那一条。 */
    function mixSteps() {
        var it = window.__app.current(), from = st();
        return pickChip("mix").then(function (ok) {
            if (!ok) { check("选中「合集」", false, "那一排是 " + window.__app.chip()); return; }
            key(KEY.ENTER);
            return waitFor(function () { var g = Grid.state(); return g && g.kind === "mix" && g.cards > 0 && g.zone === "grid" && Grid.feed().all()[g.sel].id === it.id; }, 30000).then(function (ms) {
                var g = Grid.state() || {}, f = Grid.feed();
                check("选集出来、焦点在正在看的这一集", ms >= 0, ms + "ms，《" + g.name + "》第 " + it.mix.ep + " 集，" + g.cards + " 张卡片，焦点 #" + g.sel + "，「" + g.stats + "」");
                if (ms < 0) { return; }
                key(KEY.ENTER);
                return waitId(it.id, 15000).then(function (ms2) {
                    var s = st();
                    check("点这一集从刚才的地方接着放", ms2 >= 0 && s.t >= from.t - 1, "出画面 " + ms2 + "ms，离开时 " + from.t.toFixed(1) + "s，现在 " + s.t.toFixed(1) + "s，顶上「" + document.getElementById("tabs").textContent + "」");
                    var nx = f.all()[f.position() + 1];
                    if (!nx) { Log.report("SELFTEST", "这已经是合集最后一集，跳过下一集"); return; }
                    return wait(2000).then(function () {
                        key(KEY.DOWN);
                        return waitId(nx.id, 15000);
                    }).then(function (ms3) {
                        check("合集里下键是下一集", ms3 >= 0 && nx.mix && nx.mix.ep === it.mix.ep + 1, "出画面 " + ms3 + "ms，第 " + it.mix.ep + " → " + (nx.mix && nx.mix.ep) + " 集");
                    });
                }).then(function () {
                    key(KEY.RETURN);
                    return wait(800).then(function () {
                        var g2 = Grid.state() || {};
                        check("返回键回到选集", window.__app.view() === "grid" && g2.kind === "mix", "视图=" + window.__app.view() + "，焦点 #" + g2.sel);
                        key(KEY.RETURN);
                        return waitId(it.id, 15000);
                    }).then(function (ms4) {
                        check("再按返回回到原来那一条", ms4 >= 0 && window.__app.page() !== "mix", "出画面 " + ms4 + "ms，页=" + window.__app.page());
                    });
                });
            });
        });
    }

    /* --me：「我」（观看历史 · 喜欢 · 收藏）、合集选集、评论侧栏。要已登录。**只读**：不按「退出登录」的确认键，不点赞、不收藏。 */
    function meRun() {
        var idx = 0;
        return waitShown("", 40000).then(function () { return Account.whenKnown(); }).then(function () {
            if (!Account.loggedIn()) { throw new Error("没登录，「我」页测不了"); }
            viaTabs(KEY.RIGHT);
            return waitFor(function () { var g = Grid.state(); return window.__app.page() === "me" && g && g.cards > 0 && g.imgs > 0 && g.stats; }, 20000);
        }).then(function (ms) {
            var g = Grid.state() || {};
            check("「我」出观看历史", ms >= 0 && g.zone === "tabs" && g.tab === "history", ms + "ms，「" + g.name + "」「" + g.stats + "」，" + g.cards + " 张卡片、封面 " + g.imgs + "，焦点在 " + g.zone);
            var all = Grid.feed().all();
            for (var i = 0; i < all.length; i++) { if (all[i].mix && all[i].comments > 0) { idx = i; break; } }
            key(KEY.DOWN);
            return wait(500).then(function () {
                Grid.select(idx);
                key(KEY.ENTER);
                return waitId(all[idx].id, 15000);
            });
        }).then(function (ms) {
            return longestStall(4000).then(function (stall) {
                check("观看历史里点一条能播", ms >= 0 && stall < 3000 && /观看历史/.test(document.getElementById("tabs").textContent),
                      "出画面 " + ms + "ms，第 " + idx + " 条" + (window.__app.current().mix ? "（合集第 " + window.__app.current().mix.ep + " 集）" : "（不是合集，观看历史里没找到合集）") + "，顶上「" + document.getElementById("tabs").textContent + "」");
            });
        }).then(function () {
            return window.__app.current().mix ? mixSteps() : null;
        }).then(function () { return wait(2000); }).then(commentSteps).then(function () {
            key(KEY.RETURN);
            return wait(800);
        }).then(function () {
            var g = Grid.state() || {};
            check("返回键回到观看历史的网格", window.__app.view() === "grid" && g.kind === "me" && g.sel === idx, "视图=" + window.__app.view() + "，焦点 #" + g.sel);
            for (var i = 0; i < 12; i++) { key(KEY.UP); }
            return wait(600).then(function () {
                key(KEY.RIGHT);
                return waitFor(function () { var g2 = Grid.state(); return g2.tab === "like" && (g2.cards > 0 && g2.imgs > 0 || /失败|没有/.test(g2.foot)); }, 20000);
            });
        }).then(function (ms) {
            var g = Grid.state();
            check("「喜欢」出网格", ms >= 0 && g.cards > 0, ms + "ms，" + g.cards + " 张卡片，底下「" + g.foot + "」");
            key(KEY.RIGHT);
            return waitFor(function () { var g2 = Grid.state(); return g2.tab === "collect" && !/正在加载/.test(g2.foot) && (g2.cards > 0 || g2.foot); }, 20000);
        }).then(function (ms) {
            var g = Grid.state();
            check("「收藏」出网格或说是空的", ms >= 0 && !/失败/.test(g.foot), ms + "ms，" + g.cards + " 张卡片，底下「" + g.foot + "」");
            /* 收藏和退出登录之间还有诊断日志那两项（2026-10-21 加的，之前这里只按一次右键，落在诊断日志上判 FAIL）。 */
            var n = 0;
            function toLogout() {
                if (Grid.state().tab === "logout" || n++ >= 5) { return wait(600); }
                key(KEY.RIGHT);
                return wait(300).then(toLogout);
            }
            return toLogout();
        }).then(function () {
            var g = Grid.state();
            check("「退出登录」那一项只写提示（没按确认）", g.tab === "logout" && /退出登录/.test(g.foot) && Account.loggedIn(), "底下「" + g.foot + "」");
            var n = 0;
            function toHistory() {
                if (Grid.state().tab === "history" || n++ >= 8) { return wait(800); }
                key(KEY.LEFT);
                return wait(300).then(toHistory);
            }
            return toHistory();
        }).then(function () {
            key(KEY.LEFT);                   // 观看历史再往左 → 推荐
            return waitShown("", 15000);
        }).then(function (ms) {
            check("「我」顶上那一排最左边再按左键回到推荐", window.__app.tab() === "recommend" && window.__app.view() === "feed" && ms >= 0, "标签=" + window.__app.tab() + "，出画面 " + ms + "ms");
        }).then(function () {
            Log.report("SELFTEST", fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
        }, function (e) {
            Log.report("SELFTEST", "中止：" + e.message + "（" + fails + "/" + steps + " 步失败）");
        });
    }

    /* --mix：在推荐里往下刷，找到一条带合集的，把选集走一遍（只读）。 */
    function mixRun() {
        var n = 0;
        function find() {
            var it = window.__app.current();
            if (it && it.mix) { return Promise.resolve(it); }
            if (n++ >= 30) { return Promise.resolve(null); }
            var before = st().id;
            key(KEY.DOWN);
            return waitShown(before, 15000).then(function () { return wait(800); }).then(find);
        }
        return waitShown("", 40000).then(function () { return wait(3000); }).then(find).then(function (it) {
            if (!it) { throw new Error("刷了 30 条都没有合集"); }
            Log.report("SELFTEST", "第 " + n + " 条是合集《" + it.mix.name + "》第 " + it.mix.ep + " / " + it.mix.total + " 集");
            return wait(3000).then(mixSteps);
        }).then(function () {
            Log.report("SELFTEST", fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
        }, function (e) {
            Log.report("SELFTEST", "中止：" + e.message + "（" + fails + "/" + steps + " 步失败）");
        });
    }

    /* --like：点赞和收藏各做一次、马上取消（这个账号上一来一回，最后回到原样）。**真的会写到账号上**，只在用户同意时跑。
     * 2026-10-18 第一次跑：两个都被拒，**而且服务器作废了电视上的登录**（缺 ticket guard 头，见 act.js）。现在 Act 在有签名头
     * 之前一个写请求都不发，这一项跑了也只会报「不发」。 */
    function likeRun() {
        Act.allowInSelftest();
        window.__app.enableActs();
        var failed = {};
        /* 赞（收）没成功，就不再测取消 —— 状态本来就是 false，「取消成功」是假通过（2026-10-18 第一次跑就这样）。 */
        function toggle(name, field, want) {
            var it = window.__app.current();
            if (!want && failed[name]) { Log.report("SELFTEST", "跳过取消" + (name === "like" ? "点赞" : "收藏") + "：上一步没成功，没有东西要取消"); return Promise.resolve(); }
            return pickChip(name).then(function (ok) {
                if (!ok) { check("选中「" + name + "」", false, "那一排是 " + window.__app.chip()); return -1; }
                key(KEY.ENTER);
                return waitFor(function () { return it[field] === want && !/busy/.test(document.getElementById("act-" + name).className); }, 15000);
            }).then(function (ms) {
                if (want && !(ms >= 0 && it[field] === want)) { failed[name] = true; }
                check((want ? "" : "取消") + (name === "like" ? "点赞" : "收藏"), ms >= 0 && it[field] === want,
                      ms + "ms，" + field + "=" + it[field] + "，数字「" + document.getElementById("act-" + name).textContent + "」，提示「" + document.getElementById("toast").textContent + "」");
                key(KEY.UP);
                return wait(1500);
            });
        }
        var it0;
        return waitShown("", 40000).then(function () { return Account.whenKnown(); }).then(function () {
            if (!Account.loggedIn()) { throw new Error("没登录，点赞测不了"); }
            return wait(3000);
        }).then(function () {
            /* 挑一条这个账号没赞过、没收过的。 */
            var n = 0;
            function find() {
                var it = window.__app.current();
                if (it && !it.digged && !it.collected) { return Promise.resolve(it); }
                if (n++ >= 5) { return Promise.resolve(null); }
                var before = st().id;
                key(KEY.DOWN);
                return waitShown(before, 15000).then(find);
            }
            return find();
        }).then(function (it) {
            if (!it) { throw new Error("连着几条都赞过或收过"); }
            it0 = it;
            Log.report("SELFTEST", "用 " + it.id + " 测（赞 " + it.likes + "，收藏 " + it.collects + "）");
            return toggle("like", "digged", true);
        }).then(function () { return toggle("like", "digged", false); })
          .then(function () { return toggle("collect", "collected", true); })
          .then(function () { return toggle("collect", "collected", false); })
          .then(function () {
            check("一来一回之后回到原样", !it0.digged && !it0.collected, "digged=" + it0.digged + " collected=" + it0.collected);
            if (st().paused) { key(KEY.ENTER); }
            Log.report("SELFTEST", fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
        }).catch(function (e) {
            Log.report("SELFTEST", "中止：" + e.message + "（" + fails + "/" + steps + " 步失败）");
        });
    }

    /* --probe：登录态下把「我」页、合集、评论要用的接口各问一次，只报形状（状态码、字段名、条数、翻页游标），
     * **只读，一个写请求都不发**。参数照官网前端代码（2026-10-18 从全新匿名浏览器存下的 bundle 里读的）。 */
    function probeRun() {
        var R = function (m) { Log.report("PROBE", m); };
        var keys = function (o) { return o && typeof o === "object" ? Object.keys(o).sort().join(",") : String(o); };
        var awemes = [];
        var mixOf = function (list) { return list.filter(function (a) { return a && a.mix_info && a.mix_info.mix_id; }); };
        var marks = function (a) { return a ? "user_digged=" + a.user_digged + " collect_stat=" + a.collect_stat + " collect_count=" + (a.statistics || {}).collect_count : "无"; };
        var secUid = "";
        function step(name, p) {
            return p.then(function (j) { return j; }, function (e) { R(name + " 失败：" + e.message); return null; });
        }
        return Account.whenKnown().then(function () {
            R("开始，登录态 " + Account.loggedIn());
            return step("history/read", Bridge.get("/aweme/v1/web/history/read/", {max_cursor: "0", count: "20"}));
        }).then(function (j) {
            if (!j) { return; }
            var l = j.aweme_list || [];
            awemes = awemes.concat(l);
            R("history/read status=" + j.status_code + " 顶层=" + keys(j) + " 条数=" + l.length + " has_more=" + j.has_more + " max_cursor=" + j.max_cursor +
              " aweme_date=" + (j.aweme_date ? Object.keys(j.aweme_date).length + " 个，样例 " + JSON.stringify(j.aweme_date[Object.keys(j.aweme_date)[0]]) : "无") +
              " | 带合集的 " + mixOf(l).length + " 条 | 第一条 " + marks(l[0]) + " 图文=" + !!(l[0] && l[0].images));
            if (j.max_cursor) {
                return step("history/read 第二页", Bridge.get("/aweme/v1/web/history/read/", {max_cursor: String(j.max_cursor), count: "20"})).then(function (k) {
                    if (k) { R("history/read 第二页 status=" + k.status_code + " 条数=" + (k.aweme_list || []).length + " has_more=" + k.has_more + " max_cursor=" + k.max_cursor); }
                });
            }
        }).then(function () {
            return step("profile/self", Bridge.get("/aweme/v1/web/user/profile/self/", {source: "channel_pc_web", personal_center_strategy: "1"}));
        }).then(function (j) {
            if (!j) { return; }
            var u = j.user || {};
            secUid = u.sec_uid || "";
            R("profile/self status=" + j.status_code + " " + (j.status_msg || "") + " sec_uid=" + (secUid ? "有" : "无") + " 昵称=" + (u.nickname ? u.nickname.length + " 字" : "无") +
              " 头像=" + !!(u.avatar_thumb || u.avatar_300x300) + " favoriting_count=" + u.favoriting_count + " aweme_count=" + u.aweme_count + " | user 字段 " + Object.keys(u).length + " 个");
            if (!secUid) { return; }
            return step("favorite", Bridge.get("/aweme/v1/web/aweme/favorite/", {sec_user_id: secUid, max_cursor: "0", min_cursor: "0", whale_cut_token: "", cut_version: "1", count: "18"})).then(function (k) {
                if (!k) { return; }
                var l = k.aweme_list || [];
                awemes = awemes.concat(l);
                R("favorite status=" + k.status_code + " 顶层=" + keys(k) + " 条数=" + l.length + " has_more=" + k.has_more + " max_cursor=" + k.max_cursor + " | 第一条 " + marks(l[0]));
            });
        }).then(function () {
            return step("listcollection", Bridge.post("/aweme/v1/web/aweme/listcollection/", {}, "cursor=0&count=18"));
        }).then(function (j) {
            if (!j) { return; }
            var l = j.aweme_list || [];
            awemes = awemes.concat(l);
            R("listcollection status=" + j.status_code + " 顶层=" + keys(j) + " 条数=" + l.length + " has_more=" + j.has_more + " cursor=" + j.cursor + " | 第一条 " + marks(l[0]));
            return step("推荐", Bridge.get("/aweme/v1/web/tab/feed/", {count: "10", refresh_index: "1", video_type_select: "1", pull_type: "0", filterGids: "", tag_id: "", share_aweme_id: "", live_insert_type: ""}));
        }).then(function (j) {
            var l = j && j.aweme_list || [];
            awemes = awemes.concat(l);
            R("推荐一页 条数=" + l.length + " 第一条 " + marks(l[0]));
            var mixes = mixOf(awemes);
            R("合集：一共看了 " + awemes.length + " 条，带 mix_info 的 " + mixes.length + " 条" + (mixes[0] ? " | mix_info 字段 " + keys(mixes[0].mix_info) + " statis=" + JSON.stringify(mixes[0].mix_info.statis) + " 名字 " + String(mixes[0].mix_info.mix_name).length + " 字" : ""));
            if (!mixes[0]) { return; }
            var m = mixes[0].mix_info;
            return step("mix/aweme", Bridge.get("/aweme/v1/web/mix/aweme/", {mix_id: m.mix_id, cursor: "0", count: "12"})).then(function (k) {
                if (!k) { return; }
                var l2 = k.aweme_list || [];
                R("mix/aweme status=" + k.status_code + " 顶层=" + keys(k) + " 条数=" + l2.length + " has_more=" + k.has_more + " cursor=" + k.cursor +
                  " 集数=" + l2.map(function (a) { return a.mix_info && a.mix_info.statis ? a.mix_info.statis.current_episode : "?"; }).join(","));
                if (!k.has_more) { return; }
                return step("mix/aweme 第二页", Bridge.get("/aweme/v1/web/mix/aweme/", {mix_id: m.mix_id, cursor: String(k.cursor), count: "12"})).then(function (q) {
                    if (q) { R("mix/aweme 第二页 status=" + q.status_code + " 条数=" + (q.aweme_list || []).length + " has_more=" + q.has_more + " cursor=" + q.cursor +
                               " 集数=" + (q.aweme_list || []).map(function (a) { return a.mix_info && a.mix_info.statis ? a.mix_info.statis.current_episode : "?"; }).join(",")); }
                });
            });
        }).then(function () {
            var target = awemes.filter(function (a) { return a && (a.statistics || {}).comment_count > 30; })[0];
            if (!target) { R("没有评论多的条目"); return; }
            return step("comment/list", Bridge.get("/aweme/v1/web/comment/list/", {aweme_id: target.aweme_id, cursor: "0", count: "20", item_type: "0", insert_ids: "",
                                                                               whale_cut_token: "", cut_version: "1", rcFT: ""})).then(function (j) {
                if (!j) { return; }
                var c = j.comments || [];
                var c0 = c[0] || {};
                R("comment/list status=" + j.status_code + " 顶层=" + keys(j) + " 条数=" + c.length + " total=" + j.total + "（视频说 " + target.statistics.comment_count + "）has_more=" + j.has_more + " cursor=" + j.cursor);
                R("评论字段 " + keys(c0) + " | user 字段 " + keys(c0.user) + " | 带图 " + c.filter(function (x) { return x.image_list; }).length + " 带表情 " + c.filter(function (x) { return x.sticker; }).length +
                  " ip_label 样例 " + c0.ip_label + " create_time " + c0.create_time + " 有回复的 " + c.filter(function (x) { return x.reply_comment_total > 0; }).length);
                var withReply = c.filter(function (x) { return x.reply_comment_total > 0; })[0];
                if (!withReply) { return; }
                return step("comment/list/reply（v2）", Bridge.get("/aweme/v2/web/comment/list/reply/", {item_id: target.aweme_id, comment_id: withReply.cid, cursor: "0", count: "3",
                                                                                             item_type: "0", whale_cut_token: "", cut_version: "1"})).then(function (k) {
                    if (!k) { return; }
                    var r = k.comments || [];
                    R("reply status=" + k.status_code + " 顶层=" + keys(k) + " 条数=" + r.length + " total=" + k.total + "（评论说 " + withReply.reply_comment_total + "）has_more=" + k.has_more + " cursor=" + k.cursor +
                      " | 回复字段 " + keys(r[0]) + " reply_to_username=" + (r[0] ? (r[0].reply_to_username ? "有" : "无") : "-"));
                });
            });
        }).then(function () { R("结束"); }, function (e) { R("中止：" + e.message); });
    }

    /* --abseek（2026-10-22）：切换时什么时候 seek。cover 动画（整页 250ms 盖上来）走到第几毫秒发 seek：200（原来，盖到 ~99.5%）/ 130
     * （~95%，顶上一条旧画面会冻住 / 变黑 ~120ms，要人眼看）逐条轮换。同时看：撤封面晚没晚（>100ms 算晚，主线程被顶住）、封面用上
     * 软解第一帧的有几次。 */
    function abSeek() {
        var N = 30, i = 0, ARMS = [200, 130], from = 0;
        function one() {
            if (i >= N) { return Promise.resolve(); }
            window.__app.setCoverSeek(ARMS[i % 2]);
            i++;
            var before = st().id;
            key(KEY.DOWN);
            return waitShown(before, 15000).then(function () { return wait(5000); }).then(one);
        }
        return waitShown("", 40000).then(function () { return wait(5000); }).then(function () {
            Log.report("AB", "开始：连刷 " + N + " 条，每条看 5 秒；seek 在 " + ARMS.join(" / ") + "ms 逐条轮换");
            from = window.__app.records().length;
            return one();
        }).then(function () {
            var rs = window.__app.records().slice(from).filter(function (r) { return r.push === "cover"; });
            ARMS.forEach(function (m) {
                var g = rs.filter(function (r) { return r.seekMs === m; });
                Log.report("AB", "seek " + m + "ms：" + g.length + " 次，按键→playing 中位 " + median(g.map(function (r) { return r.playing; })) + "ms，按键→撤封面 中位 " +
                           median(g.map(function (r) { return r.frame; })) + "ms，撤封面晚 >100ms " + g.filter(function (r) { return r.late > 100; }).length + " 次，封面用上软解第一帧 " +
                           g.filter(function (r) { return r.ff; }).length + " 次 | 全部=" + g.map(function (r) { return r.frame + (r.ff ? "" : "图"); }).join(","));
            });
            window.__app.setCoverSeek(130);
            Log.report("AB", "结束");
        }, function (e) { Log.report("AB", "中止：" + e.message); });
    }

    var MODES = {abseek: abSeek, soak: soak, qr: qrOnly, diag: diagRun, ab: ab, seek: seekRun, author: authorOnly, grid: gridRun, cold: coldRun, probe: probeRun, me: meRun, mix: mixRun, like: likeRun};
    if (SELFTEST === "mse" || SELFTEST === "splice" || SELFTEST === "livemse") { return; }   // js/msespike.js 自己跑
    window.addEventListener("load", function () { setTimeout(MODES[SELFTEST] || run, 500); });
})();
