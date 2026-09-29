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
  （bilibili 那边 updater 探测说「远程 https script 标签可用」，这里不一样，没查原因；
  可能是 `allow-navigation` 或别的配置差异。）
- 推荐流请求 `count=10`，每次只回 2 条，桌面上也一样。

## 客户端（app/，2026-09-29 起）

顶部四个标签：精选 · 关注 · 推荐 · 我，默认进推荐。每个视频标签各记各的位置，切回来接着看。
**标签栏只在切标签和暂停时出来**，上下刷的时候不出来（用户要求：刷的时候顶部冒出导航是打扰）；
作者、标题那层每次换视频都出来，5 秒后淡出。自测里「下一条」「暂停」两步各盯着这件事。

```
app/
  js/config.js   REPORT_TO（deploy.sh 打包前写入、打包后改回空串）
  js/log.js      上报到 tools/collect.mjs（:8098），令牌桶限速，连败五次睡五分钟
  js/bridge.js   隐藏 iframe（douyin.com/robots.txt）+ 官网签名 SDK；所有接口经它发（GET/POST）
  js/feed.js     视频流工厂：推荐 / 精选 / 关注各一个实例，前方不足 4 条就补；过滤图文/直播/广告
  js/account.js  登录态（login_time cookie 在不在）；退出登录
  js/login.js    扫码登录：隐藏框开官网 login_page，把二维码搬到电视上
  js/player.js   一个 <video>；下一条只用 XHR 预热（走完 302 + 取开头 512KB）；心跳看门狗 12 秒无进展算放不了
  js/app.js      按键与界面
```

遥控器：下键 / 频道减 → 下一条，上键 / 频道加 → 上一条，确认 / 播放暂停 → 暂停，
左右键 → 切标签（**暂停时**改为 ∓10 秒），快进 / 快退键 → 任何时候 ±10 秒，返回键按两次退出。
播完自动下一条。「我」页上按两次确认 → 退出登录。

```bash
node tools/collect.mjs | tee <日志文件>   # 终端 1
zsh tools/deploy.sh                      # 终端 2；--spike 装可行性探测那个
zsh tools/deploy.sh --selftest           # 自己派发按键把「刷」走一遍，逐步上报 PASS/FAIL（17 步，约 3 分钟）
zsh tools/deploy.sh --soak               # 连刷 20 分钟 + 登录页挂 6 分钟，看风控和二维码轮换
```

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
