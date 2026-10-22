# 三星电视（Tizen）上刷抖音

兄弟项目 `../bilibili-tizen` 的平台结论（设备、证书、部署、日志通道、AVPlay 的坑）
这里全部适用，**先读那份 CLAUDE.md**。这份只记抖音自己的事。

## 已经测定的事实（2026-09-29，开发机 + 登录态 Chrome）

**播放不需要任何凭证。** `https://www.douyin.com/aweme/v1/play/?video_id=<play_addr.uri>&ratio=1080p`
不签名、不带 Referer、不带 cookie、连 curl 默认 UA 都放行，302 到 `v3-dy-o.zjcdn.com`
返回 206。`aweme.snssdk.com` 上的同一路径同样可用。拿到的是 1920×1080 H.264 渐进式 MP4，
moov 在文件头，开发机 7.1 MB/s。**形状和 bilibili 的 `durl` 一样，AVPlay 或 `<video>` 直接吃。**

**列表接口给的 CDN 直链反而是 403。** `play_addr.url_list` 前两项（`v3-web-prime.douyinvod.com`）
从官网页面里发、带不带 Referer、带不带 Range，一律 403（238B 的 HTML 错误页，却标着
`video/mp4`）。第三项才是上面那个跳转接口。**别用前两项。**

**列表接口必须带 `a_bogus`，登录了也一样。** `/aweme/v1/web/tab/feed/`：

| 请求 | 结果 |
|---|---|
| curl，浏览器 UA，无 cookie，不签 | 200，正文 `blocked` |
| 官网页面里、带登录 cookie、用未被挂钩的 XHR，不签 | 200，正文 `blocked` |
| 官网页面里、被 SDK 挂钩的 XHR（自动加 `a_bogus`） | 200，推荐流 JSON |

`/aweme/v1/web/module/feed/` 不签则返回空正文。官网的每个 `/aweme/v1/web/*` 请求都带
`a_bogus`（外加 `webid`、`uifid`、`verifyFp` 等指纹参数），签名是页面里的 SDK 挂钩
`XMLHttpRequest.prototype.open` 自动加的。

**所以整个项目只卡在一件事上：电视上怎么产出有效的 `a_bogus`。**

### 用抖音自己的签名 SDK：签得出来，但服务器只认「页面在 douyin.com 上」（2026-09-29）

官网的组装方式：页面加载 `secsdk runtime_bundler`、`webmssdk.es5.js`、`sdk-glue.js`，
调 `window._SdkGlueInit(c, a)`（`c` 里是 `bdms: {aid: 6383, pageId: 6241, paths, ddrt: 8.5, ic: 8.5}`
和 `verifyCenter` 配置，`a` 是脚本地址列表），glue 自己再去拉 `bdms_*.js` 和验证码 SDK。
匿名访客的 `ttwid` 走 `ttwid.bytedance.com/ttwid/union/register/`（`service: www.douyin.com`），
它回的 `redirect_url` 指向 `www.douyin.com/ttwid/union/register/callback/`，由它在
`douyin.com` 名下种 `ttwid`（`SameSite=None`，跨域带凭证的 XHR 收得下）。

测试台：Playwright 的 Chrome for Testing，关掉跨域检查、全新 profile、正常桌面 UA，
页面照上面组装，跨域直连 `www.douyin.com` —— 也就是「刚装好 App 的电视」的样子。
全部匿名，每组 3 次：

| 页面在哪 | Referer | douyin.com 名下的 cookie | 推荐流 |
|---|---|---|---|
| localhost | 无 | 无 | 空正文 |
| localhost | 无 | ttwid | `blocked` |
| localhost | `http://localhost…` | ttwid | `blocked` |
| localhost | 网络层强改成 `https://www.douyin.com/` | ttwid | `blocked` |
| localhost | 同上 | ttwid + 把页面写的 `s_v_web_id`/`UIFID_TEMP` 镜像过去 | `blocked` |
| **路由伪装成 `www.douyin.com`** | **有（douyin）** | ttwid + 页面自己写的 | **3/3 拿到推荐流** |
| 路由伪装成 `www.douyin.com` | 无 | 同上 | `blocked` |

读法：SDK 在别的域名上照样加签（`a_bogus`、`verifyFp`、`fp`），组装本身是对的 ——
同一份页面放在 douyin.com 上就能用。**Referer 是必要条件**（唯一差别是去掉 Referer，
3/3 成功变成 3/3 `blocked`），**但不充分**：Referer 和 cookie 都补齐、只有页面地址还是
localhost，照样 `blocked`。剩下的变量是签名本身看得见的页面地址 —— SDK 把
`location` 编进了签名，服务器拿它和 Referer 对账。这一条是排除法得出的，没有直接证明。

**⟶ 同一天在电视上找到了出口，见下一节。** 以下是桌面上当时的判断：Referer 是 forbidden header，widget 改不了（bilibili 那边 `Cookie` 头
被静默丢掉是同一回事），widget 的页面地址也不可能是 douyin.com。所以「widget 里加载
官网 SDK、直连接口」这条路在桌面模拟里是死的。**重放不能用来判别变量**：官网页面里签好的
地址原样重放、cookie 和 Referer 都带上，也是 `blocked` —— 签名一次性。

其他：
- 首页 HTML 对 curl 是 `__ac_nonce` / `__ac_signature` 的 JS 挑战页。
- `iesdouyin.com/share/video/<id>/` 仍返回 `_ROUTER_DATA`，但测试那条 id 的
  `videoInfoRes` 是空的 —— 分享页那条免签名的老路可能已经关了，未对多条 id 复核。
- 推荐流条目：`aweme_list[].video.{duration(ms),width,height,play_addr.uri,bit_rate[]}`，
  `bit_rate` 里有 mp4 和 dash 两种 `format`，本次样本都是 H.264。

## 电视上的出口：widget 能对 www.douyin.com 的 iframe 执行脚本（2026-09-29 设备实测）

`spike/tv` 装到参考机（Tizen 9.0 / Chromium 120，同 bilibili 那台）上跑的结果，原样：

```
env location=file:///index.html origin=file:// referrer=(空)
ECHO xhr-朴素                     referer=(无)  origin=(无)
ECHO xhr-setRequestHeader-Referer referer=(无)  x-probe=custom-ok
ECHO fetch-referrer选项           referer=(无)
play xhr status=206 65536B 513ms 落到=v3-dy-o.zjcdn.com
play <video> t=5.2 1920x1080 readyState=4 error=无
ttwid 回调 status=200
iframe 可以访问！location=https://www.douyin.com/robots.txt body=User-agent: Googlebot …
iframe SDK 装载方式=tag,tag,tag _SdkGlueInit=function
iframe bdms=object
iframe 推荐流 第1次 status=200 len=246898 items=2 … | 加上的参数=a_bogus,verifyFp,fp
iframe 推荐流 第2次 status=200 len=188913 items=2 … | 加上的参数=a_bogus,uifid,verifyFp,fp
端到端 推荐流第一条 <video> t=5.4 1758x1080 readyState=4 error=无
```

- **Tizen 的 widget 不受同源策略约束去访问跨域 iframe。** 主 realm 直接读
  `iframe.contentWindow.location` / `document`，往框里的文档塞 `<script>` 也照样执行。
  框里的脚本就是「在 www.douyin.com 上的页面」：Referer、`location`、`document.cookie`
  全是 douyin.com 的 —— 正好是桌面上唯一拿到推荐流的那个条件。
- **框里装的是 `robots.txt`**：纯文本、没有脚本、不会跳转，是 douyin.com 上最轻的一份
  文档。官网 SDK（secsdk、webmssdk、sdk-glue → bdms）以 `<script>` 注入，挂钩的是框
  自己的 `XMLHttpRequest`，所以 API 调用都用 `frame.contentWindow.XMLHttpRequest`
  以相对路径发。
- **匿名 `ttwid` 在 widget 主 realm 里拿**（主 realm 不受 CORS 约束；框是真正的
  https 远程页面，受不受不确定，没测），两步：`ttwid.bytedance.com` 注册 →
  `withCredentials` 请求 douyin.com 上的回调。cookie 进引擎的全局 jar，框里的请求带得上。
  这一步是不是必要的**没有单独测**。
- **Referer 伪造不了，和预测一致**：`setRequestHeader('Referer')` 和 fetch 的 `referrer`
  选项都被静默丢弃（不抛异常），自定义头（`X-Probe`）照发。widget 的请求**不带
  Referer 也不带 Origin**。
- **widget 主 realm 的 CSP 是 `script-src 'self'`**：「直连」对照组注入远程 SDK 失败、
  退回 eval 也被拒，这一组因此没跑成 —— 不影响结论，iframe 这条路已经通了。
  **⟶ 2026-09-30 查清：开关就是 `<tizen:allow-navigation>`。** `config.xml` 里出现它（或任何
  `<tizen:content-security-policy*>`）应用就进「CSP 模式」，没写 CSP 时套默认策略；三样都没有是「WARP 模式」，
  没有 CSP —— bilibili 就是这样，所以它的远程脚本、`new Function`、`blob:` 脚本都能用。官方
  Web Runtime 文档里写着。设备实测（同一个探测 widget 只改一个变量，4 个变体）：有 `allow-navigation` 的两个
  全拦（含 `data:` 图片和 HTML 内联 `style` 属性），没有的两个全放，权限多少无关。
- 推荐流请求 `count=10`，每次只回 2 条，桌面上也一样。

## 客户端（app/，2026-09-29 起）

顶部五个标签：直播 · 精选 · 关注 · 推荐 · 我（直播在精选左边，用户 10-22 要求），默认进推荐。直播、关注、推荐上下刷，各记各的位置，切回来接着看；精选是 16:9 三列
网格、挑着看（2026-10-22 用户要求，见「精选、直播」）。
视频上的信息照手机摆（用户要求，2026-10-22；之前是右下角居右）：左下 @作者、简介、合集那一条，右边一列头像 · 赞 · 评论 ·
收藏 · 分享（分享只显示数字）。两块是两层（`#info`、`#rail`），不包整屏容器，一起出来、一起淡出；竖屏视频时贴屏幕边、落在黑边上，
和官网大屏一样。数字那行的行高写死 —— 「64.7万」和「1599」字体行高不同，不写的话换一条整列跳 20px（桌面测试台看出来的）。
电视上 `--author` 7 步全过、`--me` 评论那几步全过（10-22）。
**标签栏只在切标签和暂停时出来**，上下刷的时候不出来（用户要求：刷的时候顶部冒出导航是打扰）；
作者、标题那层每次换视频都出来，5 秒后淡出。自测里「下一条」「暂停」两步各盯着这件事。

