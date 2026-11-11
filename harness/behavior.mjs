// What a page DOES, block by block, so the check can hold the copy to the live page on behavior and not only on how it
// looks while idle (plan "A more robust Preserve quality check", step 2; Jeremy approved 2026-11-11). Every miss in his
// spot-checks was behavior: a drag gallery (Sunnie), animated GIF letters flattened (Potted Plant), a glow following the
// mouse (Backbipoc), film grain, hero videos playing behind their still (Gather, Colorize), scroll-linked effects
// (Naughty Nancy, State of Sage, Andamiro's header). probeMotion only watches parts that move by themselves with the
// mouse parked; this probe also hovers, drags and scrolls, the same gestures on the live page and on the copy, and asks
// "did this block change?" rather than "how many pixels differ?".
//
// Returned per page (keys are block ids from __preserveAnchor, sections as section:<id>, the header as el:header):
//   animated  { block: n }      pictures with more than one frame (GIF, WebP, AVIF), read from the files themselves
//   videos    [{ at, playing, hiddenBy }]   a playing video that a picture sits over (copy only; live can't play H.264)
//   hover     { block: frac }   largest share of the block that changed while the mouse swept over the screen (desktop)
//   drag      { block: { idle, dragged } }  carousels/strips: change from a drag vs. change from waiting as long
//   scroll    { key: { idle, scrolled } }   sections and the header: change after scrolling, lined up on the section
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { PROFILES, sleep, OVERLAY_SELECTORS, markPromos } from './lib.mjs';
import { ANCHOR } from './check.mjs';

export const SCREENS = 3;             // screens hovered (desktop), as probeMotion watches
const HOVER_GRID = [4, 6];            // rows x columns the mouse visits on each screen
const MAX_IMAGES = 80, MAX_DRAG = 5, MAX_SECTIONS = 14;
const PX = 48;                        // a pixel counts as changed past this sum of channel differences (probeMotion's)

// Share of a rectangle (in a screenshot's pixels) that changed between two screenshots; b may be offset by (dx, dy).
function changed(a, b, r, dx = 0, dy = 0) {
  let n = 0, c = 0;
  for (let y = Math.max(0, r.y); y < Math.min(a.height, r.y + r.h); y += 2) {
    const yb = y + dy; if (yb < 0 || yb >= b.height) continue;
    for (let x = Math.max(0, r.x); x < Math.min(a.width, r.x + r.w); x += 2) {
      const xb = x + dx; if (xb < 0 || xb >= b.width) continue;
      const i = (y * a.width + x) * 4, j = (yb * b.width + xb) * 4;
      n++; if (Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]) > PX) c++;
    }
  }
  return n ? c / n : 0;
}
const shot = async (page) => PNG.sync.read(await page.screenshot());
const r3 = (v) => +v.toFixed(3);

