// Local stand-in for Cloudflare Pages: extensionless .html, _worker.js on copy roots. Usage: node static-serve.mjs <root> <port>
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const [root, port] = process.argv.slice(2);
const worker = (await import(path.resolve(root, '_worker.js'))).default;
const CT = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'application/javascript', webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff' };
const ASSETS = { fetch: async (u) => { u = new URL(u.url || u); let p = path.join(root, decodeURIComponent(u.pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = fs.existsSync(p + '.html') ? p + '.html' : path.join(p, 'index.html'); if (!fs.existsSync(p)) return new Response('nf', { status: 404 }); return new Response(fs.readFileSync(p), { headers: { 'content-type': CT[p.split('.').pop()] || 'application/octet-stream' } }); } };
http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  const isRoot = /^\/[a-z0-9-]+\/?$/.test(u.pathname) && fs.existsSync(path.join(root, u.pathname.split('/')[1], 'desktop.html'));
  const r = isRoot ? await worker.fetch(new Request(u, { headers: req.headers }), { ASSETS }) : await ASSETS.fetch(u);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log('serving', root, port));
