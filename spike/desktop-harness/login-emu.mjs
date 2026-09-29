// 模拟电视（关跨域检查、全新 profile）跑 tv-login.html：隐藏框里的官网能不能弹出登录框、
// 我们能不能从框里取到二维码。  node login-emu.mjs   （先 node server.mjs 开 :8765）
import { chromium } from 'playwright-core';
import os from 'node:os';

const exe = os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const UA = process.env.UA || 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36';
const browser = await chromium.launch({executablePath: exe, headless: false, args: ['--disable-web-security', '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process,BlockThirdPartyCookies']});
const ctx = await browser.newContext({userAgent: UA, viewport: {width: 1280, height: 720}});
const page = await ctx.newPage();
page.on('framenavigated', fr => { if (fr !== page.mainFrame()) console.log('NAV', fr.url().split('?')[0]); });
page.on('requestfailed', q => { if (q.resourceType() === 'document') console.log('FAILED doc', q.url().split('?')[0].slice(0, 120), q.failure() && q.failure().errorText); });
page.on('request', q => { if (q.resourceType() === 'document' && q.frame() !== page.mainFrame()) console.log('DOC', q.method(), q.url().split('?')[0].slice(0, 120), q.redirectedFrom() ? '(重定向自 ' + q.redirectedFrom().url().split('?')[0] + ')' : ''); });
page.on('response', r => { if (r.request().resourceType() === 'document' && r.frame() !== page.mainFrame()) { const h = r.headers(); console.log('DOCHDR', r.status(), Object.keys(h).filter(k => /frame|policy|security|cross-origin|content-type/i.test(k)).map(k => k + '=' + h[k].slice(0, 100)).join(' | ')); } });
if (process.env.ALLREQ) page.on('request', q => { if (q.frame() !== page.mainFrame()) { const u = new URL(q.url()); console.log('REQ', q.resourceType(), u.host + u.pathname.slice(0, 90)); } });
page.on('console', m => { if (m.text().startsWith('PAGE')) console.log(m.text()); });
page.on('response', async r => {
  const u = new URL(r.url());
  if (!/get_qrcode|check_qrconnect/.test(u.pathname)) return;
  let st = ''; try { const j = await r.json(); st = (j.data && (j.data.status || '')) + ' err=' + (j.data && j.data.error_code); } catch {}
  console.log('NET', r.status(), u.pathname, st);
});
await page.goto('http://localhost:8765/tv-login.html#' + encodeURIComponent(process.env.SRC || ''), {waitUntil: 'commit'});
await page.waitForTimeout(Number(process.env.WAIT || 25000));
await page.screenshot({path: new URL('./login-emu.png', import.meta.url).pathname});
await browser.close();
