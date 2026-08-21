// static file server + POST /shot -> writes shot.png for inspection
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/shot')) {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      const name = (new URL(req.url, 'http://x')).searchParams.get('n') || 'shot';
      const m = /^data:image\/(\w+);base64,(.*)$/s.exec(b.trim());
      if (m) fs.writeFileSync(path.join(__dirname, name + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1])), Buffer.from(m[2], 'base64'));
      res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('ok');
    });
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(8422, () => console.log('apexdrive dev server on http://localhost:8422'));
