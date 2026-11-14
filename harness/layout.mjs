// Part-by-part comparison with the live page (plan "A more robust Preserve quality check", step 3; Jeremy asked for it
// 2026-11-13). Pixel diffs say "something differs" and can't tell a moved photo from a slideshow on another slide; most
// layout problems Jeremy found in the spot-checks were a part of the page with the wrong size or place: Minaa B's color
// block too short and wide so the person no longer overlaps it, Field Theory's hero not as tall, Myrtle Green's heading
// shapes too big, Margaret Rajic's nav pushed onto a hidden second row, Gather's text running into its button at tablet
// width, Backbipoc's footer spilling off the right edge, Borrachito's reservation widget cropped.
//
// probeLayout opens a page at one width and measures every block (keys from __preserveAnchor: block ids, sections as
// section:<id>, header and footer as el:header / el:footer), all positions in page pixels:
//   box      { x, y, w, h }      the block itself; ry/rx: its place inside its section
//   lines    n                   lines of text it shows (font swaps change wrapping first)
//   pics     [[w, h], ...]       its largest pictures (img, svg, canvas, video, background images), biggest first
//   frames   [{ w, h, drawn }]   embedded frames (live) or the stand-ins the copy keeps for them (picture or empty box)
//   spill    px                  how far its content runs past the window's left or right edge
//   paint    [rects]             what it actually draws (text lines, pictures, filled boxes, buttons), for overlaps
// and returns { width, height, blocks, overlaps: { "a|b": share } }.
//
// compareLayout(live, copy) lists what differs, by code (see CODES). Every finding is relative: a carousel whose slides
// sit off-screen on the live page too, or blocks that overlap on purpose, don't count.
import { PNG } from 'pngjs';
import { PROFILES, sleep, OVERLAY_SELECTORS, markPromos } from './lib.mjs';
import { ANCHOR } from './check.mjs';

// Widths compared: the two layouts a Preserve keeps, a laptop-sized window (Minaa B's color block only came apart
// there) and a tablet-sized one (Gather's overlap only showed there).
// At the in-between widths only what looks broken counts (parts running into each other or off the screen, a missing
// widget): sizes there are already covered by the size check (resize.mjs), and embeds never show that width.
export const LAYOUT_WIDTHS = [
  { prof: 'desktop', width: 1440 },
  { prof: 'desktop', width: 1280, codes: ['parts-overlap-differently', 'part-cut-off', 'frame-missing'] },
  { prof: 'desktop', width: 1024, codes: ['parts-overlap-differently', 'part-cut-off', 'frame-missing'] },
  { prof: 'mobile', width: 390 },
];