```
app/
  js/config.js   REPORT_TO、SELFTEST、UPDATE_MANIFEST、DIAG_TO（deploy.sh 打包前写入、打包后或中途退出都改回去）
  js/boot.js     这次跑哪份代码：安装包的，还是自动更新下载、验过签名的新版本；信任根（公钥），永远不随更新下发。
                 index.html 只剩 config.js、boot.js 两个标签，**新加脚本加进 boot.js 的 SCRIPTS**（lint 从那里读顺序）
  js/update.js   查新版本、下载、验签名、存进 localStorage；本身随更新下发。见「自动更新」
  js/diag.js     诊断日志：每一行去掉身份记进一圈，出事或手动时传给开发者；接收地址在这里（config.js 不随更新下发）。见「诊断日志」
  js/log.js      上报到 tools/collect.mjs（:8098），令牌桶限速，连败五次睡五分钟；每一行也交给 diag.js
  js/bridge.js   隐藏 iframe（douyin.com/robots.txt）+ 官网签名 SDK；所有接口经它发（GET/POST）
  js/feed.js     视频流工厂：推荐 / 精选 / 关注各一个实例，前方不足 4 条就补；过滤图文/直播/广告
  js/account.js  登录态（history/read 的 status_code）；自己的资料（profile/self）；退出登录
  js/login.js    扫码登录：隐藏框开官网 login_page，把二维码搬到电视上
  js/grid.js     网格页：作者主页、「我」（观看历史 · 喜欢 · 收藏）、合集选集共用 —— 头部 + 作品网格（4 列 398×531，3:4），焦点、滚动、往下翻取下一页
  js/comments.js 评论侧栏（只读）：评论、展开回复
  js/act.js      点赞、收藏的写请求 —— 没有 ticket guard 头时不发（不带头发过一次，服务器作废了登录，见「「我」页、合集、评论、点赞」）
  js/player.js   一个 <video>，三种放法：默认 MSE（js/mse.js），放不了的那一条换 src，直播间走 mpegts.js（FLV）；心跳看门狗 12 秒无进展算放不了
  js/mse.js      MSE 常驻管线：每条视频一个时间槽，预热 = 取开头、转 fMP4、append 进槽，切换 = seek
  js/vendor/mp4box.js  渐进式 MP4 → fMP4（0.5.4，包了一层函数，见下文）
  js/vendor/mpegts.js  直播的 FLV（H.265）→ fMP4 → MSE（1.8.2，包了一层函数，第一次进直播间才执行，见「精选、直播」）
  js/app.js      按键与界面
  js/selftest.js 自测（SELFTEST 非 false 才跑）；js/msespike.js 是 --mse 那个探测
```

遥控器：下键 / 频道减 → 下一条，上键 / 频道加 → 上一条，确认 / 播放暂停 → 暂停，
**左右键 → 不管暂不暂停都是 ∓10 秒**（和快进 / 快退键一样；直播不能跳），返回键按两次退出。播完自动下一条。
**切标签：暂停后上键 → 焦点到顶上的标签栏**（当前标签变红底块），左右键切、下键 / 确认键 / 返回键回来；精选、「我」的网格最上面一行再往上
也到标签栏；精选网格左右两边按到头照旧切到隔壁标签。（2026-10-22 用户要求，原来是播着的时候左右键切标签、暂停时才是快进快退。）
播着的时候快进快退，进度条和时间亮 3 秒。
**暂停时下键 → 选中右边那一列的头像**（不再是下一条；频道减键照旧是下一条），上下键按 头像 · 评论 · 合集（左下那一条）的顺序走，
左右键在右边那一列和合集之间跳，确认键做，返回键 / 在头像上按上键取消；选中的图标左边冒出「确认键……」。
头像 → 作者主页，合集 → 选集，评论 → 右边的评论侧栏。「我」顶上一排：观看历史 · 喜欢 · 收藏 · 诊断日志：开 · 上传诊断日志 · 退出登录（退出要按两次确认）；没登录时「我」是二维码，诊断日志那两项在它最底下，下键选中。
网格页（作者主页、「我」、选集）叠成一摞，返回键一层层退。见下面「作者主页」和「「我」页、合集、评论、点赞」。

```bash
node tools/collect.mjs | tee <日志文件>   # 终端 1
zsh tools/deploy.sh                      # 终端 2；--spike 装可行性探测那个
zsh tools/deploy.sh --selftest           # 自己派发按键把「刷」走一遍，逐步上报 PASS/FAIL（32 步，约 5 分钟）
zsh tools/deploy.sh --livemse            # 直播：mpegts.js 放 FLV，每个直播间开始到动起来、之后 15 秒卡不卡（约 3 分钟）
zsh tools/deploy.sh --splice             # 切换能不能不 seek：WebCodecs 软解第一帧、剪接、对照 seek（探测，见「上下滑还能多快」）
zsh tools/deploy.sh --abseek             # 切换时 seek 在动画第 200 / 130ms 发，逐条轮换连刷 30 条，顺带看软解第一帧用上几次（约 4 分钟）
zsh tools/deploy.sh --author             # 只走作者主页那 7 步，1 分钟
zsh tools/deploy.sh --grid               # 作者主页网格上下翻，同一轮轮换三种做法比掉帧，2 分钟
zsh tools/deploy.sh --soak               # 连刷 20 分钟 + 登录页挂 6 分钟，看风控和二维码轮换
zsh tools/deploy.sh --me                 # 「我」三排、合集选集、评论侧栏；要已登录，只读，30 秒
zsh tools/deploy.sh --mix                # 推荐里找一条带合集的，把选集走一遍，只读，1–3 分钟
zsh tools/deploy.sh --probe              # 登录态下把「我」、合集、评论的接口各问一次，只报形状，只读，20 秒
zsh tools/deploy.sh --like               # 点赞、收藏各一来一回 —— 真的写到账号上，只在用户同意时跑
node tools/update-verify.mjs             # 自动更新离线验证（deploy、release 都卡着它）
node tools/update-e2e.mjs                # 自动更新在桌面 Chrome 里带着 config.xml 的 CSP 走一遍（不碰抖音）
zsh tools/deploy.sh --diag               # 诊断日志：「我」里手动传、关掉再开、造一次出事自动传（6 步，1 分钟）；先开 node ../bilibili-tizen/tools/diag-local.mjs
node tools/diag-verify.mjs               # 诊断日志离线验证：去隐私、什么时候传、源码里没包起来的作者名和文案（deploy、release 都卡着它）
node ../bilibili-tizen/tools/diag-logs.mjs --app douyin-tizen   # 读别人电视传上来的（--device 编号 / <id>）
```

收集器断过（哪怕几秒）要重装一次：`log.js` 连撞五次就睡五分钟，正在跑的自测一个字都报不上来。

**自测构建不能留在电视上**：它每次打开都自己换视频、暂停、快进。`deploy.sh` 打完包就把
源码里的 `SELFTEST` 改回 `false`，跑完记得 `zsh tools/deploy.sh` 装回正常构建。自测的判据
全部来自播放头（`currentTime` 在不在走），不看界面 —— 第一版的卡死就是界面一切正常、
播放头停在 2 秒。「卡住」只算「同一条、已出画面、没暂停、播放头不动」，短视频播完自动
换下一条不算（第一版自测把 6 秒长的视频播完读成了失败）。

**上设备要读的几行**：`bridge: 就绪 Nms`（框 + SDK 装好用了多久）、
`feed: 第N次 …ms 回 k 条，新增 …，跳过 …`、
`到画面 Nms（元数据 … 首帧数据 … 可播 …）预热=好了（…）/在途/无`。**动切换路径之前先读它。**

**这台电视只有一个硬件解码器 —— 不要用第二个 `<video>` 预载（2026-09-29 设备实测）。**
第一版是两个元素轮换，备用元素在开播 1.5 秒后 `load()` 下一条。结果每一条都在开播
2–3 秒后冻住：

```
卡住: 12 秒没进展 t=3.4 readyState=1 前方缓冲=21.8s networkState=1
到画面: 54ms 预载=命中（切换时 readyState=4）
卡住: 12 秒没进展 t=2.4 readyState=1 前方缓冲=31.7s networkState=1
```

读法：前方缓冲几十秒说明字节都在，`readyState=1` 说明解码没在出帧；备用元素却解到了
`readyState=4` —— 解码器被它拿走了。冻住的时刻正好落在预载启动之后。切换时 13–54ms 的
「到画面」好看，是拿当前这条的死换的。现在只用一个元素，预热不创建媒体元素。

**切换时画面上不许有 CSS 滤镜（2026-09-29 设备实测）。** 切换到出画面一开始是 3.5–4.4 秒，
其中大头不是网络（预热 512KB 只要 300–500ms），是两层 `filter: blur(40px)`：底层背景和
切换时盖上的封面，每换一次图，这块 GPU 就要重新光栅化一张 2000 像素的模糊图，和解码器抢
时间。在**同一轮自测里轮换做法**（排除网络波动，每种 5–6 个样本）量出来的中位数：

| 做法 | 按下到出画面 |
|---|---|
| 背景 blur + 封面 blur | 3673ms |
| 背景 blur，封面不模糊 | 2584ms |
| 背景 blur，不盖封面 | 2464ms |
| 背景 blur（封面不模糊，下同） | 2575ms |
| **背景用 48×27 小画布拉伸** | **1256ms** |
| 没有背景 | 1233ms |

小画布：封面画进一张 48×27 的 canvas，CSS 拉伸到全屏，缩小本身就是模糊，压暗用 opacity。
效果和滤镜差不多，代价和没有背景一样。清理后的版本 17 次切换中位 1.5 秒，剩下的主要是
元数据 ~0.5 秒 + 解码器出首帧。**跨两轮比较会被网络骗**：第一次注意到变慢是隔了几分钟的
两轮对比，同轮轮换才分得开。

**bdms 有三台镜像，必须全给（2026-09-29）。** 只抄了第一台（`p-pc-weboff.byteimg.com`）的
那一版，17:45 撞上它整台超时（开发机上同样超时），glue 重试两次就放弃，App 起不来 —— 而
半小时前同一个地址两次正常。现在 glue 拿到全部三台（`lf-c-flwb.bytetos.com` 排第一：glue 和
webmssdk 就从它加载，走到这一步它就是活的），glue 20 秒还没装上时我们自己按顺序逐台试，
并在日志里报框里 bdms 相关的资源记录（`bridge: glue 20 秒没装上 bdms，资源记录[…]`）。

**冷启动：8–9 秒 → 2.7 秒（2026-09-29）。** `boot:` 那行从页面加载算起报第一帧、签名桥、
登录态各在第几毫秒，**动启动路径前先读它**。三步：

