/* 诊断日志（app/js/diag.js）的离线验证。deploy.sh、release.sh 卡着它。
 *
 * 照搬 bilibili-tizen 的 tools/diag-verify.mjs（接收端那一半在那边测：两个应用共用一个接收端）。卡发布，因为这件事坏掉的
 * 两种样子都是静默的：作者名、文案漏出去，看起来和正常上传一模一样；该传的时候没传，看起来就是一台没出过事的电视。
 * 所以测：什么被抹掉、什么时候传什么时候不传、log.js 是不是每一行都记进来了；再从源码里查每个进 Log.report() /
 * Diag.incident() 的作者名、文案、昵称是不是都包在 Diag.priv() 里。
 *
 *   node tools/diag-verify.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const SRC = fs.readFileSync(here("../app/js/diag.js"), "utf8");
const LOG = fs.readFileSync(here("../app/js/log.js"), "utf8");
let failures = 0;
async function t(name, fn) {
  try { await fn(); console.log("✓ " + name); }
  catch (e) { failures++; console.log("✗ " + name + "\n    " + (e && e.message || e).split("\n").join("\n    ")); }
}

/* ---------------- 给 diag.js 一台电视 ---------------- */

function television({ storage = new Map(), reportTo = "", diagTo = "https://diag.test/v1/upload", start = Date.UTC(2026, 9, 21, 4), withLog = false } = {}) {
  let clock = start;
  const timers = new Map(); let nextTimer = 1;
  const sent = [], reported = [], collector = [];
  const responder = { fn: () => [200, JSON.stringify({ id: "abc23456" })] };
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  class XHR {
    constructor() { this.readyState = 0; this.status = 0; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) {
      this.body = body;
      if (/\/report$/.test(this.url)) { collector.push(JSON.parse(body).detail.msg); return; }
      sent.push(this);
      const [status, text] = responder.fn(this);
      this.status = status; this.responseText = text; this.readyState = 4;
      if (status === 0 && this.onerror) { this.onerror(); }
      if (this.onreadystatechange) { this.onreadystatechange(); }
    }
  }
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  const sandbox = {
    Date: FakeDate, Math, JSON, String, Number, Uint8Array, RegExp,
    localStorage, XMLHttpRequest: XHR,
    navigator: { userAgent: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36" },
    window: { crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } },
              addEventListener() {} },
    document: { hidden: false, addEventListener() {} },
    console: { log() {} },
    Boot: { info: () => ({ packaged: "1.2.0", running: "1.3.0", note: "" }), scriptName: (s) => s },
    REPORT_TO: reportTo, DIAG_TO: diagTo,
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "diag.js" });
  const Diag = sandbox.Diag;
  if (withLog) {
    vm.runInContext(LOG, sandbox, { filename: "log.js" });
    Diag.init({ report: sandbox.Log.report });
  } else {
    Diag.init({ report: (k, d) => { reported.push(k + ": " + d); Diag.record(k, d); } });
  }
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].fn();
    }
    clock = until;
  }
  return { Diag, sent, reported, collector, storage, advance, responder, sandbox };
}

const lastBody = (tv) => JSON.parse(tv.sent[tv.sent.length - 1].body);

/* ---------------- 什么能传出去 ---------------- */

await t("包起来的作者、文案换成 …，视频 id 留着", () => {
  const { Diag } = television();
  const line = "播放: 推荐 #3 下键 7562389017265114403 " + Diag.priv("某个作者") + " " + Diag.priv("今天去爬山了") + " 1080x1920 18s";
  assert.equal(Diag.scrub(line), "播放: 推荐 #3 下键 7562389017265114403 … … 1080x1920 18s");
  assert.equal(Diag.plain(line), "播放: 推荐 #3 下键 7562389017265114403 某个作者 今天去爬山了 1080x1920 18s");
});

await t("被截断、没收尾的包裹一直抹到行尾", () => {
  const { Diag } = television();
  const cut = ("到画面: 812ms | " + Diag.priv("一段很长很长的文案")).slice(0, 18);
  assert.equal(Diag.scrub(cut + " 后面的字"), "到画面: 812ms | …");
});