const measure = () => {
  const SEL = '[id^="block-"],.sqs-block,[data-block-id],section[data-section-id],header,footer';
  const vw = innerWidth, sy = scrollY;
  const seen = new Map();
  const key = (el) => { const k = window.__preserveAnchor(el).blockId; const n = seen.get(k) || 0; seen.set(k, n + 1); return n ? `${k}#${n}` : k; };
  const shown = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) });
  const els = [...document.querySelectorAll(SEL)].filter((e) => e.id || e.getAttribute('data-block-id') || e.matches('section[data-section-id],header,footer'));
  const blocks = {}, clips = new Map();
  for (const el of els) {
    if (el.closest('.preserve-tour,#preserve-tour,[data-preserve-ui]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || !shown(el)) continue;
    const k = key(el);
    const leaf = !el.matches('section,header,footer') && !el.querySelector('[id^="block-"],.sqs-block');
    const sec = el.parentElement?.closest('section[data-section-id],header,footer');
    const sr = sec ? sec.getBoundingClientRect() : null;
    const txt = (el.innerText || '').trim().replace(/\s+/g, ' ');
    let th = 0; for (const ch of txt.toLowerCase().replace(/[^a-z]+/g, '')) th = (th * 31 + ch.charCodeAt(0)) | 0;
    const b = { box: box(r), leaf, label: txt.slice(0, 60), th };
    // Owner code blocks run their own scripts (text that types itself, tabs, reveals): their lines aren't steady.
    if (leaf && el.matches('.sqs-block-code,.ps-block-code,.sqs-block-embed,.ps-block-embed')) b.code = true;
    if (!leaf && el.matches('header,footer')) b.edge = true;
    if (sr) { b.rx = Math.round(r.left - sr.left); b.ry = Math.round(r.top - sr.top); b.sec = sec.getAttribute('data-section-id') ? 'section:' + sec.getAttribute('data-section-id') : 'el:' + sec.tagName.toLowerCase(); }
    if (leaf) {
      // What shows of each rectangle: cut to the boxes of ancestors that hide their overflow (a carousel's strip, a
      // cropped picture), but not to the page's own edges, so content running off the page still counts as spilling.
      const clipOf = (e) => {
        if (clips.has(e)) return clips.get(e);
        let c = null;
        const p = e.parentElement;
        if (p && p !== document.body && p !== document.documentElement) {
          c = clipOf(p);
          const cs = getComputedStyle(p);
          if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.clipPath !== 'none') {
            const q = p.getBoundingClientRect();
            const own = { l: cs.overflowX !== 'visible' ? q.left : -1e9, r: cs.overflowX !== 'visible' ? q.right : 1e9, t: cs.overflowY !== 'visible' ? q.top : -1e9, b: cs.overflowY !== 'visible' ? q.bottom : 1e9 };
            c = c ? { l: Math.max(c.l, own.l), r: Math.min(c.r, own.r), t: Math.max(c.t, own.t), b: Math.min(c.b, own.b) } : own;
          }
        }
        clips.set(e, c); return c;
      };
      let clipped = false;
      const cut = (q, e, text = false) => {
        const c = clipOf(e); if (!c) return q;
        if (text && (q.left < c.l - 2 || q.right > c.r + 2 || q.top < c.t - 2 || q.bottom > c.b + 2)) clipped = true;
        const l = Math.max(q.left, c.l), r = Math.min(q.right, c.r), t = Math.max(q.top, c.t), bt = Math.min(q.bottom, c.b);
        return r - l < 1 || bt - t < 1 ? null : { left: l, right: r, top: t, bottom: bt, width: r - l, height: bt - t };
      };
      const onPage = (q) => q && q.right > 0 && q.left < vw;
      // Text lines: distinct line tops of the text that shows (slides parked off to the side don't count).
      const tops = new Set(), paint = [];
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) {
        if (!n.textContent.trim() || !n.parentElement || !shown(n.parentElement)) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        for (const q0 of rg.getClientRects()) {
          const q = q0.width > 2 && q0.height > 4 ? cut(q0, n.parentElement, true) : null; if (!q) continue;
          if (onPage(q)) tops.add(Math.round((q.top + sy) / 6));
          paint.push(box(q));
        }
      }
      b.lines = tops.size;
      const pics = [];
      for (const p of el.querySelectorAll('img,svg,canvas,video,picture,[style*="background-image"],.preserve-embed-still')) {
        if (p.closest('svg') && p.tagName.toLowerCase() !== 'svg') continue;
        let q0 = p.getBoundingClientRect(); if (q0.width < 24 || q0.height < 24 || !shown(p)) continue;
        // A picture fitted inside its box (object-fit: contain) only paints part of it: Squarespace's own script and
        // the Preserve's stylesheet size that box differently while the picture shows the same (Sam Fresquez, 1024 px).
        const nw = p.naturalWidth || p.videoWidth, nh = p.naturalHeight || p.videoHeight, fit = getComputedStyle(p).objectFit;
        // A drawn shape (Squarespace shape blocks are SVG) can likewise paint only part of its box when the box's
        // proportions change: what it draws is measured, not the box (Minaa B's color block at laptop widths).
        if (p.tagName.toLowerCase() === 'svg') {
          const rs = [...p.querySelectorAll('path,rect,circle,ellipse,polygon,polyline,image,use')].map((x) => x.getBoundingClientRect()).filter((x) => x.width > 1 && x.height > 1);
          if (rs.length) {
            const l = Math.min(...rs.map((x) => x.left)), t = Math.min(...rs.map((x) => x.top)), r = Math.max(...rs.map((x) => x.right)), bt = Math.max(...rs.map((x) => x.bottom));
            q0 = { left: l, top: t, right: r, bottom: bt, width: r - l, height: bt - t };
          }
        }
        if (nw && nh && /contain|scale-down/.test(fit)) {
          const k = Math.min(q0.width / nw, q0.height / nh, fit === 'scale-down' ? 1 : Infinity), w = nw * k, h = nh * k;
          const l = q0.left + (q0.width - w) / 2, t = q0.top + (q0.height - h) / 2;
          q0 = { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h };
        }
        const q = cut(q0, p); if (!q || q.width < 24 || q.height < 24) continue;
        if (onPage(q)) pics.push([Math.round(q.width), Math.round(q.height)]);
        paint.push(box(q));
      }
      b.pics = pics.sort((a, c) => c[0] * c[1] - a[0] * a[1]).slice(0, 4);
      // Filled boxes and buttons (shapes, color blocks, outlined buttons) draw too.
      for (const p of [el, ...el.querySelectorAll('*')].slice(0, 300)) {
        const cs = getComputedStyle(p); if (!shown(p)) continue;
        const filled = cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor);
        const btn = p.matches('a.sqs-button-element--primary,a.sqs-block-button-element,button,.sqs-button-element,input,textarea,select');
        if (!filled && !btn) continue;
        const q = cut(p.getBoundingClientRect(), p); if (q && q.width >= 12 && q.height >= 12) paint.push(box(q));
      }
      // Frames: the live page's own; the copy's stand-ins (a picture of it, or an empty box when it didn't draw).
      b.frames = [...el.querySelectorAll('iframe,.preserve-embed-still,.preserve-embed-blank')].map((f) => {
        const q = f.getBoundingClientRect();
        return q.width < 40 || q.height < 30 || !shown(f) ? null : { w: Math.round(q.width), h: Math.round(q.height), blank: f.classList.contains('preserve-embed-blank') };
      }).filter(Boolean);
      // Content running past the window's edges (after the cuts above: only what would show on a wider window).
      let spill = 0;
      for (const q of paint) spill = Math.max(spill, q.x + q.w - vw, -q.x);
      b.spill = Math.max(0, Math.round(spill));
      b.paint = paint.slice(0, 120);
      b.clipped = clipped; // some of its text is hidden inside a strip or cropped box (a carousel): lines aren't compared
    }
    blocks[k] = b;
  }
  // Overlaps between leaf blocks of the same section: share of the smaller block's drawn area that the other covers.
  const overlaps = {};
  const leaves = Object.entries(blocks).filter(([, b]) => b.leaf && b.paint?.length);
  const area = (rs) => rs.reduce((s, q) => s + q.w * q.h, 0);
  const inter = (a, c) => Math.max(0, Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x)) * Math.max(0, Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y));
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
    const [ka, a] = leaves[i], [kb, c] = leaves[j];
    if (a.sec !== c.sec || inter(a.box, c.box) === 0) continue;
    let s = 0; for (const p of a.paint) for (const q of c.paint) s += inter(p, q);
    const share = s / Math.max(1, Math.min(area(a.paint), area(c.paint)));
    if (share >= 0.02) overlaps[[ka, kb].sort().join('|')] = +Math.min(1, share).toFixed(3);
  }
  for (const b of Object.values(blocks)) { if (b.paint) b.ink = b.paint.length; delete b.paint; }
  return { width: vw, height: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth, blocks, overlaps };
};

