// Captures a live page: every network response, the server HTML, and the rendered DOM at desktop and mobile widths.
// Usage: node capture.mjs <url> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { PROFILES, launch, sleep, OVERLAY_SELECTORS, markPromos, SQS_GALLERY_SEL, NEXT_SEL, PREV_SEL } from './lib.mjs';
import { captureVideos } from './video.mjs';
import { loadPins, focusPins, markPinStills, applyGalleryFixes, recordLonger } from './pins.mjs';
import { saveFrames } from './frames.mjs';
import { LISTEN_INIT, recordInteractions } from './interact.mjs';

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// Serialize CSSOM-only rules (insertRule) back into <style> text so the DOM snapshot keeps them.
function snapshotDom() {
  for (const st of document.querySelectorAll('style')) {
    try {
      const rules = [...st.sheet.cssRules].map((r) => r.cssText).join('\n');
      if (rules.length > (st.textContent || '').length) st.textContent = rules;
    } catch {}
  }
  // Swiper slideshows: how the site set them up (fade or slide, speed, autoplay, loop), for our slider script.
  for (const el of document.querySelectorAll('.swiper, .swiper-container')) {
    const w = el.swiper; if (!w || !w.params) continue;
    // Autoplay as the site set it up, not whether it is running now: a touch during capture stops it on phones
    // (Studiomama's hero, 2026-11-23, then stayed static in the phone Preserve).
    const p = w.params, a = p.autoplay, ap = a && (a === true || a.enabled !== false) && (a.delay || a === true) ? a.delay || 3000 : 0;
    el.setAttribute('data-pv-swiper', JSON.stringify({ effect: p.effect, speed: p.speed, loop: !!p.loop, autoplay: ap, autoHeight: !!p.autoHeight, spv: typeof p.slidesPerView === 'number' ? p.slidesPerView : null, gap: typeof p.spaceBetween === 'number' ? p.spaceBetween : null }));
  }
  // Record live form/input state and the current src chosen from srcset.
  // Pictures Squarespace's loader fitted to their box in pixels (gallery grids and slideshows, video thumbnails, summary
  // thumbnails: style="left: 0px; top: -112px; width: 288px; height: 512px"). Those pixels are for the box as the
  // capture saw it; in a wider or narrower window the box changes and the picture no longer fills it, or is cut
  // differently (Jeremy: the Instagram rows on dreamsake, margaret rajic and not crispy enough). Marked here with how
  // it was fitted (covering the box or held inside it) and where it was cut, so the copy fits it the same way at any
  // size (build.mjs). Only where the box keeps its size without the picture.
  for (const img of document.querySelectorAll('img')) {
    const px = (v) => (/px$/.test(v) ? parseFloat(v) : NaN), st = img.style, p = img.parentElement;
    const w = px(st.width), h = px(st.height), l = st.left ? px(st.left) : 0, t = st.top ? px(st.top) : 0;
    if (!(w > 0 && h > 0) || !(st.left || st.top) || isNaN(l) || isNaN(t) || !p) continue;
    const pw = p.clientWidth, ph = p.clientHeight, ps = getComputedStyle(p);
    if (pw < 8 || ph < 8 || parseFloat(ps.paddingLeft) || parseFloat(ps.paddingTop) || getComputedStyle(img).position !== 'relative') continue;
    const edge = Math.abs(w - pw) < 1.5 || Math.abs(h - ph) < 1.5;
    const fit = edge && w >= pw - 1.5 && h >= ph - 1.5 ? 'cover' : edge && w <= pw + 1.5 && h <= ph + 1.5 ? 'contain' : '';
    if (!fit) continue;
    const d = st.display; st.display = 'none';
    const holds = Math.abs(p.clientWidth - pw) < 1 && Math.abs(p.clientHeight - ph) < 1;
    st.display = d;
    if (!holds) continue;
    const at = (o, box, size) => (Math.abs(box - size) < 1.5 ? 50 : Math.max(0, Math.min(100, Math.round(o / (box - size) * 1000) / 10)));
    img.setAttribute('data-pv-fit', `${fit} ${at(l, pw, w)}% ${at(t, ph, h)}%`);
    if (ps.position === 'static') p.setAttribute('data-pv-fitbox', '');
  }
  // The same for a box the loader fitted (a video's frame inside its grid cell, dreamsake): placed and sized in pixels
  // inside its box, it keeps the same share of the box at any size.
  for (const el of document.querySelectorAll('.sqs-video-wrapper[style*="px"], [class*="video-fit"][style*="px"], [class*="video-fill"][style*="px"]')) {
    const px = (v) => (/px$/.test(v) ? parseFloat(v) : NaN), st = el.style, p = el.offsetParent;
    const w = px(st.width), h = px(st.height), l = px(st.left), t = px(st.top);
    if (!(w > 0 && h > 0) || isNaN(l) || isNaN(t) || !p || p !== el.parentElement || getComputedStyle(el).position !== 'absolute') continue;
    const pw = p.clientWidth, ph = p.clientHeight;
    if (pw < 8 || ph < 8) continue;
    const edge = Math.abs(w - pw) < 1.5 || Math.abs(h - ph) < 1.5;
    if (!edge) continue;
    const pc = (v, of) => Math.round(v / of * 1e5) / 1e3;
    el.setAttribute('data-pv-fitpc', `${pc(l, pw)} ${pc(t, ph)} ${pc(w, pw)} ${pc(h, ph)}`);
  }
  // A 7.0 slideshow's height is written in pixels by its script, from its shape (a setting) and its width at that
  // moment: at any other width the copy kept that height, so pictures were cropped differently (the lurkshop: 538
  // pixels tall at every width, 382 live at 1024). The shape is what holds, so the copy gets the shape.
  for (const el of document.querySelectorAll('.sqs-gallery-block-slideshow .sqs-gallery[style*="height"]')) {
    const st = el.style, w = el.clientWidth, h = parseFloat(st.height);
    if (!/px$/.test(st.height) || st.width || !(w > 8 && h > 8)) continue;
    el.setAttribute('data-pv-ar', `${Math.round(w * 100) / 100} ${Math.round(h * 100) / 100}`);
  }
  for (const img of document.querySelectorAll('img')) {
    if (img.currentSrc) img.setAttribute('data-preserve-current', img.currentSrc);
    // An image's size can come from its own pixels (a gallery strip: width auto, height 100%). In the copy it's lazy,
    // so until it loads it is 0 wide, never on screen, and never loads. Width and height attributes give it its shape
    // up front: the size the page used here, else the one Squarespace recorded (emmagrinteriors, 2026-10-27).
    if (img.hasAttribute('width') || img.hasAttribute('height')) continue;
    // The site sized it itself (style="height: 12px"): a width attribute next to that would fix the other side too.
    if (img.style.width || img.style.height) continue;
    const d = /^(\d+)x(\d+)$/.exec(img.getAttribute('data-image-dimensions') || '');
    const [w, h] = img.naturalWidth ? [img.naturalWidth, img.naturalHeight] : d ? [+d[1], +d[2]] : [];
    if (w && h) { img.setAttribute('width', w); img.setAttribute('height', h); img.setAttribute('data-pv-dims', ''); }
  }
  const dt = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>';
  return dt + '\n' + document.documentElement.outerHTML;
}

// Squarespace loads images itself (ImageLoader, from data-src) when they come near the screen. Ones it hadn't reached by
// the time of the snapshot (slides off to the side, a gallery strip) were saved with no src and hidden, so the copy
// showed empty frames. Load them all before saving, the way its loader does, and wait for them.
export async function loadPlaceholders(page) {
  return page.evaluate(async () => {
    const todo = [...document.images].filter((i) => !i.getAttribute('src') && !i.getAttribute('srcset') && (i.dataset.src || i.dataset.image));
    for (const i of todo) {
      // Its loader picks a size from the image's box; a box 0 wide (sized by its own pixels) would get the 100 px one.
      if (i.getBoundingClientRect().width > 0) try { window.ImageLoader?.load(i, { load: true }); } catch {}
      if (i.getAttribute('src')) continue;
      const u = i.dataset.src || i.dataset.image, w = +(/^(\d+)x/.exec(i.dataset.imageDimensions || '') || [])[1] || 1500;
      const fmt = [500, 750, 1000, 1500].find((f) => f >= w) || 1500;
      i.src = /squarespace-cdn\.com/.test(u) && !/[?&]format=/.test(u) ? u + (u.includes('?') ? '&' : '?') + `format=${fmt}w` : u;
    }
    await Promise.race([
      Promise.all(todo.map((i) => (i.complete ? 0 : new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); })))),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
    // Loaded by hand, the image keeps the hidden look the loader gives unloaded ones: mark it loaded the same way.
    for (const i of todo) if (i.naturalWidth) { i.setAttribute('data-load', 'true'); if (document.querySelector('img.loaded')) i.classList.add('loaded'); }
    return { tried: todo.length, loaded: todo.filter((i) => i.naturalWidth).length };
  }).catch(() => ({ tried: 0, loaded: 0 }));
}

// Galleries, carousels and slideshows (known limitation 9; Jeremy 2026-10-28: "make that fix"). A copy has none of
// Squarespace's scripts, so its galleries never moved. Rather than rebuild each kind of gallery's script, the capture
// steps each gallery through its slides here, the way the site's own script does it (its "next" arrow, or Squarespace's
// gallery object for blocks that have no arrow), and writes down what each step changes: the classes and inline styles
// of the elements that move. The copy's player (build.mjs GALLERY_SCRIPT) replays those steps on its arrows and, when
// the site played the gallery by itself, on the same timer. The timer is the site's setting where Squarespace records
// one (gallery blocks), otherwise measured here by watching the gallery before touching it. Swiper sliders have their
// own player (SLIDER_SCRIPT), and carousels from a site's own code are not Squarespace's, so both are left out. The gallery is put back on its first slide before the page is saved.
export async function recordGalleries(page, opts = {}) {
  const out = await recordGalleriesInPage(page, opts);
  // Can a visitor drag the strip? Only a real pointer tells: press on it, move 60 pixels and see whether the slides
  // came along, then move back and let go where the press began, so it rests where it was. (The reel on borrachito
  // does not follow a drag; list carousels do.) The click that would follow is swallowed so no link opens.
  // Galleries that are not strips (summary carousels, 7.0 slideshows): does a sideways swipe change the slide? Colorize's
  // summary carousel ignores one, and the copy used to move on any drag. Swipe left, see whether anything changed, swipe
  // back; if it did not come back, the first slide is put back as recorded. Ones that play on their own timer are not
  // tested (they change anyway) and keep answering a swipe.
  if (Array.isArray(out)) for (const r of out) {
    if (r.strip || r.id === undefined || r.how === 'timer' || !(r.steps > 1)) continue;
    try {
      const box = await page.evaluate((id) => {
        const g = [...document.querySelectorAll('[data-pv-gal]')].find((e) => { try { return JSON.parse(e.getAttribute('data-pv-gal')).id === id; } catch { return false; } });
        if (!g) return null; g.scrollIntoView({ block: 'center', behavior: 'instant' }); window.__pvG = g;
        window.__pvSig = () => [...g.querySelectorAll('[data-pv-gi]')].map((e) => [...e.attributes].filter((a) => !/^data-pv-/.test(a.name)).map((a) => a.name + '=' + a.value).join('|') + '#' + [...e.parentElement.children].indexOf(e)).join('\n');
        window.__pvEat = (e) => { e.preventDefault(); e.stopImmediatePropagation(); }; addEventListener('click', window.__pvEat, true);
        const q = g.getBoundingClientRect(); return { x: Math.max(0, q.left), w: Math.min(innerWidth, q.right) - Math.max(0, q.left), vh: innerHeight };
      }, r.id);
      if (!box) continue;
      let b2 = null;
      for (let t = 0; t < 12; t++) { await sleep(250); const q = await page.evaluate(() => { const q = window.__pvG.getBoundingClientRect(); return { y: q.top, h: q.height }; }); if (b2 && Math.abs(q.y - b2.y) < 1) { b2 = q; break; } b2 = q; }
      const x0 = box.x + box.w / 2, y0 = Math.max(10, Math.min(box.vh - 10, b2.y + b2.h / 2));
      const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && window.__pvG.contains(e); }, [x0, y0]);
      if (under) {
        const touch = (page.viewportSize()?.width || 1440) < 768;
        const cdp = touch ? await page.context().newCDPSession(page) : null;
        const swipe = async (dir) => {
          if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] }); else { await page.mouse.move(x0, y0); await page.mouse.down(); }
          for (let k = 1; k <= 6; k++) { const x = x0 + dir * 20 * k; if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 }] }); else await page.mouse.move(x, y0); await sleep(30); }
          if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); else await page.mouse.up();
          await sleep(1100);
        };
        const sig = () => page.evaluate(() => window.__pvSig());
        const s0 = await sig(); await swipe(-1);
        r.swipe = (await sig()) !== s0;
        if (r.swipe) { await swipe(1); if ((await sig()) !== s0) await page.evaluate((id) => window.__pvHome && window.__pvHome[id] && window.__pvHome[id](), r.id); }
        if (cdp) await cdp.detach().catch(() => {});
        await page.evaluate((sw) => { const g = window.__pvG, c = JSON.parse(g.getAttribute('data-pv-gal')); c.swipe = sw ? 1 : 0; g.setAttribute('data-pv-gal', JSON.stringify(c)); }, r.swipe);
      }
      await page.evaluate(() => removeEventListener('click', window.__pvEat, true));
    } catch (e) { r.swipeError = String(e.message).split('\n')[0]; await page.mouse.up().catch(() => {}); }
  }
  if (Array.isArray(out)) for (const r of out) {
    if (!r.strip || r.id === undefined) continue;
    try {
      const sel = '[data-pv-gal]';
      const box = await page.evaluate(([sel, id]) => {
        const g = [...document.querySelectorAll(sel)].find((e) => { try { return JSON.parse(e.getAttribute('data-pv-gal')).id === id; } catch { return false; } });
        if (!g) return null; g.scrollIntoView({ block: 'center', behavior: 'instant' }); window.__pvG = g;
        window.__pvXs = () => { const c = JSON.parse(g.getAttribute('data-pv-gal')); return c.strip.sl.map((j) => g.querySelector('[data-pv-gi="' + j + '"]')).map((e) => (e ? e.getBoundingClientRect().left : 0)); };
        window.__pvEat = (e) => { e.preventDefault(); e.stopImmediatePropagation(); }; addEventListener('click', window.__pvEat, true);
        const q = g.getBoundingClientRect(); return { x: Math.max(0, q.left), y: q.top, w: Math.min(innerWidth, q.right) - Math.max(0, q.left), h: q.height, vh: innerHeight };
      }, [sel, r.id]);
      if (!box) continue;
      await sleep(500);
      // A page that scrolls smoothly may still be on its way: wait until the gallery holds still, and press only if it is
      // really under the pointer.
      let b2 = null;
      for (let t = 0; t < 12; t++) { const q = await page.evaluate(() => { const q = window.__pvG.getBoundingClientRect(); return { y: q.top, h: q.height }; }); if (b2 && Math.abs(q.y - b2.y) < 1) { b2 = q; break; } b2 = q; await sleep(250); }
      const x0 = box.x + box.w / 2, y0 = Math.max(10, Math.min(box.vh - 10, b2.y + b2.h / 2));
      const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && window.__pvG.contains(e); }, [x0, y0]);
      if (!under) { r.strip.dragError = 'not under the pointer'; await page.evaluate(() => removeEventListener('click', window.__pvEat, true)); continue; }
      const xs0 = await page.evaluate(() => window.__pvXs());
      const touch = (page.viewportSize()?.width || 1440) < 768;
      const cdp = touch ? await page.context().newCDPSession(page) : null;
      const down = () => (touch ? cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] }) : page.mouse.move(x0, y0).then(() => page.mouse.down()));
      const move = (dx) => (touch ? cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx, y: y0 }] }) : page.mouse.move(x0 + dx, y0));
      const upp = () => (touch ? cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) : page.mouse.up());
      await down();
      for (const dx of [-10, -20, -30, -40, -50, -60]) { await move(dx); await sleep(30); }
      await sleep(150);
      const xs1 = await page.evaluate(() => window.__pvXs());
      for (const dx of [-45, -30, -15, 0]) { await move(dx); await sleep(30); }
      await upp(); await sleep(900);
      const xs2 = await page.evaluate(() => window.__pvXs());
      // The slides on show came along with the pointer. Compared as places on screen, not slide by slide: an endless
      // carousel keeps doubles of its slides and may swap which copy is on show as a drag begins (maria dubin's list
      // carousel, 2026-11-24: its real slides jumped off screen and their doubles took over, so it read "no drag").
      const vis = (xs) => xs.filter((x) => Math.abs(x) < 4000).sort((a, b) => a - b);
      const v0 = vis(xs0), d = vis(xs1).map((x) => { const n = v0.reduce((m, y) => (Math.abs(x - y) < Math.abs(x - m) ? y : m), Infinity); return Math.abs(x - n) < 150 ? x - n : null; }).filter((v) => v !== null && Math.abs(v) > 2);
      // (Doubles left behind where a slide was don't move, so only places that moved count; at least two must have.)
      d.sort((a, b) => a - b); const md = d.length >= 2 ? d[d.length >> 1] : 0;
      r.strip.drag = md < -35 && md > -75;
      r.strip.dragRest = xs2.every((x, j) => Math.abs(x - xs0[j]) < 2);
      await page.evaluate(([drag, back, xs0]) => {
        const g = window.__pvG, c = JSON.parse(g.getAttribute('data-pv-gal')); c.strip.drag = drag; g.setAttribute('data-pv-gal', JSON.stringify(c));
        removeEventListener('click', window.__pvEat, true);
      }, [r.strip.drag, r.strip.dragRest]);
      if (cdp) await cdp.detach().catch(() => {});
    } catch (e) { r.strip.dragError = String(e.message).split('\n')[0]; await page.mouse.up().catch(() => {}); }
  }
  return out;
}

