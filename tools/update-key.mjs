/* Make the self-update signing key, once.
 *
 *   node tools/update-key.mjs            make it (refuses if one exists), write its public half into app/js/boot.js
 *   node tools/update-key.mjs --show     print what boot.js and the key on this machine say, and whether they match
 *
 * ECDSA P-256 / SHA-256: the strongest pair every engine this app supports can
 * verify through WebCrypto (Ed25519 arrived in Chromium far later than the
 * Tizen 5.5 sets). Its own key, not bilibili-tizen's. The private key is written encrypted, mode 600, outside the
 * repository; see update-lib.mjs for why that matters. A second run never
 * overwrites it — a new key strands every installed set on its last update. */
import crypto from "crypto";
import fs from "fs";
import { BOOT, KEY_FILE, PW_FILE, describePublic, loadPrivateKey, readBoot } from "./update-lib.mjs";

function show() {
  const boot = readBoot(fs.readFileSync(BOOT, "utf8"));
  const inBoot = boot.pubkey ? describePublic(Buffer.from(boot.pubkey, "base64")) : null;
  console.log("boot.js 里的公钥：" + (inBoot ? inBoot.fp : "（空）"));
  if (fs.existsSync(KEY_FILE)) {
    const pub = crypto.createPublicKey(loadPrivateKey()).export({ type: "spki", format: "der" });
    const mine = describePublic(pub);
    console.log("本机私钥对应的公钥：" + mine.fp + "（" + KEY_FILE + "）");
    console.log(inBoot && inBoot.b64 === mine.b64 ? "✓ 一致" : "✗ 不一致 —— 用这把私钥签的更新，电视会拒收");
  } else {
    console.log("本机没有私钥（" + KEY_FILE + "）");
  }
}

if (process.argv.includes("--show")) { show(); process.exit(0); }

if (fs.existsSync(KEY_FILE)) {
  console.log("已经有私钥了：" + KEY_FILE + "，不覆盖（换钥匙等于让每台装好的电视收不到下一个更新）。");
  show();
  process.exit(0);
}

if (!fs.existsSync(PW_FILE)) {
  fs.writeFileSync(PW_FILE, crypto.randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
}
const passphrase = fs.readFileSync(PW_FILE, "utf8").trim();
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
});
fs.writeFileSync(KEY_FILE, privateKey, { mode: 0o600 });
const pub = describePublic(publicKey);

const src = fs.readFileSync(BOOT, "utf8");
const next = src.replace(/var PUBKEY = "[A-Za-z0-9+/=]*";/, 'var PUBKEY = "' + pub.b64 + '";');
if (next === src) { console.log("✗ boot.js 里没找到 var PUBKEY = \"…\"; —— 公钥没写进去，手动填：" + pub.b64); process.exit(1); }
fs.writeFileSync(BOOT, next);

console.log("私钥：" + KEY_FILE + "（600，口令在 " + PW_FILE + "）");
console.log("公钥指纹：" + pub.fp + "，已写进 app/js/boot.js");
