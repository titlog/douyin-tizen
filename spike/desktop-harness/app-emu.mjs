// 在桌面上把 app/ 整个跑起来（先 python3 -m http.server 8766 -d app/；file:// 页面在桌面 Chrome 里访问不了跨域框，关掉跨域检查 —— 和 widget 能对 douyin.com 的框执行脚本是同一个条件），
// 按 STEPS 派发遥控器按键、每步截图。看界面用，不替代设备自测：视频走的是桌面 Chrome 的解码器，不是电视的。
//   STEPS='wait:9000 key:13 wait:800 shot:paused key:40 shot:focus' OUT=dir node app-emu.mjs
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const exe = os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({executablePath: exe, headless: !process.env.HEADFUL, args: ['--disable-web-security', '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process,BlockThirdPartyCookies', '--autoplay-policy=no-user-gesture-required']});
const ctx = await browser.newContext({viewport: {width: 1920, height: 1080}, userAgent: process.env.UA || 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36'});
const page = await ctx.newPage();
const t0 = Date.now();
page.on('console', m => { const t = m.text(); if (!/^(预热|mse|封面): /.test(t) || process.env.VERBOSE) console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', t.slice(0, 300)); });
if (process.env.PARAMS) page.on('request', q => { const u = new URL(q.url()); if (!u.pathname.startsWith('/aweme/v1/web/') && !u.pathname.startsWith('/aweme/v2/web/')) return; const p = u.searchParams; console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', 'REQ', u.pathname, ['a_bogus', 'webid', 'uifid', 'verifyFp', 'fp', 'msToken'].map(k => k + (p.has(k) ? '=' + (p.get(k) || '(空)').slice(0, 12) : '✗')).join(' ')); });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
const OUT = process.env.OUT || '.';
// widget 的请求不带 Referer（设备实测），桌面页面会带 http://localhost… —— CDN 见了就 403。302 之后那一跳不经过
// page.route，所以在页面上加 no-referrer，不在网络层改头。
await page.route(/localhost:8766\/index\.html/, async r => {
  const res = await r.fetch();
  r.fulfill({response: res, body: (await res.text()).replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="referrer" content="no-referrer">')});
});
// 作品列表（aweme/post）要 uifid，SDK 从 UIFID_TEMP 这个 cookie 取；它是推荐流应答里服务器种的（Set-Cookie 没写 SameSite，
// 按 Lax 算）。桌面上顶层页面是 localhost，框里的请求算跨站，Chrome 不存 —— 作品列表回 403「Uifid Not Found」。
// 电视上存得下（2026-09-29 设备探测：第 2 个请求起 SDK 就加了 uifid）。这里照电视的样子补进 jar。
page.on('response', async r => {
  const sc = (await r.allHeaders().catch(() => ({})))['set-cookie'] || '';
  const m = /UIFID_TEMP=([^;]+)/.exec(sc);
  if (m) await ctx.addCookies([{name: 'UIFID_TEMP', value: m[1], domain: 'www.douyin.com', path: '/', secure: true, sameSite: 'None'}]);
});
// HANG=<正则>：匹配的请求永远不回（模拟 CDN 连接吊住，看看门狗报不报；2026-10-22 直播 FLV 用过）。
if (process.env.HANG) await page.route(new RegExp(process.env.HANG), () => {});
// SELFTEST=author 之类：改写 config.js，桌面上先把自测本身走一遍（判据写错了在这里就能看出来）。
if (process.env.SELFTEST) await page.route(/localhost:8766\/js\/config\.js/, async r => { const res = await r.fetch(); r.fulfill({response: res, body: (await res.text()).replace(/var SELFTEST = [^;]+;/, 'var SELFTEST = ' + process.env.SELFTEST + ';')}); });
await page.goto(process.env.APP_URL || 'http://localhost:8766/index.html');
for (const step of (process.env.STEPS || '').split(/\s+/).filter(Boolean)) {
  const [op, arg] = step.split(':');
  if (op === 'wait') await page.waitForTimeout(+arg);
  else if (op === 'key') { await page.evaluate(k => { const e = document.createEvent('Event'); e.initEvent('keydown', true, true); e.keyCode = k; document.dispatchEvent(e); }, +arg); console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', 'KEY', arg); }
  else if (op === 'shot') { await page.screenshot({path: path.join(OUT, arg + '.png')}); console.log('SHOT', arg); }
  else if (op === 'eval') console.log('EVAL', JSON.stringify(await page.evaluate(arg)));
}
await browser.close();
