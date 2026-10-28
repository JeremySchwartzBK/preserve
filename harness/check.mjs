// Checks what works and what breaks on a page: errors, overlays, images, scroll animations, menus,
// galleries, the replica notice, and pixel difference against the original.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { PROFILES, launch, sleep, OVERLAY_SELECTORS, NEXT_SEL, GALLERY_SEL } from './lib.mjs';



const BLUR = 2.5;
export async function diffPct(aPath, bPath, maxH, mask = [], dpr = 1, debugOut = null, opts = {}) {
  if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) return null;
  const a = sharp(aPath), b = sharp(bPath);
  const [ma, mb] = await Promise.all([a.metadata(), b.metadata()]);
  const w = Math.min(ma.width, mb.width, 800);
  const ha = Math.round(ma.height * w / ma.width), hb = Math.round(mb.height * w / mb.width);
  const h = Math.min(hb, maxH ? Math.round(maxH * w / mb.width) : 1e9, 6000);   // compared height, in the copy
  // Rows may line up with live rows up to SHIFT px (of 800 wide) away: far on a full page, where one taller block moves
  // everything below it, but only a little on the first screen, where things moving around is what we look for.
  const SHIFT = typeof opts.shift === 'number' ? opts.shift : ha > 1.5 * (w * 0.75) ? 300 : 40;
  const hA = Math.min(ha, h + SHIFT);
  // A light blur so a photo cropped a pixel or two differently, or text drawn a hair apart, does not count as changed.
  const raw = async (p, full, hh) => (await sharp(p).resize({ width: w, height: full }).extract({ left: 0, top: 0, width: w, height: hh }).blur(BLUR).ensureAlpha().raw().toBuffer());
  const [ra0, rb] = await Promise.all([raw(aPath, ha, hA), raw(bPath, hb, h)]);
  // Line the live page up with the copy row by row (dynamic time warping on rows, within ±SHIFT): a block a few
  // pixels taller higher up, or wrapped text, shifts everything below it, which would otherwise count as the whole
  // rest of the page being different. Rows are matched in order, so a missing or extra block still shows as changed.
  const gw = Math.ceil(w / 4);
  const gray = (buf, hh) => { const g = new Uint8Array(gw * hh); for (let y = 0; y < hh; y++) for (let x = 0, c = 0; x < w; x += 4, c++) { const i = (y * w + x) * 4; g[y * gw + c] = (buf[i] * 3 + buf[i + 1] * 6 + buf[i + 2]) / 10; } return g; };
  const ga = gray(ra0, hA), gb = gray(rb, h);
  const rowCost = (i, j) => { let c = 0; const a_ = j * gw, b_ = i * gw; for (let x = 0; x < gw; x++) c += Math.abs(ga[a_ + x] - gb[b_ + x]); return c; };
  const S = SHIFT, W2 = 2 * S + 1, GAP = gw * (opts.gap ?? 6), INF = 1e15;
  let prevRow = new Float64Array(W2).fill(INF), cur = new Float64Array(W2);
  const from = new Uint8Array(h * W2);   // 0 diagonal, 1 copy row repeats live row, 2 live row skipped
  for (let i = 0; i < h; i++) {
    cur.fill(INF);
    for (let k = 0; k < W2; k++) {
      const j = i + k - S; if (j < 0 || j >= hA) continue;
      const c = rowCost(i, j);
      // Standard DTW: from (i-1, j-1); from (i-1, j) = an extra copy row; from (i, j-1) = an extra live row.
      let best = i === 0 && j === 0 ? 0 : INF, dir = 0;
      if (i > 0 && prevRow[k] < best) { best = prevRow[k]; dir = 0; }
      if (i > 0 && k + 1 < W2 && prevRow[k + 1] + GAP < best) { best = prevRow[k + 1] + GAP; dir = 1; }
      if (k > 0 && cur[k - 1] + GAP < best) { best = cur[k - 1] + GAP; dir = 2; }
      if (i === 0 && j > 0 && k > 0) { best = cur[k - 1] + GAP; dir = 2; }
      cur[k] = best + c; from[i * W2 + k] = dir;
    }
    [prevRow, cur] = [cur, prevRow];
  }
  // Backtrack from the best end, recording the live row each copy row is matched to.
  const match = new Int32Array(h);
  let q = 0; for (let kk = 1; kk < W2; kk++) if (prevRow[kk] < prevRow[q]) q = kk;   // the copy may end before the live page
  for (let i = h - 1; i >= 0;) {
    match[i] = i + q - S;
    const dir = from[i * W2 + q];
    if (dir === 0) i--; else if (dir === 1) { i--; q++; } else { q--; if (q < 0) break; }
  }
  const ra = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) { const ya = match[y]; if (ya >= 0 && ya < hA) ra0.copy(ra, y * w * 4, ya * w * 4, (ya + 1) * w * 4); }
  // Masked areas (page pixels, measured on the copy) are made identical in both images and not counted. Page pixels
  // are CSS pixels; screenshots on phone are taken at 3x.
  const k = w / mb.width * dpr; let masked = 0;
  for (const m of mask || []) {
    const x0 = Math.max(0, Math.floor(m.x * k)), x1 = Math.min(w, Math.ceil((m.x + m.w) * k)), y0 = Math.max(0, Math.floor(m.y * k)), y1 = Math.min(h, Math.ceil((m.y + m.h) * k));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; ra[i] = rb[i]; ra[i + 1] = rb[i + 1]; ra[i + 2] = rb[i + 2]; ra[i + 3] = rb[i + 3]; masked++; }
  }
  const diff = Buffer.alloc(w * h * 4);
  const n = pixelmatch(ra, rb, diff, w, h, { threshold: 0.15, diffMask: true });
  if (debugOut) { await sharp(diff, { raw: { width: w, height: h, channels: 4 } }).png().toFile(debugOut); await sharp(ra, { raw: { width: w, height: h, channels: 4 } }).png().toFile(debugOut.replace('.png', '-live.png')); }
  const area = Math.max(1, w * h - masked);
  // Where the difference is: the 100-px bands (of the 800-px-wide comparison) with the most changed pixels, as
  // points in the copy's page pixels, so the app can pin each one on the block it falls in.
  const band = 100, cells = [];
  for (let y0 = 0; y0 < h; y0 += band) {
    let cnt = 0, sx = 0;
    for (let y = y0; y < Math.min(h, y0 + band); y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (diff[i + 3] && diff[i] > 200 && diff[i + 1] < 100) { cnt++; sx += x; } }  // red = changed; yellow (anti-aliasing) is ignored
    if (cnt > band * w * 0.08) cells.push({ x: Math.round(sx / cnt / k), y: Math.round((y0 + band / 2) / k), share: cnt / (band * w) });
  }
  const hot = cells.sort((p, q) => q.share - p.share).filter((c, i, all) => all.slice(0, i).every((o) => Math.abs(o.y - c.y) > 300 / k)).slice(0, 3);
  return { pct: +(100 * n / area).toFixed(1), heightRatio: +(hb / ha).toFixed(2), hot, ...(masked ? { maskedPct: +(100 * masked / (w * h)).toFixed(1) } : {}) };
}