| 改动 | 第一帧 |
|---|---|
| 原样：等签名桥（串行装三个 SDK）→ 等第一批推荐 → 起播 | 6.9 秒（桥 2.3，推荐 ~2，起播 ~2.5） |
| 三个 SDK 改 `async=false` 并行下载、按序执行 | 桥 2.2 → 2.0 秒，SDK 段 0.6–0.8 秒 |
| 推荐 / 精选把「已取到、还没看」的条目存 localStorage（12 小时），启动先放缓存 | 3.7 秒 —— 但那一条光元数据 2.3 秒 |
| 有缓存时等第一帧出来再起签名桥（最多等 4 秒） | **2.7 秒** |

播放地址不签名，所以缓存里的条目不需要桥就能放。**localStorage 能活过重新安装**（同一个
应用 id，设备实测）。第三行那个「元数据 2.3 秒」是缓存条目和签名桥同时起步、抢这台电视
本来就不快的链路 —— 桥不急（缓存里还有好几条），就让它等。关注流不缓存（跟登录的人有关），
登录 / 退出时 `Feed.clearCache()` 全清。

**长时间连刷不会被拦（2026-09-29，`zsh tools/deploy.sh --soak`）。** 匿名，每 10 秒一条连刷
20 分钟：103 条、0 次失败、出画面中位 1.5 秒；没有一次 `blocked`、桥重建或推荐流失败。
之后登录页挂 6 分钟：**二维码每 66 秒自动换一张**（官网登录页自己换，我们跟着搬；login.js
里「点刷新」的后备一次没用上），结束时二维码仍可见。

## 三种视频流（2026-09-29 从官网抓、在官网页面里用它自己的签名问过）

| 标签 | 接口 | 翻页 | 备注 |
|---|---|---|---|
| 推荐 | `GET /aweme/v1/web/tab/feed/` | `refresh_index` 递增 | count 写 10，实际 2–6 条 |
| 精选 | `POST /aweme/v2/web/module/feed/` | `refresh_index` | `module_id=3003101`，正文空也行，每页 20 条，横屏长片居多 |
| 关注 | `GET /aweme/v1/web/follow/feed/` | `cursor`（应答里给） | 条目在 `data[].aweme` |

**匿名时关注流也有内容**：电视未登录时 `status_code=0`、11 条。所以「关注」要不要出二维码
看的是登录态，不是看关注流空不空。

## 登录（2026-09-29）

**登录接口自己调不动。** `login.douyin.com/passport/web/get_qrcode` 除了 `a_bogus` 还要登录 SDK
自己算的 `sign` / `qs` / `p_*` 和一段服务器下发的 `challenge` 脚本（77KB），不带就回
`4031`「您正在尝试访问的网站存在安全风险……已阻止此次访问」。`sso.douyin.com/get_qrcode`
回 JS 反爬页。这套 SDK 打包在官网主程序里，不是单独的脚本。

**哪些官网页面能被嵌入**（模拟电视实测，看 `DOCHDR` 和 `ERR_BLOCKED_BY_RESPONSE`）：

| 页面 | 能嵌入 | 原因 |
|---|---|---|
| 主站 SPA（`/`、`/jingxuan` …） | 否 | `X-Frame-Options: DENY` + `frame-ancestors` 只放行字节内部域名；第一次是 `__ac` 挑战页（能加载），挑战通过后重载真页面被拦 |
| `sso.douyin.com/login/` | 能加载但没用 | 已弃用：代码无条件跳回主站（`douyin-web-login.*.js`） |
| **`www.douyin.com/login_page?service=…`** | **能** | 没有 XFO；框里官网代码自己调 `get_qrcode` 成功，二维码是 `img[src^="data:image/png"]`（512px） |
| `robots.txt` | 能 | 签名桥用的就是它 |

所以 `login.js` 在一个**屏幕内、完全透明**的框里开 `login_page`（挪到屏幕外的跨域框会被
Chromium 节流），`service` 指向 `robots.txt` —— 确认后官网跳到 service，主站页会被拦而
robots.txt 不会；框落到 robots.txt 就算登录完成。二维码图片搬到我们的界面上放大，状态只读
二维码往上四层的容器（整页正文里本来就有「验证码登录」，拿它匹配「验证」会误报）。框带
`sandbox`（不给 `allow-top-navigation`），挡住官网把整个 App 跳走。设备实测：出码 5–12 秒。

**登录判据换了四次，前三次各错在一侧 —— 每次都只测了一侧就下了结论。**

| 判据 | 匿名 | 登录后 | 结果 |
|---|---|---|---|
| `query/user` 的 `user_uid` 非空 | 电视回 19 位 | 桌面回 16 位 | ✗ 匿名也有（访客 ID） |
| 关注流 `status_code=0` | 电视回 0，还有 11 条 | 0 | ✗ 匿名也是 0 |
| 框里有 `login_time` cookie | 电视没有 | **电视扫码后也没有**（桌面有） | ✗ 登录后没有 |
| **`history/read` 的 `status_code`** | **8**（全新匿名浏览器；`notice/count` 同时回 8「用户未登录」） | **0**（电视扫码后；`notice/count` 也是 0） | ✓ 两侧都实测过 |

`login_time` 那次最贵：用户扫码确认、官网面板显示「正在登录...」、框跳到 robots.txt、cookie 从
13 个变 21 个 —— 登录明明成功了，我们判成「未登录」又换了一张码，用户看到的是「扫了没反应」。
登录后新增的 cookie 是 `passport_assist_user`、`_bd_ticket_crypt_cookie`、`bd_ticket_guard_*`、
`is_dbsc` 等；**同一个网站两台设备的 cookie 集合不一样，别再拿 cookie 名字当登录判据。**
`account:` 那行现在同时报 history/read、notice/count 和 cookie 名字，**这一行别删**。

> **别在用户自己登录着的浏览器里密集调接口做实验。** 2026-09-29 晚上在用户的 Chrome 里
> 连着问了十几个接口（部分不带官网会带的签名头），那个会话被推进了滑块验证码，之后
> history/read 等接口在那里一律回「用户未登录」—— 既打扰了用户，又污染了测量。对照实验
> 放在 `spike/desktop-harness` 的全新匿名环境（`HOSTED=douyin`）或电视上做。

昵称没拿到：`user/profile/self` 在登录态桌面上也回 `status_code=8`，passport 的 `account/info`
回 error —— 都要额外的签名头，暂不追。「我」页只写「已登录」。

退出登录：框里请求 `/passport/web/logout/`，再 `tizen.websetting.removeAllCookies`（要
`websetting` 权限，已加），再重建签名桥。**没在设备上测过。**

**widget 的默认 CSP 不许 `data:` 图片（2026-09-29 设备实测）。** 登录页的二维码是
`data:image/png`，在官网框里好好的，搬到我们界面上是个破图标 —— 而自测判「出二维码」PASS，
因为它只看了 src 和可见性。`securitypolicyviolation` 报出的默认策略原文：
`default-src *; script-src 'self'; style-src 'self'; object-src 'none';` —— 图片落在
`default-src *`，而 `*` 不含 `data:`。`config.xml` 里用 `<tizen:content-security-policy>` 照抄
默认、只给 `img-src` 加 `data:`，设备上生效（二维码 512×512 解码成功）。
- `log.js` 现在把每一次 CSP 拦截都报成 `csp:` 一行 —— 这类拦截不抛异常，只有这一行说得出来。
- 自测判二维码要 `naturalWidth > 0`。**判据要落在观众看得见的结果上，不是落在代码做了什么上。**
- `zsh tools/deploy.sh --qr`：启动后直接去「我」、只测二维码，30 秒出结果。

**切换时「闪一下、跳一下」（2026-09-29 用户反馈，同晚修掉）。** 三个来源，「封面」那行日志
（`图 Nms 到，比例 封面 / 接口给的视频 / 实际解码`）量出了其中两个：
- **封面几乎全是 4:3**（20 次切换里 19 次比例 1.33），视频却是 16:9 或 9:16。旧版封面层按封面
  自己的比例 contain 摆放，于是每次都是先一张 1440×1080 的封面、视频出来再跳成全屏或窄竖条。
  现在封面按**接口给的视频宽高**算出视频将占的区域、cover 裁切进去 —— 接口宽高和实际解码
  宽高 20 次全对得上，可以提前信它。
- **封面图一半要 170–420ms 才到**，旧版封面层是黑底，这段就是一块黑屏。现在透明底、图到了才显示。
- 背景画布每次先 `fillRect` 黑再等新图 —— 现在不刷黑，新图到了直接覆盖。
视频元素在切换期间 `visibility: hidden`，出画面再亮，不露上一条残留的最后一帧。出画面速度没受影响
（连刷十条中位 1.4 秒）。**竖屏视频的封面是把 4:3 图的中间裁成竖条**，出画面前那一秒看着偏窄，
`origin_cover` / `dynamic_cover` 的比例还没查过，也许有更合适的那张。

**「先出一张图，抖一下才开始播」（同晚第二轮）。** 两处：
- **封面换成 `origin_cover`**：按比例挑和视频最接近的那张 —— `cover` 常是 720×720 或 4:3，
  `origin_cover` 在 21 次切换里每一次都和视频同比例（1.78 / 0.56 / 1.33 各自对上），接近首帧。
  缓存里的旧条目没有它，放完就换过来。
- **撤封面等播放头真的走起来**：`playing` 之后播放头要再过 105–430ms（中位 ~180ms）才前进
  0.1 秒 —— 这一两百毫秒画面是卡着的，旧版在 `playing` 就撤封面，正好把这段卡顿露出来。
  现在在 `timeupdate` 里等 `currentTime` 比 playing 时多 0.1 秒再撤（兜底 0.8 秒），「封面」
  那行报「比 playing 晚 Nms」。
- **`requestVideoFrameCallback` 在这台电视上从不回调**（21 次全是 1 秒兜底）：视频走硬件视频层，
  不经过网页的合成器。别再拿它判断首帧。
- 挡上一条残帧不再靠把 `<video>` 设 `visibility:hidden` 再亮起来（那一藏一亮本身可疑），改为
  切换期间把背景画布提到视频上面（`#bgc.over`）。

**竖屏两侧纯黑、进度条只在暂停时出来（2026-09-29 用户要求）。** 封面拉伸出来的模糊彩色背景
「抢注意力」，去掉了；切换时挡上一条残帧的那层换成纯黑的 `#mask`。

**「像抖音 App 那样缓存接下来几条」—— 能做的部分做了，做不到的部分量过了。** 手机上丝滑靠的是
后台已经解码好的下一条（多个解码器）；这台电视只有一个，第二个媒体元素会冻住正在放的那条
（见上面）。能做的是把字节提前拿到。同一轮自测里轮换两种预热比较（按下到出画面）：

