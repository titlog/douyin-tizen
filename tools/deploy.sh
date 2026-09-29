#!/bin/zsh
# 打包、签名、安装、启动。默认是 app/，`--spike` 装 spike/tv（可行性探测）。电视、证书、签名档全部沿用 bilibili-tizen 的
# （~/.bilibili-tizen.conf、~/.bilibili-tizen-cert-password、签名档 SamsungBili）——
# 同一台电视、同一张分发证书，证书按设备签，不按应用签。
#   zsh tools/deploy.sh [--spike]
set -e

ROOT="${0:A:h:h}"
APP="$ROOT/app"
SELFTEST=false
for a in "$@"; do
  case "$a" in
    --spike) APP="$ROOT/spike/tv" ;;
    --selftest) SELFTEST=true ;;
    --soak) SELFTEST='"soak"' ;;
    --qr) SELFTEST='"qr"' ;;
  esac
done
# 应用 id 从 config.xml 读，不写死 —— bilibili 那边改过一次应用名，安装器推旧包、启动步骤
# 欢快地起了上一个版本。
APP_ID=$(sed -n 's/.*<tizen:application id="\([^"]*\)".*/\1/p' "$APP/config.xml")
[ -n "$APP_ID" ] || { echo "config.xml 里读不到应用 id"; exit 1; }
PORT="${DOUYIN_REPORT_PORT:-8098}"

export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"
CONF="${BILI_TIZEN_CONF:-$HOME/.bilibili-tizen.conf}"
[ -f "$CONF" ] || { echo "没有 $CONF —— 先在 bilibili-tizen 里跑 zsh tools/setup.sh"; exit 1; }
source "$CONF"
PROFILE="${BILI_PROFILE:-SamsungBili}"
TV_IP="${BILI_TV_IP:?}"
TARGET="${BILI_TV_TARGET:?}"
NET_IF="${BILI_NET_IF:-en0}"
TV="$TV_IP:26101"
tizen cli-config "profiles.path=$HOME/tizen-studio-data/profile/profiles.xml" >/dev/null

HOST_IP=$(ipconfig getifaddr "$NET_IF")
[ -n "$HOST_IP" ] || { echo "拿不到 $NET_IF 的地址"; exit 1; }

echo "== checking =="
for f in "$APP"/js/*.js; do node --check "$f" >/dev/null || { echo "  syntax error in $f"; exit 1; }; done

echo "== report -> http://$HOST_IP:$PORT =="
sed -i '' -E "s#^var REPORT_TO = \"[^\"]*\";#var REPORT_TO = \"http://$HOST_IP:$PORT\";#" "$APP/js/config.js"
sed -i '' -E "s#^var SELFTEST = [^;]+;#var SELFTEST = $SELFTEST;#" "$APP/js/config.js"
echo "  selftest=$SELFTEST"

echo "== packaging =="
cd "$APP"
rm -f ./*.wgt(N)
tizen package -t wgt -s "$PROFILE" -- . 2>&1 | grep -E "Package File Location|error" || true
WGTS=(./*.wgt(N)); WGT=${WGTS[1]}
# 地址已经在包里了，源码改回空串：仓库里不存地址（bilibili 那边踩过一次）。
sed -i '' -E 's#^var REPORT_TO = "[^"]*";#var REPORT_TO = "";#' "$APP/js/config.js"
sed -i '' -E 's#^var SELFTEST = [^;]+;#var SELFTEST = false;#' "$APP/js/config.js"
[ -n "$WGT" ] || { echo "packaging produced no wgt"; exit 1; }
echo "  built $WGT"

echo "== connecting =="
for i in $(seq 1 20); do
  sdb connect "$TV" >/dev/null 2>&1 || true
  if sdb devices 2>/dev/null | grep -q "$TV_IP.*device"; then echo "  connected"; break; fi
  sleep 5
done
sdb devices | grep -q "$TV_IP" || { echo "TV not reachable at $TV_IP（醒着吗？开发者模式登记的还是这台电脑吗？）"; exit 1; }

echo "== installing =="
tizen install -n "$(basename "$WGT")" -t "$TARGET" 2>&1 | grep -E "install completed|successfully|failed|error" \
  || { echo "  install produced no recognisable result"; exit 1; }

echo "== launching =="
tizen run -p "$APP_ID" -t "$TARGET" 2>&1 | grep -E "successfully|failed" || true
echo "== done =="
if [ "$SELFTEST" != "false" ]; then
  echo
  echo "!! 电视上现在是自测构建：每次打开都会自己换视频、暂停、快进。"
  echo "!! 看之前装回正常构建： zsh tools/deploy.sh"
fi
