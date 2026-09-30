// 全新匿名浏览器打开官网推荐页，按下键刷几条：看官网播放时除了拉列表还发了什么（上报观看？推荐流带了哪些参数？）。
//   node site-probe.mjs
import { chromium } from 'playwright-core';
import os from 'node:os';

const exe = os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({executablePath: exe, headless: !process.env.HEADFUL, args: ['--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled']});
const ctx = await browser.newContext({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36', viewport: {width: 1440, height: 900}, locale: 'zh-CN'});
const page = await ctx.newPage();
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const skip = /\.(js|css|png|jpe?g|webp|gif|svg|woff2?|ico|mp4|m4s)(\?|$)|douyinvod|zjcdn|byteimg|bytetos|yhgfb|douyinpic|douyinstatic|\/aweme\/v1\/play\//;
page.on('request', q => {
  const u = new URL(q.url());
  if (skip.test(q.url())) return;
  if (!/douyin\.com|snssdk|bytedance|zijieapi|amemv/.test(u.host)) return;
  const keep = ['aweme_id', 'item_id', 'group_id', 'refresh_index', 'pull_type', 'filterGids', 'awemePcRecRawData', 'pre_log_id', 'pre_item_id', 'pre_item_playtime', 'pre_item_from', 'pre_room_id', 'module_id', 'count', 'tag_id'];
  const ps = keep.filter(k => u.searchParams.has(k)).map(k => k + '=' + u.searchParams.get(k).slice(0, 80));
  const body = q.postData() ? ' BODY=' + q.postData().slice(0, 200) : '';
  console.log(T(), q.method(), u.host + u.pathname, ps.join(' '), body, process.env.ALLKEYS && u.pathname.includes('/tab/feed/') ? '\n   KEYS=' + [...u.searchParams.keys()].join(',') : '');
});
page.on('response', async r => {
  const u = new URL(r.url());
  if (!u.pathname.includes('/tab/feed/') && !u.pathname.includes('/module/feed/')) return;
  let b = ''; try { b = await r.text(); } catch (e) {}
  let ids = ''; try { ids = (JSON.parse(b).aweme_list || []).map(a => a.aweme_id + ':' + (a.desc || '').slice(0, 10)).join(' | '); } catch (e) { ids = 'head=' + b.slice(0, 40); }
  console.log(T(), '  ←', r.status(), u.pathname, ids);
});
await page.goto(process.env.URL || 'https://www.douyin.com/?recommend=1', {waitUntil: 'domcontentloaded'}).catch(e => console.log('goto', e.message));
await page.waitForTimeout(12000);
for (let i = 0; i < +(process.env.N || 5); i++) { await page.keyboard.press('ArrowDown'); console.log(T(), '== 下键'); await page.waitForTimeout(6000); }
await page.screenshot({path: process.env.SHOT || 'site-probe.png'});
await browser.close();