async function recordGalleriesInPage(page, { watchMs = 9000, maxSteps = 30, maxMs = 45000 } = {}) {
  return page.evaluate(async ([gSel, nSel, pSel, watchMs, maxSteps, maxMs]) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const BLOCK = '[id^="block-"],.sqs-block,[data-block-id],section[data-section-id]';
    const shown = (e) => { for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden') return false; } const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const pics = (e) => e.querySelectorAll('img, .swiper-slide, [data-slide-index], .slide, .list-item, [class*="__slide"]').length;
    const blockOf = (e) => e.closest(BLOCK) || e.parentElement;
    const cand = new Set([...document.querySelectorAll(gSel)]);
    for (const b of document.querySelectorAll(nSel)) { const c = b.closest(gSel); if (c) cand.add(c); }
    const byBlock = new Map();
    for (const c of cand) {
      const r = c.getBoundingClientRect();
      if (r.width < 100 || r.height < 60 || !shown(c) || pics(c) < 2 || c.closest('.swiper') || c.querySelector('.swiper-initialized,.swiper-container-initialized')) continue;
      const b = blockOf(c), prev = byBlock.get(b);
      if (!prev || c.contains(prev)) byBlock.set(b, c);
    }
    const insts = (() => { try { return window.Y?.Squarespace?.GalleryManager?.getGalleries?.() || []; } catch { return []; } })();
    const out = [];
    let id = 0;
    for (const [block, g] of byBlock) {
      const res = { kind: (g.className.baseVal ?? g.className).toString().trim().split(/\s+/)[0] };
      out.push(res);
      const els = [g, ...g.querySelectorAll('*')];
      // What a step can change on an element: its classes, its inline style, short state attributes (7.1 gallery
      // sections mark the shown slide with data-active / data-in, list carousels with aria-hidden, arrows at the end with
      // aria-disabled), and its place
      // among its siblings (7.1 fullscreen slideshows move the shown slide to the end of the list).
      const STATE = /^(data-(?!src$|image$|image-|load$|slide-url$|pv-|preserve)[\w-]+|aria-(?!label|labelledby|describedby|controls|roledescription)[\w-]+|tabindex|inert|disabled)$/;
      const attrs = (e) => [...e.attributes].filter((a) => STATE.test(a.name) && a.value.length < 40).map((a) => a.name + '=' + a.value).sort().join('\u001f');
      const ord = (e) => (e.parentElement ? [...e.parentElement.children].indexOf(e) : 0);
      const snap = () => els.map((e) => [e.getAttribute('class') || '', e.getAttribute('style') || '', attrs(e), ord(e)]);
      const noUrl = (st) => st.replace(/(^|;)\s*[\w-]+\s*:[^;]*url\([^)]*\)[^;]*/g, '$1').replace(/^;+|;;+/g, ';').replace(/^;/, '');
      const ren = (t) => t.replace(/data-sqsp?-/g, 'data-ps-').replace(/(^|[^\w-])sqsrte-/g, '$1rte-').replace(/(^|[^\w-])sqsp?-/g, '$1ps-').replace(/(^|[^\w-])tweak-/g, '$1tw-');
      const same = (a, b) => a.length === b.length && a.every((x, i) => x[0] === b[i][0] && x[1] === b[i][1] && x[2] === b[i][2] && x[3] === b[i][3]);
      const settle = async () => { let a = snap(); for (let t = 0; t < 20; t++) { await sleep(150); const b = snap(); if (same(a, b)) return b; a = b; } return a; };
      const grew = () => g.querySelectorAll('*').length + 1 !== els.length;
      g.scrollIntoView({ block: 'center' }); await sleep(600);
      // A ticker: a strip that never rests, its slides drifting sideways at one steady speed and coming round again (an
      // owner's "scrolling images" code on a list carousel; naughty nancy, 2026-11-14). There are no steps to record:
      // replaying moments of it made the slides jump and slide over one another. The copy gets the strip's rules (its
      // slides, their gap, the speed) and the player drifts it the same way at any width.
      const ticker = await (async () => {
        const far = (x) => Math.abs(x) > 4000, at = new Map(els.map((e, i) => [e, i]));
        const all = [], shot = async () => { all.push([performance.now(), els.map((e) => e.getBoundingClientRect().left)]); await sleep(200); };
        // Over the last six looks (one second), once it has reached its speed (one that starts as it scrolls into view
        // takes a moment); nothing moving at all in the first second ends the watch.
        const find = (rows) => {
          // An element's speed in pixels a second: null when it was out of play, 0 when it rested or its speed changed.
          const speed = (i) => {
            const vs = [];
            for (let k = 1; k < rows.length; k++) { const a = rows[k - 1][1][i], b = rows[k][1][i]; if (far(a) || far(b) || Math.abs(b - a) > 150) continue; vs.push((b - a) / ((rows[k][0] - rows[k - 1][0]) / 1000)); }
            if (vs.length < 3) return null;
            const m = vs.reduce((x, y) => x + y, 0) / vs.length;
            return Math.abs(m) >= 4 && vs.every((v) => Math.abs(v - m) <= Math.max(5, Math.abs(m) * 0.2)) ? m : 0;
          };
          let best = null;
          for (const p of els) {
            const kids = [...p.children].filter((c) => { const r = c.getBoundingClientRect(); return at.has(c) && r.width > 40 && r.height > 20; });
            if (kids.length < 2) continue;
            const vs = kids.map((c) => speed(at.get(c))).filter((v) => v !== null);
            if (vs.length < 2 || vs.some((v) => !v)) continue;
            const sorted = [...vs].sort((a, b) => a - b), m = sorted[sorted.length >> 1];
            if (vs.some((v) => Math.abs(v - m) > Math.max(5, Math.abs(m) * 0.2))) continue;
            let depth = 0; for (let x = p; x && x !== g; x = x.parentElement) depth++;
            if (!best || depth < best.depth) best = { p, kids, v: m, depth };
          }
          return best;
        };
        // Its speed is taken once two seconds in a row agree (it can still be gathering speed when first seen).
        let best = null, before = null;
        for (let k = 0; k < 40; k++) {
          await shot();
          if (k === 5 && all[0][1].every((x, i) => Math.abs(x - all[5][1][i]) < 0.5)) return null;
          if (k < 5 || (k + 1) % 5) continue;
          best = find(all.slice(-6));
          if (best && before && Math.abs(best.v - before.v) <= Math.abs(best.v) * 0.04) break;
          before = best;
        }
        return best;
      })();
      if (ticker) {
        const sl = ticker.kids, par = ticker.p, pr = par.getBoundingClientRect(), far = (x) => Math.abs(x) > 4000;
        const X = sl.map((e) => e.getBoundingClientRect().left - pr.left), Wd = sl.map((e) => e.getBoundingClientRect().width);
        const gaps = [];
        for (let j = 0; j + 1 < sl.length; j++) if (!far(X[j]) && !far(X[j + 1]) && X[j + 1] > X[j]) gaps.push(X[j + 1] - X[j] - Wd[j]);
        gaps.sort((a, b) => a - b);
        const gap = gaps.length ? Math.round(gaps[gaps.length >> 1] * 10) / 10 : 0;
        // The slide the strip starts from: the first one still (partly) inside the strip's start edge.
        let c0 = -1; X.forEach((x, j) => { if (!far(x) && x + Wd[j] > 0 && (c0 < 0 || x < X[c0])) c0 = j; });
        if (c0 >= 0) {
          const moving = sl.map((e) => els.indexOf(e)), st = snap();
          moving.forEach((i, j) => els[i].setAttribute('data-pv-gi', j));
          const strip = { sl: sl.map((_, j) => j), gap, al: 's', x0: Math.round(X[c0] * 10) / 10, pw: Math.round(pr.width), by: 1, inf: true, cur: [c0], max: 0, drift: Math.round(-ticker.v * 10) / 10 };
          g.setAttribute('data-pv-gal', JSON.stringify({ id, auto: 0, strip, w: Math.round(g.getBoundingClientRect().width), steps: [moving.map((i) => [ren(st[i][0]), ren(noUrl(st[i][1])), ren(st[i][2]), st[i][3]])] }));
          res.auto = 0; res.how = 'ticker'; res.steps = 1; res.moving = moving.length; res.id = id++;
          res.strip = { slides: sl.length, gap, align: 's', endless: true, drift: strip.drift };
          continue;
        }
      }
      // Its own timer: the block's setting, else what it does untouched for a few seconds.
      let cfg = {}; try { cfg = JSON.parse(g.closest('[data-block-json]')?.getAttribute('data-block-json') || '{}'); } catch {}
      let auto = cfg.autoplay ? Math.round((+cfg['autoplay-duration'] || 3) * 1000) : 0;
      // 7.1 gallery sections keep theirs in data-props on the gallery (autoplayEnabled, slideDurationMs). Without it,
      // watching guessed 1.5 s for a 6 s fullscreen slideshow (a fade changes the page more than once) and the
      // recording stopped after one step, leaving the Preserve's hero still (Arts & Parts, 2026-11-23).
      if (!auto) { let pr = {}; try { pr = JSON.parse(g.closest('[data-props]')?.getAttribute('data-props') || '{}'); } catch {}
        if (pr.autoplayEnabled && +pr.slideDurationMs > 0) auto = Math.round(+pr.slideDurationMs); }
      const inst = insts.find((x) => { try { const n = x.get('container'); const d = n && (n._node || n.getDOMNode?.()); return d && (d === g || g.contains(d) || d.contains(g)); } catch { return false; } });
      if (!auto) {
        let last = await settle(); const t0 = performance.now(), seen = [];
        while (performance.now() - t0 < watchMs) { await sleep(200); const s = snap(); if (!same(s, last)) { seen.push(performance.now()); last = await settle(); } }
        if (seen.length >= 2) auto = Math.max(1500, Math.round((seen[1] - seen[0]) / 250) * 250);
        else if (seen.length === 1) auto = Math.max(2000, Math.round((seen[0] - t0) / 500) * 500);
      }
      if (inst) { try { inst._clearAutoplay?.(); inst.set?.('autoplay', false); } catch {} }
      // Its arrows: all of them get the copy's player (a block can hold one pair per layout); the one on screen is used here.
      const nexts = [...new Set([...g.querySelectorAll(nSel), ...block.querySelectorAll(nSel)])], prevs = [...new Set([...g.querySelectorAll(pSel), ...block.querySelectorAll(pSel)])];
      const next = nexts.find(shown) || nexts[0];
      // Squarespace's gallery object ignores "next" while a slide is still moving, so wait for it to stop first.
      const idle = async () => { for (let t = 0; t < 50 && inst.get('inMotion'); t++) await sleep(100); };
      const total = inst ? +(inst._getNumberOfSlides?.() || 0) : 0;
      let step = inst && typeof inst.nextSlide === 'function' ? async () => { await idle(); const i0 = inst.get('currentIndex'); inst.nextSlide(); for (let t = 0; t < 40 && inst.get('currentIndex') === i0; t++) await sleep(100); await idle(); } : next ? async () => { next.click(); await sleep(700); } : null;
      // One that plays by itself is recorded by letting it play: clicking as well would mix its steps with ours.
      // Wait at least as long as the first watch did: a guessed interval can be too short, and stopping early ends the recording.
      if (auto && !inst) step = async () => { const a = snap(), t = performance.now(); while (performance.now() - t < Math.max(auto, watchMs) + 2500) { await sleep(200); if (!same(snap(), a)) return; } };
      res.auto = auto; res.how = inst ? 'gallery' : auto ? 'timer' : next ? 'arrow' : 'none';
      if (!step) continue;
      if (inst) await idle();
      const states = [await settle()], dt = [0];
      // Where each element sits (left edge and width, from the gallery's left edge) in every state: what the strip
      // model below is worked out from.
      const geo = () => { const gl = g.getBoundingClientRect().left; return els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round((r.left - gl) * 10) / 10, Math.round(r.width * 10) / 10]; }); };
      const geos = [geo()];
      // How the first step moves, frame by frame (elements placed by a transform), so the copy can move the same way.
      const tracked = els.map((e, i) => i).filter((i) => /transform|translate/.test(els[i].getAttribute('style') || '')).slice(0, 80);
      const track = { on: true, t0: performance.now(), rows: [] };
      (function frame() { if (!track.on) return; const gl = g.getBoundingClientRect().left; track.rows.push([performance.now() - track.t0, tracked.map((i) => els[i].getBoundingClientRect().left - gl)]); if (track.rows.length < 1500) requestAnimationFrame(frame); })();
      let tPrev = performance.now();
      const classes = (st) => st.map((x) => x[0] + '|' + x[2]).join('\n');
      const t1 = performance.now();
      for (let k = 1; k < (total > 1 ? Math.min(total, maxSteps) : maxSteps) && performance.now() - t1 < (auto && !inst ? maxMs * 2 : maxMs); k++) {
        await step();
        await sleep(250);
        let s = await settle();
        // A click while the slide is still moving can be ignored: give it one more try before calling it the end.
        if (!auto && same(s, states[states.length - 1])) { await sleep(1000); await step(); await sleep(250); s = await settle(); }
        if (grew()) { res.skip = 'the gallery adds or removes elements as it moves'; break; }
        // Back at the start: the same state, or (when something else keeps counting up, like a stacking order) the
        // same classes and state attributes as the first slide after they had changed.
        const now = performance.now(), gap = Math.round(now - tPrev); tPrev = now;
        if (same(s, states[0]) || (classes(s) === classes(states[0]) && states.some((x) => classes(x) !== classes(states[0])))) { res.stop = 'back to the first slide'; dt[0] = gap; break; }
        if (same(s, states[states.length - 1])) { res.stop = 'no change'; break; }
        if (states.some((x) => same(s, x))) { res.stop = 'repeats'; break; }
        states.push(s); dt.push(gap); geos.push(geo()); track.on = false;
      }
      track.on = false;
      res.steps = states.length;
      if (res.skip || states.length < 2) continue;
      const moving = els.map((_, i) => i).filter((i) => states.some((s) => s[i].some((v, k) => v !== states[0][i][k])));
      // A strip's spare slides can stay parked through every step (not crispy enough: twelve slides, six steps); they
      // are slides all the same, so they are numbered with the ones that moved.
      { const at = new Map(els.map((e, i) => [e, i])), byPar = new Map();
        for (const i of moving) { const p = els[i].parentElement; if (p && /transform\s*:/.test(states[0][i][1])) byPar.set(p, (byPar.get(p) || 0) + 1); }
        let par = null, n = 1; for (const [p, c] of byPar) if (c > n) { par = p; n = c; }
        if (par) { for (const e of par.children) { const i = at.get(e); if (i !== undefined && !moving.includes(i) && /transform\s*:/.test(states[0][i][1])) moving.push(i); } moving.sort((a, b) => a - b); } }
      moving.forEach((i, j) => els[i].setAttribute('data-pv-gi', j));
      // Back to the first slide, as the page was before (kept for the swipe test, which may need it again).
      const home = () => {
        for (const i of moving) {
          const [c, st, at] = states[0][i], e = els[i];
          if (c) e.setAttribute('class', c); else e.removeAttribute('class');
          if (st) e.setAttribute('style', st); else e.removeAttribute('style');
          for (const a of [...e.attributes]) if (STATE.test(a.name) && a.value.length < 40) e.removeAttribute(a.name);
          for (const kv of at ? at.split('\u001f') : []) { const k = kv.indexOf('='); e.setAttribute(kv.slice(0, k), kv.slice(k + 1)); }
        }
        const parents = new Set(moving.map((i) => els[i].parentElement).filter(Boolean));
        for (const p of parents) { const kids = moving.filter((i) => els[i].parentElement === p).sort((a, b) => states[0][a][3] - states[0][b][3]); for (const i of kids) p.insertBefore(els[i], p.children[states[0][i][3]] || null); }
      };
      home(); (window.__pvHome ||= {})[id] = home;
      // Pictures set in a style (background-image) stay as the page has them: their addresses are rewritten to the
      // copy's own files only where the page uses them, not inside this record.
      // Played by itself: how long after the one before each step came, so the copy keeps the site's rhythm (a slide
      // change can come in two or three quick steps, such as fading the new slide in, then settling it).
      // Squarespace's class names as the copy has them (own-css.mjs renames them; none may be left in a copy).
      const timed = res.how === 'timer' ? { dt: dt.map((x) => x || auto) } : {};
      // A strip of slides (list carousels, banner slideshows, gallery reels): slides that sit side by side and are slid
      // along by a pixel offset written on each one. Those offsets, and any written-in slide sizes, are for the width
      // the capture saw, so replaying them at another width overlaps the slides or opens gaps (Jeremy, sunnie, not
      // crispy enough and borrachito, 2026-11-13). For these the copy gets the strip's rules instead of its pixels:
      // which elements are the slides, the gap between them, where the current one rests (the strip's start, or the
      // middle), whether it goes round for ever, how a written-in size follows the strip's height, and how a step
      // moves over time. The copy's player lays the strip out from the slides' own sizes at whatever width it is shown.
      const strip = (() => {
        const at = new Map(els.map((e, i) => [e, i]));
        const moved = (i) => geos.some((q) => Math.abs(q[i][0] - geos[0][i][0]) > 1);
        const tops = moving.filter((i) => moved(i) && !(at.has(els[i].parentElement) && moved(at.get(els[i].parentElement))));
        const byPar = new Map(); for (const i of tops) { const p = els[i].parentElement; byPar.set(p, [...(byPar.get(p) || []), i]); }
        let sl = []; for (const v of byPar.values()) if (v.length > sl.length) sl = v;
        if (sl.length < 2) return null;
        const par = els[sl[0]].parentElement;
        // Every slide among its siblings, in page order, each placed by a transform that only moves it sideways.
        sl = [...par.children].map((e) => at.get(e)).filter((i) => i !== undefined && /transform\s*:/.test(states[0][i][1]));
        if (sl.length < 2 || sl.some((i) => !moving.includes(i))) return null;
        const yOf = (st) => { const m = /translate3d\(\s*[^,]+,\s*(-?[\d.]+)px/.exec(st) || /matrix\((?:[^,]+,){5}\s*(-?[\d.]+)\)/.exec(st) || /translate\(\s*[^,]+,\s*(-?[\d.]+)px/.exec(st); return m ? +m[1] : 0; };
        if (states.some((s) => sl.some((i) => Math.abs(yOf(s[i][1])) > 0.5))) return null;
        const N = sl.length, pr = par.getBoundingClientRect(), gl = g.getBoundingClientRect().left, pl = pr.left - gl, pw = pr.width;
        const far = (x) => Math.abs(x) > 4000;
        const X = geos.map((q) => sl.map((i) => q[i][0] - pl)), Wd = sl.map((i) => geos[0][i][1]);
        // The current slide of each state: the one resting at the strip's start offset, or else in its middle.
        const first = X[0].findIndex((x) => !far(x)); if (first < 0) return null;
        const c0 = !far(X[0][0]) && X[0].every((x, j) => far(x) || x >= X[0][0] - 1 || j > N / 2) ? 0 : X[0].reduce((b, x, j) => (!far(x) && x >= -1 && (b < 0 || x < X[0][b]) ? j : b), -1);
        if (c0 < 0) return null;
        const find = (k, test) => { const c = X[k].findIndex((x, j) => !far(x) && test(x, j)); return c; };
        const x0 = X[0][c0];
        // In the middle wins when the slide rests away from the strip's start: slides of nearly one width sit at nearly
        // one offset, which would pass for a start offset and then be wrong at every other width (borrachito's reel).
        const mid = (k) => find(k, (x, j) => Math.abs(x + Wd[j] / 2 - pw / 2) < 2);
        let al = 'c', cur = Math.abs(x0) > 2 ? X.map((_, k) => mid(k)) : [-1];
        if (cur.some((c) => c < 0)) { al = 's'; cur = X.map((_, k) => find(k, (x) => Math.abs(x - x0) < 2)); }
        if (cur.some((c) => c < 0)) { al = 'c'; cur = X.map((_, k) => mid(k)); }
        if (cur.some((c) => c < 0)) return null;
        // Slides resting side by side give the gap; they must also agree with one another.
        const gaps = [];
        X.forEach((xs) => { for (let j = 0; j < N; j++) { const n = (j + 1) % N; if (!far(xs[j]) && !far(xs[n]) && xs[n] > xs[j]) gaps.push(xs[n] - xs[j] - Wd[j]); } });
        // Never two slides in view at once (a phone reel: each picture wider than the screen): they follow on with no gap.
        // (Mid-step they are, for a moment: the frames watched during the first step give their gap.)
        // Only when the frames agree: a slide brought in from where it was parked passes through every gap on its way
        // (not crispy enough's phone banner fell back to the old player, 2026-11-14).
        if (!gaps.length) {
          const mid = [];
          for (const [, xs] of track.rows) for (let j = 0; j < N; j++) {
            const n = (j + 1) % N, a = tracked.indexOf(sl[j]), b = tracked.indexOf(sl[n]);
            if (a >= 0 && b >= 0 && !far(xs[a]) && !far(xs[b]) && xs[b] > xs[a] && xs[b] - xs[a] < Wd[j] + 200) mid.push(xs[b] - xs[a] - Wd[j]);
          }
          mid.sort((p, q) => p - q);
          const m = mid.length ? mid[mid.length >> 1] : 0, near = mid.filter((v) => Math.abs(v - m) <= 1.5);
          if (mid.length >= 3 && near.length >= mid.length * 0.8) gaps.push(...near);
        }
        if (!gaps.length) gaps.push(0);
        gaps.sort((a, b) => a - b); const gap = Math.round(gaps[gaps.length >> 1] * 10) / 10;
        if (gaps[gaps.length - 1] - gaps[0] > 3) return null;
        const by = cur.length > 1 ? ((cur[1] - cur[0]) % N + N) % N : 1;
        if (!by || cur.some((c, k) => k && ((c - cur[k - 1]) % N + N) % N !== by)) return null;
        const prev = (c0 + N - 1) % N, inf = res.stop === 'back to the first slide' || (!far(X[0][prev]) && X[0][prev] < x0) || cur.some((c, k) => k && c < cur[k - 1]);
        // A size written on the slide (reels: each picture's width for the strip's height) follows the strip's height.
        const ph = par.getBoundingClientRect().height || 1;
        const sized = sl.map((i) => { const e = els[i], w = parseFloat(e.style.width), h = parseFloat(e.style.height); return /px/.test(e.style.width) && /px/.test(e.style.height) && w > 0 && h > 0 ? [Math.round(w / h * 1e4) / 1e4, Math.round(h / ph * 1e3) / 1e3] : null; });
        const out = { sl: sl.map((i) => moving.indexOf(i)), gap, al, x0: al === 's' ? Math.round(x0 * 10) / 10 : 0, pw: Math.round(pw), by, inf, cur, max: inf ? 0 : cur[cur.length - 1] };
        if (sized.every(Boolean)) out.ar = sized.map((q) => q[0]), out.hk = sized[0][1];
        // What tells the current slide, one in view and one waiting out of view apart (aria-hidden, data-active...).
        const role = (k, j) => (j === cur[k] ? 'c' : far(X[k][j]) ? 'o' : 'v');
        const names = new Set(); const seen = { c: {}, v: {}, o: {} };
        states.forEach((s, k) => sl.forEach((i, j) => { const o = {}; for (const kv of s[i][2] ? s[i][2].split('\u001f') : []) { const q = kv.indexOf('='); o[kv.slice(0, q)] = kv.slice(q + 1); names.add(kv.slice(0, q)); } const r = role(k, j); (seen[r].all ||= []).push(o); }));
        const roles = {};
        for (const n of names) {
          const vals = (r) => [...new Set((seen[r].all || []).map((o) => (n in o ? o[n] : null)))];
          const per = { c: vals('c'), v: vals('v'), o: vals('o') };
          // Only attributes that depend on the slide's place and nothing else.
          if (Object.values(per).some((v) => v.length > 1)) continue;
          const flat = Object.values(per).filter((v) => v.length).map((v) => v[0]);
          if (new Set(flat).size < 2) continue;
          for (const r of ['c', 'v', 'o']) if (per[r].length) (roles[r] ||= {})[ren(n)] = per[r][0];
        }
        if (Object.keys(roles).length) out.roles = roles;
        // The first step over time: where the slide that becomes current is, from start (0) to rest (1).
        const lv = cur.length > 1 && !far(X[1][cur[0]]) ? cur[0] : cur[1] ?? 0, tj = tracked.indexOf(sl[lv]);
        if (tj >= 0 && cur.length > 1 && res.how !== 'timer' && track.rows.length > 4 && !far(X[0][lv]) && !far(X[1][lv])) {
          const a = track.rows[0][1][tj], b = X[1][lv] + pl, rows = track.rows.map(([t, xs]) => [t, (xs[tj] - a) / ((b - a) || 1)]).filter(([, p]) => p > -5 && p < 5);
          let i0 = 0; rows.forEach(([, p], i) => { if (p < 0.004) i0 = i; });
          const i1 = rows.findIndex(([, p], i) => i > i0 && p > 0.996);
          if (i1 > i0 + 2 && Math.abs(b - a) > 20) {
            const T = rows[i1][0] - rows[i0][0], pts = [];
            for (let i = i0; i <= i1; i++) { const t = (rows[i][0] - rows[i0][0]) / T, p = Math.min(1, Math.max(0, rows[i][1])); if (!pts.length || t - pts[pts.length - 1][0] >= 0.05 || i === i1) pts.push([Math.round(t * 1000) / 1000, Math.round(p * 1000) / 1000]); }
            if (T >= 120 && T <= 3000) out.ease = { ms: Math.round(T), pts };
          }
        }
        return out;
      })();
      if (strip) { timed.strip = strip; res.strip = { slides: strip.sl.length, gap: strip.gap, align: strip.al, endless: strip.inf, sized: !!strip.ar, ms: strip.ease?.ms || null }; }
      // The arrows ran out (nothing changed on the last press): a row with an end, which stops there instead of going round.
      if (res.how !== 'timer' && res.stop === 'no change') timed.fin = 1;
      g.setAttribute('data-pv-gal', JSON.stringify({ id, auto, ...timed, w: Math.round(g.getBoundingClientRect().width), steps: states.map((s) => moving.map((i) => [ren(s[i][0]), ren(noUrl(s[i][1])), ren(s[i][2]), s[i][3]])) }));
      for (const b of nexts) b.setAttribute('data-pv-gal-next', id);
      for (const b of prevs) b.setAttribute('data-pv-gal-prev', id);
      res.moving = moving.length; res.id = id++;
    }
    return out;
  }, [SQS_GALLERY_SEL, NEXT_SEL, PREV_SEL, watchMs, maxSteps, maxMs]).catch((e) => ({ error: String(e.message).split('\n')[0] }));
}