await t("账号：sec_uid、uid、昵称不出门；account 那行的 cookie 名字留着", () => {
  const { Diag } = television();
  const lines = [
    "作者: 资料 210ms sec_user_id=MS4wLjABAAAAx9fRk2Qe-AbCdEfG_hij 粉丝 12",
    "我: uid=98765432101 nickname=没包的昵称 喜欢 3",
    "网格: GET /aweme/v1/web/aweme/favorite/?sec_user_id=MS4wLjABAAAAzzz&max_cursor=0",
  ];
  for (const l of lines) {
    const s = Diag.scrub(l);
    assert.doesNotMatch(s, /MS4wLjABAAAA|98765432101|没包的昵称|x9fRk2Qe/, s);
  }
  const acct = "account: 启动 → history/read status_code=0 → 判为已登录 | 框里可见的 cookie（3 个）：UIFID_TEMP,passport_assist_user,s_v_web_id";
  assert.equal(Diag.scrub(acct), acct);
});

await t("地址里的签名、设备指纹参数和 cookie 值抹掉，主机、路径和 video_id 留着", () => {
  const { Diag } = television();
  const u = "播放: 最终地址失败 https://www.douyin.com/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&count=10" +
            "&webid=7426111111111111111&uifid=abcdefabcdef0123&msToken=Zx_9-aa&verifyFp=verify_m2abc&fp=verify_m2abc&a_bogus=Ef7%2FQQ" +
            " | https://www.douyin.com/aweme/v1/play/?video_id=v0200fg10000cs&ratio=1080p";
  const s = Diag.scrub(u);
  assert.match(s, /www\.douyin\.com\/aweme\/v1\/web\/tab\/feed\/\?device_platform=webapp&aid=6383&count=10/);
  assert.match(s, /video_id=v0200fg10000cs&ratio=1080p/);
  assert.doesNotMatch(s, /7426111111111111111|abcdefabcdef0123|Zx_9-aa|verify_m2abc|Ef7%2FQQ/, s);
  const c = Diag.scrub("cookie ttwid=1%7Cabc%7C123; sessionid=deadbeef; s_v_web_id=verify_xyz; passport_csrf_token=99aa");
  assert.doesNotMatch(c, /1%7Cabc|deadbeef|verify_xyz|99aa/, c);
  assert.match(c, /ttwid=…; sessionid=…; s_v_web_id=…; passport_csrf_token=…/);
});

await t("上传的整份内容里没有任何包起来的东西（原因也过一遍）", () => {
  const tv = television();
  tv.Diag.record("播放", "7562389017265114403 " + tv.Diag.priv("秘密文案") + " 放不了");
  tv.Diag.incident("「我」列表加载失败：" + tv.Diag.priv("我的昵称") + " uid=98765432101");
  tv.advance(tv.Diag._test.SETTLE);
  assert.equal(tv.sent.length, 1);
  assert.doesNotMatch(tv.sent[0].body, /秘密文案|我的昵称|98765432101||/);
  assert.match(tv.sent[0].body, /7562389017265114403/);
});

await t("log.js：每一行都进那一圈（抹过的），收集器收到的是原样、没有记号", () => {
  const tv = television({ reportTo: "http://10.0.0.2:8098", diagTo: "", withLog: true });
  tv.sandbox.Log.report("播放", "7562389017265114403 " + tv.Diag.priv("某个作者") + " 放不了");
  const ring = tv.Diag._test.ring();
  assert.match(ring[ring.length - 1], /播放: 7562389017265114403 … 放不了$/);
  assert.equal(tv.collector[tv.collector.length - 1], "播放: 7562389017265114403 某个作者 放不了");
});

await t("log.js：js 错误、没人接的 Promise 异常都算出事", () => {
  const tv = television({ withLog: true });
  tv.sandbox.window.onerror("Cannot read properties of undefined (reading 'peekNext')", "app.js", 412);
  tv.advance(tv.Diag._test.SETTLE);
  assert.equal(tv.sent.length, 1);
  assert.match(lastBody(tv).reason, /^js 错误：Cannot read properties.*@app\.js:412$/);
});

/* ---------------- 那一圈 ---------------- */

await t("关着：不记、不传；关掉时清空本地的；开关记在 dy.diag.off", () => {
  const tv = television();
  tv.Diag.record("播放", "第一行");
  tv.advance(20000);
  assert.ok(tv.storage.get("dy.diag.ring").includes("第一行"));
  tv.Diag.setEnabled(false);
  assert.equal(tv.storage.get("dy.diag.off"), "1");
  assert.equal(tv.storage.has("dy.diag.ring"), false);
  tv.Diag.record("播放", "关着时的一行");
  tv.Diag.incident("连续好几条都放不了");
  tv.advance(60000);
  assert.equal(tv.sent.length, 0);
  assert.equal(tv.Diag._test.ring().length, 0);
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, false);
  assert.equal(tv.Diag.status().enabled, false);
  tv.Diag.setEnabled(true);
  assert.equal(tv.storage.has("dy.diag.off"), false);
  assert.equal(tv.Diag.status().enabled, true);
});

