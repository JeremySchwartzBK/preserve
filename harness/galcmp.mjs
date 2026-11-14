// Compare every gallery on a live page with the same gallery in its Preserve, at one or more widths: where each picture
// sits at rest, after the arrows, and during and after a drag. usage:
//   node galcmp.mjs <liveUrl> <preserveUrl> <widths e.g. 1440,1728,390> [outDir]
import fs from 'node:fs';
import { launch, sleep, PROFILES, NEXT_SEL, PREV_SEL } from './lib.mjs';
const [liveUrl, copyUrl, widths = '1440,390', outDir = ''] = process.argv.slice(2);
const SEL = '.flickity-enabled, .user-items-list-carousel, .user-items-list-banner-slideshow, .gallery-reel, .gallery-fullscreen-slideshow, .gallery-slideshow, .gallery-strips, .gallery-grid, .gallery-masonry, .sqs-gallery-block-slideshow, .sqs-gallery-block-carousel, .sqs-gallery-block-grid, .sqs-gallery-block-stacked, .summary-block-wrapper, .user-items-list-simple';
const ren = (s) => s.replace(/\.sqs-/g, '.ps-');
const only = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : null;
const b = await launch();
async function open(url, w, h, copy) {
  const mobile = w < 768;
  const ctx = await b.newContext(mobile ? { ...PROFILES.mobile.context, viewport: { width: w, height: h || 844 }, deviceScaleFactor: 1 } : { viewport: { width: w, height: h || 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const u = copy && url.includes('{L}') ? url.replace('{L}', mobile ? 'mobile' : 'desktop') : copy ? url.replace(/\/(desktop|mobile)?(\?|$)/, '/' + (mobile ? 'mobile' : 'desktop') + '$2') : url;
  await page.goto(u, { waitUntil: 'load', timeout: 90000 }).catch((e) => console.error('goto', e.message.split('\n')[0]));
  await sleep(2500);
  if (!copy) await page.addStyleTag({ content: '.sqs-popup-overlay,.sqs-announcement-bar-dropzone,.sqs-cookie-banner-v2,[data-preserve-promo]{display:none!important}' }).catch(() => {});
  const H = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < H; y += 400) { await page.evaluate((y) => scrollTo(0, y), y); await sleep(120); }
  await page.evaluate(() => scrollTo(0, 0)); await sleep(500);
  return { ctx, page, mobile, copy };
}
const MEASURE = ([sel, i]) => {
  const g = document.querySelectorAll(sel)[i]; if (!g) return null;
  const gr = g.getBoundingClientRect();
  const vis = (e) => { let o = 1; for (let a = e; a && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden') return 0; o *= +s.opacity; } return o; };
  // the box pictures can show in: the gallery, cut by every clipping ancestor and the window
  let L = Math.max(0, gr.left), R = Math.min(innerWidth, gr.right);
  const out = [];
  const items = g.querySelectorAll('img').length >= 2 ? [...g.querySelectorAll('img')] : [...g.querySelectorAll('.list-item, .slide, [class*="__slide"]')];
  items.forEach((im, j) => {
    let r = im.getBoundingClientRect(); if (r.width < 8 || r.height < 8) return;
    // a picture the browser fits into its box (object-fit): where the picture itself is painted, not its box
    const cs = im.tagName === 'IMG' ? getComputedStyle(im) : null;
    if (cs && /cover|contain/.test(cs.objectFit) && im.naturalWidth) {
      const k = cs.objectFit === 'cover' ? Math.max(r.width / im.naturalWidth, r.height / im.naturalHeight) : Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight);
      const w = im.naturalWidth * k, h = im.naturalHeight * k, op = cs.objectPosition.split(' ').map((v) => parseFloat(v) / 100);
      r = { left: r.left + (r.width - w) * op[0], top: r.top + (r.height - h) * op[1], width: w, height: h, right: r.left + (r.width - w) * op[0] + w };
    }
    let l = r.left, rt = r.right;
    for (let a = im.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible') { const q = a.getBoundingClientRect(); l = Math.max(l, q.left); rt = Math.min(rt, q.right); } }
    l = Math.max(l, 0); rt = Math.min(rt, innerWidth);
    if (rt - l < 2) return; const o = vis(im); if (o < 0.05) return;
    out.push({ j, x: Math.round(r.left - gr.left), y: Math.round(r.top - gr.top), w: Math.round(r.width), h: Math.round(r.height), o: Math.round(o * 100) / 100 });
  });
  return { g: [Math.round(gr.width), Math.round(gr.height)], pics: out };
};
async function drive(p, sel, i, w, tag) {
  const { page, mobile } = p; const res = {};
  const ok = await page.evaluate(([sel, i]) => { const g = document.querySelectorAll(sel)[i]; if (!g) return false; g.scrollIntoView({ block: 'center' }); return true; }, [sel, i]);
  if (!ok) return null;
  await sleep(1500);
  const keys = await page.evaluate(([sel, i]) => (() => { const g = document.querySelectorAll(sel)[i]; return g.querySelectorAll('img').length >= 2 ? [...g.querySelectorAll('img')].map((im) => (im.getAttribute('data-src') || im.currentSrc || im.src || '').split('?')[0].split('/').pop()) : [...g.querySelectorAll('.list-item, .slide, [class*="__slide"]')].map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)); })(), [sel, i]);
  const m = () => page.evaluate(MEASURE, [sel, i]);
  const shot = async (name) => { if (!outDir) return; const box = await page.evaluate(([sel, i]) => { const r = document.querySelectorAll(sel)[i].getBoundingClientRect(); return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(innerWidth, r.right) - Math.max(0, r.left), height: Math.min(innerHeight, r.bottom) - Math.max(0, r.top) }; }, [sel, i]); if (box.width > 4 && box.height > 4) await page.screenshot({ path: `${outDir}/${tag}-${w}-g${i}-${name}.png`, clip: box }).catch(() => {}); };
  res.rest = await m(); await shot('rest');
  const arrow = async (which) => page.evaluate(([sel, i, n, pv, which]) => { const g = document.querySelectorAll(sel)[i]; const s = which > 0 ? n : pv; const sec = g.closest('section') || g.parentElement; const shown = (b) => { const r = b.getBoundingClientRect(); return r.width > 2 && getComputedStyle(b).visibility !== 'hidden'; }; const bt = [...new Set([...g.querySelectorAll(s), ...sec.querySelectorAll(s)])].find(shown); if (!bt) return false; bt.click(); return true; }, [sel, i, p.copy ? ren(NEXT_SEL) : NEXT_SEL, p.copy ? ren(PREV_SEL) : PREV_SEL, which]);
  if (await arrow(1)) { await sleep(250); res.nextMid = await m(); await sleep(1500); res.next1 = await m(); await shot('next1'); await arrow(1); await sleep(1700); res.next2 = await m(); await arrow(-1); await sleep(1700); res.prev1 = await m(); await arrow(-1); await sleep(1700); res.back = await m(); }
  // drag left by a third of the gallery (at most 300 px), hold, release
  const box = await page.evaluate(([sel, i]) => { const r = document.querySelectorAll(sel)[i].getBoundingClientRect(); return { x: Math.max(0, r.left), y: r.top, w: Math.min(innerWidth, r.right) - Math.max(0, r.left), h: r.height }; }, [sel, i]);
  const dx = -Math.round(Math.min(300, box.w / 3)), x0 = box.x + box.w / 2, y0 = Math.min(box.y + box.h / 2, (mobile ? 844 : 900) - 20);
  if (mobile) {
    const cdp = await p.ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx * k / 10, y: y0 }] }); await sleep(30); }
    await sleep(300); res.dragHeld = await m(); await shot('drag');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(x0, y0); await page.mouse.down();
    for (let k = 1; k <= 10; k++) { await page.mouse.move(x0 + dx * k / 10, y0); await sleep(30); }
    await sleep(300); res.dragHeld = await m(); await shot('drag');
    await page.mouse.up();
  }
  await sleep(1700); res.dragEnd = await m(); await shot('dragend');
  res.__keys = keys;
  return res;
}
const TOL = +(process.env.TOL || 3);
function diff(a, b) {
  // pictures matched by what they show (live file name, carried over by position in the page) and nearest place
  if (!a || !b) return { err: 'missing' };
  const out = { n: [a.pics.length, b.pics.length], max: 0, miss: 0, extra: 0 };
  const used = new Set();
  for (const p of a.pics) {
    let best = null, bd = 1e9;
    b.pics.forEach((q, i) => { if (used.has(i) || q.k !== p.k) return; const d = Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y), Math.abs(q.w - p.w), Math.abs(q.h - p.h)); if (d < bd) { bd = d; best = i; } });
    if (best === null) out.miss++; else { used.add(best); out.max = Math.max(out.max, bd); }
  }
  out.extra = b.pics.length - used.size;
  out.ok = out.max <= TOL && !out.miss && !out.extra;
  return out;
}
const report = [];
for (const ws of widths.split(',')) {
  const [w, h] = ws.split('x').map(Number);
  const live = await open(liveUrl, w, h, false), copy = await open(copyUrl, w, h, true);
  const nl = await live.page.evaluate((s) => document.querySelectorAll(s).length, SEL), nc = await copy.page.evaluate((s) => document.querySelectorAll(s).length, ren(SEL));
  const kinds = await live.page.evaluate((s) => [...document.querySelectorAll(s)].map((g) => { const r = g.getBoundingClientRect(); return (g.getAttribute('class') || '').trim().split(/\s+/).filter((c) => /carousel|slideshow|reel|strips|grid|masonry|stacked|simple|summary-block-wrapper$/.test(c))[0] + (r.width < 50 || r.height < 30 || (g.querySelectorAll('img').length < 2 && g.querySelectorAll('.list-item, .slide, [class*="__slide"]').length < 2) ? ':skip' : ''); }), SEL);
  if (nl !== nc) console.log(`W${ws}: gallery count differs live ${nl} copy ${nc}`);
  for (let i = 0; i < nl; i++) {
    if (kinds[i].endsWith(':skip') || (only && !only.includes(i))) continue;
    await live.page.bringToFront(); const a = await drive(live, SEL, i, ws, 'live'); await copy.page.bringToFront(); const c = await drive(copy, ren(SEL), i, ws, 'copy');
    const keys = (a && a.__keys) || []; if (a) delete a.__keys; if (c) delete c.__keys;
    for (const r of [a, c]) for (const k in r || {}) if (r[k]) r[k].pics.forEach((q) => { q.k = keys[q.j]; });
    const row = { w: ws, i, kind: kinds[i], stages: {} };
    for (const k of Object.keys(a || {})) row.stages[k] = diff(a[k], c && c[k]);
    row.raw = { live: a, copy: c };
    report.push(row);
    const bad = Object.entries(row.stages).filter(([, d]) => !d.ok);
    console.log(`W${ws} g${i} ${kinds[i].padEnd(34)} ${bad.length ? 'DIFFERS' : 'ok     '} ` + Object.entries(row.stages).map(([k, d]) => `${k}:${d.err || (d.ok ? 'ok' : `max${d.max}${d.miss ? ' miss' + d.miss : ''}${d.extra ? ' extra' + d.extra : ''}`)}`).join(' '));
  }
  await live.ctx.close(); await copy.ctx.close();
}
if (outDir) fs.writeFileSync(`${outDir}/report.json`, JSON.stringify(report));
await b.close();
