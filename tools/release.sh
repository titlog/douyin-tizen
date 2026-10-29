#!/bin/zsh
# Build the .wgt that strangers install: zsh tools/release.sh
#
# Not a deploy. Nothing here touches a television, and the package is not meant
# to install as it stands: whoever installs it (Apps2Samsung, or `tizen` with
# their own profile) re-signs it with the Samsung certificate for *their* set.
# So what matters is what goes in, and what must stay out:
#
#   - no collector address, no DIAG_TO and no selftest. deploy.sh bakes this machine's LAN
#     address into every package it builds; a release built that way would have
#     every viewer's TV posting logs at a laptop on somebody else's network.
#   - no personal signature. The SamsungBili profile's certificates carry the
#     account email, a real name and employer, and the living-room TV's DUID.
#     A wgt signed with them publishes all of that in signature1.xml and
#     author-signature.xml, where anyone can read it with openssl. Releases are
#     signed with the same throwaway profile bilibili-tizen's release.sh makes
#     (BiliRelease, author CN=bilibili-tizen) and the Tizen SDK's own
#     distributor, and the result is checked, not trusted.
#   - nothing that is not committed. The package is built from `git archive
#     HEAD`, so a stray file in app/ (an old wgt, last deploy's signatures, a
#     selftest flag) cannot ride along.
set -e

ROOT="${0:A:h:h}"
cd "$ROOT"

export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"

PROFILES="$HOME/tizen-studio-data/profile/profiles.xml"
PROFILE="BiliRelease"
AUTHOR_NAME="bilibili-tizen"
AUTHOR_P12="$HOME/tizen-studio-data/keystore/author/bilibili-tizen-release.p12"
# Not a secret worth much — the certificate is thrown away by every install — but
# a password in the repository is a habit worth not forming, same as deploy.sh.
PW_FILE="$HOME/.bilibili-tizen-release-password"

VERSION=$(python3 -I -c '
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r"<widget\b[^>]*?\bversion=\"([^\"]+)\"", s, re.S)
print(m.group(1) if m else "")
' app/config.xml)
[ -n "$VERSION" ] || { echo "config.xml 里读不到 <widget version>"; exit 1; }
OUT="$ROOT/dist/douyin-tizen-$VERSION.wgt"

echo "== release $VERSION =="

# The package comes from HEAD; uncommitted edits would silently not be in it,
# which reads exactly like "the fix didn't ship".
if [ -n "$(git status --porcelain -- app)" ]; then
  echo "  app/ 有未提交的改动 —— 发布包取自 HEAD，这些改动不会进去。先提交或还原："
  git status --short -- app | sed 's/^/    /'
  exit 1
fi

# The committed source must already be in its public state. deploy.sh restores it
# after every package, but a crashed deploy can leave either flag behind, and a
# commit made in that window would carry it here.
git show HEAD:app/js/config.js | grep -q '^var REPORT_TO = "";' \
  || { echo "  HEAD 的 config.js 里 REPORT_TO 不是空的 —— 拒绝发布"; exit 1; }
git show HEAD:app/js/config.js | grep -q '^var SELFTEST = false;' \
  || { echo "  HEAD 的 config.js 里 SELFTEST 不是 false —— 拒绝发布"; exit 1; }
git show HEAD:app/js/config.js | grep -q '^var UPDATE_MANIFEST = "";' \
  || { echo "  HEAD 的 config.js 里 UPDATE_MANIFEST 不是空的 —— 拒绝发布"; exit 1; }
git show HEAD:app/js/config.js | grep -q '^var DIAG_TO = "";' \
  || { echo "  HEAD 的 config.js 里 DIAG_TO 不是空的 —— 拒绝发布"; exit 1; }
# 没有接收地址，这一版要带回来的诊断日志就无处可去。
git show HEAD:app/js/diag.js | grep -q '^    var ENDPOINT = "https://[^"]*";' \
  || { echo "  HEAD 的 diag.js 里 ENDPOINT 不是 https 地址 —— 拒绝发布"; exit 1; }

