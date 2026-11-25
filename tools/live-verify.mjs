/* 直播挑档、降档和 mpegts 出错时怎么拆的离线验证（2026-11-25）。deploy.sh、release.sh 卡着它。
 *
 * 一类 Tizen 5.5 的问询答 hev1 1080x1920=否，每个直播间都是出画面一秒内解码失败；参考机什么都解得了，这条路在它上面走不到
 * （--livecodec 只能假装），所以在设备之外测：
 *   - feed.js 从 stream_data 里读出每一档的编码、尺寸、地址（形状照 2026-11-25 开发机上问到的，值全是编的）；
 *   - 问询答「是」的电视照旧放 flv 那一档，出错直接交给 app，不挑档；
 *   - 答「否」的挑问询说解得了的最大一档；它解码失败（还没放成 2 秒）→ 同一个直播间换下一档，不高于 1088 的 H.265 也失败就不再挑 H.265；
 *     一档都没有了 → 告诉 app「直播：解不了」；放成 2 秒之后的失败不降档；
 *   - mpegts 在它自己的 ERROR 回调里同步出错时不当场拆它（当场拆，回调的下一句碰到 null —— 三份「未处理的 Promise 异常」上传）。
 *
 *   node tools/live-verify.mjs
 */
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const FEED = read("../app/js/feed.js"), PLAYER = read("../app/js/player.js");
let failures = 0;
async function t(name, fn) {
  try { await fn(); console.log("✓ " + name); }
  catch (e) { failures++; console.log("✗ " + name + "\n    " + String(e && e.stack || e).split("\n").slice(0, 6).join("\n    ")); }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ---------- 一个直播间，形状照 /webcast/feed/ ---------- */
function room(id, {origin = "h265"} = {}) {
  const u = (sfx, host = "pull-flv-a1.example.invalid") => "http://" + host + "/live/stream-" + id + sfx + ".flv?expire=1&sign=s" + id + sfx;
  const q = (codec, res, fps, flv) => ({ main: { flv, hls: flv.replace(".flv", ".m3u8"), sdk_params: JSON.stringify({ VCodec: codec, resolution: res, fps }) } });
  const data = {
    origin: q(origin, "1080x1920", 59, u("")),
    hd: q("h265", "720x1280", 30, u("_hd5")),
    sd: q("h265", "540x960", 30, u("_sd5")),
    ld: q("h265", "480x853", 25, u("_ld5")),
    md: q("h264", "360x640", 15, u("_md", "pull-flv-a1-admin.example.invalid")),
    ao: { main: { flv: u("") + "&only_audio=1", sdk_params: JSON.stringify({ VCodec: "h264", resolution: "" }) } },
  };
  return { type: 1, data: {
    id_str: String(id), title: "编的标题", owner: { nickname: "编的主播", sec_uid: "x", id_str: "1", avatar_thumb: { url_list: ["a"] } }, cover: { url_list: ["c"] },
    stream_url: {
      stream_orientation: 1,
      flv_pull_url: { FULL_HD1: data.origin.main.flv, HD1: data.hd.main.flv, SD2: data.sd.main.flv, SD1: data.ld.main.flv },
      hls_pull_url_map: { FULL_HD1: data.origin.main.hls },
      live_core_sdk_data: { pull_data: { stream_data: JSON.stringify({ common: {}, data }),
        options: { qualities: [{ sdk_key: "origin", v_codec: origin === "h265" ? "bytevc1" : "264", resolution: "1080x1920" }] } } },
    } } };
}

/* ---------- 一台假电视：feed.js + player.js，问询按 probe 答 ---------- */
function television(probe) {
  const logs = [], errors = [], players = [];
  class Video {
    constructor() { this.l = {}; this.currentTime = 0; this.videoWidth = 0; this.videoHeight = 0; this.readyState = 0; this.networkState = 0;
      this.error = null; this.paused = true; this.src = ""; this.currentSrc = ""; this.style = {}; this.buffered = { length: 0 }; this.seekable = { length: 0 }; this.duration = Infinity; }
    addEventListener(n, f) { (this.l[n] = this.l[n] || []).push(f); }
    removeEventListener(n, f) { this.l[n] = (this.l[n] || []).filter((g) => g !== f); }
    fire(n) { (this.l[n] || []).slice().forEach((f) => f()); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ""; }
    load() {}
  }
  /* mpegts 的播放器：拆掉以后内部的控制器、发射器都是 null（和真的一样），之后再碰就抛 TypeError */
  class FakeMpegts {
    constructor(ds) { this.url = ds.url; this.h = {}; this.destroyed = false; this._loading_controller = { notifyBufferedPositionChanged() {} }; this._emitter = { emit() {} }; players.push(this); }
    on(ev, fn) { this.h[ev] = fn; }
    attachMediaElement() {} load() {} play() { return Promise.resolve(); } pause() {} unload() {} detachMediaElement() {}
    destroy() { this.destroyed = true; this._loading_controller = null; this._emitter = null; }
    get mediaInfo() { return { videoCodec: this.codec || "" }; }
    /* appendMediaSegment 里 appendBuffer 抛错 → 同步发 ERROR → 回到 MEDIA_SEGMENT 回调的下一句；转封装器排着的 Promise 回调随后再跑 */
    appendFails() {
      const crashes = [];
      Promise.resolve().then(() => { try { this._emitter.emit("media_segment"); } catch (e) { crashes.push(e.message); } });
      this.h.error("MediaError", "MediaMSEError", { msg: "Failed to execute 'appendBuffer' on 'SourceBuffer': The HTMLMediaElement.error attribute is not null." });
      try { this._loading_controller.notifyBufferedPositionChanged(1); } catch (e) { crashes.push(e.message); }
      return crashes;
    }
  }
  const store = new Map();
  const sandbox = {
    console, JSON, Math, Date, String, Number, Object, Array, RegExp, Error, Promise, isFinite, parseInt, encodeURIComponent, decodeURIComponent, DataView,
    setTimeout, clearTimeout,
    setInterval: (f, ms) => { const h = setInterval(f, ms); h.unref(); return h; }, clearInterval,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    Log: { report: (k, m) => logs.push(k + ": " + m) },
    Diag: { priv: (s) => s },
    Account: { loggedIn: () => false },
    Bridge: { get: () => Promise.resolve({ status_code: 0, extra: { has_more: false, max_time: 1 }, data: [room(1001), room(1002), room(1003, { origin: "h264" }), room(1004)] }) },
    MediaSource: { isTypeSupported: (type) => {
      const m = /codecs="([^"]+)"(?:; width=(\d+); height=(\d+))?/.exec(type);
      const c = m[1].slice(0, 4), h = +m[3] || 0;
      if (c === "hev1" || c === "hvc1") { return probe.hevcMaxH === undefined ? true : h ? h <= probe.hevcMaxH : true; }
      return true;
    } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Mse: { init() {}, on() {}, usable: () => false, detach() {}, whyBad: () => "", dimsOf: () => null },
    MpegtsLib: { get: () => ({ createPlayer: (ds) => new FakeMpegts(ds), Events: { ERROR: "error", STATISTICS_INFO: "statistics_info", MEDIA_INFO: "media_info" } }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(FEED + "\nthis.Feed = Feed;", sandbox, { filename: "feed.js" });
  vm.runInContext(PLAYER + "\nthis.Player = Player;", sandbox, { filename: "player.js" });
  const el = new Video();
  sandbox.Player.init(el);
  sandbox.Player.on("error", (why) => errors.push(why));
  return { Feed: sandbox.Feed, Player: sandbox.Player, el, logs, errors, players, last: () => players[players.length - 1] };
}
async function rooms(tv) {
  const f = tv.Feed.create("live"), out = [];
  for (let i = 0; i < 4; i++) { out.push(await f.next()); }
  return out;
}
/* 出画面：元素 playing（mpegts 先报 MEDIA_INFO） */
function picture(tv, w, h) {
  const p = tv.last();
  if (p.h.media_info) { p.h.media_info({ videoCodec: p.url.indexOf("_md") >= 0 ? "avc1.42c01e" : "hvc1.1.6.L120.B0", width: w, height: h, fps: 30 }); }
  tv.el.videoWidth = w; tv.el.videoHeight = h;
  tv.el.fire("playing");
}

await t("feed.js：stream_data 读成每一档的编码、尺寸、地址，按像素从大到小，不要只有声音的那档", async () => {
  const tv = television({});
  const [r] = await rooms(tv);
  assert.equal(r.streams.map((s) => s.q + " " + s.codec + " " + s.w + "x" + s.h + " " + s.fps).join(" | "),
    ["origin h265 1080x1920 59", "hd h265 720x1280 30", "sd h265 540x960 30", "ld h265 480x853 25", "md h264 360x640 15"].join(" | "));
  assert.equal(r.flv, r.streams[0].flv, "flv 那一档（FULL_HD1）就是 origin");
  assert.ok(/_md\.flv/.test(r.streams[4].flv));
});

await t("问询答 hev1 1080x1920=是：照旧放 flv 那一档，不挑档；解码失败直接交给 app", async () => {
  const tv = television({});
  const [r] = await rooms(tv);
  tv.Player.play(r, "直播", 0);
  assert.equal(tv.last().url, r.flv);
  assert.ok(!tv.logs.some((l) => /挑档/.test(l)), tv.logs.join("\n"));
  picture(tv, 1080, 1920);
  assert.ok(tv.logs.some((l) => /^到画面: .*1080x1920 · 流 origin H\.265 1080x1920 59fps，解出 hvc1/.test(l)), "「到画面」带着这一档和解出来的编码串：\n" + tv.logs.join("\n"));
  tv.el.error = { code: 3, message: "" };
  tv.el.fire("error");
  await tick(5);
  assert.equal(tv.errors.join(" / "), "直播：元素报错 3 ");
  assert.equal(tv.players.length, 1, "没有降档重来");
});

await t("mpegts 在自己的回调里同步报错：当场不拆（回调的下一句、排着的 Promise 回调都不碰 null），下一轮拆、再告诉 app", async () => {
  const tv = television({});
  const [, r2] = await rooms(tv);
  tv.Player.play(r2, "直播", 0);
  picture(tv, 1080, 1920);
  const p = tv.last();
  const crashes = p.appendFails();
  assert.equal(p.destroyed, false, "还在 mpegts 的回调里");
  await tick(5);
  assert.equal(crashes.join(" / "), "", "拆早了");
  assert.ok(p.destroyed, "下一轮拆了");
  assert.equal(tv.errors.length, 1);
  assert.ok(/^直播：mpegts MediaError MediaMSEError/.test(tv.errors[0]), tv.errors[0]);
});

await t("问询答 1080x1920=否：挑问询说解得了的最大一档（sd 540x960），失败了同一个直播间降到 H.264，之后不再挑 H.265", async () => {
  const tv = television({ hevcMaxH: 1088 });
  const [r, r2] = await rooms(tv);
  tv.Player.play(r, "直播", 0);
  assert.ok(/_sd5\.flv/.test(tv.last().url), tv.last().url);
  assert.ok(tv.logs.some((l) => /挑档 sd H\.265 540x960 30fps（跳过 origin、hd）/.test(l)), tv.logs.join("\n"));
  picture(tv, 540, 960);
  const first = tv.last();
  const crashes = first.appendFails();
  await tick(5);
  assert.deepEqual(crashes, [], "mpegts 自己回调里的下一句、排着的 Promise 回调都没碰到 null");
  assert.ok(first.destroyed, "下一轮才拆");
  assert.equal(tv.errors.length, 0, "降档不算放不了：" + tv.errors.join(" / "));
  assert.ok(/_md\.flv/.test(tv.last().url), "同一个直播间换到 md：" + tv.last().url);
  assert.ok(tv.logs.some((l) => /解不了 sd H\.265 540x960 30fps（mpegts MediaError MediaMSEError .*这次运行不再挑 H\.265/.test(l)), tv.logs.join("\n"));
  picture(tv, 360, 640);
  assert.equal(tv.Player.state().live.steps, 1);
  tv.el.currentTime += 2.1;
  tv.el.fire("timeupdate");
  assert.ok(tv.logs.some((l) => /放成了 md H\.264 360x640 15fps.*降了 1 档/.test(l)), tv.logs.join("\n"));
  /* 下一个直播间直接挑 H.264 */
  tv.Player.play(r2, "直播", 0);
  assert.ok(/_md\.flv/.test(tv.last().url), tv.last().url);
  assert.equal(tv.Player.state().live.steps, 0);
});

await t("一档都解不了：告诉 app「直播：解不了」；下一个直播间连试都不试", async () => {
  const tv = television({ hevcMaxH: 0 });
  const [r, r2] = await rooms(tv);
  tv.Player.play(r, "直播", 0);
  assert.ok(/_md\.flv/.test(tv.last().url), "H.265 一档都不问出来，直接 md：" + tv.last().url);
  picture(tv, 360, 640);
  tv.el.error = { code: 3, message: "" };
  tv.el.fire("error");
  await tick(5);
  assert.equal(tv.errors.length, 1, tv.logs.join("\n"));
  assert.equal(tv.errors[0], "直播：解不了");
  const n = tv.players.length;
  tv.Player.play(r2, "直播", 0);
  await tick(5);
  assert.equal(tv.players.length, n, "没有再建播放器");
  assert.deepEqual(tv.errors.slice(1), ["直播：解不了"]);
});

await t("挑的那档放成 2 秒之后才出错：不降档（不是解不了），原样交给 app", async () => {
  const tv = television({ hevcMaxH: 1088 });
  const [r] = await rooms(tv);
  tv.Player.play(r, "直播", 0);
  picture(tv, 540, 960);
  tv.el.currentTime += 2.5;
  tv.el.fire("timeupdate");
  tv.last().h.error("NetworkError", "UnrecoverableEarlyEof", { msg: "Fetch stream meet Early-EOF" });
  await tick(5);
  assert.deepEqual(tv.errors, ["直播：mpegts NetworkError UnrecoverableEarlyEof Fetch stream meet Early-EOF"]);
  tv.el.error = { code: 3, message: "" };
  assert.equal(tv.players.length, 1);
});

await t("原画是 H.264 的直播间（问询答否）：高过 1088 的 H.264 没放成过就不挑，挑 sd", async () => {
  const tv = television({ hevcMaxH: 1088 });
  const rs = await rooms(tv);
  tv.Player.play(rs[2], "直播", 0);
  assert.ok(/_sd5\.flv/.test(tv.last().url), tv.last().url);
});

if (failures) { console.log(`\n✗ ${failures} 项失败`); process.exit(1); }
console.log("\n✓ 直播挑档全部通过");