| 预热 | 次数 | 中位 | 其中元数据 |
|---|---|---|---|
| 无 | 6 | 1623ms | 834ms |
| 开头 512KB（XHR range，焐热 CDN + 拿到最终地址） | 8 | **1234ms** | 659ms |
| 整段下进内存、放 `blob:` 地址 | 2 | 1082ms | 472ms |
| 整段，但超过 30MB 放弃 | 6 | 1508ms | 779ms |

整段只再快一两百毫秒，而且推荐里的视频多是 32–216MB，多数用不上 —— **剩下的 ~1 秒是解码器
冷启动出首帧，字节提前到得再早也省不掉。** 默认用「开头 512KB」，改成预热**接下来两条**（第二条
晚 2 秒发），连着快速下划时第二条也是热的。`blob` 模式的代码留着（`PRELOAD_MODE`），CSP 为它加了
`media-src * blob:` —— `*` 不含 `blob:`，和 `data:` 图片是同一个坑。

**又一次按锚点删块带走了函数（同晚）。** 删旧背景画布时「从那段注释开头删到 show()」，而上一轮
留下的旧注释在 `render()`/`fitBox()` 上面 —— 两个函数一起没了。`node --check` 全过，电视上第一条
视频永远不出画面、没有任何报错：异常在推荐流的 Promise 回调里抛出，`window.onerror` 接不到。
两处补上：`tools/lint.mjs`（抄自 bilibili，抓「调用了不存在的东西」，`deploy.sh` 卡发布）；
`log.js` 监听 `unhandledrejection`。**自测启动失败时会把播放器状态整个报上来**，这次就是靠
`"id":"","sinceSwitch":巨大` 一眼看出「播放器根本没被调用」。

> 统计日志时别用 BSD grep 的 `[^（ ]*` 这类带中文的字符类 —— 它把所有行都算成了「预热=无」，
> 差点又当成一个 bug 去修。用 python 的 re。

**上滑动画（2026-09-29 用户要求）。** 下键 / 播完自动下一条：新封面从底部滑上来；上键：从顶部滑下来；
切标签和启动不动。0.25 秒，只用 `transform`（合成层上做），`app.js` 的 `slideIn()`。它不让视频更快
出来，是把解码器冷启动那一秒藏在动画里。旧画面不跟着滑走 —— 那得把新视频的加载推迟 0.25 秒。
加上之后出画面没变慢：预热过的中位 1263ms（加之前 1234ms），22 次切换全部中位 1316ms。

**「往上推」的动画，三条路（2026-09-29 同晚）。** 用户要的是旧画面往上走、新画面从下面跟上来。

| 做法 | 结果 |
|---|---|
| 只让新封面滑进来，旧画面先被黑幕盖掉 | 用户看到「整个屏幕闪一下、黑一下」 |
| 按键时 `drawImage` 旧视频当前帧到画布，让截图滑走 | **截到的全是黑的**：13 次可读的截图中心亮度全 0 —— 视频走硬件视频层，画布拿不到帧。读像素本身还要 CORS：跳转接口那一跳 302 不带 ACAO（CDN 那一跳带 `*`），而且画布画过一次跨域内容就永久不可读，量亮度得每次新建小画布 |
| **`PUSH_MODE="video"`：`<video>` 自己 transform 滑走，250ms 后再换源** | 真的推；但移动过视频元素之后起播慢 0.3–0.4 秒（从换源算 1566–1654ms，平时 1160–1260），`will-change` 去掉也一样。按键到出画面 **2.2 秒** |
| `PUSH_MODE="cover"`：旧视频原地继续播，新封面从下面盖上来，250ms 后换源 | 不是推，是「盖上来」；起播不受影响（从换源算 1208ms），按键到出画面 **1.6 秒** |

不加动画是 1.4 秒。先装了 `video` 给用户看，用户看过之后的判断是「太慢了」，**默认改为 `cover`**。
`video` 模式的代码留着；硬件视频层跟着 transform 移动顺不顺，没有得到答案。

## 切换慢在哪、MSE 常驻管线（2026-09-30 设备实测）

**换 `src` 这条路已经贴着底了。** 09-29 晚 cover 模式、预热过的 34 次切换（中位）：按键 → 换源 250ms（动画）
→ 元数据 528ms（359–1063，网络 + 建播放器）→ 首帧数据 +670ms（568–758，很稳，解码器冷启动）→ playing 后
播放头再走 185ms。按键到画面动起来 ~1.6 秒，观众看到的是 ~1.4 秒不动的封面。整段放 `blob:`（一个字节不走
网络）也要 1082ms（2 个样本）—— 预热再多字节最多再省一两百毫秒。长视频的 moov 很大（26 分钟那条 1.27MB，
开头 512KB 的预热连元数据都盖不住），日志里 15 分钟以上的视频元数据中位 715ms、30 秒以下 538ms。

**MSE 常驻管线：切换 = 一次 seek，226ms（`zsh tools/deploy.sh --mse`，`js/msespike.js`）。** 整个会话一个
`<video>` + 一个 MediaSource，第 k 条 append 进从 k×1000 秒开始的时间槽（mp4box.js 把渐进式 MP4 的开头
—— moov + 之后 3MB —— 转成 fMP4 分段），切换只做 `currentTime = 槽起点`。同一轮、同一个元素上：

| | 中位 | 样本 |
|---|---|---|
| 换 `src`（app 现在的做法，CDN 最终地址、边缘是热的） | 1180ms | 8 次，1081–1488 |
| MSE 冷启动（第一条：建 MediaSource + append + 首帧） | 773ms / 1432ms | 两轮各 1 次；第二轮 append 用了 1190ms，正撞上签名桥起步 |
| **seek 到预先 append 好的槽** | **226ms / 251ms** | 两轮 14 + 12 次，184–274，**没有一次失败、丢帧 0** |
| 其中横↔竖 / 同方向 / 同一条回开头 | 238 / 211 / 226ms | 第一轮 |
| 播放中往别的槽 append 3 条 | 每条 50–142ms，**播放头最长停顿 0ms** | 两轮 |

（「动起来」= 播放头比起点多走 0.1 秒，和 app 撤封面同一个判据，所以其中 ~100ms 是正常播放。）
- 往 SourceBuffer 里 append 的字节不碰解码器 —— 和「第二个 `<video>` 预载把正在放的冻住」不是一回事。
- 横竖屏、不同分辨率（1920x1080 / 1440x1080 / 1080x1920）、不同 H.264 level（`avc1.640028` / `640032`）混在
  一个 SourceBuffer 里都能放，seek 不因此变慢。
- **`videoWidth/Height` 永远停在第 0 条的尺寸，一次 `resize` 事件都没有**（两轮 26 次全是）。元素按它 contain 摆放，
  换了比例的视频画面比例会不对。修正（用户 09-30 看过，横竖交替刷比例是对的）：每次 seek 前把元素的框直接摆成这一条该占的区域（`fitBox`）、
  `object-fit: fill` —— 同一轮交替量过，修正 251ms / 不修正 249ms，改框不拖慢 seek。
- 音频全是 HE-AAC v2（`mp4a.40.29`，44.1kHz），`isTypeSupported` 为 true、append 不报错、`buffered` 里音视频交集
  正常。**有声音**（用户 09-30 在 MSE 播放器上听过）。
- mp4box.js 在电视上转一条（moov 0.1–0.9MB + 3MB）要 160–800ms，只能放在预热里做。
- **mp4box.js 的 dist 在顶层声明了 `var Log`**，直接 `<script>` 装进来会覆盖我们的 `Log`。`js/vendor/mp4box.js`
  外面包了一层函数，只往全局放 `MP4Box`。

**换 `src` 这条路上的两个小改动（2026-09-30，`zsh tools/deploy.sh --ab`：同一轮连刷 50 条、两种做法轮换）。**

| 改动 | 结果 | 处理 |
|---|---|---|
| **按键就换源**（`PUSH_MODE="early"`：旧视频停在最后一帧，一整屏黑底 + 封面滑上来，动画和起播重叠） | 按键→撤封面 early **1429** / cover 1750ms，换源→playing 1246 / 1261（动画没拖慢起播）；另一轮 1522 / 1539 | **默认改为 early** |
| 预热补取到 moov 末尾 + 512KB（`MOOV_TOPUP`） | 元数据中位 补取 627 / 不补 613ms，按 moov 大小、切换方式分开看方向来回翻 | 噪声，**默认关**，代码留着 |

- 第一轮 `--ab` 两个实验锁在了一起：moov 分组按预热次数轮换，而每次切换正好发一次新预热 —— cover 全是补取、
  early 全是不补，读出来的「补取让元数据快 180ms」是假的。现在按视频 id 奇偶分组。**同一轮里轮换两个实验时，
  先确认两个分组变量互相独立。**
- early 模式下旧视频停住的那 250ms 画面上是什么（最后一帧还是黑），日志看不出来，要人眼确认。

## MSE 做成播放器（2026-09-30 起默认，`js/mse.js`）

`player.js` 默认走 MSE：整个会话一个 MediaSource，第 k 条视频放进从 k×20000 秒开始的槽（6 个槽按最近使用
循环复用）。预热 = 取开头（先 1MB 找 moov，再补到 moov 后 1.5MB）、mp4box 转 fMP4、append 进槽；切换 =
seek 到槽起点；正在放的那条边放边续取（保持前方 30 秒）；切走的那条只留开头 8 秒。放不了的那一条（非
avc1/mp4a、缺轨、moov 不在开头、比槽长）换 src；管线一次会话坏 3 次，整场改走 src。换 src 时按键到出画面
1.2–1.6 秒，MSE 下切到预热好的槽 0.2–0.5 秒（自测每 200ms 看一次，数字偏粗）。

**几条的数据交错着 append，回到某一条要把它最后一个 GOP 重放一遍。** 第一版自测「连按三下」挂了：第三条
放到 3.35 秒停住 4.4 秒，前方缓冲 0，队列里还积着 30 段、已经取了 36MB。
- 原因：两条之间时间戳一跳，SourceBuffer 按规范当成不连续，丢帧丢到下一个关键帧为止。mp4box 0.5.4
  **没实现 `rapAlignement`**（参数收了不用），每 30 个样本切一段，多半从 GOP 中间开始。预热分两次取，两次之间
  插进了别的条目的数据，第二次开头那几秒的帧全丢了 —— 槽里留下一个缺口，正好在第一块的末尾。探测
  （msespike）里每条是一次整批塞进去的，从没交错过，所以没暴露。
