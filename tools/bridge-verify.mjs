/* 签名桥（app/js/bridge.js）的离线验证。deploy.sh、release.sh 卡着它。
 *
 * 假的框和假的 XHR，测两件只在出事时才走到、在电视上造不出来的事：
 *   - 重建签名桥时还没回来的请求：当场拒掉，GET 在新框上再发一次、由新框答（以前等满外面那 15 秒报「超时」——
 *     2026-10-28 一台电视作者资料 11 次里 8 次这样），写请求不重发；
 *   - Argus 的 403 不计入「连续 3 次失败就重建」，并且那一行说清签名 SDK 加了哪些参数、UIFID_TEMP 在不在（不报值）。
 *
 *   node tools/bridge-verify.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../app/js/bridge.js", import.meta.url), "utf8");
const logs = [];
const pending = [];          // XHRs that have not answered, per frame
let mode = "hang", frameNo = 0, argusBody = "";
function makeWin(n) {
  const win = { n, bdms: undefined, _SdkGlueInit() { win.bdms = { init() {} }; } };
  class XHR {
    open(m, url) { this.m = m; this.url = url; this.responseURL = "https://www.douyin.com" + url + (mode === "argus" ? "&a_bogus=x&msToken=y" : ""); }
    setRequestHeader() {}
    send() {
      if (mode === "hang") { pending.push(this); return; }
      setTimeout(() => {
        if (mode === "argus") { this.status = 403; this.responseText = argusBody; }
        else { this.status = 200; this.responseText = JSON.stringify({ frame: n }); }
        this.onload();
      }, 5);
    }
  }
  win.XMLHttpRequest = XHR;
  win.document = { head: { appendChild(s) { setTimeout(() => s.onload(), 1); } }, createElement() { return {}; }, cookie: "ttwid=1; UIFID_TEMP=abc" };
  win.location = { href: "https://www.douyin.com/robots.txt", host: "www.douyin.com" };
  win.performance = { getEntriesByType() { return []; } };
  return win;
}
const document = {
  body: { appendChild(f) { f.parentNode = document.body; f.contentWindow = makeWin(++frameNo); f.contentDocument = f.contentWindow.document; setTimeout(() => f.onload(), 1); },
          removeChild(f) { f.parentNode = null; } },
  createElement() { return {}; },
};
class MainXHR { open() {} setRequestHeader() {} send() { setTimeout(() => { this.responseText = "{}"; this.status = 200; this.onload(); }, 1); } }
/* 请求外面那层 15 秒的计时器在测完之后还挂着：不让它们拖住进程 */
const later = (f, ms) => { const t = setTimeout(f, ms); if (ms >= 1000) { t.unref(); } return t; };
const sandbox = { document, XMLHttpRequest: MainXHR, setTimeout: later, clearTimeout, Promise, Date, JSON, Error, String, Math, encodeURIComponent, decodeURIComponent,
  Log: { report: (k, l) => logs.push(k + ": " + l) } };
vm.createContext(sandbox);
vm.runInContext(src + "\nthis.Bridge = Bridge;", sandbox);
const B = sandbox.Bridge;
await B.ready();
assert.equal(frameNo, 1);

// 1. A GET in flight when the bridge is rebuilt: rejected at once, re-sent on the new frame, answered by it.
mode = "hang";
const t0 = Date.now();
const p = B.get("/aweme/v1/web/user/profile/other/", { sec_user_id: "x" });
await new Promise((r) => setTimeout(r, 20));
assert.equal(pending.length, 1, "the GET is out on frame 1");
mode = "ok";
B.reset();
const got = await p;
assert.equal(got.frame, 2, "answered by the rebuilt frame");
assert.ok(Date.now() - t0 < 2000, "not the 15 s timeout: " + (Date.now() - t0) + "ms");
assert.ok(logs.some((l) => /重建时还有 1 个请求在途/.test(l)), logs.join("\n"));

// 2. A POST in flight is rejected, not re-sent.
mode = "hang";
const q = B.post("/aweme/v1/web/commit/item/digg/", {}, "a=1").then(() => "ok", (e) => e.message);
await new Promise((r) => setTimeout(r, 20));
mode = "ok";
B.reset();
assert.equal(await q, "签名桥重建了");

// 3. Argus 403s: said with what the SDK added, and three of them do not rebuild the bridge.
await B.ready();
const framesBefore = frameNo;
mode = "argus"; argusBody = "Blocked by ArgusSecurityPlugin Uifid Not Found";
for (let i = 0; i < 4; i++) { await B.get("/aweme/v1/web/aweme/post/", {}).catch(() => {}); }
await new Promise((r) => setTimeout(r, 30));
assert.equal(frameNo, framesBefore, "Argus 403s did not rebuild the bridge");
const line = logs.find((l) => /被 Argus 拦下/.test(l));
assert.ok(line && /加上的参数\[a_bogus,msToken\] UIFID_TEMP 在/.test(line), line);
assert.ok(!/abc/.test(line), "no cookie value in the line");

// 4. Other failures still rebuild after three.
mode = "argus"; argusBody = "something else";
for (let i = 0; i < 3; i++) { await B.get("/aweme/v1/web/aweme/post/", {}).catch(() => {}); }
await new Promise((r) => setTimeout(r, 30));
assert.equal(frameNo, framesBefore + 1, "three ordinary failures rebuild");
console.log("✓ bridge: rebuild rejects in-flight (GET re-sent, POST not), Argus not counted, Argus line names params\n  " + line);
