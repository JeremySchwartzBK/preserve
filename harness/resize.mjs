// Size check: parts sized once for one width (Squarespace's scripts measure the window and write fixed sizes into the
// page; a copy keeps those numbers, so they're only right at the width the capture saw). Ontario Lacrosse's slider and
// highlight marks were this family (2026-10-21). Three looks per extra width, each layout:
//   1. the copy opened at that width, compared with the live page opened at that width;
//   2. the copy opened at its capture width and then resized to that width, compared with (1): a resize-only fault;
//   3. a fixed-size detector: elements with sizes written into the page that kept them while their container changed
//      size, listed so new widget types turn up even before they look wrong.
// Usage: node resize.mjs <liveUrl> <copyBase e.g. http://127.0.0.1:8080/<id>> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { diffPct } from './check.mjs';
import { PROFILES, launch, sleep, OVERLAY_SELECTORS, markPromos } from './lib.mjs';

// One extra width per layout in the quality check (each costs two live loads and three copy loads); tests can pass more.
export const WIDTHS = { desktop: [1024], mobile: [360] };
const BASE = { desktop: 1440, mobile: 390 };

async function scrollThrough(page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight), vh = await page.evaluate(() => innerHeight);
  for (let y = 0; y < h + vh; y += Math.round(vh * 0.6)) { await page.evaluate((y) => scrollTo(0, y), y); await sleep(250); }
  await page.evaluate(() => scrollTo(0, 0)); await sleep(1200);
}

// Elements carrying written-in pixel sizes or offsets, with their size and their container's, keyed by position in
// the document so the same element can be found at another width.
const sizedElements = () => [...document.querySelectorAll('body *')].map((el, i) => {
  const st = el.getAttribute('style') || '';
  if (!/(^|;)\s*(width|height|left|top|transform|font-size)\s*:[^;]*\d(\.\d+)?px/.test(st)) return null;
  const p = el.parentElement; if (!p) return null;
  const r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
  if (r.width < 40 || pr.width < 40) return null;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return null;
  return { i, w: r.width, pw: pr.width, left: r.left - pr.left, cls: (el.className && typeof el.className === 'string' ? el.className.split(' ').filter((c) => c && !/^z[a-z0-9]{1,3}$/.test(c)).slice(0, 2).join('.') : '') || el.tagName.toLowerCase(), label: (el.closest('[id^="block-"],section') || el).id || '' };
}).filter(Boolean);

export async function resizeCheck(url, copyBase, outDir, { widths = WIDTHS } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const out = {};
  // The full page at the window's width: a few pixels sticking out sideways would otherwise widen the picture and
  // shift every row of the comparison.
  const shot = async (page, name) => {
    const f = path.join(outDir, name); await page.screenshot({ path: f + '.png' });
    const { w, h } = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
    await page.screenshot({ path: f + '-full.png', fullPage: true, clip: { x: 0, y: 0, width: w, height: h } }); return f;
  };
  const open = async (prof, w, target, { copy = false, startW } = {}) => {
    const c = PROFILES[prof].context;
    const ctx = await browser.newContext({ ...c, viewport: { width: startW || w, height: c.viewport.height }, ignoreHTTPSErrors: true });
    if (copy) {
      await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) || !/^http/.test(u.protocol) ? r.continue() : r.abort(); });
      await ctx.addInitScript(() => { window.__pvStill = true; });
    }
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: 'load', timeout: 90000 });
    if (!copy) await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(2000);
    if (startW) { await page.setViewportSize({ width: w, height: c.viewport.height }); await sleep(1500); }
    await scrollThrough(page);
    if (!copy) { await page.evaluate(markPromos).catch(() => 0); await page.addStyleTag({ content: OVERLAY_SELECTORS.join(',') + '{display:none!important}' }); await sleep(300); }
    // Anything pinned to the window other than the header (chat bubbles, cookie and promo bars that came late) is left
    // out of both pictures: the width comparison is about the page.
    await page.evaluate(() => document.querySelectorAll('body *').forEach((e) => { if (getComputedStyle(e).position === 'fixed' && !e.closest('header,#header,.header')) e.style.setProperty('visibility', 'hidden', 'important'); })).catch(() => 0);
    return { ctx, page };
  };
  try {
    for (const [prof, ws] of Object.entries(widths)) {
      // Written-in sizes at the capture width, to compare against each extra width.
      let atBase = [];
      try { const b = await open(prof, BASE[prof], `${copyBase}/${prof}`, { copy: true }); atBase = await b.page.evaluate(sizedElements); await b.ctx.close(); } catch {}
      for (const w of ws) {
        const r = { width: w };
        try {
          // The live page twice: how much it differs from itself (slideshows, animations) is allowed on top.
          const live = await open(prof, w, url); const lf = await shot(live.page, `live-${w}`); await live.ctx.close();
          const live2 = await open(prof, w, url); const lf2 = await shot(live2.page, `live2-${w}`); await live2.ctx.close();
          const fresh = await open(prof, w, `${copyBase}/${prof}`, { copy: true }); const cf = await shot(fresh.page, `copy-${w}`);
          const atW = await fresh.page.evaluate(sizedElements); await fresh.ctx.close();
          const moved = await open(prof, w, `${copyBase}/${prof}`, { copy: true, startW: BASE[prof] }); const mf = await shot(moved.page, `resized-${w}`); await moved.ctx.close();
          r.firstScreen = await diffPct(lf + '.png', cf + '.png');
          r.fullPage = await diffPct(lf + '-full.png', cf + '-full.png');
          r.liveNoise = { firstScreen: await diffPct(lf + '.png', lf2 + '.png'), fullPage: await diffPct(lf + '-full.png', lf2 + '-full.png') };
          r.resized = await diffPct(cf + '-full.png', mf + '-full.png', null, [], 1, null, { shift: 40 });
          // Fixed-size detector: an element that kept its exact written-in size although its container changed size,
          // and so now sticks out of its container (narrower width) or no longer fills it (wider width). Elements sized
          // by their own content, such as a highlight around a short phrase, keep their size and still fit: not flagged.
          const base = new Map(atBase.map((e) => [e.i, e]));
          r.fixedSize = atW.filter((e) => {
            const b = base.get(e.i); if (!b || Math.abs(e.pw - b.pw) < 20 || Math.abs(e.w - b.w) >= 1) return false;
            const r0 = b.w / b.pw;
            return r0 > 0.3 && r0 < 1.05 && (e.w > e.pw + 2 || (r0 > 0.9 && e.w < e.pw * 0.9));
          }).slice(0, 8).map((e) => ({ what: e.cls, block: e.label, widthPx: Math.round(e.w), containerPx: Math.round(e.pw) }));
        } catch (e) { r.error = String(e.message).split('\n')[0].slice(0, 200); }
        (out[prof] ||= []).push(r);
      }
    }
  } finally { await browser.close(); }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, copyBase, outDir] = process.argv.slice(2);
  console.log(JSON.stringify(await resizeCheck(url, copyBase, outDir), null, 1));
  process.exit(0);
}
