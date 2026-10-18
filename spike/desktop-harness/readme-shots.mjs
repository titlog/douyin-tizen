// README 的截图（2026-10-18）：在桌面上没登录把整个 app/ 跑起来，按遥控器的键、截图。
// 「我」那一页没登录看不到内容，也**绝不拿真账号截**（观看历史、昵称都是隐私）：换掉 Account 的登录态和资料、Bridge 的观看历史 /
// 喜欢 / 收藏三个接口，名字是编的，列表拿截图里那位作者的作品和那个合集填 —— 不用随机的推荐：会混进擦边的封面，标题里看不出来
// （第一版两次都混进来了），放在「观看历史」里像是谁真看过。
//   node spike/desktop-harness/readme-shots.mjs   → docs/screenshots/*.jpg（1600×900，macOS 的 sips 转）
// app/ 直接从磁盘给（不用起服务器）。桌面 UA：用电视的 UA 在桌面上跑，推荐流直接 blocked（见 CLAUDE.md）。
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../../', import.meta.url).pathname;
const APP = ROOT + 'app/';
const OUT = ROOT + 'docs/screenshots/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const exe = os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml'};

const browser = await chromium.launch({executablePath: exe, headless: !process.env.HEADFUL, args: ['--disable-web-security', '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process,BlockThirdPartyCookies', '--autoplay-policy=no-user-gesture-required']});
const ctx = await browser.newContext({viewport: {width: 1920, height: 1080}, userAgent: UA});
const page = await ctx.newPage();
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);
page.on('pageerror', e => log('PAGEERROR', e.message));
page.on('console', m => { const t = m.text(); if (/^(页面|评论|网格|我|onerror): /.test(t)) log(t.slice(0, 160)); });

await page.route(/^http:\/\/localhost:8766\//, async r => {
  const p = decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\//, '') || 'index.html';
  const file = path.join(APP, p);
  if (!file.startsWith(APP) || !fs.existsSync(file)) return r.fulfill({status: 404, body: ''});
  let body = fs.readFileSync(file);
  // widget 的请求不带 Referer，桌面页面会带 http://localhost… —— CDN 见了就 403（见 app-emu.mjs）
  if (p === 'index.html') body = body.toString().replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="referrer" content="no-referrer">');
  r.fulfill({status: 200, contentType: TYPES[path.extname(p)] || 'application/octet-stream', body});
});
// 作者作品列表要 UIFID_TEMP；桌面上框里的请求算跨站、Chrome 不存，照电视的样子补进 jar（见 app-emu.mjs）
page.on('response', async r => {
  const sc = (await r.allHeaders().catch(() => ({})))['set-cookie'] || '';
  const m = /UIFID_TEMP=([^;]+)/.exec(sc);
  if (m) await ctx.addCookies([{name: 'UIFID_TEMP', value: m[1], domain: 'www.douyin.com', path: '/', secure: true, sameSite: 'None'}]);
});
// 作者作品、合集回来的原始条目记下来，给「我」当假数据；window.__fake 里有的路径直接回假的。要在 app.js 的 window.onload 之前包上 ——
// init script 里注册的 load 监听排在 app.js 赋值的 onload 前面。
await ctx.addInitScript(() => {
  if (window.top !== window) return;          // 签名桥、登录页的框里也会跑一遍
  window.addEventListener('load', () => {
    window.__raw = {post: [], mix: []};
    window.__fake = {};
    const keep = (p, k) => p.then(j => {
      (j && j.aweme_list || []).forEach(a => { if (a && a.video && !(a.images && a.images.length) && !a.is_ads) window.__raw[k].push(a); });
      return j;
    });
    const get = Bridge.get, post = Bridge.post;
    Bridge.get = function (p) {
      if (window.__fake[p]) return Promise.resolve(window.__fake[p]());
      const r = get.apply(this, arguments);
      return /aweme\/post/.test(p) ? keep(r, 'post') : /mix\/aweme/.test(p) ? keep(r, 'mix') : r;
    };
    Bridge.post = function (p) { if (window.__fake[p]) return Promise.resolve(window.__fake[p]()); return post.apply(this, arguments); };
  });
});

const sleep = t => new Promise(r => setTimeout(r, t));
const ev = (fn, arg) => page.evaluate(fn, arg);
const key = async k => { await ev(c => { const e = document.createEvent('Event'); e.initEvent('keydown', true, true); e.keyCode = c; document.dispatchEvent(e); }, k); await sleep(250); };
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev(fn).catch(() => false)) return true; await sleep(300); }
  throw new Error('等不到：' + what + ' | 视图=' + await ev(() => window.__app.view() + ' 页=' + window.__app.page() + ' 播放器=' + JSON.stringify(Player.state())));
}
/* 出画面：封面撤了、转圈没了、播放头走起来了。 */
const shown = () => waitFor(() => window.__app.view() === 'feed' && Player.state().shown && Player.state().t > 0.5 &&
                                  !document.getElementById('cover').className && !document.getElementById('loading').className, 20000, '出画面');