- 修法（`pump` 里的 replay）：换到另一条的数据时，要是这一段不从关键帧开始，先重放这条最后一个 GOP 里已经
  append 过的段。重放开头的帧照样被丢到关键帧为止，但那些本来就在缓冲里；从关键帧起的帧和已有的重叠、
  替换成一样的。修好后一轮 17 步里重放 1 次 0.7MB，各槽缓冲都是连续的一段。
- 切走的那条马上停续取、作废队列里还没 append 的段（`gen`），少交错一次。
- 保险：播放头停在一段缓冲的末尾、同一个槽 10 秒内还有下一段，就跳过去并报「跳过缺口」。修好之后没触发过
  —— **真出现了说明还有别的缺口来源，别当正常。**
- 「备好」和停顿那几行都报「槽里」的缓冲段（相对这条的时间），缺口一眼看得出来。

**跳转对齐到关键帧：中位 966ms → 258ms**（`zsh tools/deploy.sh --seek`，同一轮 ±120 秒跳转，每两次轮换开 / 关，
各 16 次）。不对齐时，用时跟「目标离前一个关键帧多远」一起涨：0.1 秒→258ms，1.3→1098，2.7→1283，6.6→1488 ——
解码器要从关键帧一路解到目标。**抖音的关键帧间隔 6.4–7 秒**。
- 快进 / 快退对齐到最近的关键帧，±10 秒实际落在 ±6.5–13.5 秒。
- 「从中间接着放」（切回标签）**不对齐**：退到前一个关键帧最多退 7 秒，5.2 秒处离开的回来成了从头放（自测
  抓到的）。位置要对，多花 ~1 秒解码。
- 去「我」、登录页、空页时 `Player.stop()` 只暂停、不拆管线（那几页是不透明的整屏面板，盖得住停着的画面）；
  回到同一条、位置对得上就不 seek，直接接着放。拆管线的那一版，从「我」回来要 ~2.5 秒（冷启动 + 从中间 seek），
  现在 201ms；同一轮自测里进「关注」4.1 → 2.9 秒、进「精选」1.8–2.2 → 0.9 秒（各一个样本）。18 步全过。

**排除掉的：「seek 进行中不停地 append 拖慢了 seek」。** 冷启动从中间接着放时，目标后面 0.5 秒内就有 22 秒缓冲，
seek 却又拖了 2 秒，那段时间 append 了 77 段 —— 看着像。做了节流（seek 没完成时只续取 3 秒），同一轮轮换 12 对 12：
中位 1183 / 1223ms，没区别，删了。再给每次 append 计时：慢的那几次跳转，目标早就在缓冲里、期间一次 append 都
没有，照样 1.2–1.5 秒。**先弄清慢的那段时间里到底在发生什么，再动手改** —— 这次就是后一个实验才对上真正的变量。

**MSE 下的切换动画（2026-09-30，用户看了 early：「按下键的那一瞬间，又有最后一帧又黑屏，然后新视频立马上推覆盖」）。**
`zsh tools/deploy.sh --ab`，同一轮逐条轮换，各 15 次，按键→画面动起来（撤封面）中位：

| 做法 | 按键→动起来 | 屏幕上 |
|---|---|---|
| early：按键就 seek，整页（黑底 + 封面）滑上来 | 486 → 336ms | seek 一开始硬件视频层就冻在最后一帧、再黑，整页还没盖满 —— 用户说的就是这个 |
| video：`<video>` 自己往上滑走，新的一页贴着推上来，推完才 seek | **1661ms** | **移动过 `<video>` 之后 seek 慢 ~1.1 秒、起播后还卡 ~1 秒**（换 src 时代慢 0.3–0.4 秒，MSE 下更重）。**别动 `<video>` 的位置** |
| **cover（默认）**：旧视频原地接着播，整页盖上来，盖到 ~99%（200ms）才 seek | 805 → **506ms** | 没有冻结、没有黑屏 |

箭头后面是同一天的两处改动，两种做法都受益：
- **撤封面改成每 20ms 看一次播放头、走过 0.04 秒就撤**：只靠 `timeupdate` 的话它 ~250ms 才来一次，「比 playing 晚」
  ~250ms → 40–60ms。
- **cover 模式不再把黑幕提到视频上面**（整页黑底已经盖满）：seek→playing ~309 → ~224ms，和 early 一样了。**这是跨两轮
  的比较**（同一轮对照组 early 两轮都是 ~230ms，比较稳，但那一轮同时改了撤封面的判法），不是同轮对照 ——
  「黑幕盖住视频拖慢 seek」只是推测。
- 封面图在预热时下好、`decode()`、Image 对象留住（`coverPre`），推的时候同步贴上 —— 之前只 `new Image()` 了一下没留住，
  渲染时还要再等 60–230ms，推的前半段是个黑框。现在 30/30 当场就有。

**横竖切换「抖一下」：盖在视频上的层不许完全不透明**（2026-09-30，用户确认修好）。MSE 下每换一条都要把
`<video>` 的框摆成这一条的比例（`videoWidth/Height` 停在第一条）。撤封面提前到 playing 后 ~40ms 之后，用户看到横竖
切换时新视频先按上一条的框画一下：竖屏的拉满全屏、横屏的挤成竖条，再弹回来。
- 先把改框从 `seeked` 提前到 seek 发出的同一刻（撤封面前 250–430ms 就改好了，「封面」那行报「改框→撤封面」）——
  用户看还是抖。
- 再把 `#cover`、`#mask` 设成 `opacity: 0.99` —— 不抖了。解释（没有直接观测过）：硬件视频层的位置尺寸是合成器画
  视频那一层时送给播放器的；被完全不透明的层盖住，合成器按遮挡跳过这一层，新框一直没送，撤封面那一刻才送、
  播放器再异步应用。0.99 不算遮挡，底下透出的 1% 看不出来。
- **以后往视频上面盖东西，都别用完全不透明的层**，不然盖着的时候改的框、位置都不生效。

**用户 09-30 看过、听过**：cover 模式「好多了」；有声音（HE-AAC v2 经 MSE）；横竖屏交替刷比例对
（`videoWidth/Height` 停在第一条，框由 `place()` 按这一条的尺寸摆、`object-fit: fill`）。

## 作者主页（2026-09-30 用户要求，设备自测 25 步全过）

暂停时下键选中右边那一列的头像（套一圈红，左边一句提示），确认 → 作者主页：头像、昵称、关注 / 粉丝 / 获赞 / 作品数、签名，
下面是作品网格（置顶的排最前）。网格里上下左右选、确认从这一条开始放，放着的时候上下键在 TA 的作品里刷，顶上那行
换成「@谁 的作品 · 返回键回到 TA 的主页」，左右键不切标签。返回键一层层退：取消选中 → 回网格（焦点在刚才放的那条，
再点它接着放）→ 回原来的标签、原来那一条接着放（进来时记了续播点，管线只是暂停着，出画面 ~0.2 秒）。
TA 的最后一个作品自己放完就停住（不停的话 MSE 播放头停在槽尾，12 秒后看门狗当卡住）。

| 接口 | 参数 | 匿名 | 登录（电视） |
|---|---|---|---|
| `GET /aweme/v1/web/user/profile/other/` | `sec_user_id` | 0，资料齐全 | 0 |
| `GET /aweme/v1/web/aweme/post/` | `sec_user_id`、`max_cursor`（上一页最后一条发布时间 ×1000） | **只给第一页**（18–21 条） | **能翻页**（35 个作品全拿到；另一位 18 → 54） |

`sec_uid` 在推荐 / 精选 / 关注条目的 `author` 里就有。
- **匿名第二页只回 `{"status_code":0}`**（没有 `aweme_list`、没有 `has_more`）：`need_time_list`、`from_user_page`、
  自己拿最后一条 `create_time` 当游标……五种参数都一样（测试台 `MODE=author`）。界面上底下写「没登录只能看到前 N 个作品」。
- **作品列表要 `uifid`，推荐流和作者资料不查。** 缺了回 403 `Blocked by ArgusSecurityPlugin Uifid Not Found`。SDK 从
  `UIFID_TEMP` 这个 cookie 取，而它是**服务器在推荐流应答里 Set-Cookie 种的**（一年有效、没写 SameSite）。电视上存得下
  （设备上框里看得见它）；桌面测试台顶层是 localhost、框里的请求算跨站，Chrome 按 Lax 不存 —— `app-emu.mjs` 照电视的
  样子手动补进 jar。`bridge.js` 的 HTTP 错误现在带正文开头，这种 403 一眼能看出原因。
- **缓存 key 升到 v2**：旧版存进 localStorage 的条目没有 `secUid`，更新后头几条选不中作者 —— 第一次上设备自测就撞上了
  （启动放的是缓存）。改条目形状时要升 key。
- 网格：4 列 398×531 的 3:4 竖卡片（用户先嫌 6 列小，又要求和抖音官方一样用 3:4）。封面用 `cover.url_list[0]`，它本身就是
  官方裁好的 3:4 小图（`~tplv-dy-cropcenter:323:430.jpeg`，签名地址，改不了尺寸）。一屏只放得下一整行，焦点行钉在 y=120
  （上面露一截上一行、下面露大半行下一行），上下键每次正好滚一行；滚到底不再往上推，最后一行和底下那行字贴着屏幕下沿。

**网格滚动卡顿（2026-09-30 用户反馈，`--grid` 同一轮轮换、电视上各滚 24 次，按键后 450ms 里的 rAF 间隔）：**

| 做法 | 最长帧间隔中位 | 掉帧 | 主线程长任务 |
|---|---|---|---|
| 原样：`#ap-scroll` 做 transform 过渡、焦点卡片 scale 过渡 | **167ms** | 264 | 3872ms |
| `#ap-scroll` 加 `will-change: transform` | 33ms | 37 | 341ms |
| **再加焦点卡片放大不做过渡（默认）** | 33ms | 22 | 0 |

读法：不常驻合成层时，每次滚动都要把整块网格提成一个层、滚完放下、整屏重新光栅化 —— 250ms 的动画里卡住六分之一秒。
卡片 scale 的过渡同理（过渡期间那张卡片被临时提成层）。**这台电视上要动的大块内容，先给它常驻一个层。** 桌面上三种都不掉帧，
量不出来。平时每滚 10 次报一行「作者: 滚动 10 次」。

