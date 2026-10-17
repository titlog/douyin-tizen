# 三星电视上刷抖音

**中文 · [English](#english)**

给三星 Tizen 电视做的抖音客户端，用遥控器刷。电视直连抖音：**没有后端，没有代理，没有服务器，
登录状态只存在电视本机。**

> **与抖音、字节跳动、三星均无关联。** 个人项目，MIT 协议。
> 兄弟项目：[bilibili-tizen](https://github.com/titlog/bilibili-tizen)、[telegram-tizen](https://github.com/titlog/telegram-tizen)。

![刷视频](docs/screenshots/01-feed.jpg)

*上下键刷，作者、标题和点赞在右下角，几秒后淡出。*

| | |
|---|---|
| ![选中作者](docs/screenshots/02-select-author.jpg) | ![作者主页](docs/screenshots/03-author.jpg) |
| 暂停时顶上出标签栏；按下键选中作者 | 作者主页：资料和作品网格，往下翻自动加载 |

## 能做的

- **精选 / 关注 / 推荐 / 我** 四个标签，上下键刷，播完自动下一条；每个标签各记各的位置。
- **扫码登录**：官网的登录页在隐藏框里打开，二维码搬到电视上放大；「我」页上退出登录。
- **作者主页**：暂停时按下键选中作者，确认进主页 —— 资料、作品网格，往下翻自动加载。
- 横屏竖屏都铺好，切换有上推动画；常驻的 MSE 播放管线，换一条 0.2–0.5 秒。
- 播放和观看历史照官网的方式上报，手机上也看得到。

## 怎么做到的

抖音网页接口要 `a_bogus` 签名，而签名 SDK 只有跑在 `www.douyin.com` 的页面里才签得对。三星电视的 web widget
能对 `www.douyin.com` 的 iframe 执行脚本，所以在一个隐藏框里让官网自己的 SDK 签名 —— 「签名桥」。
来龙去脉、全部测量和踩过的坑在 [`CLAUDE.md`](CLAUDE.md)。

## 我的电视能装吗

| | |
|---|---|
| **实测可用** | 三星 2023 年款 65 吋 **CU7090**，固件 Tizen 9.0（Chromium 120） |
| **其他机型** | 没人试过。装成功或者失败，都欢迎开 issue 说一声机型和固件版本 |

## 安装

三星商店不收第三方客户端，只能侧载。**只需要一次**，之后电视上直接开。两条路：

| | 装发布包（推荐） | 从源码装 |
|---|---|---|
| 适合 | 只想在电视上刷抖音 | 要改代码、要看诊断日志 |
| 需要 | 电脑（Windows / macOS / Linux）**或安卓手机**，装上 [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) | macOS、Node、Tizen Studio 命令行工具 |
| 升级 | 下载新版 `.wgt`，再装一次 | `git pull`，再跑一次 `deploy.sh` |

**两条路都要先做这一步：** 电视上打开开发者模式——在「应用」页面用遥控器输入 `12345`，打开开关，Host PC IP 填装应用的
那台电脑或手机的 IP——然后**把电视完整断电重启一次**。2023 年以后的三星电视只认三星签发的证书，两条路都会替你申请。

### 装发布包

1. 到 [Releases](https://github.com/titlog/douyin-tizen/releases/latest) 下载 `douyin-tizen-<版本>.wgt`。
2. 装 [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung/releases)，电脑版、安卓版都行。
3. 打开它，选中你的电视（列表里没有就手动输入电视的 IP），应用选自定义 `.wgt`，选第 1 步下载的文件，安装。第一次会让你
   登录三星账号，替这台电视签证书。

### 从源码装

电视、证书、签名档都沿用 [bilibili-tizen](https://github.com/titlog/bilibili-tizen) 的配置：先按它 README 里「从源码装」
那一节跑一次 `zsh tools/setup.sh`。然后：

```bash
git clone https://github.com/titlog/douyin-tizen.git && cd douyin-tizen
zsh tools/deploy.sh          # 打包、签名、安装、启动
```

> **两条路不要来回换。** 两边签名用的证书不同，电视不让一个证书签的包覆盖另一个证书签的同名应用。要换路，先在电视上把
> 旧的删掉再装——删掉会清空扫码登录，要重新扫一次。

## 调试

零售机上看不到日志，应用自己往电脑上报：

```bash
node tools/collect.mjs       # 终端 1：在 8098 端口收日志
zsh tools/deploy.sh          # 终端 2
zsh tools/deploy.sh --selftest   # 在电视上无人值守地走一遍：刷、暂停、切标签、作者主页……
```

自测构建会自己换视频、暂停，看之前记得再跑一次普通的 `deploy.sh`。

## 目录

```
app/          客户端（ES5，没有构建步骤）
  js/bridge.js   签名桥：隐藏框里的官网 SDK
  js/feed.js     推荐 / 精选 / 关注的视频流
  js/mse.js      常驻的 MSE 播放管线
  js/vendor/     mp4box.js
spike/        当初摸清平台的探测工装和桌面测试台
tools/        部署、发布包（release.sh）、日志收集、lint
CLAUDE.md     全部发现、坑，以及怎么在零售机上调试
```

## 协议

MIT。`app/js/vendor/mp4box.js` 是 BSD-3-Clause，见 [`mp4box.LICENSE`](app/js/vendor/mp4box.LICENSE)。
抖音是其所有者的商标，本项目与之无关联。

---

## English

A Douyin (TikTok China) client for Samsung Tizen TVs, driven by the remote. The TV talks to Douyin directly —
no backend, no proxy, no server; the login stays on the set.

- Four tabs (featured / following / recommended / me), up and down to browse, autoplay next.
- QR sign-in: the official login page runs in a hidden frame and its QR code is shown full size on the TV.
- Uploader pages: pause, press down to select the uploader, OK to open their profile and videos.
- A resident MSE pipeline: switching videos takes 0.2–0.5 s.

Douyin's web API wants an `a_bogus` signature that only the site's own SDK, running on `www.douyin.com`, produces
correctly. A Tizen web widget can script a `www.douyin.com` iframe, so the official SDK signs requests in a hidden
frame. The details, measurements and pitfalls are in [`CLAUDE.md`](CLAUDE.md) (Chinese).

Tested on a 2023 Samsung CU7090 (Tizen 9.0). The easy way to install: download `douyin-tizen-<version>.wgt` from
[Releases](https://github.com/titlog/douyin-tizen/releases/latest) and install it with
[Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) (desktop or Android) as a custom `.wgt` — enable Developer
Mode on the TV and power-cycle it first. From source: set up the TV and the Samsung certificate with
[bilibili-tizen](https://github.com/titlog/bilibili-tizen)'s `tools/setup.sh`, then run `zsh tools/deploy.sh` here.

MIT. mp4box.js is BSD-3-Clause. Not affiliated with Douyin, ByteDance or Samsung.
