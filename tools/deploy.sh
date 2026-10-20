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
    --author) SELFTEST='"author"' ;;  # 暂停 → 选中作者 → 作者主页 → 放 TA 的作品 → 返回两次（约 1 分钟）
    --grid) SELFTEST='"grid"' ;;      # 作者主页网格上下翻，同一轮轮换三种做法比掉帧（约 2 分钟）
    --cold) SELFTEST='"cold"' ;;      # 作者主页里挑一年以前的视频挨个点开，量冷存储多慢（约 5 分钟）
    --ab) SELFTEST='"ab"' ;;      # 同一轮里逐条轮换两种切换动画，连刷 30 条（约 4 分钟）
    --mse) SELFTEST='"mse"' ;;    # MSE 常驻管线探测：换 src 和 seek 到预塞的时间槽，同一轮对比（约 3 分钟）
    --seek) SELFTEST='"seek"' ;;  # 长视频里来回跳到没缓冲的地方，量 seek 多久（约 3 分钟）
    --probe) SELFTEST='"probe"' ;;  # 登录态下把「我」页、合集、评论的接口各问一次，只报形状，只读（约 20 秒）
    --me) SELFTEST='"me"' ;;        # 「我」（观看历史 · 喜欢 · 收藏）、合集选集、评论侧栏；要已登录，只读（约 2 分钟）
    --mix) SELFTEST='"mix"' ;;      # 推荐里找一条带合集的，选集 → 接着放 → 下一集 → 返回两次；只读（约 1–3 分钟）
    --like) SELFTEST='"like"' ;;    # 点赞、收藏各一来一回。没有 ticket guard 头时 Act 不发；2026-10-18 不带头发过一次，服务器作废了登录
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
# node --check 只证明能解析。调用一个被删掉的函数照样放行 —— 2026-09-29 一次按锚点删块
# 带走了 render()，装上去第一条视频永远不出画面、没有任何报错。lint 抓「调用了不存在的东西」。
if [ "$APP" = "$ROOT/app" ]; then node "$ROOT/tools/lint.mjs" >/dev/null || { node "$ROOT/tools/lint.mjs" | grep '✗'; echo "  refuse to deploy"; exit 1; }; fi
# 自动更新（2026-10-20）：钥匙、版本号、CSP 放不放 blob:、boot.js 每种本地状态下选对代码。
if [ "$APP" = "$ROOT/app" ]; then node "$ROOT/tools/update-verify.mjs" >/dev/null || { node "$ROOT/tools/update-verify.mjs" | grep '✗'; echo "  refuse to deploy"; exit 1; }; fi

# 地址、自测开关、更新源只进包，不进仓库：打完包、或者中途任何一步退出，都改回去。
restore_config() {
  sed -i '' -E 's#^var REPORT_TO = "[^"]*";#var REPORT_TO = "";#' "$APP/js/config.js"
  sed -i '' -E 's#^var SELFTEST = [^;]+;#var SELFTEST = false;#' "$APP/js/config.js"
  sed -i '' -E 's#^var UPDATE_MANIFEST = "[^"]*";#var UPDATE_MANIFEST = "";#' "$APP/js/config.js"
}
trap restore_config EXIT

echo "== report -> http://$HOST_IP:$PORT =="
sed -i '' -E "s#^var REPORT_TO = \"[^\"]*\";#var REPORT_TO = \"http://$HOST_IP:$PORT\";#" "$APP/js/config.js"
sed -i '' -E "s#^var SELFTEST = [^;]+;#var SELFTEST = $SELFTEST;#" "$APP/js/config.js"
echo "  selftest=$SELFTEST"
# 在电视上测自动更新：DOUYIN_UPDATE_MANIFEST=http://<这台电脑>:<端口>/manifest.json zsh tools/deploy.sh
# 只有开发构建（REPORT_TO 非空）认它，见 app/js/update.js。
if [ -n "$DOUYIN_UPDATE_MANIFEST" ]; then
  sed -i '' -E "s#^var UPDATE_MANIFEST = \"[^\"]*\";#var UPDATE_MANIFEST = \"$DOUYIN_UPDATE_MANIFEST\";#" "$APP/js/config.js"
  echo "  update manifest=$DOUYIN_UPDATE_MANIFEST"
fi

echo "== packaging =="
cd "$APP"
rm -f ./*.wgt(N)
tizen package -t wgt -s "$PROFILE" -- . 2>&1 | grep -E "Package File Location|error" || true
WGTS=(./*.wgt(N)); WGT=${WGTS[1]}
# 地址已经在包里了，源码改回空串：仓库里不存地址（bilibili 那边踩过一次）。
restore_config
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