**一条视频 12 秒没出画面被跳过 —— 怀疑过「老视频走冷存储慢」，`--cold` 实测推翻了（2026-09-30）。** 作者主页的一条 2025 年 1 月
的视频被看门狗跳掉，播放接口把它跳到 `v26-colds.douyinvod.com`。`zsh tools/deploy.sh --cold` 在作者主页里挑了 8 条 408–498 天前的
视频（每条只量一次，取过一次边缘就热了）：全走 `v9/v11/v26-colds`，第一段首字节 0.6–1.5 秒，**出画面中位 1.8 秒、最慢 3.4 秒**。
被跳的那一次更像是当时网络整体慢：同一分钟推荐流一次请求 6.2 秒（平时 1.5–2.8），两分钟前一次启动第一帧 10.7 秒。
仍然改了的（网慢时有用，自测 25 步全过）：
- 看门狗：还没出画面、或前方缓冲不到 2 秒时，**这一条的字节还在来就算有进展**，字节也停了 12 秒才算卡；切过来 60 秒还没出画面放弃。
  解码器卡死（字节都在、前方缓冲几十秒）照旧 12 秒判掉。
- MSE 请求：「整个 20 秒没取完」改为「15 秒没收到新字节」（总上限 120 秒）。
- 切换 2.5 秒还没出画面就转圈（`#loading` 原来没设 z-index，被封面层盖着，看不见）。
- 「卡住」那行附上 MSE 里这一条的状态：第一段请求在途多久、收到多少字节、哪台主机。**下次撞上先读它。**

**桌面上把整个 App 跑起来看界面**（`spike/desktop-harness/app-emu.mjs`，2026-09-30）：`python3 -m http.server 8766 -d app/`，
Playwright 的 Chrome 关掉跨域检查，按 `STEPS` 派发按键、截图；`SELFTEST='"author"'` 可以先在桌面上把自测本身走一遍。
- 页面必须是 `http://localhost`：`file://` 页面在桌面 Chrome 里访问不了跨域框（电视上可以）。
- 注入 `no-referrer`：桌面页面发的请求带 `Referer: http://localhost…`，CDN 见了就 403（302 之后那一跳不经过 `page.route`，改不了头）。
- **只用来看界面和走流程，不能用来判断风控**：用电视的 UA 在桌面上跑，推荐流直接 `blocked`（指纹对不上）；桌面 UA 才放行。

自测的坑：网格里挑的那一条可能**正好就是进来前看的那条**（作者最新的作品），「等换了 id」会超时 —— 判据改成「等挑的
那条出画面」。

## 「我」页、合集、评论、点赞（2026-10-18）

用户要的四样：「我」页列出观看历史 / 喜欢 / 收藏、合集连播、点赞收藏、只读的评论侧栏。前三样和评论做成了，点赞收藏的接口被拒，界面上先关着。

**接口都照官网前端代码问**：在全新匿名浏览器里打开 douyin.com，把加载到的 JS 全存下来，按路径搜调用点、读参数（比在登录态浏览器里抓包
安全 —— 见上面「别在用户自己登录着的浏览器里密集调接口」）。然后在电视上用登录态问一次（`zsh tools/deploy.sh --probe`，只读，只报形状）：

| 用途 | 接口 | 结果（电视、登录态） |
|---|---|---|
| 观看历史 | `GET /aweme/v1/web/history/read/` max_cursor、count=20 | 0；每页 20 条（图文跳过后常剩 12 左右），`max_cursor` 翻页，另给 `aweme_date`（id → 看的时间） |
| 自己的资料 | `GET /aweme/v1/web/user/profile/self/` source=channel_pc_web、personal_center_strategy=1 | 0（同一个接口在登录态桌面浏览器里回过 8）；给 `sec_uid`、昵称、头像、获赞 / 喜欢数 |
| 喜欢 | `GET /aweme/v1/web/aweme/favorite/` 自己的 sec_user_id、max_cursor、min_cursor=0、count | 0，`max_cursor` 翻页 |
| 收藏 | `POST /aweme/v1/web/aweme/listcollection/` 正文 cursor、count | 0（这个账号收藏是空的，只验了空列表的形状） |
| 合集 | `GET /aweme/v1/web/mix/aweme/` mix_id、cursor、count=12 | 0；**cursor 是集数偏移**：cursor=55 从第 56 集开始，任意值都行 |
| 评论 | `GET /aweme/v1/web/comment/list/` aweme_id、cursor、count=20 | 0（匿名也是 0），`total` 和视频的 comment_count 对得上 |
| 评论回复 | `GET /aweme/v2/web/comment/list/reply/` item_id、comment_id、cursor、count | 0 —— **用 v2**，见下 |

条目自己就带着登录账号的状态：`user_digged`（赞过没有，喜欢列表里全是 1）、`collect_stat`、`statistics.collect_count`，还有合集的
`mix_info`（`statis.current_episode` 第几集、`updated_to_episode` 更新到第几集；当时 41 条里 8 条带）。缓存 key 因此升到 v3。

**v1 的评论回复接口会让请求永远悬着。** `/aweme/v1/web/comment/list/reply/` 回 200 + 空正文 + `bdturing-verify` 头（解开是
`{"code":"10000","type":"verify","subtype":"text",…}`，人机验证）。官网的验证 SDK 挂钩着框里的 XHR，收到这个头就把请求扣住、等验证码
—— 验证码弹在看不见的框里，于是 onload、ontimeout、onerror 一个都不来（`x.timeout` 也不灵，它设在被挂钩的那层上）。电视上 --probe
和桌面测试台都是这样。v2 正常回数据。顺带：签名桥的每个请求外面现在都包一层 15 秒（`bridge.js`），这类悬着的请求变成一个报错，不再是一直转圈。

**点赞、收藏被拒，而且第一个点赞请求让服务器作废了电视上的登录（--like，用户同意后跑的）。**

| 请求 | 结果 |
|---|---|
| `POST /aweme/v1/web/commit/item/digg/` aweme_id、type=1、item_type=0 | 空正文；再试一次 HTTP 403 |
| `POST /aweme/v1/web/aweme/collect/` aweme_id、action=1、aweme_type=0 | status_code=8「用户未登录」 |

账号上什么都没写进去，但**代价是登录没了**：02:39:01 启动时 history/read 是 0，02:39:06 发出第一个点赞（回空正文），之后收藏回
「用户未登录」，下一次启动 history/read 也是 8 —— 要重新扫码。看起来是服务器把「没有 ticket guard 头的点赞」当成会话被盗用，直接
作废。官网发这两个时带 `bd-ticket-guard-client-data` 这套头 —— 另一个安全 SDK（ticket guard）
算的，`commit/item/digg`、`aweme/collect` 都在它管的路径表里。它打包在官网主程序的 webpack 模块里（还要再动态拉几个
`uc-secure-*` 的 UMD 包），不像签名那三个 SDK 能单独注入框里。登录时官网登录页已经在 douyin.com 名下存了它的密钥
（框里看得见 `bd_ticket_guard_client_data`、`__security_mc_1_s_sdk_*` 这些 cookie），所以理论上在框里跑起这个 SDK 就能签 —— **没做**，
要把那个模块从 webpack 包里抠出来，量大、成不成没把握。**`js/act.js` 在 `SIGNED` 为 false 时一个写请求都不发**（连 `--like`
也发不出去），界面上点赞、收藏两项跟着不能选，数字照常显示。做出签名头之前别动 `SIGNED`；做出来之后先在一个不要紧的账号上跑 `--like`。

**合集为什么要分组。** 第一版选集从第 1 集一页 12 集往后取，直到取到正在看的那一集（最多 15 页）。设备上第一条就撞上一个 462 集的合集、
看的是第 461 集 —— 取满 15 页才到第 174 集。现在超过 48 集的分组（顶上一排「1–48 · 49–96 · …」，像抖音 App 的选集），每组一个流、
从组的开头取，打开时在这一集所在的那一组，最多 4 页就找到。放到一组的最后一集，流接着往后取（下键、播完都是下一集），只是网格每组最多画 48 张。

**设备自测（同一天）**：`--me` 11 步全过（「我」头部和观看历史、点一条能播、评论侧栏、展开回复、喜欢 / 收藏 / 退出登录三排、左键回推荐），
`--mix` 5 步全过（31 集的合集：焦点在第 30 集、从刚才的位置接着放、下键第 31 集、返回两次回到原来那一条）。分组那一版的合集只在桌面测试台上走过。

## 推荐里反复刷到看过的视频（2026-09-30 用户反馈：同一条刷到三次）

**原因：我们从来不告诉服务器看过什么。** 本地缓存只存「取到了、还没看」的条目，同一次打开里按 id 去重，都不会让看过的回来；
跨几次打开重复出现，是服务器不知道这台电视看过它。官网一开始放就发两个请求（从官网的 JS 里读出来的，全新匿名浏览器存下的 bundle）：

| 请求 | 正文 | 什么时候 | 回 |
|---|---|---|---|
| `POST /aweme/v2/web/aweme/stats/` | `aweme_type、item_id、source=0、play_delta=1` | 每条开始放（「videoPlay」） | 电视上 `status_code=0`；桌面测试台 200 + 空正文 |
| `POST /aweme/v1/web/history/write/` | `aweme_id、author_id`（作者 uid）`、pre_item_id`（上一条）`、pre_item_seen`（上一条看到 ≥95% 为 1） | 登录时才发 | 电视（登录）`0`；匿名 `8 用户未登录` |

另外精选流（`module/feed`）官网在正文里带 `encoded_pre_item_ids`（加密的「之前给过的 id」）和 `pre_log_id / pre_item_from`，我们没带。

现在（`Feed.played`，每条第一次出画面时）：
- 照官网发这两个。**观看历史要等登录态查清楚**：启动时第一条视频比登录态先到，第一版把它当「未登录」漏写了。
  电视上实测 `stats=0 history/write=0`，这一条会出现在手机抖音的「观看历史」里。
- 本地记最近 2000 条看过的 id（`dy.watched.v1`，localStorage 活得过重装），推荐 / 精选里再出现直接跳过，feed 那行报
  「电视上看过 N」。**这个数往后降没降，就是服务器认没认上报的证据。** 作者主页、关注不过滤（在那里重看是有意的）。
- 自测构建既不上报也不记：它几秒一条地刷，记进账号的观看历史会带偏推荐。
- **本地过滤该不该留，看启动那行「看过:」**（用户问「这不是服务器自己做吗」—— 应该是，但没量过；官网另外还往
  `mcs.zijieapi.com` 发整套行为日志，我们没发，服务器可能只去重一部分）。推荐 / 精选每回一页按天记「新的 / 电视上看过的」，
  每天放了几条，存在电视上（`dy.watched.stats.v1`，留 30 天），启动时报累计和按天明细。收集器平时不开，哪天开着打开一次
  App 就读得到。看过的一直是 0 → 服务器自己去重了，删掉本地过滤；不是 0 → 它在兜底，留着。2026-09-30 20:25 起计。