async function scrollThrough(page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = await page.evaluate(() => innerHeight);
  for (let y = 0; y < h + vh; y += Math.round(vh * 0.6)) {
    await page.evaluate((y) => scrollTo(0, y), y);
    await sleep(350);
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(1500);
}

// Buttons that only show once the visitor scrolls down, such as "back to top" (not crispy enough's yellow arrow,
// 2026-11-13): an owner script shows them, so the copy, saved at the top of the page, kept them hidden for good. Find
// fixed pieces hidden at the top that show further down, note how far down they show and whether clicking one takes
// the page back to the top, for our stand-in (build.mjs SCROLL_SHOW_SCRIPT).
export async function scrollShown(page) {
  const vis = () => page.evaluate(() => {
    const out = {};
    document.querySelectorAll('[data-preserve-ss]').forEach((e) => {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      out[e.getAttribute('data-preserve-ss')] = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.5 ? cs.display : '';
    });
    return out;
  });
  await page.evaluate(() => scrollTo(0, 0)); await sleep(600);
  const n = await page.evaluate(() => {
    let k = 0;
    for (const e of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(e);
      if (cs.position !== 'fixed' || e.closest('[data-preserve-ss]')) continue;
      if (e.querySelectorAll('*').length > 20 || e.textContent.trim().length > 40) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05) continue;
      e.setAttribute('data-preserve-ss', String(k++));
    }
    return k;
  }).catch(() => 0);
  if (!n) return [];
  const h = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  const top = await vis(), found = {};
  for (const y of [150, 400, 800, 1500, 2500, 3500, Math.round(h / 2)].filter((y, i, a) => y < h && (i === a.length - 1 || y < a[a.length - 1]))) {
    await page.evaluate((y) => scrollTo(0, y), y); await sleep(700);
    const v = await vis();
    for (const [k, d] of Object.entries(v)) if (d && !top[k] && !found[k]) found[k] = { y, d };
  }
  // Does clicking it take the page back to the top? (Only ones that don't lead to another page.)
  for (const k of Object.keys(found)) {
    await page.evaluate((y) => scrollTo(0, y), Math.round(h / 2)); await sleep(500);
    const box = await page.evaluate((k) => { const e = document.querySelector(`[data-preserve-ss="${k}"]`); const a = e.closest('a[href]'); if (a && !/^#|^javascript:/i.test(a.getAttribute('href'))) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, k);
    if (!box) continue;
    await page.mouse.click(box.x, box.y); await sleep(1500);
    if (await page.evaluate(() => scrollY) < 40) found[k].top = 1;
  }
  await page.evaluate((found) => {
    for (const [k, f] of Object.entries(found)) { const e = document.querySelector(`[data-preserve-ss="${k}"]`); if (e) e.setAttribute('data-pv-scrollshow', JSON.stringify(f)); }
    document.querySelectorAll('[data-preserve-ss]').forEach((e) => e.removeAttribute('data-preserve-ss'));
    scrollTo(0, 0);
  }, found);
  await sleep(600);
  return Object.values(found);
}

// Effects tied to the scroll position (2026-11-16: not crispy enough's piece that turns as you scroll, a plugin running
// GSAP's ScrollTrigger; any script that moves, turns, scales or fades something in step with the scroll): the owner's
// script is dropped, so the copy froze it where it sat at the top of the page. Find what such scripts move by watching
// which elements get their style rewritten while we scroll, then sample each one's transform and opacity at scroll
// positions down the page. Keep only those whose look depends on the scroll position alone: the same at a position
// whether you arrive there or wait there (not running on a timer) and when you come back up to it (not a one-time
// reveal). Positions are kept relative to the element's box's top, so our stand-in (build.mjs SCROLL_FX_SCRIPT) can
// replay them at any width.
export async function scrollLinked(page) {
  await page.evaluate(() => {
    window.__pvSL = new Set();
    window.__pvSLo = new MutationObserver((ms) => { for (const m of ms) if (m.target.nodeType === 1) window.__pvSL.add(m.target); });
    window.__pvSLo.observe(document.body, { attributes: true, attributeFilter: ['style'], subtree: true });
  });
  const { H, vh } = await page.evaluate(() => ({ H: document.documentElement.scrollHeight - innerHeight, vh: innerHeight }));
  const step = Math.max(100, Math.round(vh / 4));
  const ys = []; for (let y = 0; y < H; y += step) ys.push(y); ys.push(Math.max(0, H));
  for (const y of ys) { await page.evaluate((y) => scrollTo(0, y), y); await sleep(120); }
  const n = await page.evaluate(() => {
    window.__pvSLo.disconnect();
    let k = 0;
    for (const e of window.__pvSL) {
      if (!e.isConnected || k >= 60) continue;
      if (e.closest('header, [data-pv-gal], [data-pv-pointer], [data-pv-scrollshow], .user-items-list-carousel, .gallery-reel, .gallery-slideshow, [class*="marquee"], [class*="scrolling"]')) continue;
      const r = e.getBoundingClientRect(); if (r.width < 8 || r.height < 8) continue;
      e.setAttribute('data-preserve-sl', String(k++));
    }
    return k;
  });
  if (!n) return 0;
  const read = () => page.evaluate(() => [...document.querySelectorAll('[data-preserve-sl]')].sort((x, y) => x.getAttribute('data-preserve-sl') - y.getAttribute('data-preserve-sl')).map((e) => { const cs = getComputedStyle(e); return [cs.transform, Math.round(+cs.opacity * 1000) / 1000]; }));
  const same = (a, b) => a[0] === b[0] && Math.abs(a[1] - b[1]) < 0.01;
  // A quick look first: only pieces whose look changes down the page are worth the slow, settled pass.
  { const seen = []; for (let j = 0; j < ys.length; j += 2) { await page.evaluate((y) => scrollTo(0, y), ys[j]); await sleep(150); seen.push(await read()); }
    const moving = seen[0].map((v, i) => seen.some((s) => !same(s[i], v)));
    if (!moving.some(Boolean)) { await page.evaluate(() => { document.querySelectorAll('[data-preserve-sl]').forEach((e) => e.removeAttribute('data-preserve-sl')); scrollTo(0, 0); }); return 0; } }
  const t0 = Date.now();
  const samples = [], timed = new Set();
  for (const y of ys) {
    if (Date.now() - t0 > 150000) { for (let i = 0; i < n; i++) timed.add(i); break; }  // too slow to settle: leave it
    await page.evaluate((y) => scrollTo(0, y), y); await sleep(250);
    // Smoothed effects ease into place over a second or so: wait for it to settle.
    let a = await read(), b = a;
    for (let t = 0; t < 10; t++) { await sleep(250); b = await read(); if (b.every((v, i) => same(v, a[i]))) break; a = b; }
    const c = await read(); await sleep(250); const d = await read();
    c.forEach((v, i) => { if (!same(v, d[i])) timed.add(i); });
    samples.push(d);
  }
  // Coming back up: the same look at the same place, or it isn't tied to the scroll.
  const once = new Set();
  for (let j = ys.length - 1; j >= 0; j -= 3) {
    await page.evaluate((y) => scrollTo(0, y), ys[j]); await sleep(250);
    let v = await read();
    for (let t = 0; t < 10; t++) { await sleep(250); const w = await read(); if (w.every((x, i) => same(x, v[i]))) break; v = w; }
    v.forEach((x, i) => { const r = samples[j][i]; if (!same(x, r) && !(x[0] !== 'none' && r[0] !== 'none' && near(x[0], r[0]))) once.add(i); });
  }
  function near(m1, m2) { const a = (m1.match(/-?[\d.e-]+/g) || []).map(Number), b = (m2.match(/-?[\d.e-]+/g) || []).map(Number); return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < (i >= a.length - 2 ? 3 : 0.03)); }
  const keep = [];
  if (process.env.PV_DEBUG_SL) console.log('scrollLinked', { n, timed: [...timed], once: [...once] });
  for (let i = 0; i < n; i++) {
    if (timed.has(i) || once.has(i)) continue;
    const vals = samples.map((s) => s[i]);
    if (vals.every((v) => same(v, vals[0]))) continue;
    keep.push(i);
  }
  await page.evaluate(([keep, ys, samples]) => {
    const anchor = (e) => { const p = e.parentElement || e; return p.getBoundingClientRect().top + scrollY; };
    for (const i of keep) {
      const e = document.querySelector(`[data-preserve-sl="${i}"]`); if (!e) continue;
      const top = anchor(e), pts = [];
      ys.forEach((y, j) => { const v = samples[j][i], last = pts[pts.length - 1], next = samples[j + 1] && samples[j + 1][i];
        // Drop points in the middle of a flat stretch.
        if (last && last[1] === v[0] && last[2] === v[1] && next && next[0] === v[0] && next[1] === v[1]) return;
        pts.push([Math.round(y - top), v[0], v[1]]); });
      e.setAttribute('data-pv-scroll', JSON.stringify(pts));
    }
    document.querySelectorAll('[data-preserve-sl]').forEach((e) => e.removeAttribute('data-preserve-sl'));
    scrollTo(0, 0);
  }, [keep, ys, samples]);
  await sleep(600);
  return keep.length;
}

// Things that move on their own, on a timer (2026-11-17, Chelsey Arce's logo strip: a plugin turns a list into a strip
// that slides sideways forever and stops while the pointer is over it): the plugin's script is dropped, so the copy
// froze the strip wherever it was. Find them by watching which elements get their style rewritten while the page sits
// still, at each screen's worth down the page, and which run a stylesheet animation that never ends. Keep those that move steadily one way (sideways, up or down, or turning),
// and work out where the motion repeats: for a strip, the distance at which its items start over (plugins copy the
// items so the strip has no end); for a turn, a full circle. Then hover each one to see whether it stops. Each is
// marked for our stand-in (build.mjs TICKER_SCRIPT): which way, how fast, how far before it repeats, and whether
// hovering stops it. One that moves some other way stays frozen, as before.
export async function timedMotion(page, { hover = true } = {}) {
  await page.evaluate(() => {
    window.__pvTM = new Set();
    window.__pvTMo = new MutationObserver((ms) => { if (!window.__pvTMon) return; for (const m of ms) if (m.target.nodeType === 1) window.__pvTM.add(m.target); });
    window.__pvTMo.observe(document.body, { attributes: true, attributeFilter: ['style'], subtree: true });
  });
  const { H, vh } = await page.evaluate(() => ({ H: document.documentElement.scrollHeight - innerHeight, vh: innerHeight }));
  for (let y = 0; ; y += vh) {
    await page.evaluate((y) => scrollTo(0, y), Math.min(y, H)); await sleep(400);
    await page.evaluate(() => { window.__pvTMon = true; }); await sleep(700);
    // Stylesheet animations that run forever move things too, with no style rewritten (plugins' own stylesheets).
    await page.evaluate(() => { window.__pvTMon = false; for (const a of document.getAnimations()) { const t = a.effect && a.effect.target, tm = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming(); if (t && t.nodeType === 1 && tm && tm.iterations === Infinity && a.playState === 'running') window.__pvTM.add(t); } });
    if (y >= H) break;
  }
  const n = await page.evaluate(() => {
    window.__pvTMo.disconnect();
    let k = 0;
    for (const e of window.__pvTM) {
      if (!e.isConnected || k >= 20) continue;
      if (e.closest('header, [data-pv-gal], [data-pv-pointer], [data-pv-scrollshow], [data-pv-scroll], .gallery-slideshow, .sqs-block-marquee, [data-pv-tick]')) continue;
      const r = e.getBoundingClientRect(); if (r.width < 8 || r.height < 8) continue;
      e.setAttribute('data-preserve-tm', String(k++));
    }
    return k;
  });
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const sel = `[data-preserve-tm="${i}"]`;
    await page.evaluate((s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); scrollTo(0, Math.max(0, r.top + scrollY - innerHeight / 3)); }, sel);
    await sleep(500);
    const read = () => page.evaluate((s) => { const e = document.querySelector(s); const m = (getComputedStyle(e).transform.match(/-?[\d.e-]+/g) || []).map(Number); return { t: performance.now(), m }; }, sel);
    const pts = []; for (let j = 0; j < 12; j++) { pts.push(await read()); await sleep(150); }
    const kind = motionKind(pts);
    if (process.env.PV_DEBUG_TM) console.log("timedMotion sample", i, kind, pts.map((p) => p.m.join(",")).slice(0, 4));
    if (!kind) continue;
    const p = kind.k === 'r' ? 360 : await page.evaluate(([s, ax]) => {
      // Where the items start over: the first child that looks like the first one.
      const e = document.querySelector(s), kids = [...e.children]; if (kids.length < 2) return 0;
      const sig = (c) => c.tagName + '|' + c.textContent.replace(/\s+/g, ' ').trim() + '|' + [...c.querySelectorAll('img')].map((im) => (im.currentSrc || im.src || '').split('?')[0]).join(',');
      const s0 = sig(kids[0]);
      for (let j = 1; j < kids.length; j++) if (sig(kids[j]) === s0) {
        const a = kids[0].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        return Math.round((ax === 'x' ? b.left - a.left : b.top - a.top) * 100) / 100;
      }
      return 0;
    }, [sel, kind.k]);
    if (!(p > 0)) continue;
    let hp = 0;
    if (hover) {
      const box = await page.locator(sel).boundingBox().catch(() => null);
      if (box) {
        // The middle of the part on screen: a strip is often far wider than the window.
        const vw = page.viewportSize()?.width || 1440, x0 = Math.max(0, box.x), x1 = Math.min(vw, box.x + box.width);
        const hx = (x0 + x1) / 2, hy = box.y + box.height / 2;
        // A popup or bar over it would take the hover: set aside whatever is on top there for the test.
        await page.evaluate(([s, x, y]) => { const e = document.querySelector(s); let top = document.elementFromPoint(x, y);
          for (let k = 0; k < 5 && top && !e.contains(top); k++) { let c = top; while (c.parentElement && c.parentElement !== document.body && getComputedStyle(c).position !== 'fixed') c = c.parentElement;
            c.setAttribute('data-preserve-tm-aside', c.style.visibility || ''); c.style.visibility = 'hidden'; top = document.elementFromPoint(x, y); } }, [sel, hx, hy]);
        await page.mouse.move(hx, hy); await sleep(400);
        const a = await read(); await sleep(400); const b = await read();
        hp = a.m.every((v, j) => Math.abs(v - b.m[j]) < 0.5) ? 1 : 0;
        if (process.env.PV_DEBUG_TM) console.log("timedMotion hover", { box, a: a.m, b: b.m });
        await page.mouse.move(1, 1); await sleep(200);
        await page.evaluate(() => document.querySelectorAll('[data-preserve-tm-aside]').forEach((c) => { c.style.visibility = c.getAttribute('data-preserve-tm-aside'); c.removeAttribute('data-preserve-tm-aside'); }));
      }
    }
    await page.evaluate(([s, c]) => document.querySelector(s).setAttribute('data-pv-tick', JSON.stringify(c)), [sel, { k: kind.k, v: Math.round(kind.v * 100) / 100, p, hp }]);
    kept++;
  }
  await page.evaluate(() => { document.querySelectorAll('[data-preserve-tm]').forEach((e) => e.removeAttribute('data-preserve-tm')); scrollTo(0, 0); });
  await sleep(400);
  return kept;
}

