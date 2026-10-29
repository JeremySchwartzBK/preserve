// "When in doubt, freeze" (custom code stage one, Jeremy 2026-10-29): a Preserve must look the same on every load,
// so a viewer sees exactly what the person reviewed. Each layout is opened twice, in fresh browsers, with the rules
// visitors get (policy.mjs) and our own slideshows held still; what the page shows (its elements, words, pictures and
// links) is compared. If the two loads differ, the kept owner scripts (build.mjs, data-pv-owner) are tried one at a time
// without each; one whose removal makes the loads agree is frozen: taken out, so the page keeps the look it had at
// capture. If none alone explains it, all of them are frozen. Our own scripts are never touched.
// Runs after scrub, before the quality check. Usage: node steady.mjs <stageDir>   (prints a JSON report)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { PROFILES, launch } from './lib.mjs';
import { policyHeaders } from './policy.mjs';

const SETTLE_MS = 4000;
const CT = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'application/javascript', webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', ico: 'image/x-icon' };

// What the page shows, without what changes on its own by design (classes and styles, which our slideshows and
// entrance animations set) or what is ours (preserve-* scripts and pins).
function snapshot() {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { const t = c.textContent.replace(/\s+/g, ' ').trim(); if (t) out.push('"' + t); continue; }
      if (c.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(c.tagName) || /^preserve-/.test(c.id || '')) continue;
      out.push('<' + c.tagName + ['src', 'href', 'alt', 'aria-label'].map((a) => (c.getAttribute(a) ? ` ${a}=${c.getAttribute(a)}` : '')).join(''));
      walk(c);
      out.push('>');
    }
  };
  walk(document.body);
  return out.join('\n');
}

export async function steady(stage) {
  const report = { layouts: {}, frozen: [] };
  const htmlOf = {};
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const p = path.join(stage, decodeURIComponent(u.pathname));
      if (!p.startsWith(stage) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      const ext = p.split('.').pop();
      res.writeHead(200, { 'content-type': CT[ext] || 'application/octet-stream', ...policyHeaders(ext) });
      // A trial page: the layout as it stands, without the owner scripts named in ?without=1,3.
      if (ext === 'html' && htmlOf[p] !== undefined) {
        const without = (u.searchParams.get('without') || '').split(',').filter(Boolean);
        return res.end(without.reduce((h, i) => h.replace(new RegExp(`<script\\b[^>]*data-pv-owner="${i}"[^>]*>[\\s\\S]*?</script>`), ''), htmlOf[p]));
      }
      fs.createReadStream(p).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await launch();
  const load = async (layout, without = []) => {
    const ctx = await browser.newContext({ ...PROFILES[layout].context });
    await ctx.addInitScript(() => { window.__pvStill = true; });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/${layout}.html?without=${without.join(',')}`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(SETTLE_MS);
      return await page.evaluate(snapshot);
    } finally { await ctx.close(); }
  };
  const agree = async (layout, without) => (await load(layout, without)) === (await load(layout, without));
  try {
    for (const layout of ['desktop', 'mobile']) {
      const file = path.join(stage, `${layout}.html`);
      if (!fs.existsSync(file)) continue;
      htmlOf[file] = fs.readFileSync(file, 'utf8');
      const owners = [...htmlOf[file].matchAll(/data-pv-owner="(\d+)"/g)].map((m) => m[1]);
      const r = report.layouts[layout] = { ownerScripts: owners.length, steady: true, frozen: [] };
      if (!owners.length || await agree(layout, [])) continue;
      r.steady = false;
      // One at a time, then all at once if no single script explains it.
      let off = null;
      for (const i of owners) if (await agree(layout, [i])) { off = [i]; break; }
      if (!off) off = owners;
      for (const i of off) {
        const m = new RegExp(`<script\\b[^>]*data-pv-owner="${i}"[^>]*>([\\s\\S]*?)</script>`).exec(htmlOf[file]);
        r.frozen.push({ script: i, what: (m?.[1] || '').replace(/^\{const Date=[^;]*;try\{/, '').trim().slice(0, 140) });
      }
      const html = off.reduce((h, i) => h.replace(new RegExp(`<script\\b[^>]*data-pv-owner="${i}"[^>]*>[\\s\\S]*?</script>`), ''), htmlOf[file]);
      fs.writeFileSync(file, html);
      htmlOf[file] = html;
      r.steadyAfter = await agree(layout, []);
      report.frozen.push(...r.frozen.map((f) => ({ layout, ...f })));
    }
  } finally { await browser.close(); srv.close(); }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await steady(path.resolve(process.argv[2])), null, 1));
}
