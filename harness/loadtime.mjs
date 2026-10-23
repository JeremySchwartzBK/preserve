// Load-time check for a finished copy: how soon its first screen is ready on desktop and phone 4G, timed the same way
// as our published-copy timings (measure.mjs, emulated devices). The copy is served locally the way the copy host
// serves it (compressed text, plus the host's first-byte wait), so the numbers track what visitors see.
// An owner's intro animation doesn't count against the time: the page is "ready" once its first-screen files have
// loaded and the intro has started, and the intro's length is reported beside it (Jeremy, 2026-10-22).
// Usage: node loadtime.mjs <copiesRoot> <id> [runs]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { measure } from './measure.mjs';

export const TARGET_MS = 2000;
export const HOST_WAIT_MS = Number(process.env.PRESERVE_HOST_WAIT_MS || 120); // copy host's typical first-byte time
const CT = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'application/javascript', webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', ico: 'image/x-icon', txt: 'text/plain; charset=utf-8' };

export function hostLike(root, wait = HOST_WAIT_MS) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!fs.existsSync(p) && fs.existsSync(p + '.html')) p += '.html';
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      const ext = p.split('.').pop();
      const text = /^(html|css|js|svg|txt)$/.test(ext);
      const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      setTimeout(() => {
        const size = fs.statSync(p).size;
        if (range && !text) {
          const a = +range[1], b = range[2] ? +range[2] : size - 1;
          res.writeHead(206, { 'content-type': CT[ext] || 'application/octet-stream', 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
          return fs.createReadStream(p, { start: a, end: b }).pipe(res);
        }
        const gz = text && /\bbr\b/.test(req.headers['accept-encoding'] || '');
        res.writeHead(200, { 'content-type': CT[ext] || 'application/octet-stream', 'accept-ranges': 'bytes', ...(gz ? { 'content-encoding': 'br' } : { 'content-length': size }) });
        const s = fs.createReadStream(p);
        gz ? s.pipe(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })).pipe(res) : s.pipe(res);
      }, wait);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// One layout's timing: medians over `runs` cold loads, plus what slowed it.
export function summarize(m) {
  // An intro is an entrance animation that starts as the page arrives; a fade that starts later is a slideshow
  // changing slides or a scroll effect, not an intro.
  const runs = m.runs.filter((r) => !r.error && r.vc95 != null)
    .map((r) => (r.intro && r.intro.start > Math.max(r.firstScreenDone || 0, r.vc95) + 500 ? { ...r, intro: null } : r));
  const med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
  const intro = runs.find((r) => r.intro)?.intro || null;
  // With an intro, ready = first-screen files loaded and the intro started; without, the visual-progress time.
  const ready = med(runs.map((r) => (r.intro ? Math.max(r.firstScreenDone || 0, r.intro.start) : r.vc95)));
  const heavy = new Map();
  for (const r of runs) for (const h of r.heavyEarly || []) heavy.set(h.url, h);
  return { readyMs: ready, vc95Ms: med(runs.map((r) => r.vc95)), kb: med(runs.map((r) => r.kb)), introMs: intro ? intro.ms : null, hiddenMs: med(runs.map((r) => r.hiddenMs)), heavyEarly: [...heavy.values()].slice(0, 5), runs: runs.length };
}

export async function timeCopy(copiesRoot, id, { runs = 3 } = {}) {
  const srv = await hostLike(copiesRoot);
  const base = `http://127.0.0.1:${srv.address().port}/${id}`;
  const out = {};
  try {
    for (const [layout, prof] of [['desktop', 'desktop'], ['mobile', 'mobile-4g']]) {
      out[layout] = summarize(await measure(`${base}/${layout}`, prof, { runs }));
    }
  } finally { srv.close(); }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, id, runs = 3] = process.argv.slice(2);
  console.log(JSON.stringify(await timeCopy(root, id, { runs: +runs }), null, 1));
  process.exit(0);
}
