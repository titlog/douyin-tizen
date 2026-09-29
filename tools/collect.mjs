/* 诊断收集器，:8098（bilibili 的在 :8099，两个可以同时开）。
 *   node tools/collect.mjs | tee <文件>
 * POST /report  —— 电视上报的一行
 * GET  /echo    —— 打印这个请求带来的 Referer / Origin / Cookie / 自定义头，
 *                  用来回答「电视到底发出了什么头」这种脚本自己看不见的问题。
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8098);
const stamp = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${d.toTimeString().slice(0, 8)}`; };

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    console.log(`${stamp()}  preflight ${req.url} 请求头=${req.headers['access-control-request-headers'] || ''}`);
    res.writeHead(204).end(); return;
  }
  if (req.url.startsWith('/echo')) {
    const tag = new URL(req.url, 'http://x').searchParams.get('tag');
    const h = req.headers;
    console.log(`${stamp()}  ECHO ${tag}  referer=${h.referer || '(无)'}  origin=${h.origin || '(无)'}  cookie=${h.cookie ? '有' : '(无)'}  x-probe=${h['x-probe'] || '(无)'}`);
    res.writeHead(200, {'content-type': 'text/plain'}).end('ok'); return;
  }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    res.writeHead(200).end('ok');
    try { const m = JSON.parse(body); console.log(`${stamp()}  ${(m.detail && m.detail.msg) || body}`); }
    catch { console.log(`${stamp()}  ${body.slice(0, 300)}`); }
  });
}).listen(PORT, () => console.log(`${stamp()}  collector on :${PORT}`));
