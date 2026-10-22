/* Catch what `node --check` cannot: code that parses but refers to things that
 * do not exist.
 *
 * 抄自 bilibili-tizen 的 tools/lint.mjs。这里第一次用上是 2026-09-29：按「从一段注释开头删到
 * show()」删掉旧背景画布时，把夹在中间的 render() 和 fitBox() 一起带走了。每个文件都能解析，
 * 电视上的症状是第一条视频永远不出画面、没有任何报错（异常发生在 Promise 回调里，onerror 接不到）。
 *
 *   node tools/lint.mjs
 */
import fs from "fs";
import path from "path";
import vm from "vm";

const APP = new URL("../app/js/", import.meta.url).pathname;

/* Load order matters: the app is a series of plain scripts sharing globals.
 *
 * Read from what the app actually loads rather than listed here. The hand-kept list had silently
 * fallen two files behind — `selftest.js` and `updater.js` shipped unchecked,
 * which is precisely the gap this tool exists to close: a call to something
 * that does not exist parses fine and fails only on the sofa. Same lesson as
 * deploy.sh deriving the wgt name from the build instead of hardcoding it.
 *
 * 2026-10-20 起 index.html 只剩 config.js 和 boot.js 两个标签，其余由 boot.js 按它的 SCRIPTS 写进去
 * （自动更新，见 CLAUDE.md），所以顺序从那里读。index.html 里多出别的标签也算错：那个文件会加载两次，
 * 而且不在更新包里。 */
const INDEX = new URL("../app/index.html", import.meta.url).pathname;
const TAGS = [...fs.readFileSync(INDEX, "utf8")
  .matchAll(/<script\s+src="js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
if (TAGS.join() !== "config.js,boot.js") {
  console.error(`✗ index.html 的脚本标签应该只有 config.js、boot.js，现在是 ${TAGS.join("、") || "（没有）"} —— 新脚本加进 boot.js 的 SCRIPTS`);
  process.exit(1);
}
const BOOT_SCRIPTS = /var SCRIPTS = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(APP, "boot.js"), "utf8"));
const ORDER = ["config.js", "boot.js", ...(BOOT_SCRIPTS ? [...BOOT_SCRIPTS[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [])];

if (ORDER.length <= 2) {
  console.error("✗ boot.js 的 SCRIPTS 里没读到任何脚本 — lint 什么都没检查");
  process.exit(1);
}
for (const f of ORDER) {
  if (!fs.existsSync(path.join(APP, f))) {
    console.error(`✗ boot.js 的 SCRIPTS 引用了 js/${f}，但文件不存在`);
    process.exit(1);
  }
}

/* Browser and Tizen surface the app is allowed to assume. */
const HOST = [
  "window", "document", "navigator", "location", "localStorage", "console",
  "XMLHttpRequest", "MediaSource", "URL", "Image", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "Math", "JSON", "Date", "String", "Number",
  "Boolean", "Array", "Object", "RegExp", "Error", "parseInt", "parseFloat",
  "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "escape",
  "unescape", "btoa", "atob", "Uint8Array", "Uint8ClampedArray", "ArrayBuffer",
  "DataView", "Promise", "Blob", "Function", "fetch", "performance",
  "requestAnimationFrame", "PerformanceObserver", "TextEncoder", "TextDecoder",
  "tizen", "webapis",
  // WebCodecs：msespike.js 的 --splice 探测用，用之前先 typeof 判断（这台电视有没有还要量）
  "VideoDecoder", "EncodedVideoChunk",
];

let failed = false;

/* A sandbox that answers for anything, so evaluation reaches the whole file
 * without a real DOM, and records which globals each file defines. */
/* Comments and string literals mention functions too — "view()" in prose is not
 * a call — so they come out before anything is counted. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

function scanFile(file, known) {
  const src = strip(fs.readFileSync(path.join(APP, file), "utf8"));

  /* Identifiers used as `name(` or `name.` or bare, excluding property access
   * and declarations, are checked against what earlier files defined plus what
   * this file declares itself. */
  const declared = new Set();
  for (const m of src.matchAll(/(?:^|\s)(?:function\s+|var\s+)([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]);
  }
  /* var a = 1, b = 2; */
  for (const m of src.matchAll(/var\s+([^;=]+)=/g)) {
    for (const part of m[1].split(",")) { declared.add(part.trim()); }
  }
  /* function parameters and catch bindings */
  for (const m of src.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(",")) { if (p.trim()) { declared.add(p.trim()); } }
  }
  for (const m of src.matchAll(/catch\s*\(\s*([\w$]+)\s*\)/g)) { declared.add(m[1]); }
  for (const m of src.matchAll(/for\s*\(\s*var\s+([\w$]+)/g)) { declared.add(m[1]); }

  const calls = new Set();
  for (const m of src.matchAll(/(?<![.\w$"'])([A-Za-z_$][\w$]*)\s*\(/g)) {
    calls.add(m[1]);
  }

  const keywords = new Set(["if", "for", "while", "switch", "catch", "return",
    "function", "typeof", "new", "delete", "void", "in", "instanceof", "do",
    "else", "throw", "case"]);

  const missing = [...calls].filter((n) =>
    !keywords.has(n) && !declared.has(n) && !known.has(n) && !HOST.includes(n));

  if (missing.length) {
    console.log(`✗ ${file}: calls undefined ${missing.join(", ")}`);
    failed = true;
  } else {
    console.log(`✓ ${file}`);
  }

  for (const d of declared) { known.add(d); }
}

/* 第三方的压缩代码不扫（满是单字母名字），只记下它往全局放了什么。 */
const VENDOR_GLOBALS = { "vendor/mp4box.js": ["MP4Box"], "vendor/mpegts.js": ["MpegtsLib"] };

const known = new Set();
for (const f of ORDER) {
  if (f.startsWith("vendor/")) {
    if (!VENDOR_GLOBALS[f]) { console.log(`✗ ${f}: 第三方文件没登记它的全局名字（VENDOR_GLOBALS）`); failed = true; continue; }
    for (const g of VENDOR_GLOBALS[f]) { known.add(g); }
    console.log(`✓ ${f}（第三方，不扫）`);
    continue;
  }
  scanFile(f, known);
}

/* Every id the app reaches for must exist in the markup or be built by it. */
const html = fs.readFileSync(new URL("../app/index.html", import.meta.url).pathname, "utf8");
const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const jsIds = new Set();
for (const f of ORDER) {
  if (f.startsWith("vendor/")) { continue; }
  const src = fs.readFileSync(path.join(APP, f), "utf8");
  for (const m of src.matchAll(/(?:\$|getElementById)\("([\w-]+)"\)/g)) { jsIds.add(m[1]); }
  /* ids created from template strings count as present */
  for (const m of src.matchAll(/id="([\w-]+)"/g)) { htmlIds.add(m[1]); }
}
const missingIds = [...jsIds].filter((id) => !htmlIds.has(id));
if (missingIds.length) {
  console.log(`✗ index.html: missing ids ${missingIds.join(", ")}`);
  failed = true;
} else {
  console.log("✓ element ids");
}

process.exit(failed ? 1 : 0);