// Steady motion one way from timed samples of a transform matrix: sideways (x), up or down (y) or turning (r), with its
// speed in pixels or degrees a second. Null when it isn't steady (eases, stops, goes back and forth) or isn't one of those.
export function motionKind(pts) {
  const ok = pts.filter((p) => p.m.length === 6); if (ok.length < 6) return null;
  const ang = (m) => Math.atan2(m[1], m[0]) * 180 / Math.PI;
  const pure = ok.every((p) => Math.abs(Math.hypot(p.m[0], p.m[1]) - 1) < 0.01);
  const series = { x: ok.map((p) => p.m[4]), y: ok.map((p) => p.m[5]), r: ok.map((p) => ang(p.m)) };
  const ts = ok.map((p) => p.t / 1000);
  const moving = Object.keys(series).filter((k) => Math.abs(series[k][series[k].length - 1] - series[k][0]) > 0.5 || series[k].some((v) => Math.abs(v - series[k][0]) > 0.5));
  if (moving.length !== 1 || !pure) return null;
  const k = moving[0], s = series[k];
  if (k !== 'r' && ok.some((p) => Math.abs(p.m[0] - 1) > 0.001 || Math.abs(p.m[1]) > 0.001)) return null;
  // Speeds between samples, leaving out one jump back where the motion starts over.
  const v = []; for (let j = 1; j < s.length; j++) { let d = s[j] - s[j - 1]; if (k === 'r') { while (d > 180) d -= 360; while (d < -180) d += 360; } v.push(d / ((ts[j] - ts[j - 1]) || 1)); }
  const sorted = [...v].sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
  if (Math.abs(med) < 2) return null;
  const off = v.filter((x) => Math.abs(x - med) > Math.abs(med) * 0.25 + 3).length;
  if (off > 1) return null;
  return { k, v: med };
}

