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

    var KEY = { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, ENTER: 13, FF: 417 };
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
                key(KEY.LEFT);                       // 回推荐
                return waitShown("", 15000).then(function () { return wait(1500); });
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
        }).then(function () {
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

    /* --ab：只刷，同一轮里轮换两组做法（跨两轮比较会被网络骗，见 CLAUDE.md）。
     *   切换方式："cover"（新封面盖满 250ms 再换源）和 "early"（按键就换源）逐条轮换，
     *            比的是从按键算起的 playing / 撤封面。
     *   预热：补取到 moov 末尾 + 512KB / 只取开头 512KB，按视频 id 奇偶分（player.js），比的是元数据。 */
    function ab() {
        var N = 50, i = 0, from = 0;
        Player.setMoovAB(true);
        function one() {
            if (i >= N) { return Promise.resolve(); }
            window.__app.setPush(i % 2 ? "early" : "cover");
            i++;
            var before = st().id;
            key(KEY.DOWN);
            return waitShown(before, 15000).then(function () { return wait(6000); }).then(one);
        }
        return waitShown("", 40000).then(function () {
            Log.report("AB", "开始：连刷 " + N + " 条，每条看 6 秒；cover/early 逐条轮换，预热补取/不补取按视频 id 奇偶分");
            return wait(4000);
        }).then(function () {
            from = window.__app.records().length;
            return one();
        }).then(function () {
            var rs = window.__app.records().slice(from);
            ["cover", "early"].forEach(function (m) {
                var g = rs.filter(function (r) { return r.push === m; });
                var warmOk = g.filter(function (r) { return r.warm.indexOf("好了") >= 0; });
                Log.report("AB", "切换 " + m + "：" + g.length + " 次（预热好了 " + warmOk.length + "），按键→playing 中位 " +
                           median(g.map(function (r) { return r.playing; })) + "ms，按键→撤封面 中位 " + median(g.map(function (r) { return r.frame; })) +
                           "ms | 全部=" + g.map(function (r) { return r.frame; }).join(","));
            });
            [["补取", "moov 补取"], ["不补（对照）", "moov 不补"]].forEach(function (arm) {
                var g = rs.filter(function (r) { return r.warm.indexOf("好了") >= 0 && r.warm.indexOf(arm[0]) >= 0; });
                Log.report("AB", arm[1] + "：" + g.length + " 次，元数据 中位 " + median(g.map(function (r) { return r.meta; })) +
                           "ms | 全部=" + g.map(function (r) { return r.meta; }).join(","));
            });
            Log.report("AB", "结束");
        }, function (e) { Log.report("AB", "中止：" + e.message); });
    }

    var MODES = {soak: soak, qr: qrOnly, ab: ab};
    if (SELFTEST === "mse") { return; }                 // js/msespike.js 自己跑
    window.addEventListener("load", function () { setTimeout(MODES[SELFTEST] || run, 500); });
})();