// Whether each frame on the live page drew anything (a widget stopped by a bot check shows one flat color).
async function framesDrawn(page) {
  const out = [];
  for (const f of await page.$$('iframe')) {
    const b = await f.boundingBox().catch(() => null);
    if (!b || b.width < 40 || b.height < 30) continue;
    try {
      const png = PNG.sync.read(await f.screenshot({ timeout: 5000 }));
      let lo = 765, hi = 0; for (let i = 0; i < png.data.length; i += 4 * 97) { const v = png.data[i] + png.data[i + 1] + png.data[i + 2]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
      out.push(hi - lo > 36);
    } catch { out.push(null); }
  }
  return out;
}

export async function probeLayout(browser, url, { prof = 'desktop', width, isCopy = false } = {}) {
  const base = PROFILES[prof].context;
  const ctx = await browser.newContext({ ...base, viewport: { width: width || base.viewport.width, height: base.viewport.height }, ignoreHTTPSErrors: true });
  if (isCopy) await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); return /^(localhost|127\.0\.0\.1)$/.test(u.hostname) || !/^http/.test(u.protocol) ? r.continue() : r.abort(); });
  await ctx.addInitScript(ANCHOR);
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.addStyleTag({ content: 'html,body{scroll-behavior:auto!important}' }).catch(() => {});
    // Through the page once so lazy pictures load and entrance animations finish, then back to the top (sticky headers
    // and scroll-shrunk headers measured as a visitor first sees them).
    const vh = await page.evaluate(() => innerHeight);
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < H; y += Math.round(vh * 0.7)) { await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), y); await sleep(250); }
    await page.evaluate(() => scrollTo(0, 0)); await sleep(1500);
    if (!isCopy) {
      await page.evaluate(markPromos).catch(() => 0);
      await page.addStyleTag({ content: OVERLAY_SELECTORS.join(',') + '{display:none!important}' }).catch(() => {});
      await sleep(300);
    }
    const m = await page.evaluate(measure);
    if (!isCopy) {
      const drawn = await framesDrawn(page); let i = 0;
      for (const b of Object.values(m.blocks)) for (const f of b.frames || []) f.drawn = drawn[i++] ?? null;
    }
    return m;
  } catch (e) { return { error: String(e.message).split('\n')[0].slice(0, 200) }; }
  finally { await ctx.close(); }
}

