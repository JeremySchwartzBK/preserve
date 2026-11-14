// Captures a live page: every network response, the server HTML, and the rendered DOM at desktop and mobile widths.
// Usage: node capture.mjs <url> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { PROFILES, launch, sleep, OVERLAY_SELECTORS, markPromos, SQS_GALLERY_SEL, NEXT_SEL, PREV_SEL } from './lib.mjs';
import { captureVideos } from './video.mjs';
import { loadPins, focusPins, markPinStills } from './pins.mjs';
import { saveFrames } from './frames.mjs';

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
    const p = w.params, ap = p.autoplay && w.autoplay && w.autoplay.running ? p.autoplay.delay || 3000 : 0;
    el.setAttribute('data-pv-swiper', JSON.stringify({ effect: p.effect, speed: p.speed, loop: !!p.loop, autoplay: ap, autoHeight: !!p.autoHeight, spv: typeof p.slidesPerView === 'number' ? p.slidesPerView : null, gap: typeof p.spaceBetween === 'number' ? p.spaceBetween : null }));
  }
  // Record live form/input state and the current src chosen from srcset.
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
export async function recordGalleries(page, { watchMs = 9000, maxSteps = 30, maxMs = 45000 } = {}) {
  return page.evaluate(async ([gSel, nSel, pSel, watchMs, maxSteps, maxMs]) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const BLOCK = '[id^="block-"],.sqs-block,[data-block-id],section[data-section-id]';
    const shown = (e) => { for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden') return false; } const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const pics = (e) => e.querySelectorAll('img, .swiper-slide, [data-slide-index], .slide').length;
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
      const same = (a, b) => a.length === b.length && a.every((x, i) => x[0] === b[i][0] && x[1] === b[i][1] && x[2] === b[i][2] && x[3] === b[i][3]);
      const settle = async () => { let a = snap(); for (let t = 0; t < 20; t++) { await sleep(150); const b = snap(); if (same(a, b)) return b; a = b; } return a; };
      const grew = () => g.querySelectorAll('*').length + 1 !== els.length;
      g.scrollIntoView({ block: 'center' }); await sleep(600);
      // Its own timer: the block's setting, else what it does untouched for a few seconds.
      let cfg = {}; try { cfg = JSON.parse(g.closest('[data-block-json]')?.getAttribute('data-block-json') || '{}'); } catch {}
      let auto = cfg.autoplay ? Math.round((+cfg['autoplay-duration'] || 3) * 1000) : 0;
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
      if (auto && !inst) step = async () => { const a = snap(), t = performance.now(); while (performance.now() - t < auto + 2500) { await sleep(200); if (!same(snap(), a)) return; } };
      res.auto = auto; res.how = inst ? 'gallery' : auto ? 'timer' : next ? 'arrow' : 'none';
      if (!step) continue;
      if (inst) await idle();
      const states = [await settle()], dt = [0];
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
        states.push(s); dt.push(gap);
      }
      res.steps = states.length;
      if (res.skip || states.length < 2) continue;
      const moving = els.map((_, i) => i).filter((i) => states.some((s) => s[i].some((v, k) => v !== states[0][i][k])));
      moving.forEach((i, j) => els[i].setAttribute('data-pv-gi', j));
      // Back to the first slide, as the page was before.
      for (const i of moving) {
        const [c, st, at] = states[0][i], e = els[i];
        if (c) e.setAttribute('class', c); else e.removeAttribute('class');
        if (st) e.setAttribute('style', st); else e.removeAttribute('style');
        for (const a of [...e.attributes]) if (STATE.test(a.name) && a.value.length < 40) e.removeAttribute(a.name);
        for (const kv of at ? at.split('\u001f') : []) { const k = kv.indexOf('='); e.setAttribute(kv.slice(0, k), kv.slice(k + 1)); }
      }
      const parents = new Set(moving.map((i) => els[i].parentElement).filter(Boolean));
      for (const p of parents) { const kids = moving.filter((i) => els[i].parentElement === p).sort((a, b) => states[0][a][3] - states[0][b][3]); for (const i of kids) p.insertBefore(els[i], p.children[states[0][i][3]] || null); }
      // Pictures set in a style (background-image) stay as the page has them: their addresses are rewritten to the
      // copy's own files only where the page uses them, not inside this record.
      const noUrl = (st) => st.replace(/(^|;)\s*[\w-]+\s*:[^;]*url\([^)]*\)[^;]*/g, '$1').replace(/^;+|;;+/g, ';').replace(/^;/, '');
      // Played by itself: how long after the one before each step came, so the copy keeps the site's rhythm (a slide
      // change can come in two or three quick steps, such as fading the new slide in, then settling it).
      // Squarespace's class names as the copy has them (own-css.mjs renames them; none may be left in a copy).
      const ren = (t) => t.replace(/data-sqsp?-/g, 'data-ps-').replace(/(^|[^\w-])sqsrte-/g, '$1rte-').replace(/(^|[^\w-])sqsp?-/g, '$1ps-').replace(/(^|[^\w-])tweak-/g, '$1tw-');
      const timed = res.how === 'timer' ? { dt: dt.map((x) => x || auto) } : {};
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
      if (cs.position !== 'fixed' && !(cs.position === 'absolute' && par && par.position === 'fixed' && par.pointerEvents === 'none')) continue;
      if (el.querySelectorAll('*').length > 30 || el.textContent.trim().length > 60) continue;
      el.setAttribute('data-preserve-fc', String(k++));
    }
    return k;
  }).catch(() => 0);
  if (!n) return [];
  const snap = () => page.evaluate(() => [...document.querySelectorAll('[data-preserve-fc]')].map((e) => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return { k: +e.getAttribute('data-preserve-fc'), vis: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none', x: r.left, y: r.top };
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
    if (moved(a, b, 400, 200)) found.push({ k: b.k, t: 'page', dx: Math.round(b.x - 700), dy: Math.round(b.y - 500), cur: await cursorAt(700, 500) === 'none' ? 'none' : '' });
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
  await page.mouse.move(1, 1); await sleep(300);
  await page.evaluate((found) => {
    for (const f of found) {
      const e = document.querySelector(`[data-preserve-fc="${f.k}"]`); if (!e) continue;
      const c = { dx: f.dx, dy: f.dy, cur: f.cur };
      if (f.t === 'block') { const b = document.querySelector(`[data-preserve-pb="${f.b}"]`); if (!b) continue; b.setAttribute('data-pv-ptrig', String(f.k)); c.on = String(f.k); }
      e.setAttribute('data-pv-pointer', JSON.stringify(c));
    }
    document.querySelectorAll('[data-preserve-fc]').forEach((e) => e.removeAttribute('data-preserve-fc'));
    document.querySelectorAll('[data-preserve-pb]').forEach((e) => e.removeAttribute('data-preserve-pb'));
    scrollTo(0, 0);
  }, found);
  await sleep(500);
  return found.map((f) => ({ t: f.t, dx: f.dx, dy: f.dy, cur: f.cur }));
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
    // Fixed headers and badges that don't contain the widget would otherwise land in the photo.
    await page.evaluate((i) => { const w = document.querySelector(`[data-preserve-still="${i}"]`); for (const e of document.querySelectorAll('body *')) if (getComputedStyle(e).position === 'fixed' && !e.contains(w)) { e.dataset.preserveHid = e.style.visibility || '-'; e.style.visibility = 'hidden'; } }, i);
    const box = await el.boundingBox();
    const file = `${prof}-${i}.png`;
    const ok = box && await el.screenshot({ path: path.join(outDir, 'stills', file), timeout: 15000 }).then(() => true, () => false);
    await page.evaluate(() => { for (const e of document.querySelectorAll('[data-preserve-hid]')) { e.style.visibility = e.dataset.preserveHid === '-' ? '' : e.dataset.preserveHid; delete e.dataset.preserveHid; } });
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

// A picture of each font as the live site draws it, in the page's own words, for the review's Fonts step (Adobe files
// can't be shipped; pictures can). For each font face the page loaded: the first visible text drawn in it, photographed
// tight around the words, and the block it sits in (for "Show on page").
async function fontSamples(page, outDir, info) {
  // Desktop first; the phone layout adds fonts only it shows.
  const done = Object.keys(info.fontSamples || {});
  const found = await page.evaluate((done) => {
    const unq = (s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase();
    const fams = new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => unq(f.family)));
    const out = [], seen = new Set(done);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      const el = n.parentElement;
      if (t.length < 2 || !el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
      const cs = getComputedStyle(el);
      const fam = unq(cs.fontFamily.split(',')[0]);
      if (!fams.has(fam) || seen.has(fam) || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      const box = r.getBoundingClientRect();
      if (box.width < 8 || box.height < 6) continue;
      seen.add(fam);
      const b = el.closest('[id^="block-"],[data-block-id],section[data-section-id]') || el.closest('header,footer');
      const block = !b ? 'el:body' : /^(HEADER|FOOTER)$/.test(b.tagName) && !b.id ? 'el:' + b.tagName.toLowerCase() : b.id || b.getAttribute('data-block-id') || 'section:' + b.getAttribute('data-section-id');
      el.setAttribute('data-pv-fsample', String(out.length));
      out.push({ family: fam, text: t.slice(0, 60), block });
    }
    return out;
  }, done).catch(() => []);
  if (!found.length) return;
  fs.mkdirSync(path.join(outDir, 'font-samples'), { recursive: true });
  info.fontSamples ||= {};
  for (const [i, f] of found.entries()) {
    const el = await page.$(`[data-pv-fsample="${i}"]`);
    if (!el) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {}); await sleep(300);
    // A fixed header that doesn't hold the words would otherwise land in the picture.
    await el.evaluate((w) => { for (const e of document.querySelectorAll('body *')) if (getComputedStyle(e).position === 'fixed' && !e.contains(w)) { e.dataset.preserveHid = e.style.visibility || '-'; e.style.visibility = 'hidden'; } }).catch(() => {});
    const box = await el.evaluate((e) => {
      const n = [...e.childNodes].find((x) => x.nodeType === 3 && x.textContent.trim());
      const r = document.createRange(); r.selectNodeContents(n || e);
      const b = r.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    }).catch(() => null);
    await el.evaluate((e) => e.removeAttribute('data-pv-fsample')).catch(() => {});
    if (!box) continue;
    const pad = 6, vp = page.viewportSize();
    const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(640, box.width + 2 * pad), height: Math.min(160, box.height + 2 * pad) };
    clip.width = Math.min(clip.width, vp.width - clip.x); clip.height = Math.min(clip.height, vp.height - clip.y);
    if (clip.width < 8 || clip.height < 6) continue;
    const file = `${hash(f.family)}.png`;
    const ok = await page.screenshot({ path: path.join(outDir, 'font-samples', file), clip }).then(() => true, () => false);
    if (ok) info.fontSamples[f.family] = { file, text: f.text, block: f.block };
    await page.evaluate(() => { for (const e of document.querySelectorAll('[data-preserve-hid]')) { e.style.visibility = e.dataset.preserveHid === '-' ? '' : e.dataset.preserveHid; delete e.dataset.preserveHid; } }).catch(() => {});
  }
  await page.evaluate(() => scrollTo(0, 0)); await sleep(300);
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

  for (const prof of ['desktop', 'mobile']) {
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
    if (prof === 'desktop') fs.writeFileSync(path.join(outDir, 'server.html'), await resp.body());
    await sleep(2000);
    // Reference shot of the first screen exactly as a visitor sees it (overlays included).
    await page.screenshot({ path: path.join(outDir, `orig-asis-${prof}.png`) });
    await scrollThrough(page);
    // A refinement: give the blocks the person pinned time to load and play, and load what they brought in.
    const pins = loadPins();
    if (pins.length) (info.pinsFocused ||= {})[prof] = await focusPins(page, prof, pins);
    (info.placeholders ||= {})[prof] = await loadPlaceholders(page);
    // Back to where the page was scrolled: the header's look (shrunk or not) is saved with the page.
    const y0 = await page.evaluate(() => scrollY);
    (info.galleries ||= {})[prof] = await recordGalleries(page);
    await page.evaluate((y) => scrollTo(0, y), y0); await sleep(500);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    if (pins.length) (info.pinStills ||= {})[prof] = await markPinStills(page, prof, pins);
    (info.scrollShown ||= {})[prof] = await scrollShown(page).catch((e) => ({ error: String(e.message).split('\n')[0] }));
    if (prof === 'desktop') (info.pointers ||= {})[prof] = await pointerFollowers(page).catch((e) => ({ error: String(e.message).split('\n')[0] }));
    await shadowStills(page, outDir, prof, info);
    await canvasStills(page, outDir, prof, info);
    // Widgets from other sites in frames, saved as real content with each of their views (frames.mjs).
    await saveFrames(page, outDir, prof, info, manifest, ctx.request).catch((e) => info.errors.push(`${prof}: frames: ${String(e.message).split('\n')[0]}`));
    info.promos = (info.promos || 0) + await page.evaluate(markPromos).catch(() => 0);
    (info.blockHovers ||= {})[prof] = await page.evaluate(markBlockHovers).catch(() => 0);
    // Squarespace pads the first section (and the menu overlay) by the header's height, in pixels, for the width it
    // saw. The copy redoes that sum at other widths (build.mjs HEADER_PAD_SCRIPT), so it needs the header's height that
    // the padding was worked out from: measured here as Squarespace saw it, announcement bar included.
    await page.evaluate(() => {
      const h = document.querySelector('header#header') || document.querySelector('header');
      if (h) h.setAttribute('data-pv-h0', String(Math.round(h.getBoundingClientRect().height * 100) / 100));
    }).catch(() => {});
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
