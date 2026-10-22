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
async function waitFor(fn, ms, what, arg) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev(fn, arg).catch(() => false)) return true; await sleep(300); }
  throw new Error('等不到：' + what + ' | 视图=' + await ev(() => window.__app.view() + ' 页=' + window.__app.page() + ' 播放器=' + JSON.stringify(Player.state())));
}
/* 出画面：封面撤了、转圈没了、播放头走起来了。 */
const shown = () => waitFor(() => window.__app.view() === 'feed' && Player.state().shown && Player.state().t > 0.5 &&
                                  !document.getElementById('cover').className && !document.getElementById('loading').className, 20000, '出画面');
/* 只重截其中几张：ONLY=04-mix,06-me。「我」拿作者作品和合集里的视频填，只换合集时这一轮进的作者要和 03-author 是同一位
 * （看日志「进入 @…」）。
 * 选集那张是一屏封面，好不好看全看刷到的是哪个合集（2026-10-22：歌单拼贴、钓鱼节目的大脸都被嫌丑），按名字挑不准 —— 只要名字带
 * 「动物」「美食」的，刷 80 条一个没撞上，而《花鸟鱼虫》《我的乡村生活》这些名字里看不出来。所以 MIX_PICK=<目录>：往下刷 PICK_SCROLLS 条
 * （默认 60），每碰到一个没见过的合集就截一张选集、一张拿它填的「我」，存成 <目录>/<k>-04-mix.jpg、<k>-06-me.jpg，看过挑一组拷进
 * docs/screenshots/。这个模式不写 04、06。MIX_SKIP=回忆歌单：名字里含这几个字的合集不要（逗号分隔）。 */
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const MIX_SKIP = (process.env.MIX_SKIP || '').split(',').filter(Boolean);
const PICK = process.env.MIX_PICK || '';
async function shot(name, dir) {
  if (!dir && ONLY.length && !ONLY.includes(name)) { log('不写 ' + name + '（ONLY）'); return; }
  const png = os.tmpdir() + '/dy-shot-' + name + '.png';
  await page.screenshot({path: png});
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', '1600', png, '--out', path.join(dir || OUT, name + '.jpg')], {stdio: 'ignore'});
  log('截图 ' + name);
}
/* 切标签：视频页上左右键是快进快退（2026-10-22 起），切标签要先到顶上的标签栏 —— 视频页暂停后上键、网格页一路往上 —— 再左 / 右 n 下，
 * 最后下键回来。 */
async function viaTabs(code, n = 1) {
  if (!(await ev(() => window.__app.tabFocus()))) {
    const v = await ev(() => window.__app.view());
    if (v === 'feed') { if (!(await ev(() => Player.state().paused))) await key(13); await key(38); }
    else if (v === 'grid') { for (let i = 0; i < 10 && !(await ev(() => window.__app.tabFocus())); i++) await key(38); }
    else await key(38);
  }
  for (let i = 0; i < n; i++) await key(code);
  await key(40);
}
/* 暂停、下键选中右边那一列的头像、再下键往下走到 name（合集在最后，左下那一条）。 */
async function chip(name) {
  await key(13); await sleep(600); await key(40); await sleep(300);
  for (let i = 0; i < 6 && await ev(() => window.__app.chip()) !== name; i++) await key(40);
  if (await ev(() => window.__app.chip()) !== name) throw new Error('选不中「' + name + '」');
}

const mixOf = () => ev(() => { const x = window.__app.current(); return x && x.mix ? {total: x.mix.total, name: x.mix.name, id: x.id, ep: x.mix.ep} : null; });
async function openMix() {
  await chip('mix');
  await key(13);
  await waitFor(() => { const g = Grid.state(); return g && g.kind === 'mix' && g.zone === 'grid' && g.cards > 0 && g.imgs >= g.cards; }, 30000, '选集');
  await sleep(1500);
}
const closeMix = async () => { await key(10009); await shown(); await sleep(1000); };