// Where a finding is, in the same terms the app's review pins use (block id + position inside it), so the app can
// show the finding as a pin. Keep in step with blk()/idOf() in platform/worker/src/index.js.
const ANCHOR = () => {
  window.__preserveAnchor = (e, px, py) => {
    const b = (e && e.closest && (e.closest('[id^="block-"],.sqs-block,.ps-block,[data-block-id],section[data-section-id]') || e.closest('header,footer'))) || document.body;
    const id = b === document.body ? 'el:body' : /^(HEADER|FOOTER)$/.test(b.tagName) && !b.id ? 'el:' + b.tagName.toLowerCase() : b.id || b.getAttribute('data-block-id') || 'section:' + b.getAttribute('data-section-id');
    const r = b.getBoundingClientRect(), er = e?.getBoundingClientRect?.() || r;
    // Centre of the part of the element inside its block: a wide strip (a gallery reel) marks its visible part.
    const mid = (a1, a2, b1, b2) => { const lo = Math.max(a1, b1), hi = Math.min(a2, b2); return hi > lo ? (lo + hi) / 2 : (a1 + a2) / 2; };
    const cx = px ?? mid(er.left, er.right, r.left, r.right), cy = py ?? mid(er.top, er.bottom, r.top, r.bottom);
    const f = (v) => +Math.min(1, Math.max(0, v)).toFixed(3);
    return { blockId: id, x: f((cx - r.left) / (r.width || 1)), y: f((cy - r.top) / (r.height || 1)), pageY: Math.round(cy + scrollY), label: (b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80) };
  };
};