- 签名桥的 `Bridge.report`：空正文算成功，失败不计入「连续 3 次失败就重建框」。

## 多账号：不做，为什么（2026-10-18）

用户问能不能像 bilibili / telegram-tizen 那样一台电视好几个账号、应用里切换。查下来**应用内切换做不了**，用户决定先不做。
以后要做，从这里接着往下想，别从头查：

- **会话在引擎全局的 cookie 罐里，一个应用同一时间只装得下一个人。** 登录是框里开官网 `login_page`、官网自己种 cookie（见「登录」）；
  这正是 bilibili 那边「一台电视，好几个人」踩的坑 —— 全局一个坑位，第二个人登录就把第一个人挤掉。
- **存不下来，也换不回去。** 真正的会话 cookie（`sessionid`、`sid_tt` 这一类）是 HttpOnly 的，框里的脚本读不到 —— 「登录」那节记的
  登录后新增 cookie（`passport_assist_user`、`_bd_ticket_crypt_cookie`、`bd_ticket_guard_*`、`is_dbsc`）里就没有它们（这条是从那份名单推断的，
  没单独测过）。Tizen 给 widget 的 `tizen.websetting` 只有 `removeAllCookies` 和 `setUserAgentString`，读不出、写不进某个 cookie。
  bilibili 能做多账号，是因为它的 TV 登录接口用 JSON 把凭证交回来（`access_key` 走 query）；telegram-tizen 能做，是因为 mtcute 的会话存在
  每个账号各自的 IndexedDB 库里。这边两样都没有。
- **就算搬得动也危险。** 会话和 ticket guard 的设备密钥绑在一起，服务器会作废它觉得被盗用的会话 —— 一个不带 ticket guard 头的点赞请求
  就把电视上的登录弄掉过（见「「我」页、合集、评论、点赞」）。把 cookie 在两个人之间来回换，很可能被当成同一种情况。
- **可行的两条路（都没做），第三条不考虑：**
  1. **装两份**：同一个客户端用不同的应用编号和名字打两个包（「抖音」「抖音 2」），每份各自登录一个人。三星的每个应用有自己的数据目录，
     cookie、localStorage、IndexedDB 应该是各存各的 —— **没在电视上验证过**，要用两个账号各扫一次码、两份都回 `history/read` 0、
     `profile/self` 回不同的 `sec_uid` 才算。代码几乎不用改，`deploy.sh` 加个参数换 `config.xml` 的编号和名字；卸载、重装要按两份算
     （动电视上的应用之前先列出来对照，telegram-tizen 的 CLAUDE.md 记过一次误卸）。
  2. **切换 = 退出再扫码**：应用里记几个人、各自的本地记录分开存，但每次切换都要退出、拿那个人的手机重扫（出码 5–12 秒）。麻烦，
     频繁登出登入也可能招风控。
  3. 自己逆向抖音电视版那种带 token 的登录：要它 App 的私有签名，工作量和风险都不成比例，不考虑。

## 自动更新（2026-10-20，用户要求，照搬 bilibili）

和 bilibili 那套是同一份代码（那边 `docs/自动更新.md` 有完整的来龙去脉）：签名过的 `update/manifest.json` 从 master 取，
更新包按 tag 取，下载时验 ECDSA 签名和 sha256，存进 localStorage，**下次打开生效**；`boot.js` 在页面解析期间用
`document.write` 写脚本；走不到首页的更新包下次启动标坏、退回安装包。**已经装着的电视要先侧载一次 1.2.0**，之后才会自己更新。

**这里多出来的一件事：这个应用是「CSP 模式」**（`config.xml` 里有 `allow-navigation`，签名桥要它），bilibili 不是。
默认策略 `script-src 'self'` 静默拦掉 `blob:` 脚本 —— 更新包的代码正是从 localStorage 拿出来、以 `blob:` 地址交给页面的。
所以 `config.xml` 的 `script-src`、`style-src` 各加了 `blob:`，样式也改成 `blob:` 的 `<link>`（bilibili 用内联 `<style>`，
这里会被拦；没加 `'unsafe-inline'`）。`update-verify` 卡着 CSP 里有这两个 `blob:`。

| 测量 | 结果 |
|---|---|
| 桌面 e2e，CSP 作为响应头，策略原样取自 config.xml | 下载 → 下次打开跑新代码（脚本、DOM、样式三样记号都在，脚本在 load 之前跑完），没有 CSP 拦截 |
| 对照：同一个更新包，策略去掉 `blob:` | 一个脚本都没跑、应用起不来；下次打开退回安装包，原因写着「CSP 拦了 style-src-elem blob…」 |
| 电视（Tizen 9.0），装标成 1.1.9 的开发构建、更新源指到开发机 | 开机一分钟 `已下载 1.2.0，下次打开生效（490KB …，160ms）` |
| 杀掉再开 | `这次跑的是更新 1.2.0（安装包 1.1.9）`，签名桥、登录态、出画面都正常，没有 `csp:` / `onerror` |
| 再杀再开 | 还是 1.2.0（`Boot.ok()` 清掉了 booting） |
| 装回正式的 1.2.0 | `下载过的 1.2.0 不比安装包 1.2.0 新，删掉了` |
| 冷启动第一帧，安装包 vs 更新包 | 安装包 2.5 / 5.7 / 3.3 秒，更新包 3.4 / 5.2 秒 —— 同一个范围，看不出更新包的开销（差别是网络） |

和 bilibili 不同的地方：

- **钥匙是自己的**：私钥 `~/.douyin-tizen-update-key.pem`、口令 `~/.douyin-tizen-update-password`（都 600、都在仓库外），
  公钥指纹 `1bc5:f76f:620b:998d:0aaf:2bc8:c9d7:3e52`。不和 bilibili 共用：漏了一把，不该两个应用一起开门。**丢了**，以后发更新就得让
  所有人重装一个换了公钥的包；**泄露了**，谁都能往每台装着它的电视推代码，而这个应用拿着登录好的抖音会话。
- **不避开播放**：这里一直在播放。manifest 不到 1KB；更新包约 490KB，每个版本只下一次。
- **没有设置页**：没有开关、没有「现在检查」。第一次跑一个新下载的版本时屏幕正中提示一次「已更新到 x.y.z」（4 秒），
  这是观众唯一知道更新到了的途径。
- 启动检查：onload 走完、之后两秒没有 `window.onerror` 才 `Boot.ok()`（`Log.errors()` 数着）。不等第一条视频：断网不是代码坏了。
- 在电视上测更新：`DOUYIN_UPDATE_MANIFEST=http://<这台电脑>:<端口>/manifest.json zsh tools/deploy.sh` 装一个去那里查的开发构建
  （只有 REPORT_TO 非空的构建认它）；更新包用 `node tools/update-release.mjs --worktree --base http://<这台电脑>:<端口>/ --out <目录>` 打，
  `config.xml` 和 `boot.js` 的 `PACKAGED_FALLBACK` 临时改低一档再部署，测完改回、删掉那份测试 manifest。

### 发一版

1. 改 `app/config.xml` 的版本号和 `app/js/boot.js` 的 `PACKAGED_FALLBACK`（要一致，update-verify 卡着），提交。
2. `node tools/update-release.mjs`（取自 `git archive HEAD`，`app/` 有未提交改动就拒绝），
   `git add update && git commit -m "更新包 x.y.z" && git tag vx.y.z && git push origin master vx.y.z`
   —— tag 要一起推：manifest 从 master 取，bundle 从 tag 取。
3. `zsh tools/release.sh` 出 wgt，`gh release create`。
4. 规则：改了 boot.js 对更新包的约定，`SHELL` 加一（旧电视跳过那一版，要重装）。**往 `config.xml` 的 CSP 里删 `blob:` 等于关掉自动更新**，
   而且只在下一次打开时才看得出来。
5. 不用管 Apps2Samsung 的社区目录（README 里推荐的装法）：它每天按 `releases/latest` 自己取新的 wgt
   （`Apps2Samsung/tizen-community-packages` 的 `packages/titlog__douyin-tizen.json`，按 `douyin-tizen-.*[.]wgt$` 挑资产），
   所以 wgt 要一直叫 `douyin-tizen-<版本>.wgt`。

## 精选、直播（2026-10-22，用户要求）

**精选**：「不用上下滑，像手机上一样挑着看，布局参考 bilibili，三列」。不缓存（挑着看时「只存位置之后的」那条缓存规则会扔掉没看过的）；
一张卡片都没有时确认键整个重来。标签自己的页就是网格（`Grid.jingxuan`，和「我」一样是 root 页），
16:9 宽卡片三列，尺寸照 bilibili-tizen 首页（576 宽、间距 32、左右各 64，图 556×313、两行标题、一行灰字 @作者 · 赞 · 多久以前、时长贴右下）。
**卡片用作者做的封面**（`card` = `video.universal_cover_horizontal169`，853×480，大字都在上面；没有横版的退到 `thumb` = `video.cover`，
4:3）。第一版用的 `origin_cover` 是视频里抽的一帧、没有字，用户拿手机上的精选截图问「为啥你的封面几乎都没有大字」；有一条的截帧还是全黑的。
`_big` 是 1760×990，电视上一张解码 7MB，一屏二十张不划算。（切换时盖着的封面照旧用 `origin_cover`：那里要的是和视频画面一致。）
确认键放、放着上下键接着刷、返回键回网格（焦点跟着刚才那条）。页对象一直留着，切走再回来焦点和列表都在。标签栏不能选，**最左边那一列
再按左键到「直播」、最右边那一列再按右键到「关注」** —— 这是离开精选的路。
顶上垫一条渐变底色，往下翻时卡片不从标签栏后面露出来。

**直播**：「再加一个直播的 tab，上下滑动切换」。