await t("最多 600 行、16 万字，挤掉最老的", () => {
  const tv = television();
  for (let i = 0; i < 700; i++) tv.Diag.record("播放", "行 " + i);
  const ring = tv.Diag._test.ring();
  assert.equal(ring.length, 600);
  assert.match(ring[ring.length - 1], /行 699$/);
  for (let i = 0; i < 100; i++) tv.Diag.record("播放", "长".repeat(3000));
  const total = tv.Diag._test.ring().reduce((n, l) => n + l.length, 0);
  assert.ok(total <= 160000, "ring holds " + total + " chars");
  tv.Diag.record("播放", "x".repeat(9000));
  assert.ok(tv.Diag._test.ring().pop().length < 4100);
});

await t("重开应用：上次的日志还在，中间有一行分界；编号不变", () => {
  const storage = new Map();
  const a = television({ storage });
  a.Diag.record("播放", "上一次的最后一行");
  a.advance(20000);
  const b = television({ storage });
  const ring = b.Diag._test.ring();
  assert.ok(ring.some((l) => l.includes("上一次的最后一行")));
  assert.match(ring[ring.length - 1], /新的一次启动/);
  assert.equal(b.Diag.status().device, a.Diag.status().device);
  assert.match(a.Diag.status().device, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

/* ---------------- 什么时候传 ---------------- */

await t("出事后等 8 秒再传，期间的几件事合成一份；信封里是 douyin-tizen", () => {
  const tv = television();
  tv.Diag.incident("连不上抖音：三台 bdms 镜像都加载不了");
  tv.advance(3000);
  tv.Diag.record("bridge", "后到的一行");
  tv.Diag.incident("推荐加载失败，按下键重试");
  assert.equal(tv.sent.length, 0);
  tv.advance(tv.Diag._test.SETTLE);
  assert.equal(tv.sent.length, 1);
  const b = lastBody(tv);
  assert.equal(b.reason, "连不上抖音：三台 bdms 镜像都加载不了 / 推荐加载失败，按下键重试");
  assert.ok(b.lines.some((l) => l.includes("后到的一行")));
  assert.equal(b.app, "douyin-tizen");
  assert.match(b.device, /^[A-Z2-9]{8}$/);
  assert.equal(b.version, "1.2.0");
  assert.equal(b.running, "1.3.0");
  assert.equal(b.manual, false);
  assert.match(b.ua, /Tizen 6\.0/);
  assert.equal(tv.sent[0].headers["Content-Type"], "text/plain;charset=UTF-8");
  assert.equal(tv.Diag.status().last.id, "abc23456");
  assert.ok(tv.reported.some((l) => /传了 \d+ 行，编号 abc23456，走 https/.test(l)));
});

await t("自动上传：三分钟一份、一天十二份；手动不受这个限制", () => {
  const tv = television();
  const { SETTLE, AUTO_GAP, AUTO_PER_DAY } = tv.Diag._test;
  tv.Diag.incident("一"); tv.advance(SETTLE);
  tv.Diag.incident("二"); tv.advance(SETTLE);
  assert.equal(tv.sent.length, 1, "second within three minutes is held back");
  assert.ok(tv.reported.some((l) => l.includes("没传（三分钟内")));
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, true, "manual is not held back by the automatic gap");
  assert.equal(lastBody(tv).manual, true);
  for (let i = 0; i < 20; i++) { tv.advance(AUTO_GAP); tv.Diag.incident("循环 " + i); tv.advance(SETTLE); }
  assert.equal(tv.sent.filter((x) => !JSON.parse(x.body).manual).length, AUTO_PER_DAY);
  assert.ok(tv.reported.some((l) => l.includes("今天已经自动传了")));
});

await t("手动连按：十秒内第二次被拒，状态里写着原因", () => {
  const tv = television();
  tv.Diag.upload(() => {});
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, false);
  assert.equal(tv.sent.length, 1);
  assert.match(tv.Diag.status().last.why, /刚传过/);
});

await t("https 连不上时用 http 再试一次，日志写明走的哪条", () => {
  const tv = television();
  tv.responder.fn = (x) => (x.url.startsWith("https:") ? [0, ""] : [200, JSON.stringify({ id: "viahttp2" })]);
  tv.Diag.upload(() => {});
  assert.deepEqual(tv.sent.map((x) => x.url), ["https://diag.test/v1/upload", "http://diag.test/v1/upload"]);
  assert.equal(tv.Diag.status().last.id, "viahttp2");
  assert.ok(tv.reported.some((l) => l.includes("走 http（https")));
});

await t("服务器拒绝：写进状态，不当成功", () => {
  const tv = television();
  tv.responder.fn = () => [429, JSON.stringify({ error: "too many from this device" })];
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, false);
  assert.match(tv.Diag.status().last.why, /HTTP 429 too many/);
});

