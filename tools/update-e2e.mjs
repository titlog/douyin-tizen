/* 自动更新在真浏览器里走一遍：页面启动、在更新源上查到新的签名版本、下载，下一次打开跑它；走不到首页的版本
 * 再下一次被丢掉。照搬 bilibili-tizen 的 tools/update-e2e.mjs，加了这里自己的那一条：
 *
 *   **页面带着 config.xml 里那条 CSP 跑**（作为响应头）。电视上的 widget 有 allow-navigation，是「CSP 模式」，
 *   更新包的脚本和样式走 blob: 地址，CSP 不放 blob: 就被静默拦掉。对照组用不带 blob: 的旧策略再起一次，
 *   必须起不来、下一次退回安装包、并说出是 CSP 拦的 —— 证明这个测试分得开两种情况。
 *
 *   node tools/update-e2e.mjs
 *
 * 不在 deploy.sh / release.sh 的门禁里：要 Chromium（spike/desktop-harness 的 Playwright）和两个本地端口。
 * 不碰抖音：localhost 以外的请求一律拦掉（签名桥起不来，应用照常走「连不上抖音」那条路）。签名用一把临时钥匙，
 * 测试浏览器拿到的 boot.js 是换了公钥的（路由改写），真钥匙不给任何只为测试存在的东西签名。 */
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { ROOT, buildBundle, sign } from "./update-lib.mjs";

const require = createRequire(path.join(ROOT, "spike/desktop-harness/package.json"));
const { chromium } = require("playwright-core");
const CHROME = os.homedir() + "/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const APP_PORT = 8133, HOST_PORT = 8134;
const APP = `http://localhost:${APP_PORT}/`;
const HOST = `http://localhost:${HOST_PORT}/`;
let failed = 0;
const ok = (cond, what) => { if (cond) { console.log("  ✓ " + what); } else { failed++; console.log("  ✗ " + what); } };
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const CSP = (/<tizen:content-security-policy>([^<]*)</.exec(read("app/config.xml")) || [])[1];
if (!CSP) { console.error("✗ config.xml 里没有 tizen:content-security-policy"); process.exit(1); }
const CSP_NO_BLOB = CSP.replace(/(script-src|style-src)([^;]*)/g, (m, d, v) => d + v.replace(/\s*blob:/g, ""));
let csp = CSP;

/* ---- app/，照电视的样子带着 CSP ---- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".png": "image/png" };
const appServer = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(ROOT, "app", p === "/" ? "index.html" : p);
  if (!file.startsWith(path.join(ROOT, "app")) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const h = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" };
  if (/\.html$/.test(file)) { h["Content-Security-Policy"] = csp; }
  res.writeHead(200, h).end(fs.readFileSync(file));
}).listen(APP_PORT);

/* ---- 更新源：这一步发布了什么就给什么；也收应用的日志 ---- */
const published = {};
const reports = [];
const hostServer = http.createServer((req, res) => {
  if (req.method === "POST") {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      try { reports.push(JSON.parse(b).detail.msg); } catch (e) { /* 不是日志 */ }
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("ok");
    });
    return;
  }
  const name = req.url.split("?")[0].slice(1);
  if (!published[name]) { res.writeHead(404, { "Access-Control-Allow-Origin": "*" }).end("nope"); return; }
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }).end(published[name]);
}).listen(HOST_PORT);

/* ---- 临时钥匙签名 ---- */
const key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubB64 = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const bootSrc = read("app/js/boot.js");
const testBoot = bootSrc.replace(/var PUBKEY = "[^"]*";/, `var PUBKEY = "${pubB64}";`);

