// deploy.sh 在打包前改写，打包后改回空串 —— 仓库里不存任何地址。
var REPORT_TO = "";
// deploy.sh --selftest 打包时置 true，打包后立刻改回 false。
var SELFTEST = false;
// deploy.sh 在设了 DOUYIN_UPDATE_MANIFEST 时写入，打包后改回空串：开发构建去这里查更新（在电视上测自动更新）。
// 只有 REPORT_TO 非空的开发构建认它，见 update.js。
var UPDATE_MANIFEST = "";