const shotHash = async (loc) => { try { const b = await loc.screenshot({ timeout: 3000 }); return b.toString('base64').length + ':' + b.subarray(b.length / 2, b.length / 2 + 64).toString('hex'); } catch { return null; } };

// Galleries, carousels and slideshows, each one on the page (2026-10-28; before, only the first "next" arrow was tried).
// Run in a page of its own, without __pvStill, so our slideshow scripts play the way a visitor sees them. For each:
// does it move by itself (watched for a few seconds once it holds still), does its "next" arrow move it, and does every slide it shows draw
// its picture. Galleries are keyed by block id so gate.mjs can hold the copy's to the live page's.
const SETTLE_MS = 5000, WATCH_MS = 7000, MAX_GALLERIES = 6;
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');

export async function probeGalleries(browser, url, profileName, { isCopy = false } = {}) {
  const ctx = await browser.newContext({ ...PROFILES[profileName].context, ignoreHTTPSErrors: true });
  if (isCopy) await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) || !/^http/.test(u.protocol) ? r.continue() : r.abort(); });
  await ctx.addInitScript(ANCHOR);
  const page = await ctx.newPage();
  const out = [];
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (!isCopy) await page.addStyleTag({ content: OVERLAY_SELECTORS.join(',') + '{display:none!important}' }).catch(() => {});
    const h = await page.evaluate(() => document.documentElement.scrollHeight), vh = await page.evaluate(() => innerHeight);
    for (let y = 0; y < h; y += Math.round(vh * 0.7)) { await page.evaluate((y) => scrollTo(0, y), y); await sleep(250); }
    await page.mouse.move(0, 0);
    const found = await page.evaluate(([gSel, nSel, max]) => {
      const shown = (e) => { for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.05) return false; } const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
      const pics = (e) => e.querySelectorAll('img, .swiper-slide, [data-slide-index], .slide').length;
      const cand = new Set([...document.querySelectorAll(gSel)]);
      for (const b of document.querySelectorAll(nSel)) if (shown(b)) { const c = b.closest(gSel) || b.parentElement?.parentElement; if (c) cand.add(c); }
      // One per block: the outermost candidate that is on screen, big enough and holds more than one picture.
      const byBlock = new Map();
      for (const c of cand) {
        const r = c.getBoundingClientRect();
        if (r.width < 100 || r.height < 60 || !shown(c) || pics(c) < 2) continue;
        const a = window.__preserveAnchor(c);
        const prev = byBlock.get(a.blockId);
        if (!prev || c.contains(prev)) byBlock.set(a.blockId, c);
      }
      return [...byBlock.values()].slice(0, max).map((c, i) => {
        c.setAttribute('data-pv-g', i);
        const block = c.closest('[id^="block-"],.sqs-block,.ps-block,[data-block-id],section[data-section-id]') || c;
        const btn = [...c.querySelectorAll(nSel), ...block.querySelectorAll(nSel)].find(shown);
        if (btn) btn.setAttribute('data-pv-gn', i);
        return { i, key: window.__preserveAnchor(c).blockId, anchor: window.__preserveAnchor(c), arrow: btn ? window.__preserveAnchor(btn) : null };
      });
    }, [GALLERY_SEL, NEXT_SEL, MAX_GALLERIES]);

    // Pinned things outside the galleries (menus, badges) would sit in a gallery's picture: hide them while probing.
    await page.evaluate(() => { for (const e of document.querySelectorAll('body *')) { const p = getComputedStyle(e).position; if ((p === 'fixed' || p === 'sticky') && !e.querySelector('[data-pv-g]') && !e.closest('[data-pv-g]')) e.style.setProperty('visibility', 'hidden', 'important'); } });
    // A picture of the part of the gallery on screen (a reel can be far wider than the window).
    const shot = async (i) => {
      const box = await page.evaluate((i) => { const r = document.querySelector(`[data-pv-g="${i}"]`)?.getBoundingClientRect(); if (!r) return null; const x = Math.max(0, r.left), y = Math.max(0, r.top); return { x, y, width: Math.min(innerWidth, r.right) - x, height: Math.min(innerHeight, r.bottom) - y }; }, i);
      if (!box || box.width < 10 || box.height < 10) return null;
      try { return sha(await page.screenshot({ clip: box, timeout: 5000 })); } catch { return null; }
    };
    // Where its slides are, as the page's own state (positions, transforms, which slide is active, scroll offsets): it
    // sees the gallery alone, where a picture would also catch a spinning badge or a pinned menu drawn over it.
    const state = (i) => page.evaluate((i) => {
      const g = document.querySelector(`[data-pv-g="${i}"]`); if (!g) return null;
      let h = 0;
      for (const e of [g, ...g.querySelectorAll('*')].slice(0, 800)) {
        const c = getComputedStyle(e);
        const v = [e.className?.baseVal ?? e.className, c.transform, c.translate, c.left, c.top, c.marginLeft, c.opacity, c.visibility, e.scrollLeft, e.currentSrc || ''].join('|');
        for (let k = 0; k < v.length; k++) h = (h * 31 + v.charCodeAt(k)) | 0;
      }
      return h;
    }, i).catch(() => null);
    // Pictures in the visible part of the gallery that never drew (waits up to 2 s for ones still loading).
    const blank = async (i) => {
      for (let t = 0; t < 5; t++) {
        const n = await page.evaluate((i) => {
          const g = document.querySelector(`[data-pv-g="${i}"]`); if (!g) return 0;
          const gr = g.getBoundingClientRect();
          return [...g.querySelectorAll('img')].filter((im) => {
            const r = im.getBoundingClientRect();
            const w = Math.min(r.right, gr.right, innerWidth) - Math.max(r.left, gr.left, 0), h = Math.min(r.bottom, gr.bottom, innerHeight) - Math.max(r.top, gr.top, 0);
            if (w < 40 || h < 40) return false;
            for (let a = im; a && a !== g.parentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.1) return false; }
            return !(im.currentSrc || im.getAttribute('src')) || !im.complete || im.naturalWidth === 0;
          }).length;
        }, i);
        if (!n || t === 4) return n;
        await sleep(500);
      }
    };

    for (const g of found) {
      await page.evaluate((i) => document.querySelector(`[data-pv-g="${i}"]`)?.scrollIntoView({ block: 'center' }), g.i);
      await sleep(1500);
      const r = { key: g.key, anchor: g.anchor, arrow: g.arrow, autoplay: false, next: g.arrow ? 'unknown' : 'n/a', blankSlides: 0 };
      // Watch it: a change with nothing touched means it plays by itself. It first has to hold still for a second
      // (pictures fading in as they load are not autoplay); one that never holds still is moving all the time.
      let h0 = await state(g.i), still = false;
      for (let t = 0; t < SETTLE_MS && h0 != null; t += 1000) {
        await sleep(1000);
        const h1 = await state(g.i);
        if (h1 === h0) { still = true; break; }
        h0 = h1;
      }
      r.blankSlides = await blank(g.i);
      if (h0 != null && !still) r.autoplay = true;
      for (let t = 0; t < WATCH_MS && h0 != null && still; t += 500) {
        await sleep(500);
        const h1 = await state(g.i);
        if (h1 != null && h1 !== h0) { r.autoplay = true; break; }
      }
      if (r.autoplay) { await sleep(1200); r.blankSlides = Math.max(r.blankSlides, await blank(g.i)); }
      // Its arrow: right after an autoplay step (or any time, if it is still), so the next step can't be mistaken for it.
      if (g.arrow) {
        const before = await shot(g.i);
        await page.locator(`[data-pv-gn="${g.i}"]`).click({ timeout: 3000 }).catch(() => {});
        await sleep(1200);
        await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(0, 0); await sleep(200);
        const after = await shot(g.i);
        r.next = !before || !after ? 'unknown' : before !== after ? 'pass' : 'fail';
        if (r.next === 'pass') r.blankSlides = Math.max(r.blankSlides, await blank(g.i));
      }
      out.push(r);
    }
  } catch (e) { out.error = String(e.message).split('\n')[0]; }
  await ctx.close();
  return out;
}

