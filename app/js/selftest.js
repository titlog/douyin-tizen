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
            var focused = document.getElementById("author").className === "focus";
            check("暂停时下键选中作者（不换视频）", focused && s1.paused && s1.id === from.id,
                  "作者块=" + (focused ? "亮了" : "没亮") + "，暂停=" + s1.paused + "，同一条=" + (s1.id === from.id) + "，提示=" + document.getElementById("hint").textContent);
            if (!focused) { throw new Error("没选中作者，后面的作者主页步骤不跑了"); }
            key(KEY.ENTER);
            t0 = Date.now();
            function poll() {
                var a = Author.state();
                if (a && a.cards > 0 && a.imgs > 0 && (a.stats || Date.now() - t0 > 8000)) { return Promise.resolve(Date.now() - t0); }
                if (Date.now() - t0 > 20000) { return Promise.resolve(-1); }
                return wait(300).then(poll);
            }
            return poll();
        }).then(function (ms) {
            var a = Author.state() || {};
            /* 看得见的结果：卡片的封面真的解码出来了、头部有数字。 */
            check("确认进作者主页、出网格", window.__app.view() === "author" && ms >= 0 && !!a.stats,
                  ms + "ms，@" + a.name + "，" + a.cards + " 张卡片、封面解码 " + a.imgs + "，头像 " + a.avatar + "px，「" + a.stats + "」" + (a.foot ? "，底下「" + a.foot + "」" : ""));
            if (!a.cards) { throw new Error("网格没出来：" + JSON.stringify(a)); }
            if (a.cards < 3) { return null; }
            key(KEY.RIGHT);
            return wait(400).then(function () {
                var want = Author.feed().all()[1].id;
                key(KEY.ENTER);
                return waitId(want, 15000).then(function (ms2) {
                    return longestStall(5000).then(function (stall) {
                        check("网格里挑一条能播", st().id === want && ms2 >= 0 && stall < 3000 && window.__app.view() === "feed",
                              "出画面 " + ms2 + "ms，是挑的那条=" + (st().id === want) + "，最长停顿 " + stall + "ms");
                    });
                });
            }).then(function () {
                var want = Author.feed().all()[2].id;
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
                var a = Author.state() || {};
                check("返回键回到网格、焦点在刚才那条", window.__app.view() === "author" && a.sel === 2, "视图=" + window.__app.view() + "，焦点 #" + a.sel);
            });
        }).then(function () {
            /* 一直往下翻：快到底了会取下一页。匿名时第二页只回 {"status_code":0}（测试台实测）；登录后给不给，就看这一步。 */
            if (window.__app.view() !== "author") { return; }
            var n0 = Author.state().cards, i = 0;
            function down() {
                if (i++ >= 5) { return Promise.resolve(); }
                key(KEY.DOWN);
                return wait(700).then(down);
            }
            return down().then(function () { return wait(4000); }).then(function () {
                var a = Author.state(), f = Author.feed();
                var ok = a.cards > n0 || (!f.hasMore() && !(f.gated() && Account.loggedIn()));
                check("网格往下翻取下一页", ok, "卡片 " + n0 + " → " + a.cards + "，还有更多=" + f.hasMore() + "，第二页只回了 status_code=" + f.gated() +
                      "，" + (Account.loggedIn() ? "已登录" : "未登录") + "，焦点 #" + a.sel + "，底下「" + a.foot + "」");
            });
        }).then(function () {
            if (window.__app.view() !== "author") { return; }
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
        }).then(ensureLong).then(function () {
            var a = st().t;
            key(KEY.FF);
            return wait(1500).then(function () {
                var b = st().t;
                check("快进键 +10 秒", b - a > 8 && b - a < 14, a.toFixed(1) + " → " + b.toFixed(1));
            });
        }).then(function () {
            /* 左右键播放时切标签、暂停时快进 —— 这里测后一半。 */
            key(KEY.ENTER);
            return wait(800).then(function () {
                var a = st().t;
                key(KEY.RIGHT);
                return wait(1500).then(function () {
                    var b = st().t;
                    check("暂停时右键是快进", b - a > 8 && b - a < 14 && window.__app.tab() === "recommend", a.toFixed(1) + " → " + b.toFixed(1) + "，标签=" + window.__app.tab());
                    key(KEY.ENTER);
                    return wait(1000);
                });
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
            /* 标签顺序：精选 · 关注 · 推荐 · 我。预期跟着登录态走：已登录时「关注」能播、「我」是
             * 账号页；未登录时两个都出二维码。**「我」页上绝不按确认键** —— 那是退出登录。 */
            var recId = st().id, recT = st().t;
            var logged = Account.loggedIn();
            key(KEY.RIGHT);
            return (logged ? wait(1500).then(function () { return 0; }) : waitQr(20000)).then(function (ms) {
                if (logged) {
                    check("已登录时「我」是账号页", window.__app.tab() === "me" && window.__app.view() === "me", "视图=" + window.__app.view());
                } else {
                    check("未登录时「我」出二维码", window.__app.tab() === "me" && window.__app.view() === "login" && ms >= 0, "视图=" + window.__app.view() + "，二维码 " + ms + "ms");
                }
                key(KEY.LEFT);                       // 回推荐：管线只是暂停着（Player.stop），该是原地接着放
                return waitShown("", 15000).then(function (ms) {
                    var s1 = st();
                    check("从「我」回到推荐接着放", ms >= 0 && s1.id === recId && s1.t >= recT - 1,
                          "出画面 " + ms + "ms，同一条=" + (s1.id === recId) + "，离开时 " + recT.toFixed(1) + "s，现在 " + s1.t.toFixed(1) + "s");
                    return wait(1500);
                });
            }).then(function () {
                key(KEY.LEFT);                       // 到关注
                return logged ? waitShown(recId, 20000) : waitQr(20000);
            }).then(function (ms) {
                if (logged) {
                    return longestStall(6000).then(function (stall) {
                        check("已登录时「关注」能播", window.__app.tab() === "follow" && ms >= 0 && stall < 3000, "出画面 " + ms + "ms，最长停顿 " + stall + "ms");
                    });
                }
                check("未登录时「关注」出二维码", window.__app.tab() === "follow" && window.__app.view() === "login" && ms >= 0, "视图=" + window.__app.view() + "，二维码 " + ms + "ms");
            }).then(function () {
                key(KEY.LEFT);                       // 到精选
                return waitShown(st().id, 20000);
            }).then(function (ms) {
                return longestStall(6000).then(function (stall) {
                    check("「精选」能播", window.__app.tab() === "jingxuan" && ms >= 0 && stall < 3000, "出画面 " + ms + "ms，最长停顿 " + stall + "ms");
                });
            }).then(function () { return switchStep("精选里下一条", KEY.DOWN); })
              .then(function () {
                key(KEY.RIGHT); key(KEY.RIGHT);      // 经过关注回到推荐
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
            key(KEY.RIGHT);
            return wait(1500);
        }).then(function () {
            if (Player.isPaused()) { key(KEY.ENTER); }
            key(KEY.RIGHT);
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
            key(KEY.RIGHT);                          // 推荐右边就是「我」
            return waitQr(30000);
        }).then(function (ms) {
            var q = document.getElementById("qr");
            check("「我」的二维码真的显示出来", ms >= 0, "等了 " + ms + "ms，naturalWidth=" + (q ? q.naturalWidth : "-") + " complete=" + (q ? q.complete : "-"));
            Log.report("SELFTEST", fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
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
                var a = Author.state();
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
            if (!ok) { throw new Error("网格不到 5 行或封面没到齐：" + JSON.stringify(Author.state())); }
            return keys(KEY.DOWN, 6).then(function () { return keys(KEY.UP, 6); }).then(function () { return waitImgs(17, 10000); });
        }).then(function () {
            Author.probes().length = 0;
            var r = 0;
            function round() {
                if (r >= ROUNDS) { return Promise.resolve(); }
                Author.setMode(ARMS[r++ % ARMS.length]);
                return keys(KEY.DOWN, 4).then(function () { return keys(KEY.UP, 4); }).then(round);
            }
            return round();
        }).then(function () {
            var ps = Author.probes();
            ARMS.forEach(function (m) {
                var g = ps.filter(function (p) { return p.mode === m && p.scrolled; });
                Log.report("GRID", m + "：滚动 " + g.length + " 次，最长帧间隔 中位 " + median(g.map(function (p) { return p.maxGap; })) +
                           "ms，掉帧 共 " + sum(g.map(function (p) { return p.drops; })) + "（有掉帧的 " + g.filter(function (p) { return p.drops; }).length +
                           " 次），按键→第一帧 中位 " + median(g.map(function (p) { return p.first; })) + "ms，长任务 共 " + sum(g.map(function (p) { return p.long; })) +
                           "ms | 最长间隔 全部=" + g.map(function (p) { return p.maxGap; }).join(","));
            });
            Author.setMode("层+瞬");
            if (window.__app.view() === "author") { key(KEY.RETURN); }
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
                    var f = Author.feed();
                    if (!f) { return Promise.resolve(); }
                    var n = f.all().filter(old).length;
                    if (n >= WANT * 3 || (!f.hasMore() && presses > 0) || presses >= 60) { return Promise.resolve(); }
                    presses += 6;
                    return keys(KEY.DOWN, 6).then(function () { return wait(1500); }).then(page);
                }
                return page();
            }).then(function () {
                var all = Author.feed() ? Author.feed().all() : [];
                var idx = [];
                for (var i = all.length - 1; i >= 0 && idx.length < WANT; i--) {
                    if (old(all[i]) && (!idx.length || idx[idx.length - 1] - i >= 3)) { idx.push(i); }
                }
                Log.report("COLD", "@" + Author.name() + " 翻到 " + all.length + " 条，一年以前的 " + all.filter(old).length + " 条，挑 " + idx.length + " 条");
                return idx;
            });
        }
        function one(i) {
            var it = Author.feed().all()[i];
            var days = Math.floor((Date.now() / 1000 - it.time) / 86400);
            return quiet(30000).then(function () {
                Author.select(i);
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
                if (window.__app.view() === "author") { key(KEY.RETURN); }
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

    var MODES = {soak: soak, qr: qrOnly, ab: ab, seek: seekRun, author: authorOnly, grid: gridRun, cold: coldRun};
    if (SELFTEST === "mse") { return; }                 // js/msespike.js 自己跑
    window.addEventListener("load", function () { setTimeout(MODES[SELFTEST] || run, 500); });
})();
