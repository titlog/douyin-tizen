// 直播 tab 的接口（2026-10-22 加直播标签，上下键换直播间）：全新匿名浏览器打开官网直播页，看它问了哪些
// /webcast/ 接口、带什么参数、回来的房间里拉流地址长什么样（FLV / HLS、几档清晰度）。只读，不登录。
//   node live-probe.mjs                     → live.douyin.com 首页
//   URL=https://www.douyin.com/... node live-probe.mjs
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';

const exe = os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({executablePath: exe, headless: !process.env.HEADFUL, args: ['--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled']});
const ctx = await browser.newContext({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36', viewport: {width: 1440, height: 900}, locale: 'zh-CN'});
const page = await ctx.newPage();
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const OUT = process.env.OUT || '/tmp';
let n = 0;
page.on('request', q => {
  const u = new URL(q.url());
  if (/\.(flv|m3u8)(\?|$)/.test(u.pathname)) { console.log(T(), 'STREAM', q.method(), u.host + u.pathname, 'referer=' + (q.headers().referer || '(无)')); return; }
  if (!u.host.endsWith('douyin.com') || !u.pathname.startsWith('/webcast/')) return;
  const ps = [...u.searchParams.keys()].filter(k => !/^(a_bogus|msToken|X-Bogus|_signature)$/.test(k));
  if (process.env.FULL && u.pathname === process.env.FULL) console.log('FULLQ', [...u.searchParams.entries()].filter(([k]) => !/^(a_bogus|msToken)$/.test(k)).map(([k, v]) => k + '=' + v).join('&'));
  console.log(T(), q.method(), u.host + u.pathname, '| 参数 ' + ps.join(','), '| 签名 ' + ['a_bogus', 'X-Bogus', 'msToken', '_signature'].filter(k => u.searchParams.has(k)).join(','));
});
page.on('response', async r => {
  const u = new URL(r.url());
  if (!u.host.endsWith('douyin.com') || !u.pathname.startsWith('/webcast/')) return;
  let b = ''; try { b = await r.text(); } catch (e) { return; }
  if (!b.startsWith('{')) { console.log(T(), '  ←', r.status(), u.pathname, '非 JSON ' + b.length + 'B'); return; }
  const f = OUT + '/live-' + (++n) + '-' + u.pathname.replace(/\W+/g, '_') + '.json';
  fs.writeFileSync(f, b);
  let j = {}; try { j = JSON.parse(b); } catch (e) {}
  const d = j.data;
  const shape = d ? (Array.isArray(d) ? 'data[' + d.length + ']' : 'data{' + Object.keys(d).slice(0, 12).join(',') + '}') : 'keys{' + Object.keys(j).slice(0, 10).join(',') + '}';
  console.log(T(), '  ←', r.status(), u.pathname, 'status_code=' + j.status_code, shape, b.length + 'B →', f);
});
await page.goto(process.env.URL || 'https://live.douyin.com/', {waitUntil: 'domcontentloaded'}).catch(e => console.log('goto', e.message));
await page.waitForTimeout(+process.env.WAIT || 15000);
if (process.env.SHOT) await page.screenshot({path: process.env.SHOT});
await browser.close();