| 问题 | 结果（全新匿名测试台 / 电视） |
|---|---|
| 接口 | 官网直播首页只问 `GET /webcast/feed/`，一次 20 个直播间，要 a_bogus。**主站的签名桥直接问 `www.douyin.com/webcast/feed/` 就行**（不用去 live.douyin.com、不用第二个框；live 页的 SDK 是 pageId 7571，试过不需要） |
| 参数 | **要照抄官网那一次的值**（`action=load_more`、`is_ssr=true`、`enter_source=web_homepage_hot_web_live_card`……，见 feed.js 的 `LIVE_Q`）。不照抄：签名对、200、`status_code=0`、data 是空的 `{}` —— 一开始以为是页面地址的事，逐项加 cookie 都没用，换成官网的参数值第一步就有了 |
| 翻页 | 上一页 `extra.max_time` 当 `maxtime`；每页约一半重复，按房间号去重 |
| 拉流 | 房间里直接有 `flv_pull_url`、`hls_pull_url_map` 各四档（蓝光 1088p…标清），**不签名、不认 Referer、不要 cookie**（curl 直接取到）；每个地址带自己的 `sign`，FLV 不能从 HLS 地址改出来（403） |
| 编码 | **几乎全是 H.265**（`live_core_sdk_data` 里各档 VCodec，只有 240p 那档是 H.264；不声明 HEVC 也一样）。HLS 是 TS 分片 ~3.7 秒，音频 AAC-LC |
| `<video>` 直接放 m3u8 | 电视：HEVC 解得出，但 playing 之后**播放头停在 0 不动 5–10 秒**（缓冲里已经 12 秒、readyState=4），8 个直播间 3 个被看门狗跳掉；`seekable` 是空的，往回退做不了（`--live` 量的，那个探测和往回退的代码后来删了）。平台播放器要先攒一大截，`<video>` 没开关。现在只在直播间没有 FLV 地址时退回它 |
| `<video>` 直接放 FLV | 电视：8 秒没动 |
| AVPlay | bilibili 用它 + `setBufferingParam` 压到 ~1 秒，但**我们的 CSP 有 `object-src 'none'`，它的 `<object>` 会被拦，而 CSP 跟安装包走、不跟自动更新走** —— 已经装着的电视都用不了，没试 |
| **mpegts.js（FLV → MSE）** | 电视（`--livemse`，同一轮 8 个直播间）：默认配置**开始到动起来中位 1.0 秒**（741–1050ms），之后 15 秒 4 个里 3 个一次没停；「低延迟」配置中位 0.75 秒但 4 个里 3 个停了 0.4–0.6 秒。**用默认配置** |

- mpegts.js 1.8.2（Apache-2.0，275KB）包了一层函数（`MpegtsLib.get()` 第一次才执行），在 SCRIPTS 里 —— 自动更新包只带 SCRIPTS 里的
  文件，用到时再装的话靠自动更新上来的电视没有这个文件。
- 每个直播间新建一个 mpegts 播放器（它自己的 MediaSource），和点播的 Mse 管线共用一个 `<video>`，换过去之前拆另一边。**从点播进直播间
  先等 350ms 再动管线**（`FLV_DELAY`，直播间之间换台不等）：自测连按三下右键穿过直播，点播管线被拆、直播的建了又拆、点播冷启动再从中间
  seek，那一下 seek 卡了 12 秒被看门狗跳过；路过不拆就没事，回推荐原地接着放。等的那段（`pendingLive`）点播管线的事件、暂停键都不算在
  直播间头上。`Player.stop()` 对直播是真停（暂停了 FLV 也一直在下）。
- 看门狗看「字节还在不在来」只认 mpegts 统计信息里 `speed > 0`：统计信息是定时器每 600ms 发的、不管有没有字节，只数事件的话 CDN 连接
  吊住时永远不报（桌面测试台把 FLV 请求吊住：现在 14 秒报卡住、跳下一个）。一个直播间只报一次错（`failFlv`），主播下播（`ended`）就换下一个。
- 离开直播超过 10 分钟再回来换一批直播间（那一批多半下播了）。直播间不当观看历史的「上一条」（编号是 room…，不是作品 id）。
- 界面：头像套红圈、「直播」标签，左下第三行「● 直播中 · N 人在看」，赞评论收藏分享不显示；暂停时下键只有头像（进主播主页），评论 /
  弹幕没接（要另接 WebSocket）；不能快进快退；暂停超过 20 秒再继续就重新连（照 bilibili）。观看不上报（`Feed.played` 跳过直播间）。
- 设备自测 30 步全过（「直播」能播：出画面 1.4 秒、之后 6 秒不停；换直播间 1.7 秒不停）。

## 上下滑还能多快（2026-10-22，用户：「下滑先出现一个画面，再突然开始播放，最好直接就开始播」）

日志里 39 次按下键（MSE、cover 动画）：按键 → 封面滑上来（250ms）→ 第 200ms 才 seek → 解码器 110–380ms（中位 ~230）出新画面 → 再 ~40ms
播放头走起来撤封面，**按键到动起来中位 ~490ms**。观众看到的是：动画结束后封面静止 ~250ms，再换成视频；封面（`origin_cover`）不一定是
第一帧，换的那一下画面会跳。39 次里 4 次撤封面晚了 120–180ms（那一刻主线程在解推荐流的 JSON / mp4box 转封装，20ms 一次的计时器被顶住），
视频在封面下面已经走了 0.15 秒，一撤就是一跳。

手机为什么丝滑：下一条早在另一个解码器里解好了第一帧（多个硬件解码器），滑动时两层视频一起动，松手直接播。这台电视只有一个解码器，
第二个媒体元素会冻住正在放的那条（见上）。`--splice` 在同一轮里量了两条出路：

| 想法 | 电视上 |
|---|---|
| **剪接**：不 seek，在播放头之后 δ 秒处 `remove` 掉当前这条、把下一条 append 在那里，解码器不停 | **不行**：只要删播放头前面的缓冲，播放就整个冻住（readyState→1，6 秒不恢复，δ 从 1.5 到 0.25 秒 10 次全是），之后 seek 也救不回来。桌面 Chrome 上 10 次全顺 —— 电视的硬件管线早把前面的数据读进去了 |
| **封面换成真第一帧**：WebCodecs 解出下一条的第一个关键帧，画进 canvas 当封面（和 seek 之后硬件出的第一帧一模一样，撤封面就不会跳） | **可以，但只能软件解**：`prefer-software` 出帧 76ms、正在放的那条播放头一动不动；`no-preference` / `prefer-hardware` 抢了唯一的解码器，正在放的那条停了 100–272ms、readyState 掉到 1。画进 canvas 又 ~150ms（576×1024），得在预热时做，不能在按键那一刻 |

做了的三样（`zsh tools/deploy.sh --abseek`：同一轮连刷 30 条，seek 时刻 200 / 130ms 逐条轮换）：

- **封面换成软解的第一帧**（mse.js 的 `decodeFirst`）：转封装时把第 0 个样本（关键帧）抄下来，备好之后 `VideoDecoder`（只许
  prefer-software）解、`createImageBitmap` 缩到画面大小、画进 canvas，最多留 3 张。切过去从头放时 `#cover .img` 里贴这张 canvas
  （从中间接着放的不用）。电视上解一帧 82–99ms + 缩放画布 11–21ms，30 次切换 30 次用上。「封面」那行报「软解第一帧（解+画 ms）」或
  「封面图（为什么没有）」。
- **seek 提前到 130ms**（`COVER_SEEK_MS`）：两轮按键→画面动起来中位 453 / 507ms、462 / 574ms（130 / 200）。
- **切换那一秒主线程让出来**：seek 之后 1 秒内不续取（`HOLD_MS`，前方缓冲 ≥3 秒时），预热回来的数据先不转封装、软解第一帧也等（`QUIET_MS`，
  正在切过去的那条标 `urgent` 不等）。只做前一半时撤封面晚 >100ms 还是 4/30 —— 每次同一秒里都有一条「备好 … 转封装 220–470ms」：预热的
  下一两条正好在切换那一刻回来；两半都做之后 **0/30**。
- 合起来：按键→画面动起来中位 ~490 → ~450ms，撤封面不再跳（同一帧）、不再偶发晚。**还要用户看**：seek 提前后顶上 ~5% 那一条旧画面冻住 /
  变黑 ~120ms 看不看得出来；软解的第一帧和硬件画出来的第一帧颜色亮度有没有差（电视对视频层有画质处理，对网页层没有）。

## 诊断日志（2026-10-21，用户要求，照搬 bilibili）

装发布包的电视出了事，开发者这边一个字都看不到（收集器只有开发构建有）。所以 `log.js` 的每一行也交给 `diag.js`，记进一圈
（600 行 / 16 万字，存在 localStorage，活过重启），**出了观众看得见的事**、或观众在「我」里按「上传诊断日志」时传上去。
默认开，「我」里能关；关了什么都不记、不存、不传。接收端、限流、保留期和 bilibili 共用一套（bilibili-tizen 的 `server/`，
按 `app` 分开），设计和测量在那边的 `server/README.md`、`docs/调试与日志.md`。

- **出事** = `trouble(文字)`（提示 + `Diag.incident`）或直接 `Diag.incident`：连不上抖音（签名桥起不来）、一个标签取不到内容 /
  加载失败、连续五条放不了、扫码之后仍判为未登录、退出登录失败、网格列表 / 评论加载失败、js 错误和没人接的 Promise 异常、
  更新包被标坏。**新的失败出口用 `trouble()`，不用 `toast()`。** 单独一条放不了、跳下一条不算（太常见）。
- **往 `Log.report()` 里放作者名、文案、昵称、合集名、页名、登录页上的字，一律包 `Diag.priv()`**：上传时换成「…」，收集器那边
  照样是原文。`diag-verify` 从源码里查 `Log.report` / `Diag.incident` / `R` / `pushPage` / `trouble` 的参数，卡着 `.desc`、`.author`、
  `.nickname`、`.title`、`Grid.name()`、`mix.name`、`body.slice`；sec_uid、uid、签名和指纹参数（`a_bogus`、`msToken`、`verifyFp`、
  `webid`……）、cookie 值由 `scrub()` 兜底，cookie 名字留着（account 那行判登录态要它）。视频 id 留着。
- **没有设置页**，开关和上传放在「我」：登录了是顶上那一排的两项（底下那行字写说明、这台电视的编号、上次上传的结果），没登录是
  二维码页最底下那一排（下键选中，左右换，确认做，上键 / 返回键取消；只在「我」的二维码页上，「关注」的没有）。按下去的回答是
  那行字变了，不弹提示。
- 开发构建（`REPORT_TO` 非空）不传，除非 `DOUYIN_DIAG_TO`（`--diag` 默认这台电脑的 :8097）；发布包传到 `diag.js` 的 `ENDPOINT`，
  `release.sh` 卡着它是 https、`DIAG_TO` 是空串。`diag.js` 排在 SCRIPTS 最前（`log.js` 一加载就用它）。
- 测量（同一天）：电视 `--diag` 6 步全过（手动传、关掉缓冲清空、再开、造一次出事 8 秒后自动传、回推荐接着放），读回传上去的那份：
  作者名、文案全是「…」，签名参数、sec_uid 一个没有；完整 `--selftest` 26 步全过。电视登录着，二维码页那一排在桌面测试台
  （Playwright，抖音的请求全拦掉）里走过：签名桥起不来 → 「连不上抖音」自动传了一份，那一排的选中、上传、开关、返回键都对。