// Leaf blocks on screen (as probeMotion picks them), in viewport pixels.
const blocksOnScreen = (page) => page.evaluate(() => {
  const sel = '[id^="block-"],[data-block-id]';
  return [...document.querySelectorAll(sel)].filter((b) => !b.querySelector(sel)).map((b) => {
    const r = b.getBoundingClientRect();
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(innerWidth, r.right), y1 = Math.min(innerHeight, r.bottom);
    return x1 - x0 < 24 || y1 - y0 < 24 ? null : { id: window.__preserveAnchor(b).blockId, at: window.__preserveAnchor(b), x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  }).filter(Boolean);
});

export async function probeBehavior(browser, url, profileName, { isCopy = false } = {}) {
  const ctx = await browser.newContext({ ...PROFILES[profileName].context, ignoreHTTPSErrors: true });
  if (isCopy) await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) || !/^http/.test(u.protocol) ? r.continue() : r.abort(); });
  await ctx.addInitScript(ANCHOR);
  const page = await ctx.newPage();
  const out = { animated: {}, videos: [], hover: {}, drag: {}, scroll: {}, at: {} };
  const remember = (at) => { if (at?.blockId && !out.at[at.blockId]) out.at[at.blockId] = at; };
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (!isCopy) {
      await page.evaluate(markPromos).catch(() => 0);
      await page.addStyleTag({ content: OVERLAY_SELECTORS.join(',') + '{display:none!important}' }).catch(() => {});
    }
    // Jumps, not smooth scrolling (some sites set it), so a section is measured where the page says it is; and no text
    // selection, which a mouse drag would otherwise paint blue.
    await page.addStyleTag({ content: 'html,body{scroll-behavior:auto!important} *{user-select:none!important;-webkit-user-select:none!important}' }).catch(() => {});
    await page.mouse.move(0, 0);
    const vh = await page.evaluate(() => innerHeight), vw = await page.evaluate(() => innerWidth);
    // Through the page once, so lazy pictures load and entrance animations have run before anything is compared.
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < H; y += Math.round(vh * 0.7)) { await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), y); await sleep(300); }
    await page.evaluate(() => scrollTo(0, 0)); await sleep(1200);

    // 1. Pictures with more than one frame, counted from the files (a flattened GIF has the same picture, one frame).
    const imgs = await page.evaluate((max) => [...document.querySelectorAll('img')].filter((i) => { const r = i.getBoundingClientRect(); return r.width >= 24 && r.height >= 24 && (i.currentSrc || i.src); })
      .slice(0, max).map((i) => ({ src: i.currentSrc || i.src, at: window.__preserveAnchor(i) })), MAX_IMAGES);
    const frames = new Map();
    for (const { src } of imgs) {
      if (frames.has(src) || !/^https?:/.test(src)) continue;
      frames.set(src, 1);
      try {
        const res = await ctx.request.get(src, { timeout: 15000 });
        const ct = res.headers()['content-type'] || '';
        if (res.ok() && /gif|webp|avif|png/.test(ct + src)) frames.set(src, (await sharp(await res.body(), { animated: true }).metadata()).pages || 1);
      } catch { /* unreadable: counted as one frame */ }
    }
    for (const { src, at } of imgs) if ((frames.get(src) || 1) > 1) { out.animated[at.blockId] = (out.animated[at.blockId] || 0) + 1; remember(at); }

    // 2. Videos: playing, and whether a picture sits over the middle of one (a fallback still never hidden).
    const vids = await page.evaluate(() => [...document.querySelectorAll('video')].map((v, i) => { const r = v.getBoundingClientRect(); v.dataset.pvVid = i; return r.width >= 50 && r.height >= 50 ? i : null; }).filter((i) => i != null));
    for (const i of vids.slice(0, 6)) {
      const box = await page.evaluate(async (i) => {
        const el = document.querySelector(`video[data-pv-vid="${i}"]`); el.scrollIntoView({ block: 'center' });
        await new Promise((s) => setTimeout(s, 600));
        el.dataset.pvT0 = el.currentTime;
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), w: Math.round(Math.min(r.width, innerWidth)), h: Math.round(Math.min(r.height, innerHeight)) };
      }, i).catch(() => null);
      if (!box) continue;
      const s0 = await shot(page); await sleep(1200); const s1 = await shot(page);
      const v = await page.evaluate(async (i) => {
        const el = document.querySelector(`video[data-pv-vid="${i}"]`);
        const t0 = +el.dataset.pvT0;
        const r = el.getBoundingClientRect(), area = r.width * r.height;
        let hiddenBy = null;
        // Elements over the video's middle, topmost first: a picture (img, or a box with a background picture) that
        // covers at least half the video and is drawn hides it. Text over a hero video does not.
        for (const e of document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)) {
          if (e === el || e.contains(el)) break;
          const s = getComputedStyle(e), er = e.getBoundingClientRect();
          let o = 1; for (let a = e; a; a = a.parentElement) o *= +getComputedStyle(a).opacity;
          const pic = e.tagName === 'IMG' || e.tagName === 'PICTURE' || (s.backgroundImage && s.backgroundImage !== 'none' && !/gradient/.test(s.backgroundImage));
          if (pic && o > 0.5 && s.visibility !== 'hidden' && er.width * er.height >= area * 0.5) { hiddenBy = (e.className?.toString() || e.tagName).slice(0, 60); break; }
        }
        return { at: window.__preserveAnchor(el), playing: !el.paused && el.currentTime > t0 + 0.3, hiddenBy };
      }, i).catch(() => null);
      if (!v) continue;
      // A video that plays while nothing in its place on screen changes is covered, whatever covers it (a still with
      // pointer-events:none doesn't show up under the pointer).
      v.screenChanged = r3(changed(s0, s1, box));
      if (v.playing && !v.hiddenBy && v.screenChanged < 0.003) v.hiddenBy = 'something drawn over it';
      out.videos.push(v); remember(v.at);
    }
    await page.evaluate(() => scrollTo(0, 0)); await sleep(800);

    // 3. Hover (desktop only: phones have no pointer). The mouse visits a grid on each screen; a block that changes
    // while it does, and not while waiting as long, reacts to the pointer (hover pictures, follow-cursor glows).
    if (profileName === 'desktop') {
      for (let s = 0; s < SCREENS && s * vh < H; s++) {
        await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), s * vh); await page.mouse.move(0, 0); await sleep(1500);
        const blocks = await blocksOnScreen(page);
        const base = await shot(page); await sleep(600); const idleShot = await shot(page);
        const best = {};
        const [rows, cols] = HOVER_GRID;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const cc = r % 2 ? cols - 1 - c : c; // back and forth, as a hand would
          await page.mouse.move(Math.round(vw * (cc + 0.5) / cols), Math.round(vh * (r + 0.5) / rows), { steps: 4 });
          await sleep(350);
          const sh = await shot(page);
          for (const b of blocks) best[b.id] = Math.max(best[b.id] || 0, changed(base, sh, b));
        }
        for (const b of blocks) {
          const idle = changed(base, idleShot, b);
          if (idle > 0.01) continue; // moves by itself: probeMotion's job
          if (out.hover[b.id] == null || best[b.id] > out.hover[b.id]) { out.hover[b.id] = r3(best[b.id]); remember(b.at); }
        }
        await page.mouse.move(0, 0);
      }
    }

    // 4. Drag: strips and carousels, dragged from right to left across their middle. Clicks after the drag are
    // swallowed, so a drag that ends on a link doesn't leave the page.
    const strips = await page.evaluate((max) => {
      const re = /carousel|slider|swiper|slick|flickity|splide|glide|user-items-list|reel|marquee|gallery-strip/i;
      const seen = new Set(), list = [];
      for (const e of document.querySelectorAll('body *')) {
        const r = e.getBoundingClientRect(); if (r.width < 200 || r.height < 80) continue;
        const s = getComputedStyle(e);
        const scrolls = e.scrollWidth > e.clientWidth + 40 && /hidden|auto|scroll|clip/.test(s.overflowX);
        if (!scrolls && !re.test(e.className?.toString() || '')) continue;
        const at = window.__preserveAnchor(e); if (seen.has(at.blockId)) continue;
        seen.add(at.blockId); e.dataset.pvStrip = list.length; list.push(at);
        if (list.length >= max) break;
      }
      return list;
    }, MAX_DRAG);
    for (let i = 0; i < strips.length; i++) {
      const box = await page.evaluate(async (i) => { const e = document.querySelector(`[data-pv-strip="${i}"]`); e.scrollIntoView({ block: 'center' }); await new Promise((s) => setTimeout(s, 900)); const r = e.getBoundingClientRect(); return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), w: Math.round(Math.min(r.width, innerWidth - Math.max(0, r.left))), h: Math.round(Math.min(r.height, innerHeight - Math.max(0, r.top))) }; }, i).catch(() => null);
      if (!box || box.w < 100 || box.h < 50) continue;
      const a = await shot(page); await sleep(1300); const b = await shot(page);
      const idle = changed(a, b, box);
      await page.evaluate(() => { const stop = (e) => { e.preventDefault(); e.stopPropagation(); }; addEventListener('click', stop, { capture: true }); setTimeout(() => removeEventListener('click', stop, { capture: true }), 1500); });
      const cy = box.y + box.h / 2;
      if (profileName === 'mobile') {
        // A swipe on a phone: touch events through the browser's own input, as a finger would.
        const cdp = await ctx.newCDPSession(page);
        const pt = (x) => [{ x, y: cy }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(box.x + box.w * 0.8) });
        for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(box.x + box.w * (0.8 - 0.06 * k)) }); await sleep(25); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(box.x + box.w * 0.75, cy); await page.mouse.down();
        await page.mouse.move(box.x + box.w * 0.25, cy, { steps: 12 }); await page.mouse.up();
      }
      await sleep(1000);
      const c = await shot(page);
      out.drag[strips[i].blockId] = { idle: r3(idle), dragged: r3(changed(b, c, box)) }; remember(strips[i]);
      await page.mouse.move(0, 0);
    }

    // 5. Scroll: each section (and the header) pictured at two scroll positions a quarter screen apart, lined up on
    // where the section itself went. A section that scrolls plainly looks the same once lined up; parallax, scroll-
    // driven sideways galleries, backgrounds that change as you scroll and shrinking headers don't.
    await page.evaluate(() => scrollTo(0, 0)); await sleep(600);
    const units = await page.evaluate((max) => {
      const list = [];
      const head = document.querySelector('header,#header,.header');
      if (head) { head.dataset.pvUnit = 'el:header'; list.push('el:header'); }
      for (const s of document.querySelectorAll('section[data-section-id]')) {
        if (list.length > max) break;
        const r = s.getBoundingClientRect(); if (r.height < 120) continue;
        const k = 'section:' + s.getAttribute('data-section-id'); s.dataset.pvUnit = k; list.push(k);
      }
      return list;
    }, MAX_SECTIONS);
    const d = Math.round(vh * 0.25);
    for (const k of units) {
      const isHead = k === 'el:header';
      // Start with the section's top a little below the top of the screen (the header from the top of the page).
      const y1 = isHead ? 0 : await page.evaluate((k) => { const e = document.querySelector(`[data-pv-unit="${k}"]`); return Math.max(0, Math.round(e.getBoundingClientRect().top + scrollY - innerHeight * 0.1)); }, k);
      await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), y1); await sleep(700);
      // Fixed and sticky things (the header over every section) hidden while a section is pictured.
      if (!isHead) await page.evaluate(() => { for (const e of document.querySelectorAll('header,#header,.header')) { e.dataset.pvHid = e.style.visibility || '-'; e.style.visibility = 'hidden'; } });
      const r1 = await page.evaluate((k) => { const r = document.querySelector(`[data-pv-unit="${k}"]`).getBoundingClientRect(); return { top: r.top, left: r.left, w: r.width, h: r.height }; }, k);
      const a = await shot(page); await sleep(500); const a2 = await shot(page);
      await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), y1 + (isHead ? Math.round(vh * 0.6) : d)); await sleep(800);
      const r2 = await page.evaluate((k) => { const r = document.querySelector(`[data-pv-unit="${k}"]`).getBoundingClientRect(); return { top: r.top, left: r.left }; }, k);
      const b = await shot(page);
      await page.evaluate(() => { for (const e of document.querySelectorAll('[data-pv-hid]')) { e.style.visibility = e.dataset.pvHid === '-' ? '' : e.dataset.pvHid; delete e.dataset.pvHid; } });
      // The part of the section on screen both times, in the first screenshot's pixels.
      const dy = Math.round(r2.top - r1.top), dx = Math.round(r2.left - r1.left);
      const top = Math.max(0, Math.round(r1.top), -dy), bottom = Math.min(vh, Math.round(r1.top + r1.h), vh - dy);
      const rect = { x: Math.max(0, Math.round(r1.left)), y: top, w: Math.min(vw, Math.round(r1.w)), h: bottom - top };
      if (rect.h < 60 || rect.w < 60) continue;
      out.scroll[k] = { idle: r3(changed(a, a2, rect)), scrolled: r3(changed(a, b, rect, dx, dy)) };
    }
  } catch (e) { out.error = String(e.message).split('\n')[0]; }
  finally { await ctx.close(); }
  return out;
}

