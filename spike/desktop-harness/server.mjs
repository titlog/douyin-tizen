// 本地同源测试台：页面在 localhost，bdms 给 /aweme/ 请求加签，这里原样转发给 www.douyin.com
// —— 不带 cookie、不带 Referer，UA 用浏览器发来的那个（a_bogus 与 UA 绑定）。
import http from 'node:http';
import fs from 'node:fs';
import https from 'node:https';

const PORT = 8765;
const page = fs.readFileSync(new URL('./index.html', import.meta.url));
let TTWID = ''; try { TTWID = fs.readFileSync(new URL('./ttwid.txt', import.meta.url), 'utf8').trim(); } catch (e) {}

http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    return res.end(page);
  }
  if (req.url.startsWith('/tv-ref.html')) {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    return res.end(fs.readFileSync(new URL('./tv-ref.html', import.meta.url)));
  }
  if (req.url.startsWith('/tv-login.html')) {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    return res.end(fs.readFileSync(new URL('./tv-login.html', import.meta.url)));
  }
  if (req.url.startsWith('/tv.html')) {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    return res.end(fs.readFileSync(new URL('./tv.html', import.meta.url)));
  }
  if (req.url.startsWith('/log')) {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { console.log('PAGE', b); res.end('ok'); });
    return;
  }
  if (req.url.startsWith('/aweme/')) {
    const u = new URL(req.url, 'https://www.douyin.com');
    const keys = [...u.searchParams.keys()];
    console.log('SIGN', decodeURIComponent(req.headers['x-case'] || ''), 'cookie=' + (req.headers['x-cookie'] || '无'), 'a_bogus=' + (u.searchParams.has('a_bogus') ? '有' : '无'), 'msToken=' + (u.searchParams.has('msToken') ? '有' : '无'), 'keys=' + keys.length);
    const up = https.request(u, {method: req.method, headers: (() => { const mode = req.headers['x-cookie'] || ''; const jar = []; if (mode.includes('ttwid')) jar.push(TTWID); if (mode.includes('svweb')) jar.push('s_v_web_id=' + req.headers['x-fp']); const h = {'user-agent': req.headers['user-agent'], 'accept': 'application/json'}; if (jar.length) h.cookie = jar.join('; '); return h; })()}, r => {
      let chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => {
        const body = Buffer.concat(chunks);
        let n = '?'; try { n = (JSON.parse(body).aweme_list || []).length; } catch (e) {}
        console.log('UPSTREAM', r.statusCode, body.length + 'B', 'items=' + n, 'head=' + body.slice(0, 16).toString());
        res.writeHead(r.statusCode, {'content-type': 'application/json'}); res.end(body);
      });
    });
    up.on('error', e => { console.log('UPSTREAM ERR', e.message); res.writeHead(502); res.end(); });
    return up.end();
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log('harness on', PORT));