await t("开发构建不传（除非 deploy.sh 给了 DIAG_TO）；发布构建用 diag.js 自己的 https 地址", () => {
  const dev = television({ reportTo: "http://10.0.0.2:8098", diagTo: "" });
  dev.Diag.incident("连续好几条都放不了"); dev.advance(60000);
  assert.equal(dev.sent.length, 0);
  assert.equal(dev.Diag.status().configured, false);
  const pointed = television({ reportTo: "http://10.0.0.2:8098", diagTo: "http://10.0.0.2:8097/v1/upload" });
  assert.equal(pointed.Diag._test.endpoint(), "http://10.0.0.2:8097/v1/upload");
  const release = television({ reportTo: "", diagTo: "" });
  const ENDPOINT = /var ENDPOINT = "([^"]*)";/.exec(SRC)[1];
  assert.match(ENDPOINT, /^https:\/\//);
  assert.equal(release.Diag._test.endpoint(), ENDPOINT);
  const cfg = fs.readFileSync(here("../app/js/config.js"), "utf8");
  assert.match(cfg, /^var DIAG_TO = "";$/m, "config.js 里的 DIAG_TO 要是空串（deploy.sh 中途退出留下的？）");
});

await t("boot.js：diag.js 排在最前（log.js 一加载就要用它）", () => {
  const boot = fs.readFileSync(here("../app/js/boot.js"), "utf8");
  const list = [.../var SCRIPTS = \[([^\]]*)\]/.exec(boot)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(list[0], "diag.js", "SCRIPTS 是 " + list.join(", "));
});

/* ---------------- 源码：进 Log.report() / Diag.incident() 的作者名、文案、昵称都包起来 ---------------- */

await t("app/js：进日志和出事原因的作者名、文案、昵称、页名、登录页文字都包在 Diag.priv 里", () => {
  const dir = here("../app/js/");
  const skip = new Set(["diag.js", "log.js", "selftest.js", "msespike.js", "config.js", "boot.js"]);
  const bad = [];
  let calls = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js") && !skip.has(x))) {
    const src = fs.readFileSync(dir + f, "utf8");
    /* mse.js 的 R(msg) 就是 Log.report("mse", msg)；pushPage(page, why) 把 why 写进「页面」那行；trouble(msg) 的 msg 是出事原因。 */
    const re = /(?:Log\.report|Diag\.incident|(?<![\w.])(?:R|pushPage|trouble))\(/g;
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length, depth = 1, q = null;
      while (i < src.length && depth) {
        const c = src[i];
        if (q) { if (c === "\\") i++; else if (c === q) q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        i++;
      }
      calls++;
      const call = src.slice(m.index, i);
      let rest = call, prev;
      do { prev = rest; rest = rest.replace(/Diag\.priv\((?:[^()]|\([^()]*(?:\([^()]*\)[^()]*)*\))*\)/g, "PRIV"); } while (rest !== prev);
      /* 字段，不是方法：Grid.author(it) 是开一页作者主页，不是作者名。 */
      if (/\.(desc|author|nickname|title|signature)\b(?!\()|\bGrid\.name\(\)|\bbody\.slice\b|\bm\.name\b|\bmix\.name\b|\bsec_?[uU]id\b|\bsecUid\b/.test(rest)) {
        bad.push(f + ":" + src.slice(0, m.index).split("\n").length + ": " + call.replace(/\s+/g, " ").slice(0, 140));
      }
    }
  }
  assert.ok(calls > 50, "只找到 " + calls + " 处调用 —— 匹配规则坏了？");
  assert.deepEqual(bad, [], "没包起来：\n" + bad.join("\n"));
});

if (failures) { console.log(`\n✗ ${failures} 项失败`); process.exit(1); }
console.log("\n✓ 诊断日志全部通过");