function publish(version, tweak, { corrupt } = {}) {
  const b = buildBundle({ version, indexHtml: read("app/index.html"), bootSrc, readFile: read });
  if (tweak) { tweak(b); }
  const name = `bundle-${version}.json`;
  const bytes = Buffer.from(JSON.stringify(b), "utf8");
  const manifest = JSON.stringify({ version, shell: b.shell, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length, date: new Date().toISOString(), urls: [HOST + name] });
  if (corrupt) { bytes[300] = bytes[300] === 0x61 ? 0x62 : 0x61; }
  published[name] = bytes;
  published["manifest.json"] = JSON.stringify({ manifest, sig: sign(key.privateKey, manifest) });
}
/* 记号：一行脚本、一个 DOM 节点、一条样式，三样都得从更新包里来。 */
const marker = (v) => (b) => {
  b.files["js/app.js"] += `\nwindow.__bundleMarker = "${v}";` +
    `\nwindow.addEventListener("load", function () { window.__loadAfterBundle = "${v}"; });`;
  b.files.body = '<div id="__bundle_dom"></div>' + b.files.body;
  b.files["css/app.css"] += "\n#__bundle_dom { width: 37px; }";
};

/* ---- 浏览器 ---- */
const browser = await chromium.launch({ executablePath: CHROME, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
/* 每条出现过的提示：桌面上签名桥起不来，「连不上抖音」会立刻盖掉前一条。 */
await page.addInitScript(() => {
  window.__toasts = [];
  new MutationObserver(() => {
    const t = document.getElementById("toast");
    if (t && t.textContent && window.__toasts[window.__toasts.length - 1] !== t.textContent) { window.__toasts.push(t.textContent); }
  }).observe(document, { subtree: true, childList: true, characterData: true });
});
await page.route("**/*", (r) => {
  const u = r.request().url();
  if (!u.startsWith(APP) && !u.startsWith(HOST) && !u.startsWith("blob:") && !u.startsWith("data:")) { return r.abort(); }
  if (u === APP + "js/boot.js") { return r.fulfill({ contentType: "application/javascript", body: testBoot }); }
  if (u === APP + "js/config.js") {
    return r.fulfill({ contentType: "application/javascript", body: read("app/js/config.js")
      .replace(/var REPORT_TO = "[^"]*";/, `var REPORT_TO = "${HOST.replace(/\/$/, "")}";`)
      .replace(/var SELFTEST = [^;]+;/, "var SELFTEST = false;")
      .replace(/var UPDATE_MANIFEST = "[^"]*";/, `var UPDATE_MANIFEST = "${HOST}manifest.json";`) });
  }
  return r.continue();
});

const state = () => page.evaluate(() => ({
  info: Boot.info(), marker: window.__bundleMarker || "", loadAfter: window.__loadAfterBundle || "",
  dom: !!document.getElementById("__bundle_dom"),
  css: document.getElementById("__bundle_dom") ? getComputedStyle(document.getElementById("__bundle_dom")).width : "",
  booting: localStorage.getItem("dy.update.booting"),
  booted: !!(window.__app && typeof window.__app.tab === "function" && document.getElementById("tabs").innerHTML),
  toasts: window.__toasts || [],
  status: typeof Update !== "undefined" ? Update.status() : null,
}));
const check = () => page.evaluate(() => new Promise((res) => Update.check(res)));
/* 2.5 秒：app.js 在 onload 之后两秒调 Boot.ok()。 */
const load = async () => { await page.reload({ waitUntil: "load" }); await sleep(2500); };

await page.goto(APP, { waitUntil: "load" });
await page.evaluate(() => localStorage.clear());
await load();

console.log("安装包（带着 config.xml 的 CSP：" + CSP + "）");
let s = await state();
ok(s.info.running === s.info.packaged && !s.marker, `跑的是安装包 ${s.info.packaged}`);
ok(s.booted, "app.js 的 window.onload 跑了（标签栏画出来了）");
ok(reports.some((x) => /^update: 这次跑的是安装包/.test(x)), "报了 update: 这次跑的是安装包…");

console.log("发布 9.0.0 → 检查 → 下载 → 下次打开生效");
publish("9.0.0", marker("9.0.0"));
let r = await check();
ok(/^已下载 9\.0\.0，下次打开生效/.test(r), "检查：" + r);
await load();
s = await state();
ok(s.info.running === "9.0.0" && s.marker === "9.0.0", "重新打开跑的是 9.0.0（更新包里加的那一行脚本生效了 —— blob: 脚本过了 CSP）");
ok(s.loadAfter === "9.0.0", "更新包的脚本在 load 之前跑完（document.write 的时机对）");
ok(s.booted, "app.js 照样从 window.onload 启动");
ok(s.dom, "body 换成了更新包里的 DOM");
ok(s.css === "37px", "样式换成了更新包里的（blob: 的 <link> 过了 CSP，计算出的宽 " + s.css + "）");
ok(s.toasts.includes("已更新到 9.0.0"), "屏幕上提示过「已更新到 9.0.0」（这次的提示：" + s.toasts.join(" / ") + "）");
ok(s.booting === null, "启动两秒没出错，Boot.ok() 清掉了 booting");
ok(!reports.some((x) => /^csp: /.test(x)), "没有 CSP 拦截" + (reports.filter((x) => /^csp: /.test(x)).length ? "：" + reports.filter((x) => /^csp: /.test(x))[0] : ""));
await load();
s = await state();
ok(s.info.running === "9.0.0" && !s.toasts.includes("已更新到 9.0.0"), "再打开还是 9.0.0，不再提示");
r = await check();
ok(/版本不更高/.test(r), "再查一次（还是 9.0.0）：" + r);

console.log("对照：同一个 9.1.0，CSP 去掉 blob:（等于 config.xml 没改）");
publish("9.1.0", marker("9.1.0"));
r = await check();
ok(/^已下载 9\.1\.0/.test(r), "检查：" + r);
csp = CSP_NO_BLOB;
await load();
s = await page.evaluate(() => ({ marker: window.__bundleMarker || "", booting: localStorage.getItem("dy.update.booting"),
  csp: localStorage.getItem("dy.update.csp"), booted: !!window.__app }));
ok(!s.marker && !s.booted && s.booting === "9.1.0", "起不来：更新包的脚本一个都没跑（booting=9.1.0 挂着）");
ok(/blob/.test(s.csp || ""), "boot.js 记下了是 CSP 拦的：" + s.csp);
csp = CSP;
await load();
s = await state();
ok(s.info.running === s.info.packaged && s.booted, "下一次打开退回安装包 " + s.info.packaged + "，应用正常");
ok(/CSP 拦了/.test(s.info.note), "原因：" + s.info.note);

console.log("发布一个启动就抛错的 9.2.0");
publish("9.2.0", (b) => { b.files["js/app.js"] = 'throw new Error("e2e: broken build");\n' + b.files["js/app.js"]; });
r = await check();
ok(/^已下载 9\.2\.0/.test(r), "检查：" + r);
await load();
s = await state();
ok(s.info.running === "9.2.0" && !s.booted && s.booting === "9.2.0", "9.2.0 起来了但应用没启动（没人调 Boot.ok）");
await load();
s = await state();
ok(s.info.running === s.info.packaged && s.booted, "再打开一次：退回安装包，应用正常");
ok(/没走到首页/.test(s.info.note), "原因：" + s.info.note);
r = await check();
ok(/启动失败过/.test(r), "线上还是 9.2.0 时：" + r);

console.log("篡改和旧版本");
publish("9.3.0", null, { corrupt: true });
r = await check();
ok(/sha256 不对/.test(r), "bundle 被改过一个字节：" + r);
published["manifest.json"] = JSON.stringify({ ...JSON.parse(published["manifest.json"]), manifest: JSON.parse(published["manifest.json"]).manifest.replace("9.3.0", "9.4.0") });
r = await check();
ok(/签名不对/.test(r), "签名之后改了 manifest：" + r);
publish("1.0.9", null);
r = await check();
ok(/版本不更高/.test(r), "线上版本比安装包还旧：" + r);

const other = errors.filter((e) => !/e2e: broken build/.test(e));
ok(other.length === 0, "页面上没有别的 JS 错误" + (other.length ? "（" + other.join(" | ").slice(0, 300) + "）" : ""));
console.log("  上报的 update 行：\n    " + reports.filter((x) => /^update: /.test(x)).join("\n    "));

await browser.close();
appServer.close();
hostServer.close();
console.log(failed ? `✗ ${failed} 处不对` : "✓ 端到端全部通过");
process.exit(failed ? 1 : 0);
