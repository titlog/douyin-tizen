/* Build and sign the self-update for the version in config.xml.
 *
 *   node tools/update-release.mjs        → update/manifest.json + update/bundle-<version>.json
 *
 * then commit update/, tag v<version> on that commit, push master and the tag
 * (CLAUDE.md 「自动更新」 has the whole sequence). Copied from bilibili-tizen. The televisions read the
 * manifest from master and the bundle from the tag, so the tag must exist
 * before the manifest that points at it is pushed — or every set spends a
 * check on a 404.
 *
 * Built from `git archive HEAD`, like release.sh: an uncommitted edit would not
 * be in the bundle, and that reads exactly like "the fix didn't ship". So app/
 * must be clean. Test-only options (never for a real release):
 *   --worktree           take app/ from the working tree instead of HEAD
 *   --version X          override the version
 *   --base URL           bundle urls = URL + bundle file name, instead of the repository's
 *   --out DIR            write there instead of update/
 *   --key FILE --pass FILE   sign with another key (the e2e test's throwaway one) */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { ROOT, buildBundle, configVersion, describePublic, loadPrivateKey, readBoot, sha256Hex, sign } from "./update-lib.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const WORKTREE = args.includes("--worktree");
const OUT = opt("--out") || path.join(ROOT, "update");

function git(...a) { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }); }

if (!WORKTREE) {
  const dirty = git("status", "--porcelain", "--", "app").trim();
  if (dirty) {
    console.error("✗ app/ 有未提交的改动 —— 更新包取自 HEAD，这些改动不会进去。先提交或还原：\n" + dirty.replace(/^/gm, "    "));
    process.exit(1);
  }
}

const read = WORKTREE
  ? (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
  : (p) => git("show", "HEAD:" + p);

const bootSrc = read("app/js/boot.js");
const boot = readBoot(bootSrc);
const version = opt("--version") || configVersion(read("app/config.xml"));

/* The key that signs must be the one the sets trust. A mismatch would publish
 * an update every television throws away as forged. */
let privateKey;
if (opt("--key")) {
  privateKey = crypto.createPrivateKey({ key: fs.readFileSync(opt("--key"), "utf8"), passphrase: fs.readFileSync(opt("--pass"), "utf8").trim() });
} else {
  privateKey = loadPrivateKey();
  const pub = describePublic(crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }));
  if (pub.b64 !== boot.pubkey) {
    console.error("✗ 私钥和 boot.js 里的公钥不是一对 —— 签出来的更新每台电视都会拒收");
    process.exit(1);
  }
}

const bundle = buildBundle({ version, shell: boot.shell, indexHtml: read("app/index.html"), bootSrc, readFile: read });
const bundleName = "bundle-" + version + ".json";
const bundleBytes = Buffer.from(JSON.stringify(bundle), "utf8");

const base = opt("--base");
const urls = base
  ? [base.replace(/\/?$/, "/") + bundleName]
  : ["https://cdn.jsdelivr.net/gh/titlog/douyin-tizen@v" + version + "/update/" + bundleName,
     "https://raw.githubusercontent.com/titlog/douyin-tizen/v" + version + "/update/" + bundleName];

const manifest = JSON.stringify({
  version, shell: bundle.shell, sha256: sha256Hex(bundleBytes), size: bundleBytes.length,
  date: new Date().toISOString(), urls,
});

fs.mkdirSync(OUT, { recursive: true });
/* Older bundles go: master only ever needs the current one (each tag keeps its
 * own), and every set re-downloads from the tag the manifest names anyway. */
if (!opt("--out")) {
  for (const f of fs.readdirSync(OUT)) { if (/^bundle-.*\.json$/.test(f) && f !== bundleName) { fs.unlinkSync(path.join(OUT, f)); } }
}
fs.writeFileSync(path.join(OUT, bundleName), bundleBytes);
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ manifest, sig: sign(privateKey, manifest) }, null, 1) + "\n");

console.log(`✓ ${version}（shell ${bundle.shell}）：${bundle.scripts.length} 个脚本、${bundle.styles.length} 个样式，` +
  `bundle ${Math.round(bundleBytes.length / 1024)}KB → ${path.relative(ROOT, path.join(OUT, bundleName)) || bundleName}`);
if (!base && !opt("--out")) {
  console.log(`接下来：git add update && git commit -m "更新包 ${version}" && git tag v${version} && git push origin master v${version}`);
}
