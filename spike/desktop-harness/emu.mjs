// 用关掉跨域检查、全新 profile 的 Chromium 跑 tv.html —— 最接近「刚装好 App 的电视」的环境。
import { chromium } from 'playwright-core';
import os from 'node:os';

const UA = process.env.UA || '';
const exe = os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({executablePath: exe, headless: !process.env.HEADFUL, args: ['--disable-web-security', '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process,BlockThirdPartyCookies']});
const ctx = await browser.newContext(UA ? {userAgent: UA} : {});
const page = await ctx.newPage();
page.on('console', m => { if (m.text().startsWith('PAGE')) console.log(m.text()); });
page.on('request', q => { if (q.url().includes('/tab/feed/')) console.log('REFERER', q.headers()['referer'] || '(无)'); if (process.env.PARAMS && /\/aweme\/v[12]\/web\//.test(q.url())) { const u = new URL(q.url()), p = u.searchParams; console.log('REQ', u.pathname, ['a_bogus', 'webid', 'uifid', 'verifyFp', 'msToken'].map(k => k + (p.has(k) ? '=' + (p.get(k) || '(空)').slice(0, 12) : '✗')).join(' ')); } });
page.on('response', async r => { if (process.env.PARAMS) { const sc = (await r.allHeaders().catch(() => ({})))['set-cookie'] || ''; if (/uifid/i.test(sc)) console.log('SETCOOKIE', new URL(r.url()).host + new URL(r.url()).pathname, sc.replace(/=[0-9a-f]{40,}/g, '=<hex>')); } });
page.on('response', r => { const u = new URL(r.url()); if (/douyin\.com|bytedance|zijieapi|mssdk|byteimg|bytetos|yhgfb/.test(u.host) && true) console.log('NET', r.status(), u.host + u.pathname); });
console.log('UA', await page.evaluate(() => navigator.userAgent).catch(() => '?'));
import fs from 'node:fs';
const HOSTED = process.env.HOSTED === 'douyin' ? 'https://www.douyin.com/__tvemu.html' : (process.env.LOCALPAGE || 'http://localhost:8765/tv.html');
if (process.env.HOSTED === 'douyin') {
  let html = fs.readFileSync(new URL('./tv.html', import.meta.url), 'utf8');
  if (process.env.KEEP_REFERRER) html = html.replace('<meta name="referrer" content="no-referrer">', '');
  await page.route('https://www.douyin.com/__tvemu.html', r => r.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: html}));
}
if (process.env.FORCE_REFERER) await page.route(/www\.douyin\.com\/aweme\//, r => r.continue({headers: Object.assign({}, r.request().headers(), {referer: process.env.FORCE_REFERER})}));
console.log('HOSTED', HOSTED, 'mode', process.env.MODE || 'glue');
await page.goto(HOSTED + (process.env.MODE ? '#' + process.env.MODE : ''), {waitUntil: 'commit'});
if (process.env.MIRROR_COOKIES) {
  // 页面脚本写在 localhost 名下的 cookie，镜像一份到 www.douyin.com 名下，模拟「页面在 douyin.com 上」的 cookie 面
  for (let k = 0; k < 12; k++) {
    await new Promise(r => setTimeout(r, 500));
    const mine = (await ctx.cookies('http://localhost:8765')).filter(c => ['s_v_web_id', 'UIFID_TEMP', 'x-web-secsdk-uid'].includes(c.name));
    if (mine.length) await ctx.addCookies(mine.map(c => ({name: c.name, value: c.value, domain: 'www.douyin.com', path: '/', secure: true, sameSite: 'None'})));
  }
  console.log('MIRRORED');
}
await page.waitForFunction(() => false, null, {timeout: 30000}).catch(() => {});
const cookies = await ctx.cookies();
console.log('JAR', cookies.map(c => c.domain + ':' + c.name).join(' '));
await browser.close();
