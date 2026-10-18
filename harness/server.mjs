// Serves one captured site and its copies from a single local origin.
//   /<variant>/...              files the builder wrote (index.html, mobile.html, desktop.html)
//   /<variant>/x/<host>/<path>  captured assets, with per-variant rewriting (URLs, fonts, image resizing)
//   anything else               looked up as a path on the original site, else 404 (logged as a miss)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';

export function rewriteUrls(text, variant, hosts, siteHost) {
  for (const h of hosts) {
    const e = h.replace(/\./g, '\\.');
    const target = `/${variant}/x/${h}/`;
    text = text.replace(new RegExp(`(https?:)?//${e}/`, 'g'), target);
    text = text.replace(new RegExp(`(https?:)?\\\\/\\\\/${e}\\\\/`, 'g'), target.replace(/\//g, '\\/'));
  }
  if (siteHost) {
    const e = siteHost.replace(/\./g, '\\.');
    text = text.replace(new RegExp(`https?://${e}/`, 'g'), '/').replace(new RegExp(`https?:\\\\/\\\\/${e}\\\\/`, 'g'), '\\/');
  }
  return text;
}

const IMG_HOSTS = /^(images\.squarespace-cdn\.com|static1\.squarespace\.com)$/;

export function startServer(siteDir, port, variants) {
  const manifest = JSON.parse(fs.readFileSync(path.join(siteDir, 'manifest.json'), 'utf8'));
  const info = JSON.parse(fs.readFileSync(path.join(siteDir, 'capture-info.json'), 'utf8'));
  const siteOrigin = new URL(info.finalUrl || info.url).origin;
  const siteHost = new URL(siteOrigin).host;
  const hosts = [...new Set(Object.keys(manifest).filter((u) => u.startsWith('http')).map((u) => new URL(u).host))].filter((h) => h !== siteHost);
  const byPath = {}; // origin+path -> [urls]
  for (const u of Object.keys(manifest)) {
    if (!u.startsWith('http')) continue;
    const k = u.split('?')[0];
    (byPath[k] ||= []).push(u);
  }
  const misses = [];
  const cache = new Map();
  const cacheDir = path.join(siteDir, 'img-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const lookup = (abs) => {
    if (manifest[abs]) return manifest[abs];
    const alt = abs.startsWith('https:') ? 'http:' + abs.slice(6) : 'https:' + abs.slice(5);
    if (manifest[alt]) return manifest[alt];
    const list = byPath[abs.split('?')[0]] || byPath[alt.split('?')[0]];
    if (list) return list.map((u) => manifest[u]).sort((a, b) => b.size - a.size)[0];
    return manifest['orig:' + abs.split('?')[0]] || null;
  };

  const send = (req, res, status, ct, body) => {
    const ae = req.headers['accept-encoding'] || '';
    const textual = /text|javascript|json|css|svg|xml/.test(ct);
    const h = { 'content-type': ct, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' };
    if (textual && body.length > 1024 && ae.includes('br')) {
      const key = 'br:' + req.url;
      let z = cache.get(key);
      if (!z) { z = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }); cache.set(key, z); }
      h['content-encoding'] = 'br'; body = z;
    }
    res.writeHead(status, h); res.end(body);
  };

  async function resized(entry, url, accept) {
    const m = /format=(\d+)w/.exec(url.search);
    const want = m ? +m[1] : 1500;
    const fmt = /image\/avif/.test(accept) ? 'avif' : /image\/webp/.test(accept) ? 'webp' : 'jpeg';
    const key = `${entry.file}-${want}.${fmt}`;
    const p = path.join(cacheDir, key);
    if (fs.existsSync(p)) return { body: fs.readFileSync(p), ct: `image/${fmt}` };
    const pw = p.replace(/\.\w+$/, '.webp');
    if (/gif/.test(entry.ct) && fmt !== 'jpeg' && fs.existsSync(pw)) return { body: fs.readFileSync(pw), ct: 'image/webp' };
    const src = fs.readFileSync(path.join(siteDir, 'raw', entry.file));
    if (/svg/.test(entry.ct)) return { body: src, ct: entry.ct };
    if (/gif/.test(entry.ct)) {
      // Animated GIFs are often the heaviest files on a page; animated WebP keeps the motion at a fraction of the size.
      if (fmt === 'jpeg') return { body: src, ct: entry.ct };
      let g = sharp(src, { animated: true });
      const gm = await g.metadata();
      if (gm.width > want) g = g.resize({ width: want });
      const body = await g.webp({ quality: 75, effort: 4 }).toBuffer();
      if (body.length >= src.length) return { body: src, ct: entry.ct };
      fs.writeFileSync(p.replace(/\.\w+$/, '.webp'), body);
      return { body, ct: 'image/webp' };
    }
    let img = sharp(src, { animated: false }).rotate();
    const meta = await img.metadata();
    if (meta.width > want) img = img.resize({ width: want });
    const body = await (fmt === 'avif' ? img.avif({ quality: 50, effort: 3 }) : fmt === 'webp' ? img.webp({ quality: 72 }) : img.jpeg({ quality: 78, mozjpeg: true })).toBuffer();
    fs.writeFileSync(p, body);
    return { body, ct: `image/${fmt}` };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const parts = url.pathname.split('/');
    const variant = variants[parts[1]] ? parts[1] : null;
    try {
      if (variant && parts[2] === 'x') {
        const host = parts[3];
        const rest = parts.slice(4).join('/');
        const abs = `https://${host}/${rest}${url.search}`;
        const opts = variants[variant];
        if (opts.resizeImages && IMG_HOSTS.test(host)) {
          const entry = manifest['orig:' + abs.split('?')[0]] || lookup(abs);
          if (entry && /image/.test(entry.ct)) { const r = await resized(entry, url, req.headers.accept || ''); return send(req, res, 200, r.ct, r.body); }
        }
        // A site's own CSS can glue two URLs together (seen on xanadu: "a.otfhttps://.../b.otf"). Browsers request the
        // glued path as-is and Squarespace still serves the first file, so undo our rewrite of the inner URL and retry.
        let entry = lookup(abs);
        if (!entry && rest.includes(`/${parts[1]}/x/`)) entry = lookup(`https://${host}/${rest.replace(new RegExp(`/${parts[1]}/x/`, 'g'), 'https://')}${url.search}`) || lookup(`https://${host}/${rest.split(`/${parts[1]}/x/`)[0]}`);
        if (!entry) { misses.push(`${variant} ${abs}`); return send(req, res, 404, 'text/plain', Buffer.from('miss')); }
        let body = fs.readFileSync(path.join(siteDir, 'raw', entry.file));
        if (/css|javascript|json|html/.test(entry.ct) || /\.(css|js)$/.test(rest)) {
          const key = `${variant}:${abs}`;
          let t = cache.get(key);
          if (!t) {
            t = rewriteUrls(body.toString('utf8'), variant, hosts, siteHost);
            if (opts.transformText) t = opts.transformText(t, entry.ct, abs);
            t = Buffer.from(t); cache.set(key, t);
          }
          body = t;
        }
        return send(req, res, 200, entry.ct || 'application/octet-stream', body);
      }
      if (variant) {
        let p = path.join(siteDir, 'variants', variant, parts.slice(2).join('/') || 'index.html');
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
        if (fs.existsSync(p)) {
          const ct = p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
          return send(req, res, 200, ct, fs.readFileSync(p));
        }
      }
      // Root-relative request: try the original site's path.
      const entry = lookup(siteOrigin + url.pathname + url.search);
      if (entry && !/html/.test(entry.ct)) {
        let body = fs.readFileSync(path.join(siteDir, 'raw', entry.file));
        return send(req, res, 200, entry.ct, body);
      }
      misses.push(`${variant || '-'} ${req.method} ${url.pathname}${url.search}`.slice(0, 200));
      send(req, res, 404, 'text/plain', Buffer.from('miss'));
    } catch (e) {
      misses.push(`ERR ${req.url} ${e.message}`);
      res.writeHead(500); res.end();
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, misses, hosts, siteHost, siteOrigin })));
}
