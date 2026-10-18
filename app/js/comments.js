/* 评论侧栏（2026-10-18），只读：暂停时选中「评论」、确认键打开，盖在画面右边。上下键一行一行走（评论、展开的回复、
 * 「展开更多回复」各算一行），确认键展开 / 收起这条评论的回复，返回键关掉。往下快到底了自动取下一页。
 *
 * 接口照官网前端代码，2026-10-18 电视上登录态 --probe 问过：
 *   GET /aweme/v1/web/comment/list/        aweme_id、cursor（偏移量，应答给下一个）、count=20 → comments[]、total、has_more
 *       每条 text、user.{nickname, avatar_thumb}、digg_count、create_time（秒）、ip_label、reply_comment_total、label_text、
 *       image_list（带图的评论）、sticker（表情）
 *   GET /aweme/v2/web/comment/list/reply/  item_id、comment_id（评论的 cid）、cursor、count → comments[]（回复里有 reply_to_username）
 *       **用 v2，不用 v1**：v1 的 /aweme/v1/web/comment/list/reply/ 回 200 + 空正文 + bdturing-verify 头（人机验证，type=verify
 *       subtype=text），签名 SDK 收到它就把请求扣住等验证码，而验证码弹在看不见的框里 —— onload、ontimeout 一个都不来，
 *       请求永远悬着（2026-10-18 电视上 --probe 和桌面测试台都是这样）。官网前端代码里两个都有，v2 正常回数据。
 * 发评论、给评论点赞都不做（只读）。按键在 app.js（侧栏开着时按键都交给这里）。
 */
