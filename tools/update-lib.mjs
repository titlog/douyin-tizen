/* Shared by the self-update tools: where the signing key lives, how a manifest
 * is signed, and how boot.js is read. One copy, so the key generator, the
 * release tool and the verifier cannot disagree about any of it.
 * (Copied from bilibili-tizen's tools/update-lib.mjs, 2026-10-20.)
 *
 * The private key is the one thing that can make every installed television
 * run new code — including the copies holding someone's logged-in Douyin
 * session. So it lives outside the repository, mode 600, encrypted with a
 * passphrase that also lives outside the repository. It is not bilibili-tizen's
 * key: one leak should not open both apps. Losing it means the next release has
 * to be a reinstall with a new public key; leaking it means anyone can ship code
 * to every set. */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const KEY_FILE = process.env.DOUYIN_UPDATE_KEY || path.join(os.homedir(), ".douyin-tizen-update-key.pem");
export const PW_FILE = process.env.DOUYIN_UPDATE_PASSWORD || path.join(os.homedir(), ".douyin-tizen-update-password");
export const BOOT = path.join(ROOT, "app/js/boot.js");

/* What boot.js declares. Read with regexes rather than evaluated: the release
 * tool reads it out of `git show HEAD:…`, and boot.js runs document.write at
 * load. */
export function readBoot(src) {
  const pub = /var PUBKEY = "([A-Za-z0-9+/=]*)";/.exec(src);
  const shell = /var SHELL = (\d+);/.exec(src);
  const fallback = /var PACKAGED_FALLBACK = "([^"]*)";/.exec(src);
  const scripts = /var SCRIPTS = \[([^\]]*)\]/.exec(src);
  if (!pub || !shell || !fallback || !scripts) {
    throw new Error("boot.js 里读不到 PUBKEY / SHELL / PACKAGED_FALLBACK / SCRIPTS 之一");
  }
  return {
    pubkey: pub[1],
    shell: Number(shell[1]),
    packagedFallback: fallback[1],
    scripts: [...scripts[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  };
}

export function configVersion(xml) {
  const m = /<widget\b[^>]*?\bversion="([^"]+)"/s.exec(xml);
  if (!m) { throw new Error("config.xml 里读不到 <widget version>"); }
  return m[1];
}

/* SPKI DER → the two forms people compare: the base64 boot.js carries, and a
 * short fingerprint for a human to read off two screens. */
export function describePublic(spkiDer) {
  const b64 = Buffer.from(spkiDer).toString("base64");
  const fp = crypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 32).match(/.{4}/g).join(":");
  return { b64, fp };
}

export function loadPrivateKey() {
  if (!fs.existsSync(KEY_FILE)) { throw new Error("没有私钥 " + KEY_FILE + " —— 先跑 node tools/update-key.mjs"); }
  if (!fs.existsSync(PW_FILE)) { throw new Error("没有口令文件 " + PW_FILE); }
  const mode = fs.statSync(KEY_FILE).mode & 0o077;
  if (mode) { throw new Error(KEY_FILE + " 别人读得到（权限 " + (fs.statSync(KEY_FILE).mode & 0o777).toString(8) + "），先 chmod 600"); }
  return crypto.createPrivateKey({
    key: fs.readFileSync(KEY_FILE, "utf8"),
    passphrase: fs.readFileSync(PW_FILE, "utf8").trim(),
  });
}

/* IEEE P1363 (r || s, 64 bytes) — what WebCrypto's ECDSA verify expects. Node's
 * default is DER, which WebCrypto rejects as a wrong-length signature: a
 * failure that would read exactly like "the signature is forged". */
export function sign(privateKey, payload) {
  return crypto.sign("sha256", Buffer.from(payload, "utf8"),
    { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
}

export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* The update a television downloads: the static DOM of index.html's body, the
 * stylesheets it links, and every script boot.js loads except the two that
 * must never come over the network — config.js (deploy.sh writes the report
 * address and the selftest flag into it) and boot.js (the trust root). */
export function buildBundle({ version, shell, indexHtml, bootSrc, readFile }) {
  const boot = readBoot(bootSrc);
  const bodyMatch = /<body[^>]*>([\s\S]*?)<script\b/.exec(indexHtml);
  if (!bodyMatch) { throw new Error("index.html 里找不到 <body> 后面的第一个 <script>"); }
  const styles = [...indexHtml.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)">/g)].map((m) => m[1]);
  const files = { body: bodyMatch[1] };
  for (const s of styles) { files[s] = readFile("app/" + s); }
  for (const name of boot.scripts) {
    if (name === "config.js" || name === "boot.js") { throw new Error("SCRIPTS 里不该有 " + name); }
    files["js/" + name] = readFile("app/js/" + name);
  }
  return { version, shell: shell ?? boot.shell, scripts: boot.scripts, styles, files };
}
