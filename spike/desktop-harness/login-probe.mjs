// 全新 profile 打开官网、点「登录」，记录扫码登录用到的 sso/passport 请求（路径、参数名、响应结构）。
// 不扫码；只看出码和轮询长什么样。  node login-probe.mjs
import { chromium } from 'playwright-core';
import os from 'node:os';

const exe = os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const browser = await chromium.launch({executablePath: exe, headless: false});
const ctx = await browser.newContext({userAgent: UA, viewport: {width: 1400, height: 900}});
const page = await ctx.newPage();

function shape(v, depth = 0) {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? `str(${v.length})` : typeof v;
  if (Array.isArray(v)) return `[${v.length ? shape(v[0], depth + 1) : ''}]`;
  if (depth > 2) return '{…}';
  return '{' + Object.keys(v).map(k => k + ':' + shape(v[k], depth + 1)).join(', ') + '}';
}

page.on('request', q => { if (q.resourceType() === 'script') { const u = new URL(q.url()); if (/passport|account|login|sso|ucenter|uc-/i.test(u.host + u.pathname)) console.log('SCRIPT', u.host + u.pathname); } });
page.on('response', async r => {
  const u = new URL(r.url());
  if (!/sso\.douyin\.com|passport|login/.test(u.host + u.pathname)) return;
  if (/\.(js|css|png|svg|woff2?)$/.test(u.pathname)) return;
  let body = '';
  try { body = await r.text(); } catch {}
  let s = '';
  try { const j = JSON.parse(body); s = shape(j); if (j.data && typeof j.data.status !== 'undefined') s += ` status=${j.data.status}`; if (j.error_code !== undefined) s += ` error_code=${j.error_code}`; if (j.description) s += ` desc=${j.description}`; } catch { s = `非 JSON ${body.length}B`; }
  console.log(`${r.request().method()} ${r.status()} ${u.host}${u.pathname}\n   参数: ${[...u.searchParams.keys()].join(',')}\n   请求头: referer=${r.request().headers().referer || '-'} origin=${r.request().headers().origin || '-'}\n   响应: ${s.slice(0, 700)}`);
});

await page.goto('https://www.douyin.com/?recommend=1', {waitUntil: 'domcontentloaded'});
await page.waitForTimeout(6000);
const btn = page.getByText('登录', {exact: true}).first();
if (await btn.count()) { await btn.click().catch(e => console.log('click failed', e.message)); console.log('== 点了登录'); }
else console.log('== 找不到「登录」按钮');
await page.waitForTimeout(12000);
await page.screenshot({path: new URL('./login-probe.png', import.meta.url).pathname});
await browser.close();