// Limits (tuned on check-cases.json with score-check.mjs --add-layout).
export const LIMITS = {
  size: 0.15, sizePx: 24,        // a block's width or height off by more than this share and these pixels
  move: 0.12, movePx: 40,        // its place in its section, as a share of the section's size
  pic: 0.2, picPx: 24,           // its largest picture
  lines: 1,                      // more than this many lines more or fewer (and at least a quarter of them)
  overlap: 0.15,                 // share of the smaller block newly covered (or no longer covered)
  spill: 24,                     // px past the window's edge, beyond what the live page does
  frame: 0.2,                    // a frame's stand-in size off by more than this share
  minBlock: 40,                  // blocks smaller than this (either side) are not size-checked
};

export const CODES = ['part-size-differs', 'part-moved', 'picture-size-differs', 'text-wraps-differently', 'parts-overlap-differently', 'part-cut-off', 'frame-missing', 'frame-size-differs'];


export function compareLayout(live, copy, { label = '', codes = null } = {}) {
  const out = Object.fromEntries(CODES.map((c) => [c, []]));
  if (!live || !copy || live.error || copy.error) return out;
  const L = LIMITS;
  const off = (a, b, share, px) => Math.abs(a - b) > Math.max(px, share * Math.max(a, b));
  const at = (k, b) => ({ blockId: k.replace(/#\d+$/, ''), label: b?.label || '', pageY: b?.box?.y });
  const where = label ? `${label}: ` : '';
  const secs = (m, k) => m.blocks[k];
  // Sections where some words differ (contact details we replace, live edits): rows there size around other words.
  const reworded = new Set();
  for (const [k, lb] of Object.entries(live.blocks)) { const cb = copy.blocks[k]; if (cb && lb.leaf && lb.th !== cb.th) { reworded.add(lb.sec); } }
  for (const [k, lb] of Object.entries(live.blocks)) {
    const cb = copy.blocks[k];
    if (!cb) continue; // a block the copy doesn't have shows up in the pixel and content checks
    // Different words (contact details we replace, a price or date that changed on the live site) size a block
    // differently for a good reason: only its place is compared.
    const sameText = lb.th === cb.th && !reworded.has(lb.leaf ? lb.sec : k);
    const name = lb.label ? `“${lb.label.slice(0, 40)}”` : k.replace(/#\d+$/, '');
    const big = lb.leaf ? Math.min(lb.box.w, lb.box.h, cb.box.w, cb.box.h) >= L.minBlock : !lb.edge && !k.startsWith('el:');
    if (big && sameText && (off(lb.box.w, cb.box.w, L.size, L.sizePx) || off(lb.box.h, cb.box.h, L.size, L.sizePx)))
      out['part-size-differs'].push({ at: at(k, lb), leaf: lb.leaf, detail: `${where}${name} is ${cb.box.w}×${cb.box.h} px in the Preserve, ${lb.box.w}×${lb.box.h} on the live page` });
    if (!lb.leaf) continue;
    const ls = lb.sec && secs(live, lb.sec), cs = lb.sec && secs(copy, lb.sec);
    if (ls && cs && lb.rx != null && cb.rx != null && (Math.abs(lb.rx - cb.rx) > Math.max(L.movePx, L.move * ls.box.w) || Math.abs(lb.ry - cb.ry) > Math.max(L.movePx, L.move * ls.box.h)))
      out['part-moved'].push({ at: at(k, lb), detail: `${where}${name} sits ${Math.round(cb.rx - lb.rx)} px across, ${Math.round(cb.ry - lb.ry)} px down from where it is on the live page` });
    const lp = lb.pics?.[0], cp = cb.pics?.[0];
    if (lp && cp && !(lb.frames?.length) && (off(lp[0], cp[0], L.pic, L.picPx) || off(lp[1], cp[1], L.pic, L.picPx)))
      out['picture-size-differs'].push({ at: at(k, lb), detail: `${where}a picture in ${name} is ${cp[0]}×${cp[1]} px, ${lp[0]}×${lp[1]} on the live page` });
    if (sameText && !lb.code && !lb.clipped && !cb.clipped && lb.lines >= 2 && cb.lines >= 1 && Math.abs(lb.lines - cb.lines) > L.lines && Math.abs(lb.lines - cb.lines) >= lb.lines / 4)
      out['text-wraps-differently'].push({ at: at(k, lb), detail: `${where}${name} takes ${cb.lines} lines in the Preserve, ${lb.lines} on the live page` });
    if ((cb.spill || 0) - (lb.spill || 0) > L.spill)
      out['part-cut-off'].push({ at: at(k, lb), detail: `${where}${name} runs ${cb.spill} px past the edge of the window` });
    (lb.frames || []).forEach((f, i) => {
      if (f.drawn === false) return; // didn't draw on the live page either
      const c = cb.frames?.[i];
      if (!c || c.blank) out['frame-missing'].push({ at: at(k, lb), detail: `${where}an embedded ${f.w}×${f.h} part in ${name} (a form, booking or map widget) is ${c ? 'an empty box' : 'missing'} in the Preserve` });
      else if (off(f.w, c.w, L.frame, 24) || off(f.h, c.h, L.frame, 24)) out['frame-size-differs'].push({ at: at(k, lb), detail: `${where}an embedded part in ${name} is ${c.w}×${c.h} px, ${f.w}×${f.h} on the live page` });
    });
  }
  for (const pair of new Set([...Object.keys(live.overlaps), ...Object.keys(copy.overlaps)])) {
    const [a, b] = pair.split('|');
    if (!live.blocks[a] || !live.blocks[b] || !copy.blocks[a] || !copy.blocks[b]) continue;
    // A block that draws nothing on one side (text not yet faded in on the live page) can't be compared.
    if (![live.blocks[a], live.blocks[b], copy.blocks[a], copy.blocks[b]].every((x) => x.ink)) continue;
    const l = live.overlaps[pair] || 0, c = copy.overlaps[pair] || 0;
    // Newly overlapping (they don't touch on the live page), or no longer overlapping (they clearly did).
    // Or text that sat wholly on a backdrop (a color block, a shape) now running off it (Minaa B at laptop widths).
    const offBackdrop = l >= 0.97 && c <= l - 0.03;
    if (!(l < 0.03 && c >= L.overlap) && !(c < 0.03 && l >= L.overlap) && !offBackdrop) continue;
    const n = (k) => (live.blocks[k].label ? `“${live.blocks[k].label.slice(0, 30)}”` : k);
    out['parts-overlap-differently'].push({ at: at(a, live.blocks[a]), detail: offBackdrop ? `${where}${n(a)} and ${n(b)} no longer line up: part of one runs off the other (${Math.round((l - c) * 100)}% of it)` : c > l ? `${where}${n(a)} and ${n(b)} run into each other in the Preserve (not on the live page)` : `${where}${n(a)} and ${n(b)} overlap on the live page, not in the Preserve` });
  }
  if (codes) for (const c of CODES) if (!codes.includes(c)) out[c] = [];
  return out;
}