export async function check(url, profileName, { refDir, shotPrefix, isCopy }) {
  const prof = PROFILES[profileName];
  const browser = await launch();
  const ctx = await browser.newContext({ ...prof.context, ignoreHTTPSErrors: true });
  const external = new Set();
  if (isCopy) await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname) || !/^http/.test(u.protocol)) return r.continue(); external.add(u.hostname); return r.abort(); });
  // Our slideshow script holds still, showing the slide the capture saw, so the copy compares with the live shots.
  if (isCopy) await ctx.addInitScript(() => { window.__pvStill = true; });
  const page = await ctx.newPage();
  const errors = [], consoleErrors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) consoleErrors.push(m.text().slice(0, 160)); });
  const out = { url, profile: profileName, spots: {} };
  await ctx.addInitScript(ANCHOR);
  let navs = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
  // Spots of one finding that land on the same place in a block are one spot, so no marker hides under another.
  const near = (a, b) => a.blockId === b.blockId && Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05;
  const spot = (code, list) => { for (const p of list || []) { const cur = out.spots[code] || []; if (cur.length < 3 && !cur.some((q) => near(p, q))) out.spots[code] = [...cur, p]; } };
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  } catch (e) { out.loadError = String(e.message).split('\n')[0]; }
  await sleep(4000);
  // A page that keeps reloading itself (a copy flipping between its phone and computer layouts) can't be checked.
  if (isCopy && navs > 1) {
    out.loadError = `the page keeps reloading itself (${navs} times in 4 seconds; last ${new URL(page.url()).pathname})`;
    out.externalRequests = [...external]; out.pageErrors = errors.length; out.errorSamples = [];
    await browser.close(); return out;
  }
  // Marketing overlays still on screen. (Squarespace 7.0 parallax backgrounds are fixed layers too, but design.)
  out.overlaysVisible = await page.evaluate((sels) => {
    const vis = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05 && r.width > 0 && r.height > 0; };
    const named = [...document.querySelectorAll(sels.join(','))].filter(vis).map((e) => e.className.toString().slice(0, 40));
    const big = [...document.querySelectorAll('body *')].filter((e) => { const s = getComputedStyle(e); if (s.position !== 'fixed' || !vis(e)) return false; const r = e.getBoundingClientRect(); return r.width * r.height > innerWidth * innerHeight * 0.3 && !e.closest('header,#header,.header') && !/parallax/i.test(e.className.toString()); }).map((e) => 'fixed:' + e.className.toString().slice(0, 40));
    return [...named, ...big].slice(0, 5);
  }, OVERLAY_SELECTORS);
  if (out.overlaysVisible.length) spot('overlay-left', await page.evaluate((sels) => [...document.querySelectorAll(sels.join(','))].filter((e) => e.getBoundingClientRect().width > 0).slice(0, 3).map((e) => window.__preserveAnchor(e)), OVERLAY_SELECTORS));
  await page.screenshot({ path: `${shotPrefix}-${profileName}.png` });
  // Squarespace video can't play in the capture browser (no H.264), so the live reference shows a blank or an error
  // where the copy plays its saved video. Those areas are left out of the picture comparison.
  const videoRects = () => page.evaluate(() => [...document.querySelectorAll('video')].map((v) => { const r = v.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }).filter((r) => r.w > 20 && r.h > 20));
  out.videoMask = await videoRects().catch(() => []);
  // Scroll through, then look for broken images and elements stuck invisible (scroll animations that never ran).
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = prof.context.viewport.height;
  // An element counts as stuck only if it was invisible while on screen and is still invisible after the whole page
  // has been scrolled through and given time to animate (an entrance fade caught mid-way is not stuck).
  for (let y = 0; y < h; y += Math.round(vh * 0.7)) {
    await page.evaluate((y) => scrollTo(0, y), y);
    await sleep(500);
    await page.evaluate(() => {
      for (const e of document.querySelectorAll('[class*="preFade"],[class*="preScale"],[class*="preSlide"],[class*="preClip"],[data-animation-role],.sqs-block-image,.sqs-block-html,.sqs-block-gallery,.ps-block-image,.ps-block-html,.ps-block-gallery')) {
        const r = e.getBoundingClientRect();
        if (r.top < innerHeight * 0.8 && r.bottom > innerHeight * 0.2 && r.left < innerWidth && r.right > 0 && r.height > 10 && +getComputedStyle(e).opacity < 0.1) e.setAttribute('data-preserve-was-hidden', '');
      }
    });
  }
  await sleep(2500);
  const stuckList = await page.evaluate(() => [...document.querySelectorAll('[data-preserve-was-hidden]')].filter((e) => {
    // Hidden on purpose by an ancestor (closed menus, inactive slides) is not an animation that failed.
    for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden') return false; }
    let o = 1; for (let a = e; a; a = a.parentElement) o *= +getComputedStyle(a).opacity;
    return o < 0.1;
  }).map((e) => (e.className.toString() || e.tagName).slice(0, 60)));
  const stuck = stuckList.length;
  out.stuckInvisible = stuck; out.stuckSamples = stuckList.slice(0, 4);
  // Faces the page actually drew with, once scrolled through (a browser loads a face only when text needs it), so the
  // review lists only fonts a visitor sees.
  out.fontsUsed = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => ({ family: f.family.replace(/^["']|["']$/g, ''), weight: f.weight, style: f.style })));
  // Positions are taken at the top of the page; block-relative positions don't depend on the scroll.
  if (stuck) spot('blocks-stay-invisible', await page.evaluate(() => [...document.querySelectorAll('[data-preserve-was-hidden]')].filter((e) => { let o = 1; for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden') return false; o *= +s.opacity; } return o < 0.1; }).slice(0, 3).map((e) => window.__preserveAnchor(e))));
  spot('broken-images', await page.evaluate(() => [...document.images].filter((i) => i.getBoundingClientRect().height > 20 && i.complete && i.naturalWidth === 0 && getComputedStyle(i).display !== 'none').slice(0, 3).map((i) => window.__preserveAnchor(i))));
  // Blocks with their page positions, to place picture differences (measured later, after the browser closes).
  out.pageSize = await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
  out.blockRects = await page.evaluate(() => [...document.querySelectorAll('[id^="block-"],.sqs-block,.ps-block,[data-block-id],section[data-section-id],header,footer')].map((b) => { const r = b.getBoundingClientRect(); return { el: b, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }).filter((r) => r.w > 10 && r.h > 10).map((r) => { const a = window.__preserveAnchor(r.el.firstElementChild || r.el, r.x - scrollX + 1, r.y - scrollY + 1); return { blockId: a.blockId, label: a.label, x: r.x, y: r.y, w: r.w, h: r.h }; }));
  // Images that will never draw (emmagrinteriors' gallery, 2026-10-27): no file at all (a loader placeholder saved before
  // the loader ran), or a lazy image with a box 0 wide or high, which the browser never counts as near enough to load.
  // Only where there is room for a picture (a hidden slide or a closed menu doesn't count).
  const blankList = await page.evaluate(() => [...document.images].filter((i) => {
    for (let a = i; a; a = a.parentElement) if (getComputedStyle(a).display === 'none') return false;
    const p = i.parentElement?.getBoundingClientRect(); if (!p || p.width < 10 || p.height < 10) return false;
    if (!i.getAttribute('src') && !i.getAttribute('srcset')) return true;
    const r = i.getBoundingClientRect();
    return !i.complete && (r.width === 0 || r.height === 0);
  }).map((i) => window.__preserveAnchor(i.getBoundingClientRect().width > 4 ? i : i.parentElement)));
  out.blankImages = blankList.length;
  spot('blank-images', blankList);
  out.brokenImages = await page.evaluate(() => [...document.images].filter((i) => i.getBoundingClientRect().height > 20 && i.complete && i.naturalWidth === 0 && getComputedStyle(i).display !== 'none').length);
  out.blankImages = await page.evaluate(() => [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.height > 20 && r.width > 20 && !i.getAttribute('src') && !i.currentSrc; }).length);
  await page.screenshot({ path: `${shotPrefix}-full-${profileName}.png`, fullPage: true }).catch(() => {});
  await page.evaluate(() => scrollTo(0, 0)); await sleep(600);

  // Mobile menu or desktop dropdown.
  if (profileName === 'mobile') {
    const btn = page.locator('.header-burger-btn, .burger, [class*="burger"] button, button[aria-label*="menu" i]').filter({ visible: true }).first();
    if (await btn.count()) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await sleep(1000);
      out.mobileMenu = await page.evaluate(() => {
        if (/menu-open|menu--open|open-menu/.test(document.body.className + ' ' + (document.querySelector('header')?.className || ''))) return 'pass';
        const m = document.querySelector('.header-menu, [class*="mobile-menu"], [class*="menu-overlay"]');
        if (!m) return 'fail';
        const s = getComputedStyle(m); const r = m.getBoundingClientRect();
        return s.visibility !== 'hidden' && +s.opacity > 0.5 && r.height > 100 ? 'pass' : 'fail';
      });
      if (out.mobileMenu === 'fail') spot('phone-menu-broken', [await btn.evaluate((e) => window.__preserveAnchor(e)).catch(() => null)].filter(Boolean));
      await page.screenshot({ path: `${shotPrefix}-menu-${profileName}.png` });
      await btn.click({ timeout: 2000 }).catch(() => {}); await sleep(600);
    } else out.mobileMenu = 'n/a';
  } else {
    const folder = page.locator('.header-nav-folder-title').filter({ visible: true }).first();
    if (await folder.count()) {
      await folder.hover({ timeout: 3000 }).catch(() => {}); await sleep(700);
      out.dropdown = await page.evaluate(() => { const c = document.querySelector('.header-nav-item--folder:hover .header-nav-folder-content, .header-nav-folder-content'); if (!c) return 'fail'; const s = getComputedStyle(c); return s.visibility !== 'hidden' && +s.opacity > 0.5 && c.getBoundingClientRect().height > 10 ? 'pass' : 'fail'; });
      if (out.dropdown === 'fail') spot('dropdown-broken', [await folder.evaluate((e) => window.__preserveAnchor(e)).catch(() => null)].filter(Boolean));
    } else out.dropdown = 'n/a';
  }

  // Galleries / carousels / slideshows: see probeGalleries. out.gallery sums them up for older readers.
  out.galleries = await probeGalleries(browser, url, profileName, { isCopy });
  out.gallery = !out.galleries.length ? 'n/a' : out.galleries.some((g) => g.next === 'fail') ? 'fail' : out.galleries.some((g) => g.autoplay || g.next === 'pass') ? 'pass' : 'unknown';

  // Replica notice on a navigation link (copies only).
  if (isCopy) {
    // A page link a visitor can actually tap: on screen once scrolled to, not covered by anything, outside menus.
    const marked = await page.evaluate(async () => {
      for (const a of document.querySelectorAll('a[href]')) {
        const h = a.getAttribute('href') || '';
        if (!/^(\/[^/]|https?:)/.test(h) || h === '/' || a.matches('[data-folder-id]') || a.closest('.header-menu, nav, header')) continue;
        a.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 150));
        const r = a.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && (hit === a || a.contains(hit))) { a.setAttribute('data-preserve-probe', ''); return h.slice(0, 80); }
      }
      return null;
    });
    out.replicaProbe = marked;
    if (marked) {
      // Links inside moving rows (drifting testimonials, marquees) can slide out from under the pointer, so a miss is
      // retried; leaving the page at any point is a failure.
      const before = page.url();
      out.replicaNotice = 'fail';
      for (let i = 0; i < 3 && page.url() === before; i++) {
        await page.locator('[data-preserve-probe]').click({ timeout: 3000, force: true }).catch(() => {}); await sleep(500);
        if (page.url() === before && (await page.locator('text=preview copy of the site').count())) { out.replicaNotice = 'pass'; break; }
      }
      if (out.replicaNotice === 'fail' && page.url() === before) spot('replica-notice-missing', [await page.locator('[data-preserve-probe]').evaluate((e) => window.__preserveAnchor(e)).catch(() => null)].filter(Boolean));
    } else out.replicaNotice = 'n/a';
  }

  out.pageErrors = errors.length; out.errorSamples = [...new Set(errors)].slice(0, 3);
  out.consoleErrors = consoleErrors.length;
  out.externalRequests = [...external];
  await browser.close();
  if (refDir) {
    const dpr = prof.context.deviceScaleFactor || 1;
    out.diffFirstScreen = await diffPct(`${refDir}/ref-${profileName}.png`, `${shotPrefix}-${profileName}.png`, null, out.videoMask, dpr);
    out.diffFullPage = await diffPct(`${refDir}/ref-full-${profileName}.png`, `${shotPrefix}-full-${profileName}.png`, null, out.videoMask, dpr);
    // Each difference area goes on the smallest block that contains it.
    // A point outside every block (a full-width banner, say) goes on the page itself.
    const place = (pt) => { const b = (out.blockRects || []).filter((r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h).sort((p, q) => p.w * p.h - q.w * q.h)[0]
      || (out.pageSize && { blockId: 'el:body', label: '', x: 0, y: 0, ...out.pageSize }); return b ? { blockId: b.blockId, label: b.label, pageY: Math.round(pt.y), x: +Math.min(1, (pt.x - b.x) / b.w).toFixed(3), y: +Math.min(1, (pt.y - b.y) / b.h).toFixed(3) } : null; };
    spot('first-screen-differs', (out.diffFirstScreen?.hot || []).slice(0, 1).map(place).filter(Boolean));  // one: the first screen is small
    spot('page-differs', (out.diffFullPage?.hot || []).map(place).filter(Boolean));
  }
  delete out.blockRects; delete out.pageSize;
  return out;
}