// Pointer followers (2026-11-13: hello world studio's 3D cursor, not crispy enough's little pictures that follow the
// pointer over some blocks): owner scripts hide the arrow and move a small fixed element with the pointer, everywhere
// or only while it is over one block. Those scripts are dropped, so the copy showed the follower frozen where it sat
// (or not at all). Find them by watching what moves with the mouse: anything fixed that ignores the pointer and moves
// by as much as the mouse did. For the hidden ones, hover each block to find the one that shows it. Each is marked with
// what our stand-in (build.mjs POINTER_SCRIPT) needs: where it sits relative to the pointer, the block that shows it,
// and whether the arrow is hidden there. Desktop only: phones have no pointer.
async function pointerFollowers(page) {
  const n = await page.evaluate(() => {
    let k = 0;
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.pointerEvents !== 'none') continue;
      const par = el.parentElement && getComputedStyle(el.parentElement);
      const onPage = cs.position === 'absolute' && (!el.offsetParent || el.offsetParent === document.body || el.offsetParent === document.documentElement) && (!par || par.position === 'static');
      if (cs.position !== 'fixed' && !onPage && !(cs.position === 'absolute' && par && par.position === 'fixed' && par.pointerEvents === 'none')) continue;
      if (el.querySelectorAll('*').length > 30 || el.textContent.trim().length > 60) continue;
      el.setAttribute('data-preserve-fc', String(k++));
    }
    return k;
  }).catch(() => 0);
  if (!n) return [];
  const snap = () => page.evaluate(() => [...document.querySelectorAll('[data-preserve-fc]')].map((e) => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return { k: +e.getAttribute('data-preserve-fc'), vis: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none', x: r.left, y: r.top, w: r.width, h: r.height };
  }));
  const cursorAt = (x, y) => page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? getComputedStyle(e).cursor : ''; }, [x, y]);
  const moved = (a, b, dx, dy) => a && b && a.vis && b.vis && Math.abs((b.x - a.x) - dx) < Math.abs(dx) * 0.25 + 4 && Math.abs((b.y - a.y) - dy) < Math.abs(dy) * 0.25 + 4;
  const found = [];
  // Everywhere on the page.
  await page.evaluate(() => scrollTo(0, 0)); await sleep(300);
  await page.mouse.move(300, 300, { steps: 5 }); await sleep(700);
  const s1 = await snap();
  await page.mouse.move(700, 500, { steps: 12 }); await sleep(1000);
  const s2 = await snap();
  for (const b of s2) {
    const a = s1.find((x) => x.k === b.k);
    if (moved(a, b, 400, 200)) found.push({ k: b.k, t: 'page', dx: Math.round(b.x - 700), dy: Math.round(b.y - 500), cx: Math.round(b.x + b.w / 2 - 700), cy: Math.round(b.y + b.h / 2 - 500), cur: await cursorAt(700, 500) === 'none' ? 'none' : '' });
  }
  // Only over a block: hover each block and see which hidden follower appears and moves with the pointer.
  const hidden = s2.filter((x) => !x.vis && !found.some((f) => f.k === x.k)).map((x) => x.k);
  if (hidden.length) {
    const blocks = await page.evaluate(() => {
      const bs = [...document.querySelectorAll('.sqs-block[id], .fe-block[id], [id^="block-"]')].slice(0, 200);
      bs.forEach((b, i) => b.setAttribute('data-preserve-pb', String(i)));
      return bs.length;
    });
    for (let i = 0; i < blocks && hidden.length; i++) {
      // Sites often scroll smoothly: jump, then measure once the page has settled.
      const ok = await page.evaluate((i) => { const b = document.querySelector(`[data-preserve-pb="${i}"]`); if (!b) return false; b.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; }, i);
      if (!ok) continue;
      await sleep(150);
      const box = await page.evaluate((i) => { const r = document.querySelector(`[data-preserve-pb="${i}"]`).getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.top >= 0 && r.bottom <= innerHeight + r.height ? { x: r.left + r.width / 2, y: Math.max(10, Math.min(innerHeight - 30, r.top + r.height / 2)) } : null; }, i);
      if (!box) continue;
      await page.mouse.move(box.x, box.y, { steps: 2 }); await sleep(120);
      const a = await snap();
      if (!a.some((x) => x.vis && hidden.includes(x.k))) continue;
      await page.mouse.move(box.x + 30, box.y + 15, { steps: 4 }); await sleep(250);
      const b = await snap();
      for (const k of [...hidden]) {
        const p = a.find((x) => x.k === k), q = b.find((x) => x.k === k);
        if (!moved(p, q, 30, 15)) continue;
        found.push({ k, t: 'block', b: i, dx: Math.round(q.x - box.x - 30), dy: Math.round(q.y - box.y - 15), cur: await cursorAt(box.x + 30, box.y + 15) === 'none' ? 'none' : '' });
        hidden.splice(hidden.indexOf(k), 1);
      }
    }
  }
  // The look of each page-wide one at rest and over a link: some grow or change colour over links.
  const look = (k) => page.evaluate((k) => { const e = document.querySelector(`[data-preserve-fc="${k}"]`); if (!e) return null; const cs = getComputedStyle(e); return { w: cs.width, h: cs.height, bg: cs.backgroundColor, cls: e.className }; }, k);
  const pageWide = found.filter((f) => f.t === 'page');
  if (pageWide.length) {
    await page.evaluate(() => scrollTo(0, 0)); await sleep(200);
    const spot = await page.evaluate(() => {
      const plain = (x, y) => { const e = document.elementFromPoint(x, y); return e && !e.closest('a,button,[role="button"],input,select,textarea,label'); };
      const link = [...document.querySelectorAll('a[href]')].map((a) => a.getBoundingClientRect()).find((r) => r.width > 8 && r.height > 8 && r.top > 0 && r.bottom < innerHeight);
      let rest = null; for (let y = 120; y < innerHeight - 40 && !rest; y += 60) for (let x = 80; x < innerWidth - 80 && !rest; x += 120) if (plain(x, y)) rest = { x, y };
      return { rest, link: link ? { x: link.left + link.width / 2, y: link.top + link.height / 2 } : null };
    });
    if (spot.rest) {
      await page.mouse.move(spot.rest.x, spot.rest.y, { steps: 4 }); await sleep(900);
      for (const f of pageWide) f.rest = await look(f.k);
      if (spot.link) {
        await page.mouse.move(spot.link.x, spot.link.y, { steps: 4 }); await sleep(900);
        for (const f of pageWide) { const l = await look(f.k); if (l && f.rest && (l.w !== f.rest.w || l.h !== f.rest.h || l.bg !== f.rest.bg)) f.link = l; }
      }
      // Leave it as it looks at rest, so the saved page doesn't keep a link's look.
      await page.mouse.move(spot.rest.x, spot.rest.y, { steps: 4 }); await sleep(900);
    }
  }
  await page.evaluate((found) => {
    for (const f of found) {
      const e = document.querySelector(`[data-preserve-fc="${f.k}"]`); if (!e) continue;
      const c = { dx: f.dx, dy: f.dy, cur: f.cur, ...(f.cx != null ? { cx: f.cx, cy: f.cy } : {}) };
      if (getComputedStyle(e).position === 'absolute' && getComputedStyle(e.parentElement).position === 'static') c.pg = 1;
      if (f.rest && f.link) c.hov = { w: f.rest.w, h: f.rest.h, bg: f.rest.bg, lw: f.link.w, lh: f.link.h, lbg: f.link.bg };
      if (f.t === 'block') { const b = document.querySelector(`[data-preserve-pb="${f.b}"]`); if (!b) continue; b.setAttribute('data-pv-ptrig', String(f.k)); c.on = String(f.k); }
      e.setAttribute('data-pv-pointer', JSON.stringify(c));
    }
    document.querySelectorAll('[data-preserve-fc]').forEach((e) => e.removeAttribute('data-preserve-fc'));
    document.querySelectorAll('[data-preserve-pb]').forEach((e) => e.removeAttribute('data-preserve-pb'));
    scrollTo(0, 0);
  }, found);
  await page.mouse.move(1, 1); await sleep(300);
  await sleep(500);
  return found.map((f) => ({ t: f.t, dx: f.dx, dy: f.dy, cur: f.cur, link: !!f.link }));
}