async function shot(name) {
  const png = os.tmpdir() + '/dy-shot-' + name + '.png';
  await page.screenshot({path: png});
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', '1600', png, '--out', OUT + name + '.jpg'], {stdio: 'ignore'});
  log('截图 ' + name);
}
/* 暂停、下键选中那一排、右键挪到 name。 */
async function chip(name) {
  await key(13); await sleep(600); await key(40); await sleep(300);
  for (let i = 0; i < 6 && await ev(() => window.__app.chip()) !== name; i++) await key(39);
  if (await ev(() => window.__app.chip()) !== name) throw new Error('选不中「' + name + '」');
}

await page.goto('http://localhost:8766/index.html');
await shown();

/* 头图用开机第一条（全新浏览器、没登录时推荐流给的第一条，画面干净），一出画面就截：作者、标题、数字那一排 5 秒后淡出。 */
await sleep(300);
await shot('01-feed');
await sleep(8000);                           // 片头那几秒是一片白光，放一会儿再暂停

await chip('comment');
await sleep(500);
await shot('02-actions');

await key(13);                               // 评论侧栏，展开一条的回复
await waitFor(() => { const c = Comments.state(); return c && !c.loading && c.comments > 0; }, 20000, '评论');
const wr = await ev(() => Comments.state().withReplies);
if (wr >= 0) {
  await ev(i => Comments.select(i), wr);
  await key(13);
  await waitFor(() => Comments.state().replies > 0, 20000, '回复');
}
await sleep(2000);
await shot('05-comments');
await key(10009); await key(10009); await key(13); await sleep(1500);

await chip('author');
await key(13);
await waitFor(() => { const g = Grid.state(); return g && g.kind === 'author' && g.stats && g.cards > 0 && g.imgs >= Math.min(g.cards, 12); }, 30000, '作者主页');
await sleep(1500);
await shot('03-author');
await key(10009); await shown(); await sleep(1000);

/* 往下刷，找一条带合集的（超过 48 集最好：选集上有分组）。 */
let found = null;
for (let i = 0; i < 40 && !found; i++) {
  await key(40); await shown(); await sleep(2000);
  const it = await ev(() => { const x = window.__app.current(); return x && x.mix ? {total: x.mix.total, name: x.mix.name} : null; });
  if (it && (it.total > 48 || i >= 25)) { found = it; }
}
if (!found) throw new Error('刷了 40 条没有合集');
log('合集《' + found.name + '》共 ' + found.total + ' 集');
await chip('mix');
await key(13);
await waitFor(() => { const g = Grid.state(); return g && g.kind === 'mix' && g.zone === 'grid' && g.cards > 0 && g.imgs >= g.cards; }, 30000, '选集');
await sleep(1500);
await shot('04-mix');
await key(10009); await shown(); await sleep(1000);

/* 「我」：假的。登录态、资料是编的，观看历史 / 喜欢是推荐里取到的公开视频。 */
const n = await ev(() => {
  /* 作者作品和合集交错着放，像一份真的观看历史。 */
  const post = window.__raw.post, mix = window.__raw.mix, raw = [];
  for (let k = 0; raw.length < 12 && (k < post.length || k < mix.length); k++) {
    if (post[k]) raw.push(post[k]);
    if (k % 2 === 0 && mix[k / 2]) raw.push(mix[k / 2]);
  }
  const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#25f4ee"/><stop offset="1" stop-color="#fe2c55"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/></svg>');
  Account.loggedIn = () => true;
  Account.known = () => true;
  Account.profile = () => Promise.resolve({sec_uid: 'readme', nickname: '客厅的电视', total_favorited: 0, following_count: 36, follower_count: 2,
                                           favoriting_count: 214, avatar_thumb: {url_list: [avatar]}});
  window.__fake['/aweme/v1/web/history/read/'] = () => ({status_code: 0, aweme_list: raw.slice(0, 16), has_more: 0, max_cursor: 0});
  window.__fake['/aweme/v1/web/aweme/favorite/'] = () => ({status_code: 0, aweme_list: raw.slice(16, 32), has_more: 0, max_cursor: 0});
  window.__fake['/aweme/v1/web/aweme/listcollection/'] = () => ({status_code: 0, aweme_list: [], has_more: 0, cursor: 0});
  return raw.length;
});
log('「我」拿作者作品和合集里的 ' + n + ' 条公开视频填');
await key(39);                               // 推荐 → 我
await waitFor(() => { const g = Grid.state(); return g && g.kind === 'me' && g.cards >= 4 && g.imgs >= Math.min(g.cards, 8); }, 20000, '「我」');
await sleep(1500);
await shot('06-me');
await browser.close();