var Comments = (function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };
    var VIEW_H = 900;         // #cm-view 的高度（app.css）
    var cur = null;           // {item, rows, sel, cursor, more, loading, err, total, offset, foot}

    function count(n) {
        if (n >= 100000000) { return (n / 100000000).toFixed(1) + "亿"; }
        if (n >= 10000) { return (n / 10000).toFixed(1) + "万"; }
        return String(n || 0);
    }
    function first(list) { return list && list.url_list && list.url_list[0] || ""; }
    function ago(sec) {
        var d = Date.now() / 1000 - sec;
        if (d < 60) { return "刚刚"; }
        if (d < 3600) { return Math.floor(d / 60) + " 分钟前"; }
        if (d < 86400) { return Math.floor(d / 3600) + " 小时前"; }
        if (d < 30 * 86400) { return Math.floor(d / 86400) + " 天前"; }
        var t = new Date(sec * 1000);
        return (t.getFullYear() !== new Date().getFullYear() ? t.getFullYear() + "-" : "") + (t.getMonth() + 1) + "-" + t.getDate();
    }
    function text(c) {
        var t = c.text || "";
        if (c.reply_to_username) { t = "回复 @" + c.reply_to_username + "：" + t; }
        if (c.image_list) { t += (t ? " " : "") + "[图片]"; }
        if (c.sticker) { t += (t ? " " : "") + "[表情]"; }
        return t;
    }

    /* 一行：评论（"c"）、回复（"r"，缩进）、「展开更多回复」（"more"）。 */
    function rowEl(kind, c) {
        var el = document.createElement("div");
        if (kind === "more") { el.className = "cm-more"; return el; }
        el.className = "cm" + (kind === "r" ? " reply" : "");
        el.innerHTML = "<img class=\"av\"><div class=\"bd\"><div class=\"nm\"></div><div class=\"tx\"></div><div class=\"mt\"></div><div class=\"rp\"></div></div>";
        var u = c.user || {};
        var src = first(u.avatar_thumb);
        if (src) { el.firstChild.src = src; } else { el.firstChild.style.visibility = "hidden"; }
        var bd = el.lastChild.childNodes;
        bd[0].textContent = (u.nickname || "") + (c.label_text ? " · " + c.label_text : "");
        bd[1].textContent = text(c);
        bd[2].textContent = (c.ip_label ? c.ip_label + " · " : "") + ago(c.create_time) + (c.digg_count ? " · ♥ " + count(c.digg_count) : "");
        return el;
    }
    /* 评论下面那行：有几条回复、展开没有。 */
    function rp(row, msg) {
        var el = row.el.lastChild.childNodes[3];
        var n = row.c.reply_comment_total || 0;
        el.textContent = msg || (n ? (row.open ? "收起回复" : "展开 " + n + " 条回复") : "");
    }

    function title() {
        var me = cur;
        $("cm-title").textContent = "评论 " + (me.total !== undefined ? count(me.total) : count(me.item.comments));
    }
    function foot() {
        var me = cur;
        me.foot.textContent = me.loading ? "正在加载…" : me.err ? "加载失败（" + me.err + "）" + (me.rows.length ? "，往下翻重试" : "，按确认键重试") :
                              !me.more ? (me.rows.length ? "没有更多评论了" : "还没有评论") : "";
    }

    function focus() {
        var me = cur;
        if (!me.rows.length) { return; }
        if (me.sel >= me.rows.length) { me.sel = me.rows.length - 1; }
        for (var i = 0; i < me.rows.length; i++) {
            var r = me.rows[i];
            var cls = r.kind === "more" ? "cm-more" : "cm" + (r.kind === "r" ? " reply" : "");
            r.el.className = cls + (i === me.sel ? " on" : "");
        }
        /* 焦点那一行停在上面三分之一附近；滚到底就不再往上推。 */
        var el = me.rows[me.sel].el;
        var list = $("cm-list");
        var off = Math.max(0, Math.min(el.offsetTop - 160, list.offsetHeight - VIEW_H + 40));
        if (off !== me.offset) {
            me.offset = off;
            list.style.transform = "translateY(" + (-off) + "px)";
        }
        if (me.sel >= me.rows.length - 4) { load(); }
    }

    function load() {
        var me = cur;
        if (!me || me.loading || !me.more) { return; }
        me.loading = true;
        me.err = "";
        foot();
        var t0 = Date.now(), isFirst = me.cursor === 0;
        Bridge.get("/aweme/v1/web/comment/list/", {aweme_id: me.item.id, cursor: String(me.cursor), count: "20", item_type: "0",
                                                   insert_ids: "", whale_cut_token: "", cut_version: "1", rcFT: ""}).then(function (j) {
            if (j.status_code !== 0) { throw new Error("status_code=" + j.status_code + (j.status_msg ? " " + j.status_msg : "")); }
            me.loading = false;
            if (cur !== me) { return; }
            var list = j.comments || [];
            if (isFirst) {
                me.total = j.total;
                title();
                Log.report("评论", me.item.id + " 第一页 " + (Date.now() - t0) + "ms，" + list.length + " 条，total=" + j.total + "（视频说 " + me.item.comments + "）has_more=" + j.has_more);
            }
            me.cursor = j.cursor || me.cursor + list.length;
            me.more = !!j.has_more && list.length > 0;
            for (var i = 0; i < list.length; i++) {
                var row = {kind: "c", c: list[i], el: rowEl("c", list[i])};
                $("cm-list").insertBefore(row.el, me.foot);
                me.rows.push(row);
                rp(row);
            }
            foot();
            focus();
        }).catch(function (e) {
            me.loading = false;
            if (cur !== me) { return; }
            me.err = e.message;
            Log.report("评论", me.item.id + " 取不到（" + (Date.now() - t0) + "ms）：" + e.message);
            foot();
        });
    }

    /* 这条评论下面现在挂着的那几行（回复和「展开更多」）在 rows 里从哪到哪。 */
    function block(row) {
        var i = cur.rows.indexOf(row), j = i + 1;
        while (j < cur.rows.length && cur.rows[j].parent === row) { j++; }
        return {start: i, end: j};
    }

    /* 把 list 这几条回复挂到评论下面（挂在「展开更多」那一行之前，那一行最后重画）。 */
    function attach(row, list) {
        var me = cur, b = block(row);
        if (b.end > b.start + 1 && me.rows[b.end - 1].kind === "more") {
            var old = me.rows.splice(b.end - 1, 1)[0];
            old.el.parentNode.removeChild(old.el);
            b.end--;
        }
        var before = me.rows[b.end] ? me.rows[b.end].el : me.foot;
        var add = [];
        for (var i = 0; i < list.length; i++) { add.push({kind: "r", c: list[i], parent: row, el: rowEl("r", list[i])}); }
        if (row.rmore) {
            var left = (row.c.reply_comment_total || 0) - row.replies.length;
            var mo = {kind: "more", parent: row, el: rowEl("more")};
            mo.el.textContent = "展开更多回复" + (left > 0 ? "（还有 " + left + " 条）" : "");
            add.push(mo);
        }
        for (var k = 0; k < add.length; k++) { $("cm-list").insertBefore(add[k].el, before); }
        Array.prototype.splice.apply(me.rows, [b.end, 0].concat(add));
    }

    function loadReplies(row) {
        var me = cur;
        if (row.rloading) { return; }
        row.rloading = true;
        rp(row, "正在加载回复…");
        var t0 = Date.now();
        Bridge.get("/aweme/v2/web/comment/list/reply/", {item_id: me.item.id, comment_id: row.c.cid, cursor: String(row.rcursor || 0), count: "10",
                                                         item_type: "0", whale_cut_token: "", cut_version: "1"}).then(function (j) {
            if (j.status_code !== 0) { throw new Error("status_code=" + j.status_code + (j.status_msg ? " " + j.status_msg : "")); }
            row.rloading = false;
            if (cur !== me) { return; }
            var list = j.comments || [];
            if (!row.replies) { Log.report("评论", "回复 " + (Date.now() - t0) + "ms，" + list.length + " 条，total=" + j.total + "（评论说 " + row.c.reply_comment_total + "）has_more=" + j.has_more); }
            row.replies = (row.replies || []).concat(list);
            row.rcursor = j.cursor || (row.rcursor || 0) + list.length;
            row.rmore = !!j.has_more && list.length > 0;
            row.open = true;
            rp(row);
            attach(row, list);
            focus();
        }).catch(function (e) {
            row.rloading = false;
            if (cur !== me) { return; }
            Log.report("评论", "回复取不到（" + (Date.now() - t0) + "ms）：" + e.message);
            rp(row, "回复加载失败（" + e.message + "），按确认键重试");
        });
    }

    function collapse(row) {
        var me = cur, b = block(row);
        var gone = me.rows.splice(b.start + 1, b.end - b.start - 1);
        for (var i = 0; i < gone.length; i++) { gone[i].el.parentNode.removeChild(gone[i].el); }
        row.open = false;
        rp(row);
        me.sel = b.start;
        focus();
    }

    function open(item) {
        cur = {item: item, rows: [], sel: 0, cursor: 0, more: true, loading: false, err: "", offset: -1};
        var list = $("cm-list");
        list.innerHTML = "";
        list.style.transform = "translateY(0)";
        cur.foot = document.createElement("div");
        cur.foot.className = "cm-foot";
        list.appendChild(cur.foot);
        title();
        $("comments").className = "show";
        load();
    }

    return {
        open: open,
        close: function () {
            cur = null;
            $("comments").className = "";
            $("cm-list").innerHTML = "";
        },
        isOpen: function () { return !!cur; },
        move: function (dy) {
            if (!cur || !cur.rows.length) { return; }
            var s = cur.sel + dy;
            if (s < 0 || s >= cur.rows.length) { if (dy > 0) { load(); } return; }
            cur.sel = s;
            focus();
        },
        /* 确认键：评论 → 展开 / 收起回复；「展开更多回复」→ 再取一页；整个列表加载失败 → 重试。 */
        enter: function () {
            var me = cur;
            if (!me) { return; }
            if (!me.rows.length) { if (me.err) { me.more = true; load(); } return; }
            var row = me.rows[me.sel];
            if (row.kind === "more") { loadReplies(row.parent); return; }
            if (row.kind !== "c" || !row.c.reply_comment_total) { return; }
            if (row.open) { collapse(row); return; }
            if (row.replies && row.replies.length) {
                row.open = true;
                rp(row);
                attach(row, row.replies);
                focus();
                return;
            }
            loadReplies(row);
        },
        /* 给自测读的 / 用的。 */
        state: function () {
            if (!cur) { return null; }
            var c = 0, r = 0, withReplies = -1;
            for (var i = 0; i < cur.rows.length; i++) {
                if (cur.rows[i].kind === "c") { c++; if (withReplies < 0 && cur.rows[i].c.reply_comment_total > 0) { withReplies = i; } }
                if (cur.rows[i].kind === "r") { r++; }
            }
            return {comments: c, replies: r, rows: cur.rows.length, sel: cur.sel, total: cur.total, withReplies: withReplies,
                    loading: cur.loading, err: cur.err, foot: cur.foot.textContent, title: $("cm-title").textContent};
        },
        select: function (i) { if (cur && i < cur.rows.length) { cur.sel = i; focus(); } }
    };
})();