// Squarespace's block animations set to play on hover (not crispy enough's boxes tilt a little, 2026-11-13): the
// settings sit in a JSON script next to the block, which Squarespace's own code reads and the copy drops. Keep the
// hover's end state on the block itself (data-pv-hover with CSS variables) for our stylesheet (build.mjs HOVER_FX_CSS).
function markBlockHovers() {
  let n = 0;
  for (const t of document.querySelectorAll('script[data-block-animations]')) {
    let j; try { j = JSON.parse(t.textContent); } catch { continue; }
    const a = (j.animations || []).find((x) => x.trigger === 'hover' && (x.triggerElement || 'self') === 'self' && x.transforms && x.transforms[0]);
    const el = t.closest('.fe-block') || t.closest('.sqs-block');
    if (!a || !el) continue;
    const x = a.transforms[0], v = (o, d) => (o && o.value != null ? o.value : d), u = (o, d) => (o && o.unit) || d;
    const dur = Math.max(0.05, Math.min(3, v(a.duration, 0.5)));
    const ease = a.ease === 'linear' ? 'linear' : a.ease === 'spring' ? `cubic-bezier(.34,${(1 + Math.min(1, v({ value: a.bounce }, 0.5)) * 0.9).toFixed(2)},.64,1)` : 'cubic-bezier(.25,.1,.25,1)';
    const o = j.transforms && j.transforms.origin;
    el.style.setProperty('--pv-hr', `${v(x.rotation && x.rotation.z, 0)}deg`);
    el.style.setProperty('--pv-hs', `${v(x.scale && x.scale.x, 100) / 100} ${v(x.scale && x.scale.y, 100) / 100}`);
    el.style.setProperty('--pv-ht', `${v(x.offset && x.offset.x, 0)}${u(x.offset && x.offset.x, 'px')} ${v(x.offset && x.offset.y, 0)}${u(x.offset && x.offset.y, 'px')}`);
    el.style.setProperty('--pv-ho', `${v(x.opacity, 100) / 100}`);
    el.style.setProperty('--pv-hd', `${dur}s ${ease}`);
    if (o) el.style.setProperty('--pv-hog', `${v(o.x, 50)}${u(o.x, '%')} ${v(o.y, 50)}${u(o.y, '%')}`);
    el.setAttribute('data-pv-hover', '');
    n++;
  }
  return n;
}

// Squarespace's block animations set to play as the block comes into view (chelsey arce's posters grow from nothing as
// you scroll to them, 2026-11-17). Settings sit in the same JSON script as the hover ones (markBlockHovers); the copy
// drops Squarespace's code and so showed every block at rest from the start. Keep the start state on the block (CSS
// variables) and when it plays (data-pv-appear) for our stand-in (build.mjs APPEAR_SCRIPT). "scrolls" ones follow the
// scroll between two points of the block's way up the screen and, as live, don't go back once played.
function markBlockAppears() {
  let n = 0;
  for (const t of document.querySelectorAll('script[data-block-animations]')) {
    let j; try { j = JSON.parse(t.textContent); } catch { continue; }
    const a = (j.animations || []).find((x) => x.trigger === 'appear' && (x.triggerElement || 'self') === 'self' && x.transforms && x.transforms[0]);
    const el = t.closest('.fe-block') || t.closest('.sqs-block');
    if (!a || !el || el.hasAttribute('data-pv-hover')) continue;
    const x = a.transforms[0], v = (o, d) => (o && o.value != null ? o.value : d), u = (o, d) => (o && o.unit) || d;
    const sx = v(x.scale && x.scale.x, 100) / 100, sy = v(x.scale && x.scale.y, 100) / 100, r = v(x.rotation && x.rotation.z, 0);
    const tx = `${v(x.offset && x.offset.x, 0)}${u(x.offset && x.offset.x, 'px')}`, ty = `${v(x.offset && x.offset.y, 0)}${u(x.offset && x.offset.y, 'px')}`;
    const op = v(x.opacity, 100) / 100;
    if (sx === 1 && sy === 1 && !r && /^0[a-z%]*$/.test(tx) && /^0[a-z%]*$/.test(ty) && op === 1) continue;  // starts at rest: nothing to play
    el.style.setProperty('--pv-ar', `${r}deg`);
    el.style.setProperty('--pv-as', `${Math.max(sx, 0.000001)} ${Math.max(sy, 0.000001)}`);
    el.style.setProperty('--pv-at', `${tx} ${ty}`);
    el.style.setProperty('--pv-ao', String(op));
    const o = j.transforms && j.transforms.origin;
    if (o) el.style.setProperty('--pv-aog', `${v(o.x, 50)}${u(o.x, '%')} ${v(o.y, 50)}${u(o.y, '%')}`);
    const rng = (q, m, d) => [(q && q.mode) || m, v(q && q.value, d) / 100];
    el.setAttribute('data-pv-appear', JSON.stringify({
      s: a.action === 'scrolls' ? 1 : 0, rs: rng(a.rangeStart, 'entry', 0), re: rng(a.rangeEnd, 'cover', 50),
      ap: a.appearPoint || 'middle', d: Math.max(0.05, Math.min(4, v(a.duration, 1))), dl: Math.max(0, Math.min(4, v(a.delay, 0))), e: a.ease || 'ease',
    }));
    n++;
  }
  return n;
}

// Section backgrounds Squarespace draws with a script, which the copy drops (chelsey arce, 2026-11-17):
// - Background images with an effect (parallax, film grain, liquid...) live as a hidden picture under a WebGL drawing.
//   The drawing only paints near the screen, so photographing it (canvasStills) left most such sections black. For
//   parallax (a zoom and drift with the scroll) we keep the picture itself and our stand-in redoes the movement from the
//   section's own settings (build.mjs PARALLAX_SCRIPT). Other effects keep their photo when it took (afterCanvasStills).
// - Background videos hosted on Vimeo or YouTube (Squarespace's own are clipped to MP4 by video.mjs). Jeremy
//   (2026-11-17): play them through the provider's own player, over a still from the video that stays if the video is
//   ever taken down. Here we put the still in (so it is saved like any picture) and note the video for
//   build.mjs BGVIDEO_SCRIPT. Their player is never saved.
export function bgVideoId(u) {
  let m;
  if ((m = /vimeo\.com\/(?:video\/)?(\d+)(?:\/([0-9a-f]{6,}))?/i.exec(u))) {
    const h = m[2] || (/[?&]h=([0-9a-f]+)/i.exec(u) || [])[1];
    return { p: 'vimeo', id: m[1], ...(h ? { h } : {}) };
  }
  if ((m = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i.exec(u))) return { p: 'youtube', id: m[1] };
  return null;
}
// A frame of the playing video, drawn from inside the provider's player: the still owners pick on Vimeo is often the
// black first frame (chelsey arce's reel). Watch a few seconds and keep the brightest, busiest frame.
async function grabVideoFrame(page, v) {
  const fr = page.frames().find((f) => f.url().includes(v.id) && (v.p === 'vimeo' ? /player\.vimeo\.com\/video\//.test(f.url()) : /youtube(-nocookie)?\.com\/embed\//.test(f.url())));
  if (!fr) return null;
  return fr.evaluate(async () => {
    const vid = document.querySelector('video'); if (!vid) return null;
    vid.muted = true; try { await vid.play(); } catch {}
    const c = document.createElement('canvas'); let best = null, bestS = -1;
    for (let k = 0; k < 8; k++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!vid.videoWidth || vid.readyState < 2) continue;
      const w = Math.min(1920, vid.videoWidth), h = Math.round(w * vid.videoHeight / vid.videoWidth);
      c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(vid, 0, 0, w, h);
      let d; try { d = x.getImageData(0, 0, w, h).data; } catch { return null; }  // a video from another site can't be read
      let s = 0, s2 = 0, n = 0; for (let i = 0; i < d.length; i += 4 * 97) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; s += l; s2 += l * l; n++; }
      const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean)), score = mean + sd;
      if (score > bestS) { bestS = score; best = c.toDataURL('image/jpeg', 0.85); }
      if (mean > 40 && sd > 30) break;
    }
    return best && bestS > 12 ? best : null;
  }).catch(() => null);
}
async function mediaBackgrounds(page, request, outDir, manifest) {
  const found = { parallax: 0, liquid: 0, videos: [] };
  found.parallax = await page.evaluate(() => {
    let n = 0;
    for (const c of document.querySelectorAll('[data-controller="BackgroundImageFXParallax"]')) {
      const im = c.querySelector('img.background-image-fx'); if (!im) continue;
      let fx = {};
      try { fx = JSON.parse(c.closest('[data-current-context]').getAttribute('data-current-context')).backgroundMediaEffect || {}; } catch {}
      const f = (im.getAttribute('data-image-focal-point') || '0.5,0.5').split(',').map(Number);
      im.setAttribute('data-pv-parallax', JSON.stringify({ a: +fx.intensity || 0, r: +fx.rotation || 0, z0: +fx.zoomStart || 0, z1: +fx.zoomEnd || 0, fx: Number.isFinite(f[0]) ? f[0] : 0.5, fy: Number.isFinite(f[1]) ? f[1] : 0.5 }));
      c.querySelectorAll('canvas').forEach((cv) => (cv.closest('.background-fx-canvas') || cv).remove());
      im.style.visibility = 'visible';
      n++;
    }
    return n;
  }).catch(() => 0);
  // Squarespace's "liquid" image effect, on image blocks and section backgrounds (Xanadu, The Garret Group; 2026-11-27):
  // the picture ripples slowly. Live draws it with WebGL, which a snapshot can't keep, so the copy showed a still photo
  // of one moment. Keep the picture itself, note the effect's settings (data-pv-liquid) and drop the drawing; our own
  // stand-in (build.mjs LIQUID_SCRIPT) redraws the ripple over the picture from those settings.
  found.liquid = await page.evaluate(() => {
    let n = 0;
    const mark = (im, fx, box) => {
      if (!im || !fx || fx.type !== 'liquid') return;
      const f = (im.getAttribute('data-image-focal-point') || '0.5,0.5').split(',').map(Number);
      const num = (v, d) => (Number.isFinite(+v) ? +v : d);
      im.setAttribute('data-pv-liquid', JSON.stringify({ i: num(fx.intensity, 10), s: num(fx.scale, 2), r: num(fx.rotation, 0), v: num(fx.speed, 50), m: num(fx.morphSpeed, 5), sh: num(fx.shadow, 0), sm: num(fx.smoothness, 100), sd: num(fx.seed, 1), fx: Number.isFinite(f[0]) ? f[0] : 0.5, fy: Number.isFinite(f[1]) ? f[1] : 0.5 }));
      box.querySelectorAll('canvas').forEach((cv) => (cv.closest('.background-fx-canvas') || cv).remove());
      im.style.visibility = 'visible';
      n++;
    };
    for (const c of document.querySelectorAll('.imageEffectContainer[data-effect]')) {
      let fx = null; try { fx = JSON.parse(c.getAttribute('data-effect')); } catch {}
      mark(c.parentElement && c.parentElement.querySelector('img'), fx, c);
    }
    for (const c of document.querySelectorAll('[data-controller="BackgroundImageFXLiquid"]')) {
      let fx = null; try { fx = JSON.parse(c.closest('[data-current-context]').getAttribute('data-current-context')).backgroundMediaEffect; } catch {}
      mark(c.querySelector('img.background-image-fx'), fx, c);
    }
    return n;
  }).catch(() => 0);
  const vids = await page.evaluate(() => [...document.querySelectorAll('.sqs-video-background[data-config-url]:not([data-config-video])')].map((e, i) => { e.setAttribute('data-preserve-bgv', String(i)); return e.getAttribute('data-config-url'); })).catch(() => []);
  for (let i = 0; i < vids.length; i++) {
    const v = bgVideoId(vids[i] || '');
    if (!v) continue;
    let poster = null, ar = 16 / 9;  // the provider's still, if we can't take our own
    try {
      if (v.p === 'vimeo') {
        const r = await request.get(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${v.id}${v.h ? `/${v.h}` : ''}`)}&width=1920`, { timeout: 20000 });
        if (r.ok()) { const j = await r.json(); poster = j.thumbnail_url || null; if (j.width && j.height) ar = j.width / j.height; }
      } else {
        for (const n of ['maxresdefault', 'sddefault', 'hqdefault']) {
          const u = `https://i.ytimg.com/vi/${v.id}/${n}.jpg`;
          const r = await request.get(u, { timeout: 20000 });
          // A missing size comes back as a small grey picture with a 404.
          if (r.ok()) { poster = u; break; }
        }
      }
    } catch {}
    // Our own frame of the video, saved as the picture the page asks for (the export finds it like any other).
    const frame = await grabVideoFrame(page, v);
    if (frame) {
      const u = `https://preserve.invalid/video-still/${v.p}-${v.id}.jpg`, body = Buffer.from(frame.split(',')[1], 'base64'), file = hash(u);
      fs.writeFileSync(path.join(outDir, 'raw', file), body);
      manifest[u] = { status: 200, ct: 'image/jpeg', file, size: body.length, type: 'image' };
      poster = u;
    }
    const ok = await page.evaluate(async ([i, v, poster, ar, own]) => {
      const box = document.querySelector(`[data-preserve-bgv="${i}"]`); if (!box) return false;
      box.removeAttribute('data-preserve-bgv');
      box.setAttribute('data-pv-bgvideo', JSON.stringify({ ...v, ar: Math.round(ar * 1000) / 1000 }));
      box.querySelectorAll('iframe, #player > *').forEach((e) => e.remove());
      if (!poster) return true;
      const im = document.createElement('img');
      im.alt = ''; im.className = 'pv-bgvideo-poster'; im.setAttribute('aria-hidden', 'true');
      im.setAttribute('style', 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block;pointer-events:none');
      box.prepend(im);
      if (own) { im.src = poster; return true; }  // saved already; nothing to load from there
      await new Promise((res) => { im.onload = im.onerror = res; im.src = poster; setTimeout(res, 15000); });
      return im.naturalWidth > 0;
    }, [i, v, poster, ar, !!frame]).catch(() => false);
    found.videos.push({ ...v, poster: !!poster && ok, frame: !!frame });
  }
  await page.evaluate(() => document.querySelectorAll('[data-preserve-bgv]').forEach((e) => e.removeAttribute('data-preserve-bgv'))).catch(() => {});
  return found;
}
// Other background effects whose drawing couldn't be photographed (off screen, or blank): show their picture instead of
// an empty section.
function afterCanvasStills() {
  let n = 0;
  for (const c of document.querySelectorAll('[data-controller^="BackgroundImageFX"]')) {
    const im = c.querySelector('img.background-image-fx'), cv = c.querySelector('canvas');
    if (!im || !cv || cv.hasAttribute('data-preserve-canvas')) continue;
    (cv.closest('.background-fx-canvas') || cv).remove();
    im.style.visibility = 'visible';
    n++;
  }
  return n;
}

// Widgets built as web components (e.g. a third-party search box) draw inside a shadow root, which a DOM snapshot can't
// keep, so the copy would show nothing there. Photograph each visible one now, as the visitor sees it, and mark the
// element so the export puts the picture in its place (same size; clicking it shows the replica note).
async function shadowStills(page, outDir, prof, info) {
  const n = await page.evaluate(() => {
    let i = 0;
    for (const el of document.querySelectorAll('*')) {
      // Custom elements whose drawing lives in a shadow root (open or closed): defined, sized, and no light-DOM content.
      const tag = el.tagName.toLowerCase();
      // ...and any block a refinement's AI pick asked to show as a picture (pins.mjs markPinStills).
      const pinned = el.hasAttribute('data-preserve-pin-still');
      if (!pinned && (!tag.includes('-') || /^(sqs-|preserve-)/.test(tag) || !(el.shadowRoot || (customElements.get(tag) && !el.textContent.trim() && !el.children.length)))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || getComputedStyle(el).visibility === 'hidden') continue;
      el.setAttribute('data-preserve-still', `${i++}`);
    }
    return i;
  });
  if (!n) return;
  fs.mkdirSync(path.join(outDir, 'stills'), { recursive: true });
  info.shadowStills = info.shadowStills || {};
  for (let i = 0; i < n; i++) {
    const el = await page.$(`[data-preserve-still="${i}"]`);
    if (!el) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {}); await sleep(600);
    // Fixed headers and badges that don't contain the widget would otherwise land in the photo, and so would marketing
    // pop-ups (the copy drops them). Faded out rather than made invisible: a pop-up's inner box that sets its own
    // visibility showed through and landed in a refinement's photo (chelsey arce's newsletter pop-up, 2026-11-17).
    await page.evaluate(([i, sel]) => {
      const w = document.querySelector(`[data-preserve-still="${i}"]`);
      const hide = (e) => { if (e.hasAttribute('data-preserve-hid') || e.contains(w)) return; e.setAttribute('data-preserve-hid', e.style.getPropertyValue('opacity') + '|' + e.style.getPropertyPriority('opacity')); e.style.setProperty('opacity', '0', 'important'); };
      for (const e of document.querySelectorAll(sel)) hide(e);
      for (const e of document.querySelectorAll('body *')) if (getComputedStyle(e).position === 'fixed') hide(e);
    }, [i, OVERLAY_SELECTORS.join(',')]);
    const box = await el.boundingBox();
    const file = `${prof}-${i}.png`;
    const ok = box && await el.screenshot({ path: path.join(outDir, 'stills', file), timeout: 15000 }).then(() => true, () => false);
    await page.evaluate(() => { for (const e of document.querySelectorAll('[data-preserve-hid]')) { const [v, pr] = e.getAttribute('data-preserve-hid').split('|'); if (v) e.style.setProperty('opacity', v, pr); else e.style.removeProperty('opacity'); e.removeAttribute('data-preserve-hid'); } });
    await el.evaluate((e, f) => { if (f) e.setAttribute('data-preserve-still', f); else e.removeAttribute('data-preserve-still'); }, ok ? file : null);
    if (ok) info.shadowStills[file] = { tag: await el.evaluate((e) => e.tagName.toLowerCase()), w: Math.round(box.width), h: Math.round(box.height) };
  }
  await page.evaluate(() => scrollTo(0, 0)); await sleep(500);
}