// The copy against the live page. Returns { code: [{ at, detail }] } for what the live page does and the copy doesn't.
// Thresholds: a live block "does" something when at least REACT of it changes; the copy keeps it when it changes at
// least a third as much (a stand-in effect needn't match frame for frame).
// Drag and scroll need more: a scroll moves a whole section's worth of pixels, and Jeremy didn't notice a parallax
// background that moved 14% of a section (Breathpod) or a strip that moved 5% when dragged (La Playa), 2026-11-11.
export const REACT = 0.04, DRAG_REACT = 0.1, SCROLL_REACT = 0.2;
export function compareBehavior(live, copy, layout) {
  const lost = { 'animation-flattened': [], 'video-hidden': [], 'hover-effect-lost': [], 'drag-lost': [], 'scroll-effect-lost': [] };
  if (!live || !copy || live.error || copy.error) return lost;
  const at = (k) => copy.at[k] || live.at[k] || { blockId: k };
  for (const [k, n] of Object.entries(live.animated || {})) if ((copy.animated?.[k] || 0) < n) lost['animation-flattened'].push({ at: at(k), detail: `${n - (copy.animated?.[k] || 0)} moving picture(s) in ${k} show one still frame` });
  for (const v of copy.videos || []) if (v.playing && v.hiddenBy && !(live.videos || []).some((l) => l.at?.blockId === v.at?.blockId && l.hiddenBy)) lost['video-hidden'].push({ at: v.at, detail: `a video plays under a picture (${v.hiddenBy}) in ${v.at.blockId}` });
  if (layout === 'desktop') for (const [k, f] of Object.entries(live.hover || {})) {
    const c = copy.hover?.[k];
    if (f >= REACT && c != null && c < f / 3) lost['hover-effect-lost'].push({ at: at(k), detail: `${k} changes under the mouse on the live page (${Math.round(f * 100)}%), not in the copy (${Math.round(c * 100)}%)` });
  }
  for (const [k, g] of Object.entries(live.drag || {})) {
    const c = copy.drag?.[k];
    if (g.idle < 0.01 && g.dragged >= DRAG_REACT && c && c.dragged < g.dragged / 3) lost['drag-lost'].push({ at: at(k), detail: `${k} moves when dragged on the live page, not in the copy` });
  }
  for (const [k, s] of Object.entries(live.scroll || {})) {
    const c = copy.scroll?.[k];
    if (s.idle < 0.01 && s.scrolled >= SCROLL_REACT && c && c.idle < 0.01 && c.scrolled < s.scrolled / 3) lost['scroll-effect-lost'].push({ at: at(k), detail: `${k} changes as the page scrolls on the live page (${Math.round(s.scrolled * 100)}%), not in the copy (${Math.round(c.scrolled * 100)}%)` });
  }
  return lost;
}