/* 「我」：假的。登录态、资料是编的，观看历史 / 喜欢是推荐里取到的公开视频：作者作品和合集（window.__mixes[k]，没给 k 就是刚开过的那个）。 */
async function shootMe(name, dir, k) {
  const n = await ev(k => {
    /* 作者作品和合集交错着放，像一份真的观看历史。 */
    const post = window.__raw.post, mix = k ? window.__mixes[k] : window.__raw.mix, raw = [];
    for (let i = 0; raw.length < 12 && (i < post.length || i < mix.length); i++) {
      if (post[i]) raw.push(post[i]);
      if (i % 2 === 0 && mix[i / 2]) raw.push(mix[i / 2]);
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
  }, k || 0);
  log('「我」拿作者作品和合集里的 ' + n + ' 条公开视频填');
  await viaTabs(39);                           // 推荐 → 我
  await waitFor(() => { const g = Grid.state(); return g && g.kind === 'me' && g.cards >= 4 && g.imgs >= Math.min(g.cards, 8); }, 20000, '「我」');
  await sleep(1500);
  await shot(name, dir);
}

await page.goto('http://localhost:8766/index.html');
await shown();

/* MIX_FROM=<合集里一条视频的 id>[:<第几集>]、AUTHOR_FROM=<作者的一条视频 id>：不刷推荐碰运气，只截 04、06。用 aweme/detail 查出
 * 合集和作者，把正在放的这一条换成合集的那一集（id、作者、mix），再照常「暂停 → 选中合集 → 确认」进选集；「我」拿这位作者的作品
 * 和这个合集填。id 从日志里抄：「进入 @… 的主页（从推荐 <id>）」「打开合集《…》第 N 集（从推荐 <id>）」。给第 1 集，选集顶上的
 * 合集名和分组那一排都截得进来。 */
const MIX_FROM = process.env.MIX_FROM || '', AUTHOR_FROM = process.env.AUTHOR_FROM || '';
if (MIX_FROM) {
  const [mixAweme, ep] = MIX_FROM.split(':');
  const info = await ev(async ([mixAweme, ep, authorAweme]) => {
    await Bridge.ready();
    const detail = async id => {
      const j = await Bridge.get('/aweme/v1/web/aweme/detail/', {aweme_id: id});
      if (!j || !j.aweme_detail) throw new Error('aweme/detail 没回 ' + id + '：' + JSON.stringify(j).slice(0, 160));
      return j.aweme_detail;
    };
    const out = {};
    if (authorAweme) {
      const a = await detail(authorAweme);
      window.__raw.post = [];
      await Feed.create('author', {secUid: a.author.sec_uid}).next();
      out.author = a.author.nickname; out.posts = window.__raw.post.length;
    }
    const d = await detail(mixAweme), mi = d.mix_info;
    let t = d;
    if (ep) {
      const j = await Bridge.get('/aweme/v1/web/mix/aweme/', {mix_id: mi.mix_id, cursor: String(ep - 1), count: '12'});
      t = j.aweme_list[0];
    }
    const it = window.__app.current();
    it.id = t.aweme_id;
    it.author = t.author.nickname;
    it.mix = {id: mi.mix_id, name: mi.mix_name, ep: (t.mix_info.statis || {}).current_episode || 0, total: (mi.statis || {}).updated_to_episode || 0,
              desc: mi.desc || '', cover: mi.cover_url && mi.cover_url.url_list ? mi.cover_url.url_list[0] : ''};
    window.__raw.mix = [];
    out.mix = mi.mix_name; out.ep = it.mix.ep; out.total = it.mix.total;
    return out;
  }, [mixAweme, +ep || 0, AUTHOR_FROM]);
  log('MIX_FROM ' + JSON.stringify(info));
  await openMix();
  await shot('04-mix');
  await closeMix();
  await shootMe('06-me');
  await browser.close();
  process.exit(0);
}

/* 头图用第二条：后面暂停、评论、作者主页截的都是它，几张图讲的是同一位作者（2026-10-22 那次开机第一条是一位博主的自拍
 * 大特写，后面再没出现，不适合当头图）。一出画面就截：左下的作者、标题和右边那一列 5 秒后淡出。 */
/* 下一条：按下键之后等 id 真的换了再等出画面（按完键的那一刻旧的那条还「出着画面」，shown() 当场就满足）。 */
async function nextOne() {
  const id0 = await ev(() => window.__app.current() && window.__app.current().id);
  await key(40);
  await waitFor(id => window.__app.current() && window.__app.current().id !== id, 20000, '换下一条', id0).catch(() => {});
  await shown();
}
/* HERO_FROM=<视频 id>：头图（以及后面暂停、评论、作者主页）就用这一条 —— 插到推荐的下一条再按下键过去。推荐流每次开新浏览器都不一样，
 * 2026-10-22 一天里头图位置轮到过自拍大特写、海滩比基尼、只有 7–10 秒的（等着暂停时就放完了）；README 那一组用的是 7690892518036098350。 */
if (process.env.HERO_FROM) {
  const ok = await ev(async id => {
    await Bridge.ready();
    const j = await Bridge.get('/aweme/v1/web/aweme/detail/', {aweme_id: id});
    const it = j && j.aweme_detail && Feed.fromAweme(j.aweme_detail);
    if (!it) return 'aweme/detail 没回能放的：' + JSON.stringify(j).slice(0, 120);
    const f = window.__app.feedNow();
    f.all().splice(f.position() + 1, 0, it);
    return 'ok @' + it.author + ' ' + Math.round(it.dur / 1000) + 's';
  }, process.env.HERO_FROM);
  log('HERO_FROM ' + ok);
}
await nextOne();
/* HERO_SKIP=作者名,作者名：头图那条跳过这些作者（2026-10-22：同一位博主的自拍大特写两次排到这个位置）。 */
const HERO_SKIP = (process.env.HERO_SKIP || '').split(',').filter(Boolean);
for (let i = 0; i < 10 && HERO_SKIP.includes(await ev(() => window.__app.current().author)); i++) { log('头图跳过 @' + await ev(() => window.__app.current().author)); await nextOne(); }
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

/* 精选（三列网格）和直播（2026-10-22 加的两个标签）。标签顺序 直播 · 精选 · 关注 · 推荐 · 我：推荐 → 左 关注（没登录是二维码）→ 左 精选
 * → 最左边那一列再左 直播。直播挑横屏的直播间（多是游戏、体育），不拿对着镜头的真人当 README 的图。 */
if (!ONLY.length || ONLY.includes('07-jingxuan') || ONLY.includes('08-live')) {
  await viaTabs(37, 2);                            // 推荐 → 关注 → 精选
  await waitFor(() => { const g = Grid.state(); return g && g.kind === 'jingxuan' && g.cards >= 6 && g.imgs >= 6; }, 30000, '精选');
  /* JX_SEL=n：焦点挪到第 n 张（一行三张：往下 n/3 行、往右 n%3 张）再截（2026-10-22 第一张的封面是全黑的，焦点框里空一块）。
   * 截完原路回到第一行最左边，再左就是直播。 */
  const jxSel = +process.env.JX_SEL || 0, downs = Math.floor(jxSel / 3), rights = jxSel % 3;
  for (let i = 0; i < downs; i++) { await key(40); await sleep(300); }
  for (let i = 0; i < rights; i++) await key(39);
  await sleep(1500);
  await shot('07-jingxuan');
  for (let i = 0; i < downs; i++) { await key(38); await sleep(300); }
  for (let i = 0; i < rights + 1; i++) await key(37);
  await shown();
  /* LIVE_PICK=<目录>：横屏、不是新闻台的直播间挨个截一张候选（live-<k>.jpg，日志里写是谁），看过挑一张拷成 08-live.jpg。截完就退出。 */
  if (process.env.LIVE_PICK) {
    fs.mkdirSync(process.env.LIVE_PICK, {recursive: true});
    const seenRoom = new Set();
    for (let i = 0, k = 0; i < 40 && k < 10; i++) {
      const it = await ev(() => { const x = window.__app.current(); return x ? {room: x.room, author: x.author, desc: x.desc, w: x.w, h: x.h} : null; });
      /* 横屏的直播间太少（2026-10-22：40 个里 1 个），候选里竖屏的也要；LIVE_ANY=1 时不管横竖。 */
      if (it && !seenRoom.has(it.room) && (process.env.LIVE_ANY || it.w > it.h) && !/央视|CCTV|新闻|卫视|人民|新华|政务/.test(it.author + it.desc)) {
        seenRoom.add(it.room);
        await sleep(1500);
        await shot('live-' + (++k), process.env.LIVE_PICK);
        log('候选 live-' + k + '：@' + it.author + ' · ' + it.desc);
      }
      await key(40); await sleep(500); await shown();
    }
    await browser.close(); process.exit(0);
  }
  /* 新闻、官方台的直播（2026-10-22 第一次挑到的是央视转播会议）也跳过。 */
  const okLive = () => ev(() => { const it = window.__app.current(); return !!it && it.live && it.w > it.h && !/央视|CCTV|新闻|卫视|人民|新华|政务/.test(it.author + it.desc); });
  for (let i = 0; i < 25 && !(await okLive()); i++) { await key(40); await sleep(500); await shown(); }
  log('直播间：' + await ev(() => { const it = window.__app.current(); return it.author + ' ' + it.w + 'x' + it.h; }));
  await sleep(1500);
  await shot('08-live');
  await viaTabs(39, 3);                           // 直播 → 精选 → 关注 → 推荐
  await shown(); await sleep(1000);
  if (ONLY.length && !ONLY.includes('04-mix') && !ONLY.includes('06-me')) { await browser.close(); process.exit(0); }
}

if (PICK) {
  fs.mkdirSync(PICK, {recursive: true});
  await ev(() => { window.__mixes = {}; });
  const seen = new Set(), cands = [];
  for (let i = 0; i < (+process.env.PICK_SCROLLS || 60); i++) {
    await key(40); await shown(); await sleep(2000);
    const it = await mixOf();
    if (!it || seen.has(it.name)) continue;
    seen.add(it.name);
    if (MIX_SKIP.some(s => it.name.includes(s))) { log('跳过合集《' + it.name + '》（MIX_SKIP）'); continue; }
    const k = cands.length + 1;
    await ev(() => { window.__raw.mix = []; });
    try { await openMix(); } catch (e) { log('合集《' + it.name + '》打不开：' + e.message.slice(0, 80)); await key(10009); await shown().catch(() => {}); continue; }
    await shot(k + '-04-mix', PICK);
    await ev(k => { window.__mixes[k] = window.__raw.mix; }, k);
    cands.push({k, name: it.name, total: it.total});
    log('候选 ' + k + '：《' + it.name + '》共 ' + it.total + ' 集，MIX_FROM=' + it.id + '（第 ' + it.ep + ' 集）');
    await closeMix();
  }
  for (const c of cands) {
    await shootMe(c.k + '-06-me', PICK, c.k);
    await key(37); await shown(); await sleep(500);   // 「我」→ 推荐，焦点在顶上那一排最左边
  }
  log('候选合集：' + cands.map(c => c.k + '《' + c.name + '》').join(' '));
  await browser.close();
  process.exit(0);
}

/* 往下刷，找一条带合集的（超过 48 集最好：选集上有分组）。 */
let found = null;
for (let i = 0; i < 40 && !found; i++) {
  await key(40); await shown(); await sleep(2000);
  const it = await mixOf();
  if (it && MIX_SKIP.some(k => it.name.includes(k))) { log('跳过合集《' + it.name + '》（MIX_SKIP）'); continue; }
  if (it && (it.total > 48 || i >= 25)) { found = it; }
}
if (!found) throw new Error('刷了 40 条没有合集');
log('合集《' + found.name + '》共 ' + found.total + ' 集');
await openMix();
await shot('04-mix');
await closeMix();
await shootMe('06-me');
await browser.close();