// Drawings on a <canvas> (Squarespace's section background effects: animated gradients, blobs, liquid; owner
// graphics) live only in the canvas's pixels, which a DOM snapshot can't keep, so the copy showed an empty section
// (backbipoc, 2026-11-10). Photograph each visible canvas on its own (everything else hidden, transparent around it) and
// mark it so the export puts the picture in its place, at the canvas's own size and position.
async function canvasStills(page, outDir, prof, info) {
  // The canvas's own pixels (not a screenshot of the spot, which would take in text laid over it).
  const shots = await page.evaluate(() => {
    const out = [];
    for (const c of document.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect(), cs = getComputedStyle(c);
      if (r.width < 40 || r.height < 40 || cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      if (c.closest('[data-preserve-still]')) continue;
      let url = null; try { url = c.toDataURL('image/png'); } catch {}  // a canvas drawn from another site can't be read
      if (!url || url.length < 200) continue;
      c.setAttribute('data-preserve-canvas', String(out.length));
      // Where it sits in the box it's placed against, in percent, so the copy can keep that at any width (field theory's
      // film-grain picture stops above the strip at the foot of its section, 2026-11-13).
      const op = c.offsetParent;
      if (op && cs.position === 'absolute') {
        const q = op.getBoundingClientRect();
        if (q.width > 0 && q.height > 0) c.setAttribute('data-preserve-cbox', [r.left - q.left, r.top - q.top].map((v, i) => (100 * v / (i ? q.height : q.width)).toFixed(3)).concat([(100 * r.width / q.width).toFixed(3), (100 * r.height / q.height).toFixed(3)]).join(','));
      }
      out.push({ url, w: Math.round(r.width), h: Math.round(r.height) });
      // Squarespace's radial gradient background that follows the pointer: its settings, with colours resolved, so
      // our stand-in (build.mjs FOLLOW_SCRIPT) can move the glow the way the site does.
      try {
        const sec = c.closest('[data-current-styles]');
        const g = sec && JSON.parse(sec.getAttribute('data-current-styles')).generative;
        if (g && g.gradientType === 'radial' && g.radialGradientFollowCursor) {
          const col = (v) => {
            if (!v) return null;
            const a = v.sitePaletteColor ? v.sitePaletteColor.alpha : (v.alpha ?? 1);
            let hsl = null;
            if (v.sitePaletteColor) hsl = getComputedStyle(sec).getPropertyValue(`--${v.sitePaletteColor.id}-hsl`).trim();
            else if (v.customColor || v.hsl) { const h = v.customColor || v.hsl; hsl = `${h.hue},${h.saturation}%,${h.lightness}%`; }
            if (!hsl) return null;
            const t = document.createElement('i'); t.style.color = `hsla(${hsl},${a})`; document.body.appendChild(t);
            const rgb = getComputedStyle(t).color; t.remove(); return rgb;
          };
          const c0 = col(g.startColor), c1 = col(g.endColor);
          if (c0 && c1) c.setAttribute('data-preserve-follow', JSON.stringify({ c0, c1, r: g.radialGradientRadius ?? 30, x: g.radialGradientPositionX ?? 50, y: g.radialGradientPositionY ?? 50, s: g.radialGradientFollowSpeed ?? 100, inv: !!g.invertColors }));
        }
      } catch {}
      // Squarespace's image effects (film grain, liquid, refracted...): the effect's name, for a stand-in where we have one.
      const fx = c.closest('[data-controller^="BackgroundImageFX"]');
      if (fx) c.setAttribute('data-preserve-fx', fx.getAttribute('data-controller').replace('BackgroundImageFX', '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
    }
    return out;
  });
  if (!shots.length) return;
  fs.mkdirSync(path.join(outDir, 'stills'), { recursive: true });
  info.canvasStills = info.canvasStills || {};
  for (let i = 0; i < shots.length; i++) {
    const buf = Buffer.from(shots[i].url.split(',')[1], 'base64');
    // A canvas that drew nothing (or one flat colour) is left as it is.
    let ok = false; try { const st = await sharp(buf).stats(); ok = st.channels.some((c) => c.max - c.min > 6); } catch {}
    const file = `${prof}-canvas-${i}.png`;
    if (ok) { fs.writeFileSync(path.join(outDir, 'stills', file), buf); info.canvasStills[file] = { w: shots[i].w, h: shots[i].h }; }
    await page.evaluate(([i, f]) => { const c = document.querySelector(`[data-preserve-canvas="${i}"]`); if (!c) return; if (f) c.setAttribute('data-preserve-canvas', f); else c.removeAttribute('data-preserve-canvas'); }, [i, ok ? file : null]);
  }
}

// Pictures of each font as the live site draws it, for the review's Fonts step (Adobe files can't be shipped; pictures
// can). For each font face the page loaded:
// - "The quick brown fox" set in that font on a plain background (FOX_TEXT), drawn by the live page itself, which the
//   app sets beside the same words in the lookalike, so the two compare like for like (Jeremy, 2026-11-16).
// - the first text drawn in it that a visitor can actually see, photographed tight, and the block it sits in (for "Show
//   on page"). Text hidden off-screen or under other content (a "Skip to Content" link) is passed over: its photo was
//   of whatever covered it (margaretrajic.com, 2026-11-16).
export const FOX_TEXT = 'The quick brown fox';
async function fontSamples(page, outDir, info) {
  // Desktop first; the phone layout adds fonts only it shows.
  const done = Object.keys(info.fontSamples || {});
  const found = await page.evaluate((done) => {
    const unq = (s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase();
    const fams = new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => unq(f.family)));
    const out = [], count = {};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    // Hidden by an ancestor: see-through, or clipped to a sliver (the usual "visually hidden" pattern).
    const hidden = (el) => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (+cs.opacity === 0 || cs.display === 'none') return true;
        if (cs.clip && cs.clip !== 'auto' || cs.clipPath && /inset\(50%|circle\(0/.test(cs.clipPath)) return true;
        if (cs.overflow !== 'visible') { const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return true; }
      }
      return false;
    };
    const docW = document.documentElement.scrollWidth;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      const el = n.parentElement;
      if (t.length < 2 || !el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
      const cs = getComputedStyle(el);
      const fam = unq(cs.fontFamily.split(',')[0]);
      if (!fams.has(fam) || done.includes(fam) || (count[fam] || 0) >= 6 || cs.visibility === 'hidden') continue;
      const r = document.createRange(); r.selectNodeContents(n);
      const box = r.getBoundingClientRect();
      if (box.width < 8 || box.height < 6 || box.right < 0 || box.left > docW || box.bottom + scrollY < 0 || hidden(el)) continue;
      count[fam] = (count[fam] || 0) + 1;
      const b = el.closest('[id^="block-"],[data-block-id],section[data-section-id]') || el.closest('header,footer');
      const block = !b ? 'el:body' : /^(HEADER|FOOTER)$/.test(b.tagName) && !b.id ? 'el:' + b.tagName.toLowerCase() : b.id || b.getAttribute('data-block-id') || 'section:' + b.getAttribute('data-section-id');
      el.setAttribute('data-pv-fsample', String(out.length));
      out.push({ family: fam, text: t.slice(0, 60), block, weight: cs.fontWeight, style: cs.fontStyle, upper: cs.textTransform === 'uppercase' || /[A-Z]/.test(t) && t === t.toUpperCase() });
    }
    return out;
  }, done).catch(() => []);
  if (!found.length) return;
  fs.mkdirSync(path.join(outDir, 'font-samples'), { recursive: true });
  info.fontSamples ||= {};
  const unhide = () => page.evaluate(() => { for (const e of document.querySelectorAll('[data-preserve-hid]')) { e.style.visibility = e.dataset.preserveHid === '-' ? '' : e.dataset.preserveHid; delete e.dataset.preserveHid; } }).catch(() => {});
  for (const [i, f] of found.entries()) {
    const el = await page.$(`[data-pv-fsample="${i}"]`);
    if (!el) continue;
    await el.evaluate((e) => e.removeAttribute('data-pv-fsample')).catch(() => {});
    if (info.fontSamples[f.family]) continue;   // an earlier candidate for this font already worked
    await el.scrollIntoViewIfNeeded().catch(() => {}); await sleep(300);
    // A fixed header that doesn't hold the words would otherwise land in the picture.
    await el.evaluate((w) => { for (const e of document.querySelectorAll('body *')) if (getComputedStyle(e).position === 'fixed' && !e.contains(w)) { e.dataset.preserveHid = e.style.visibility || '-'; e.style.visibility = 'hidden'; } }).catch(() => {});
    // The words' box, if a visitor sees them there: the page's topmost element at their middle is theirs (or inside them).
    const box = await el.evaluate((e) => {
      const n = [...e.childNodes].find((x) => x.nodeType === 3 && x.textContent.trim());
      const r = document.createRange(); r.selectNodeContents(n || e);
      const b = r.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!top || !(e.contains(top) || top.contains(e) && top.textContent.trim() === e.textContent.trim())) return null;
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    }).catch(() => null);
    if (!box) { await unhide(); continue; }
    const pad = 6, vp = page.viewportSize();
    const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(640, box.width + 2 * pad), height: Math.min(160, box.height + 2 * pad) };
    clip.width = Math.min(clip.width, vp.width - clip.x); clip.height = Math.min(clip.height, vp.height - clip.y);
    if (clip.width < 8 || clip.height < 6) { await unhide(); continue; }
    const file = `${hash(f.family)}.png`;
    const ok = await page.screenshot({ path: path.join(outDir, 'font-samples', file), clip }).then(() => true, () => false);
    await unhide();
    if (!ok) continue;
    info.fontSamples[f.family] = { file, text: f.upper ? f.text.toUpperCase() : f.text, block: f.block, weight: f.weight, style: f.style, caps: f.upper };
    const fox = await foxPicture(page, outDir, f);
    if (fox) info.fontSamples[f.family].fox = fox;
  }
  await page.evaluate(() => scrollTo(0, 0)); await sleep(300);
}