echo "== checking =="
for f in app/js/*.js; do node --check "$f" >/dev/null || { echo "  syntax error in $f"; exit 1; }; done
node "$ROOT/tools/lint.mjs" >/dev/null || { node "$ROOT/tools/lint.mjs" | grep '✗'; echo "  refuse to release"; exit 1; }
node "$ROOT/tools/update-verify.mjs" >/dev/null || { node "$ROOT/tools/update-verify.mjs" | grep '✗'; echo "  refuse to release"; exit 1; }
node "$ROOT/tools/diag-verify.mjs" >/dev/null || { node "$ROOT/tools/diag-verify.mjs" | grep '✗'; echo "  refuse to release"; exit 1; }
node "$ROOT/tools/bridge-verify.mjs" >/dev/null 2>&1 || { node "$ROOT/tools/bridge-verify.mjs"; echo "  refuse to release"; exit 1; }

echo "== signing profile =="
if [ ! -f "$PW_FILE" ]; then
  (umask 077; openssl rand -hex 16 > "$PW_FILE")
  echo "  generated $PW_FILE"
fi
PW=$(cat "$PW_FILE")
if [ ! -f "$AUTHOR_P12" ]; then
  # Name only: no email, organisation or place. Whatever is typed here is printed
  # in every release package.
  tizen certificate -a "$AUTHOR_NAME" -p "$PW" -n "$AUTHOR_NAME" \
    -f "${AUTHOR_P12:t:r}" >/dev/null
  [ -f "$AUTHOR_P12" ] || { echo "  tizen certificate did not produce $AUTHOR_P12"; exit 1; }
  echo "  author certificate created"
fi
if ! grep -q "profile name=\"$PROFILE\"" "$PROFILES" 2>/dev/null; then
  # No -A: the active profile is whatever the developer set, and stays so.
  # No -d: the SDK's own distributor, which is what an install replaces anyway.
  # Left exactly as the CLI writes it. deploy.sh rewrites the `*.pwd` entries to
  # inline passwords; here (2026-10-17, macOS) that made `tizen package` stop at an
  # "Author password:" prompt and die with a NullPointerException. The .pwd files
  # never exist on disk — on macOS the paths are keys for passwords the CLI keeps
  # elsewhere — and every working profile on this machine has them unrewritten.
  tizen security-profiles add -n "$PROFILE" -a "$AUTHOR_P12" -p "$PW" >/dev/null
  echo "  profile $PROFILE created"
else
  echo "  profile $PROFILE already present"
fi
tizen cli-config "profiles.path=$PROFILES" >/dev/null

echo "== packaging =="
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD app | tar -x -C "$STAGE"
tizen package -t wgt -s "$PROFILE" -- "$STAGE/app" 2>&1 | grep -E "Package File Location|error" || true
WGTS=("$STAGE"/app/*.wgt(N))
[ -n "${WGTS[1]}" ] || { echo "  packaging produced no wgt"; exit 1; }
mkdir -p "$ROOT/dist"
mv "${WGTS[1]}" "$OUT"

# Read back what was actually written, rather than trusting the steps above.
echo "== verifying package =="
git ls-files app | sed 's|^app/||' > "$STAGE/expected.txt"
python3 -I - "$OUT" "$STAGE/expected.txt" "$AUTHOR_NAME" <<'PY'
import base64, re, subprocess, sys, zipfile

wgt, expected_path, author_name = sys.argv[1:4]
z = zipfile.ZipFile(wgt)
names = set(z.namelist())
problems = []

# Exactly the committed files plus the two signatures; anything else is a stray.
expected = set(open(expected_path).read().split())
signatures = {"author-signature.xml", "signature1.xml"}
for n in sorted(names - expected - signatures):
    if not n.endswith("/"):
        problems.append("unexpected file in package: " + n)
for n in sorted(expected - names):
    problems.append("missing from package: " + n)
for n in sorted(signatures - names):
    problems.append("package is not signed: no " + n)

cfg = z.read("js/config.js").decode("utf-8")
if not re.search(r'^var REPORT_TO = "";', cfg, re.M):
    problems.append("config.js: REPORT_TO is not empty")
if not re.search(r'^var SELFTEST = false;', cfg, re.M):
    problems.append("config.js: SELFTEST is not false")
if not re.search(r'^var UPDATE_MANIFEST = "";', cfg, re.M):
    problems.append("config.js: UPDATE_MANIFEST is not empty")
if not re.search(r'^var DIAG_TO = "";', cfg, re.M):
    problems.append("config.js: DIAG_TO is not empty")

def certs(xml):
    for b64 in re.findall(r"<X509Certificate>\s*(.*?)\s*</X509Certificate>", xml, re.S):
        der = base64.b64decode(re.sub(r"\s", "", b64))
        out = subprocess.run(
            ["openssl", "x509", "-inform", "DER", "-noout", "-subject", "-issuer", "-ext", "subjectAltName"],
            input=der, capture_output=True).stdout.decode()
        yield out

for sig in sorted(signatures & names):
    for i, text in enumerate(certs(z.read(sig).decode("utf-8"))):
        subject = re.search(r"^subject=(.*)$", text, re.M)
        subject = subject.group(1).strip() if subject else "?"
        print("  %s #%d %s" % (sig, i, subject))
        # Samsung-issued certificates are per-person: they name the account and
        # are bound to a TV's DUID. None belongs in a public package.
        if "Samsung" in text or "deviceid=" in text or "emailAddress" in text:
            problems.append("%s carries a personal certificate: %s" % (sig, subject))
    if sig == "author-signature.xml":
        leaf = next(certs(z.read(sig).decode("utf-8")), "")
        if not re.search(r"^subject=\s*CN\s*=\s*%s\s*$" % re.escape(author_name), leaf, re.M):
            problems.append("author certificate is not the release one (CN=%s)" % author_name)

if problems:
    for p in problems:
        print("  !! " + p)
    sys.exit(1)
print("  %d files, REPORT_TO empty, SELFTEST off, UPDATE_MANIFEST empty, DIAG_TO empty, no personal certificate" % len(names - signatures))
PY

echo "== done =="
echo "  $OUT"
echo "  $(wc -c < "$OUT" | tr -d ' ') bytes  sha256 $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
