/* 抖音 × Tizen 可行性探测。
 *
 * 桌面上已经测定（见 CLAUDE.md）：官网签名 SDK 在别的域名上签得出来，但服务器只认
 * 「页面真在 www.douyin.com 上、Referer 也是它」的请求。这里在电视上回答三个问题：
 *   1. widget 能不能对一个 www.douyin.com 的 iframe 执行脚本？能的话，在那个框里装官网
 *      SDK，就等于「页面在 douyin.com 上」—— 桌面上唯一拿到推荐流的那个条件。
 *   2. 电视发请求时带什么 Referer，脚本改不改得了（发给收集器的 /echo，它打印请求头）。
 *   3. widget 自己装 SDK 直连（桌面预期：被拒）—— 真机上确认一次。
 * 外加播放对照：/aweme/v1/play/ 不签名跳转，电视上拿不拿得到、<video> 播不播得了。
 */
(function () {
  var D = 'https://www.douyin.com';
  var VIDEO_ID = 'v0d00fg10000dagiqdnog65i8u4q2rpg'; // 2026-09-29 推荐流里的一条，桌面实测可播
  var Q = 'device_platform=webapp&aid=6383&channel=channel_pc_web&count=10&refresh_index=1&video_type_select=1&version_code=170400&version_name=17.4.0&pc_client_type=1&cookie_enabled=true&platform=PC';
  var SDKS = [
    'https://lf-security.bytegoofy.com/obj/security-secsdk/runtime_bundler_34_v2.js',
    'https://lf-c-flwb.bytetos.com/obj/rc-client-security/c-webmssdk/1.0.0.20/webmssdk.es5.js',
    'https://lf-c-flwb.bytetos.com/obj/rc-client-security/web/glue/1.0.0.64-fix.01/sdk-glue.js'
  ];
  var PATHS = ['^/webcast/', '^/aweme/v1/', '^/aweme/v2/', '/douplus/', '^/api/ad/v1/inspire', '/v1/message/send', '^/live/', '^/captcha/', '^/ecom/', '^/luna/pc'];
  var t0 = Date.now();

  var logEl = document.getElementById('log');
  function report(msg) {
    var line = '[' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + msg;
    logEl.textContent += line + '\n';
    if (logEl.textContent.length > 6000) { logEl.textContent = logEl.textContent.slice(-5000); }
    if (!REPORT_TO) { return; }
    try {
      var x = new XMLHttpRequest();
      x.open('POST', REPORT_TO + '/report', true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(JSON.stringify({event: 'log', detail: {msg: line}}));
    } catch (e) {}
  }
  window.onerror = function (m, src, line) { report('onerror ' + m + ' @' + (src || '').split('/').pop() + ':' + line); };

  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 10009) { try { tizen.application.getCurrentApplication().exit(); } catch (err) {} }
  });

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function withTimeout(p, ms, tag) {
    return Promise.race([p, wait(ms).then(function () { throw new Error(tag + ' 超时 ' + ms + 'ms'); })]);
  }
  function host(u) { try { return new URL(u).host; } catch (e) { return '?'; } }
  function summarise(text) {
    var n = '?', first = '', uri = '';
    try {
      var j = JSON.parse(text); var l = j.aweme_list || [];
      n = l.length;
      if (l[0]) { first = (l[0].desc || '').slice(0, 20); uri = l[0].video && l[0].video.play_addr && l[0].video.play_addr.uri || ''; }
    } catch (e) {}
    return {n: n, first: first, uri: uri, head: text.slice(0, 10)};
  }

  // ---------- 通用：在某个 window（widget 自己或 iframe）里装官网 SDK ----------
  function loadScriptIn(win, src) {
    return new Promise(function (ok, bad) {
      var doc = win.document;
      var s = doc.createElement('script');
      s.src = src;
      s.onload = function () { ok('tag'); };
      s.onerror = function () { bad(new Error('script onerror ' + host(src))); };
      (doc.head || doc.documentElement).appendChild(s);
    });
  }
  // 标签注入不执行时的后备：widget 自己的 XHR（不受 CORS）取回源码，在目标 realm 里 eval。
  function evalIn(win, src) {
    return new Promise(function (ok, bad) {
      var x = new XMLHttpRequest();
      x.open('GET', src);
      x.onload = function () { try { win.eval(x.responseText); ok('eval'); } catch (e) { bad(e); } };
      x.onerror = function () { bad(new Error('xhr error ' + host(src))); };
      x.send();
    });
  }
  function installSdk(win, tag) {
    var how = [];
    var chain = Promise.resolve();
    SDKS.forEach(function (src) {
      chain = chain.then(function () {
        return withTimeout(loadScriptIn(win, src), 8000, 'script').catch(function () { return evalIn(win, src); })
          .then(function (m) { how.push(m); });
      });
    });
    return chain.then(function () {
      report(tag + ' SDK 装载方式=' + how.join(',') + ' _SdkGlueInit=' + typeof win._SdkGlueInit);
      win._SdkGlueInit({
        self: {aid: 6383, pageId: 6241},
        bdms: {aid: 6383, pageId: 6241, paths: PATHS, boe: false, ddrt: 8.5, ic: 8.5},
        verifyCenter: {interceptPathList: {include: PATHS, exclude: ['^/aweme/v1/play/', 'douyinvod\\.com']}, commonOptions: {aid: 6383, pageId: 6241}, nocaptchaOptions: {enabled: true}, captchaOptions: {ele: 'captcha_container', showMode: 'mask'}}
      }, {
        verifyCenter: {srcList: ['https://lf-rc1.yhgfb-cn-static.com/obj/rc-verifycenter/sec_sdk_build/4.0.28/captcha/index.js']},
        bdms: {srcList: ['https://p-pc-weboff.byteimg.com/tos-cn-i-9r5gewecjs/bdms_1.0.1.19_fix.js']}
      });
      var tries = 0;
      function poll() {
        if (typeof win.bdms !== 'undefined' || tries++ > 30) { return Promise.resolve(); }
        return wait(500).then(poll);
      }
      return poll();
    }).then(function () { report(tag + ' bdms=' + typeof win.bdms); });
  }
  function feedIn(win, url, tag, cred) {
    return new Promise(function (ok) {
      var x = new win.XMLHttpRequest();
      x.open('GET', url);
      if (cred) { x.withCredentials = true; }
      x.onload = function () {
        var s = summarise(x.responseText);
        var added = [];
        try { var u = new URL(x.responseURL); ['a_bogus', 'msToken', 'uifid', 'verifyFp', 'fp'].forEach(function (k) { if (u.searchParams.has(k)) { added.push(k); } }); } catch (e) {}
        report(tag + ' status=' + x.status + ' len=' + x.responseText.length + ' items=' + s.n + ' head=' + s.head + ' first=' + s.first + ' | 加上的参数=' + added.join(','));
        ok(s);
      };
      x.onerror = function () { report(tag + ' XHR error'); ok(null); };
      x.send();
    });
  }

  // ---------- 0. 环境 ----------
  function testEnv() {
    report('env UA=' + navigator.userAgent);
    report('env location=' + location.href + ' origin=' + location.origin + ' referrer=' + (document.referrer || '(空)') + ' cookieEnabled=' + navigator.cookieEnabled);
    return Promise.resolve();
  }

  // ---------- 2. Referer：收集器 /echo 打印它收到的请求头 ----------
  function echo(tag, send) {
    return withTimeout(new Promise(function (ok) { send(REPORT_TO + '/echo?tag=' + encodeURIComponent(tag), ok); }), 5000, tag)
      .catch(function (e) { report(tag + ' ' + e.message); });
  }
  function testReferer() {
    if (!REPORT_TO) { report('referer 没有 REPORT_TO，跳过'); return Promise.resolve(); }
    return echo('xhr-朴素', function (u, ok) {
      var x = new XMLHttpRequest(); x.open('GET', u); x.onloadend = ok; x.send();
    }).then(function () {
      return echo('xhr-setRequestHeader-Referer', function (u, ok) {
        var x = new XMLHttpRequest(); x.open('GET', u);
        var errs = [];
        try { x.setRequestHeader('Referer', D + '/'); } catch (e) { errs.push('Referer:' + e.message); }
        try { x.setRequestHeader('X-Probe', 'custom-ok'); } catch (e) { errs.push('X-Probe:' + e.message); }
        if (errs.length) { report('setRequestHeader 抛了 ' + errs.join(' ')); }
        x.onloadend = ok; x.send();
      });
    }).then(function () {
      return echo('fetch-referrer选项', function (u, ok) {
        fetch(u, {referrer: D + '/', referrerPolicy: 'unsafe-url'}).then(ok, function (e) { report('fetch-referrer选项 抛了 ' + e.message); ok(); });
      });
    });
  }

  // ---------- 4. 播放 ----------
  function testPlay() {
    var url = D + '/aweme/v1/play/?video_id=' + VIDEO_ID + '&ratio=1080p&line=0';
    return withTimeout(new Promise(function (ok) {
      var st = Date.now();
      var x = new XMLHttpRequest();
      x.open('GET', url); x.responseType = 'arraybuffer';
      x.setRequestHeader('Range', 'bytes=0-65535');
      x.onload = function () { report('play xhr status=' + x.status + ' ' + (x.response ? x.response.byteLength : 0) + 'B ' + (Date.now() - st) + 'ms 落到=' + host(x.responseURL)); ok(); };
      x.onerror = function () { report('play xhr error'); ok(); };
      x.send();
    }), 10000, 'play xhr').catch(function (e) { report(e.message); })
      .then(function () { return playVideo(url, 'play <video>'); });
  }
  function playVideo(url, tag) {
    var v = document.getElementById('v');
    v.src = url;
    var p = v.play();
    if (p && p.catch) { p.catch(function (e) { report(tag + ' play() 拒绝 ' + e.message); }); }
    return wait(7000).then(function () {
      report(tag + ' t=' + v.currentTime.toFixed(1) + ' ' + v.videoWidth + 'x' + v.videoHeight + ' readyState=' + v.readyState + ' error=' + (v.error ? v.error.code : '无'));
    });
  }

  // ---------- 匿名 ttwid：在 widget realm 里做（不受 CORS），cookie 进引擎的 jar ----------
  function getTtwid() {
    return withTimeout(new Promise(function (ok) {
      var x = new XMLHttpRequest();
      x.open('POST', 'https://ttwid.bytedance.com/ttwid/union/register/');
      x.setRequestHeader('content-type', 'application/json');
      x.onload = function () {
        var cb = ''; try { cb = JSON.parse(x.responseText).redirect_url; } catch (e) {}
        if (!cb) { report('ttwid 注册失败 status=' + x.status); return ok(); }
        var y = new XMLHttpRequest(); y.open('GET', cb); y.withCredentials = true;
        y.onload = function () { report('ttwid 回调 status=' + y.status + '（cookie 在 jar 里，脚本看不见，下面的结果间接说明它在不在）'); ok(); };
        y.onerror = function () { report('ttwid 回调 error'); ok(); };
        y.send();
      };
      x.onerror = function () { report('ttwid 注册 error'); ok(); };
      x.send(JSON.stringify({region: 'cn', aid: 6383, needFid: false, service: 'www.douyin.com', migrate_info: {ticket: '', source: 'node'}, cbUrlProtocol: 'https', union: true}));
    }), 10000, 'ttwid').catch(function (e) { report(e.message); });
  }

  // ---------- 1. iframe ----------
  function openFrame(src) {
    return withTimeout(new Promise(function (ok) {
      var f = document.createElement('iframe');
      f.onload = function () { ok(f); };
      f.src = src;
      document.body.appendChild(f);
    }), 15000, 'iframe load');
  }
  function testIframe() {
    return openFrame(D + '/robots.txt').then(function (f) {
      var win = f.contentWindow, peek;
      try {
        peek = 'location=' + win.location.href + ' body=' + (win.document.body ? win.document.body.textContent.slice(0, 30).replace(/\s+/g, ' ') : '(无 body)');
      } catch (e) {
        report('iframe 跨域访问被拦：' + e.name + ' ' + e.message);
        return;
      }
      report('iframe 可以访问！' + peek);
      return installSdk(win, 'iframe').then(function () {
        return feedIn(win, '/aweme/v1/web/tab/feed/?' + Q, 'iframe 推荐流 第1次', false);
      }).then(function (s) {
        return wait(2000).then(function () { return feedIn(win, '/aweme/v1/web/tab/feed/?' + Q, 'iframe 推荐流 第2次', false); })
          .then(function (s2) { return s2 && s2.uri ? s2 : s; });
      }).then(function (s) {
        if (s && s.uri) { return playVideo(D + '/aweme/v1/play/?video_id=' + s.uri + '&ratio=1080p&line=0', '端到端 推荐流第一条 <video>'); }
      });
    }).catch(function (e) { report('iframe 实验失败 ' + e.message); });
  }

  // ---------- 3. widget 自己直连（放最后：装 SDK 会挂钩 widget 自己的 XHR） ----------
  function testDirect() {
    return installSdk(window, 'direct').then(function () {
      return feedIn(window, D + '/aweme/v1/web/tab/feed/?' + Q, 'direct 推荐流', true);
    }).catch(function (e) { report('direct 实验失败 ' + e.message); });
  }

  report('douyin spike 启动');
  testEnv()
    .then(testReferer)
    .then(testPlay)
    .then(getTtwid)
    .then(testIframe)
    .then(testDirect)
    .then(function () { report('全部结束（返回键退出）'); });
})();