// FOX_TEXT in one font, in the weight and style the page uses it in, black on white at 34px (twice the size the app
// shows it, so it stays sharp), with nothing of the page's own styling. The app sets the lookalike at the same size.
async function foxPicture(page, outDir, f) {
  // Text the site shows in capitals is compared in capitals (Jeremy, 2026-11-17).
  const box = await page.evaluate(async ([fam, weight, style, text]) => {
    // The font has to be the one drawing every letter. A subset that lacks one (a font sliced by language, or an Adobe
    // kit cut down to the letters the page uses) would let a fallback font draw it unseen: a letter it lacks measures
    // differently behind two different fallbacks.
    const spec = (fb) => `${style} ${weight} 34px "${fam}", ${fb}`;
    await document.fonts.load(spec('serif'), text).catch(() => {});
    const cx = document.createElement('canvas').getContext('2d');
    const w = (ch, fb) => { cx.font = spec(fb); return cx.measureText(ch).width; };
    if ([...new Set(text.replace(/ /g, ''))].some((ch) => Math.abs(w(ch, 'monospace') - w(ch, 'serif')) > 0.01)) return null;
    const el = document.createElement('pv-fox');
    el.setAttribute('style', `all:initial;position:fixed;left:0;top:0;z-index:2147483647;display:block;box-sizing:content-box;background:#fff;color:#111;padding:0 8px;font:${style} ${weight} 34px/44px "${fam}";white-space:nowrap;letter-spacing:normal;text-transform:none;font-feature-settings:normal`);
    el.textContent = text;
    document.documentElement.appendChild(el);
    const r = el.getBoundingClientRect();
    return { x: Math.ceil(r.left), y: Math.ceil(r.top), width: Math.floor(r.width), height: Math.floor(r.height) };
  }, [f.family, f.weight, f.style, f.upper ? FOX_TEXT.toUpperCase() : FOX_TEXT]).catch(() => null);
  if (!box) return null;
  await sleep(100);
  const file = `${hash(f.family)}-fox.png`;
  const vp = page.viewportSize();
  const ok = await page.screenshot({ path: path.join(outDir, 'font-samples', file), clip: { ...box, width: Math.min(box.width, vp.width) } }).then(() => true, () => false);
  await page.evaluate(() => document.querySelectorAll('pv-fox').forEach((e) => e.remove())).catch(() => {});
  return ok ? file : null;
}

export async function capture(url, outDir) {
  fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true });
  const manifest = {}; // url -> { status, ct, file, size, type }
  const browser = await launch();
  const info = { url, finalUrl: null, inlineScripts: [], scripts: [], errors: [] };

  const record = (page) => page.on('response', async (r) => {
    const u = r.url();
    if (u.startsWith('data:') || manifest[u]) return;
    const status = r.status();
    if (status >= 300 && status < 400) return;
    let body;
    try { body = await r.body(); } catch { return; }
    const file = hash(u);
    fs.writeFileSync(path.join(outDir, 'raw', file), body);
    manifest[u] = { status, ct: r.headers()['content-type'] || '', file, size: body.length, type: r.request().resourceType() };
  });

  // A page that leaves itself while we work on it (Xanadu's signup widget sent the computer layout to /newsletter in two
  // of three captures, 2026-11-27) would be saved as the wrong page: that layout is captured again, once.
  const profs = ['desktop', 'mobile'], again = new Set();
  for (const prof of profs) {
    const ctx = await browser.newContext({ ...PROFILES[prof].context, ignoreHTTPSErrors: true });
    // WebGL canvases clear their pixels after each frame unless asked to keep them; keep them so canvasStills can read
    // what the canvas shows (only drawing is affected, not what the visitor sees).
    await ctx.addInitScript(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, opts) {
        if (/webgl/i.test(String(type))) opts = { ...(opts || {}), preserveDrawingBuffer: true };
        return get.call(this, type, opts);
      };
    });
    // Which elements plugins listen on for clicks and the pointer (interact.mjs), noted before the page's scripts run.
    if (process.env.PRESERVE_INTERACT !== '0') await ctx.addInitScript(LISTEN_INIT);
    const page = await ctx.newPage();
    record(page);
    page.on('pageerror', (e) => info.errors.push(`${prof}: ${e.message.slice(0, 200)}`));
    // Widgets that keep polling (chat, bot checks) can stop the network from ever going quiet: fall back to the load
    // event plus a bounded wait instead of giving up on the page.
    let resp = await page.goto(url, { waitUntil: 'load', timeout: 90000 }).catch((e) => { info.errors.push(String(e.message).split('\n')[0]); return null; });
    if (resp) await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => info.errors.push(`${prof}: network never went idle (continued after 20 s)`));
    if (!resp) { await ctx.close(); continue; }
    info.finalUrl = page.url();
    info.status = resp.status();
    const home = new URL(page.url()); let left = null;
    // A new document only (a gallery or quick view that rewrites the address in place stays on the page).
    page.on('domcontentloaded', () => { if (left) return; const u = new URL(page.url()); if (u.pathname !== home.pathname || u.host !== home.host) left = u.pathname; });
    if (prof === 'desktop') fs.writeFileSync(path.join(outDir, 'server.html'), await resp.body());
    await sleep(2000);
    const yStart = await page.evaluate(() => scrollY).catch(() => 0);
    // Reference shot of the first screen exactly as a visitor sees it (overlays included).
    await page.screenshot({ path: path.join(outDir, `orig-asis-${prof}.png`) });
    await scrollThrough(page);
    // A refinement: give the blocks the person pinned time to load and play, and load what they brought in.
    const pins = loadPins();
    if (pins.length) (info.pinsFocused ||= {})[prof] = await focusPins(page, prof, pins);
    (info.placeholders ||= {})[prof] = await loadPlaceholders(page);
    // Back to where the page was scrolled: the header's look (shrunk or not) is saved with the page.
    const y0 = await page.evaluate(() => scrollY);
    (info.galleries ||= {})[prof] = await recordGalleries(page, recordLonger(pins) ? { watchMs: 24000, maxSteps: 40, maxMs: 120000 } : {});
    // A refinement's targeted fixes for how slideshows move (fix-menu.mjs): drag, or playing by themselves.
    if (pins.length) (info.galleryFixes ||= {})[prof] = await applyGalleryFixes(page, prof, pins);
    await page.evaluate((y) => scrollTo(0, y), y0); await sleep(500);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    if (pins.length) (info.pinStills ||= {})[prof] = await markPinStills(page, prof, pins);
    (info.scrollShown ||= {})[prof] = await scrollShown(page).catch((e) => ({ error: String(e.message).split('\n')[0] }));
    (info.scrollLinked ||= {})[prof] = await scrollLinked(page).catch((e) => ({ error: String(e.message).split('\n')[0] }));
    (info.timedMotion ||= {})[prof] = await timedMotion(page, { hover: prof === 'desktop' }).catch((e) => ({ error: String(e.message).split('\n')[0] }));
    if (prof === 'desktop') (info.pointers ||= {})[prof] = await pointerFollowers(page).catch((e) => ({ error: String(e.message).split('\n')[0] }));
    // Clicks and hovers that plugins drive, recorded for our stand-in (interact.mjs, build.mjs ACT_SCRIPT).
    if (process.env.PRESERVE_INTERACT !== '0') (info.interactions ||= {})[prof] = await recordInteractions(page, prof).catch((e) => ({ error: String(e.message).split('\n')[0] }));
    await shadowStills(page, outDir, prof, info);
    (info.mediaBackgrounds ||= {})[prof] = await mediaBackgrounds(page, ctx.request, outDir, manifest).catch((e) => ({ error: String(e.message).split('\n')[0] }));
    await canvasStills(page, outDir, prof, info);
    (info.fxPictures ||= {})[prof] = await page.evaluate(afterCanvasStills).catch(() => 0);
    // Widgets from other sites in frames, saved as real content with each of their views (frames.mjs).
    await saveFrames(page, outDir, prof, info, manifest, ctx.request).catch((e) => info.errors.push(`${prof}: frames: ${String(e.message).split('\n')[0]}`));
    info.promos = (info.promos || 0) + await page.evaluate(markPromos).catch(() => 0);
    (info.blockHovers ||= {})[prof] = await page.evaluate(markBlockHovers).catch(() => 0);
    (info.blockAppears ||= {})[prof] = await page.evaluate(markBlockAppears).catch(() => 0);
    // Squarespace pads the first section (and the menu overlay) by the header's height, in pixels, for the width it
    // saw. The copy redoes that sum at other widths (build.mjs HEADER_PAD_SCRIPT), so it needs the header's height that
    // the padding was worked out from: measured here as Squarespace saw it, announcement bar included.
    await page.evaluate(() => {
      const h = document.querySelector('header#header') || document.querySelector('header');
      if (h) h.setAttribute('data-pv-h0', String(Math.round(h.getBoundingClientRect().height * 100) / 100));
    }).catch(() => {});
    // The site's own layers pinned over most of the window (a full-screen background, a frame, a closed menu panel)
    // are part of its design, not a popup: marked so the quality check doesn't count them as a popup left on the page
    // (check.mjs; six of seven such holds in the Nov 16 showcase re-run). Looked for with the marketing overlays
    // hidden, and never anything with an email box or popup wording, so a signup popup is still caught.
    if (left) {
      info.errors.push(`${prof}: the page went to ${left} during capture${again.has(prof) ? '; saved as it was' : '; captured again'}`);
      if (!again.has(prof)) { again.add(prof); profs.push(prof); await ctx.close(); continue; }
    }
    (info.fixedLayers ||= {})[prof] = await page.evaluate((sels) => {
      const st = document.createElement('style'); st.textContent = sels.join(',') + '{display:none!important}'; document.head.appendChild(st);
      const vis = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05 && r.width > 0 && r.height > 0; };
      let n = 0;
      for (const e of document.querySelectorAll('body *')) {
        if (getComputedStyle(e).position !== 'fixed' || !vis(e)) continue;
        const r = e.getBoundingClientRect(); if (r.width * r.height <= innerWidth * innerHeight * 0.3) continue;
        if (/popup|modal|klaviyo|newsletter|signup|subscribe|cookie|promo/i.test(e.className.toString() + ' ' + e.id) || e.querySelector('input[type=email]')) continue;
        e.setAttribute('data-pv-fixed', ''); n++;
      }
      st.remove(); return n;
    }, OVERLAY_SELECTORS).catch(() => 0);
    // Every recorded gallery back on its first slide, as recorded, just before the page is saved. Putting it back once
    // after the swipe test is not enough: a carousel still gliding after the drag (Flickity) keeps writing its own
    // position on the next frames, so Ela House's blog carousel was saved scrolled to its last slide (-3600 px) with
    // the first one still marked as shown.
    // Back where a visitor arrives before the page is saved and photographed. A widget that puts the cursor in its own
    // box (Xanadu's signup form, in the footer) scrolls the page to itself, which left the reference pictures of the
    // live page showing the footer, so every comparison of the first screen failed.
    const yEnd = await page.evaluate((y) => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); const was = scrollY; if (Math.abs(was - y) > 2) scrollTo(0, y); return was; }, yStart).catch(() => yStart);
    if (Math.abs(yEnd - yStart) > 2) { info.errors.push(`${prof}: the page had scrolled itself to ${Math.round(yEnd)} during capture; put back`); await sleep(800); }
    await page.evaluate(() => { for (const h of Object.values(window.__pvHome || {})) { try { h(); } catch {} } }).catch(() => {});
    fs.writeFileSync(path.join(outDir, `rendered-${prof}.html`), await page.evaluate(snapshotDom));
    // Reference shots with marketing overlays hidden, to compare copies against.
    await page.addStyleTag({ content: OVERLAY_SELECTORS.join(',') + '{display:none!important}' });
    await sleep(300);
    await page.screenshot({ path: path.join(outDir, `ref-${prof}.png`) });
    await page.screenshot({ path: path.join(outDir, `ref-full-${prof}.png`), fullPage: true }).catch(() => {});
    await fontSamples(page, outDir, info);
    if (prof === 'desktop') {
      Object.assign(info, await page.evaluate(() => ({
        scripts: [...document.scripts].filter((s) => s.src).map((s) => s.src),
        inlineScripts: [...document.scripts].filter((s) => !s.src).map((s) => (s.type || '') + ' | ' + s.textContent.trim().slice(0, 160)),
        generator: document.querySelector('meta[name=generator]')?.content || '',
        overlaysFound: [...document.querySelectorAll('.sqs-announcement-bar-dropzone *, .sqs-popup-overlay, .sqs-cookie-banner-v2, #sqs-cookie-banner, .sqs-announcement-bar')].map((e) => e.className).slice(0, 10),
        templateHints: [...document.body.classList].slice(0, 40),
      })));
    }
    await ctx.close();
  }

  // Fetch the largest version of every Squarespace CDN image so copies can make their own sizes.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const imgBases = new Set(Object.keys(manifest).filter((u) => /images\.squarespace-cdn\.com|static1\.squarespace\.com\/static\/.+\.(jpe?g|png|webp|gif)/i.test(u)).map((u) => u.split('?')[0]));
  // Also images referenced in the HTML but never requested (lazy or responsive variants).
  for (const f of ['server.html', 'rendered-desktop.html', 'rendered-mobile.html']) {
    const p = path.join(outDir, f);
    if (!fs.existsSync(p)) continue;
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/https?:\/\/images\.squarespace-cdn\.com\/[^"'\s?)&,]+/g)) imgBases.add(m[0]);
  }
  for (const base of imgBases) {
    const key = 'orig:' + base;
    if (manifest[key]) continue;
    try {
      const r = await ctx.request.get(base + '?format=2500w', { timeout: 30000 });
      if (!r.ok()) continue;
      const body = await r.body();
      const file = hash(key);
      fs.writeFileSync(path.join(outDir, 'raw', file), body);
      manifest[key] = { status: 200, ct: r.headers()['content-type'] || '', file, size: body.length, type: 'image-original' };
    } catch {}
  }
  // Squarespace video blocks and background videos, as plain files (see video.mjs).
  info.videos = await captureVideos(outDir, manifest, ctx.request);
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(outDir, 'capture-info.json'), JSON.stringify(info, null, 1));
  return { manifest, info };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, out] = process.argv.slice(2);
  const { manifest, info } = await capture(url, out);
  console.log(Object.keys(manifest).length, 'resources;', info.status, info.finalUrl, info.errors.slice(0, 3));
}
