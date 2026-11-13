// The person's pinned issues on a refinement (Jeremy, 2026-10-27: refinements follow within minutes of the first
// capture, so they capture the live page again; the person never has to pin the same issue twice).
// The runner writes the open pins to a file and make-copy passes it on as PRESERVE_PINS. With pins, the capture takes
// more care where they point (each pinned block is scrolled to and given time: slideshows, animations, late images),
// and the quality check compares each pinned block with the live page, so each pin can say "looks fixed" or "still
// different" after the round.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './lib.mjs';
import { diffPct } from './check.mjs';

export function loadPins() {
  const f = process.env.PRESERVE_PINS;
  if (!f) return [];
  try { return (JSON.parse(fs.readFileSync(f, 'utf8')) || []).filter((p) => p && p.block_id); } catch { return []; }
}
// A pin applies to its block on every layout, not just the one it was placed on (Jeremy, 2026-11-13: "a pinned issue on
// one view should be solved for both views"). Phone and desktop are the same page, so the block has the same id on both;
// where a layout hides it, the lookup finds nothing (or nothing visible) and that layout is skipped.
const LAYOUTS = ['desktop', 'mobile'];
const forLayout = (pins) => pins.map((p, i) => ({ ...p, i }));

// Same lookup as the review bridge (platform/worker/src/index.js find()): block ids, el:<selector>, section:<id>.
const FIND = (id) => {
  if (id.indexOf('el:') === 0) return document.querySelector(id.slice(3));
  if (id.indexOf('section:') === 0) return document.querySelector('section[data-section-id="' + id.slice(8) + '"]');
  return document.getElementById(id) || document.querySelector('[data-block-id="' + id + '"]');
};

// Capture: scroll each pinned block into view and wait there, so what the person pointed at has loaded and played.
export async function focusPins(page, prof, pins = loadPins(), wait = 3000) {
  let found = 0;
  for (const p of forLayout(pins)) {
    const ok = await page.evaluate(([find, id]) => { const el = eval(`(${find})`)(id); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; }, [FIND.toString(), p.block_id]).catch(() => false);
    // The pin's AI pick (ai-pins.mjs) can ask for much more time: something caught before it finished.
    if (ok) { found++; await sleep(p.ai?.action === 'wait-longer' ? Math.max(wait, 9000) : wait); }
  }
  return found;
}

// Pins whose AI pick is "still": mark the block so capture photographs it on the live site and the export shows that
// picture in its place (the same path as widgets that draw in a shadow root, capture.mjs shadowStills).
export async function markPinStills(page, prof, pins = loadPins()) {
  let n = 0;
  for (const p of forLayout(pins).filter((p) => p.ai?.action === 'still')) {
    if (await page.evaluate(([find, id]) => { const el = eval(`(${find})`)(id); if (!el) return false; el.setAttribute('data-preserve-pin-still', ''); return true; }, [FIND.toString(), p.block_id]).catch(() => false)) n++;
  }
  return n;
}

// A picture of each pinned block on this page (live or copy), at most 1500 px tall.
export async function shootPins(page, prof, dir, prefix, pins = loadPins()) {
  for (const p of forLayout(pins)) {
    const file = path.join(dir, `${prefix}-pin${p.i}-${prof}.png`);
    fs.rmSync(file, { force: true });
    const box = await page.evaluate(([find, id]) => { const el = eval(`(${find})`)(id); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }, [FIND.toString(), p.block_id]).catch(() => null);
    if (!box || box.w < 4 || box.h < 4) continue;
    await sleep(1500);
    await page.screenshot({ path: file, fullPage: true, clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.w, height: Math.min(box.h, 1500) } }).catch(() => {});
  }
}

// One layout's result for one pin, from the two pictures. A block the page varies by itself (self) gets that much more
// leeway.
async function compareOne(dir, i, prof, limitPct, self) {
  const live = path.join(dir, `live-pin${i}-${prof}.png`), copy = path.join(dir, `copy-pin${i}-${prof}.png`);
  if (!fs.existsSync(copy)) return { result: 'not-found' };
  if (!fs.existsSync(live)) return { result: 'no-live-block' };
  const diff = (await diffPct(live, copy, null, [], 1, null, { shift: 40 }))?.pct ?? null;
  const allowed = limitPct + (self[prof]?.fullPage?.pct || 0);
  return { diff, result: diff != null && diff <= allowed ? 'looks-fixed' : 'still-different' };
}

// Each pin's result. The layout it was placed on decides "not found"; it looks fixed only when it looks fixed on every
// layout that shows the block (diff is the worst of them), and "layouts" says how each one came out.
export async function comparePins(dir, limitPct, self = {}, pins = loadPins()) {
  const out = [];
  for (const [i, p] of pins.entries()) {
    const prof = p.layout || 'desktop';
    const base = { block_id: p.block_id, layout: prof, at: p.at, from: p.from || 'person', ...(p.ai ? { ai: p.ai } : {}) };
    const layouts = {};
    for (const l of [prof, ...LAYOUTS.filter((x) => x !== prof)]) layouts[l] = await compareOne(dir, i, l, limitPct, self);
    const own = layouts[prof];
    if (own.result === 'not-found' || own.result === 'no-live-block') { out.push({ ...base, ...own, layouts }); continue; }
    const judged = Object.values(layouts).filter((r) => r.diff !== undefined);
    const diffs = judged.map((r) => r.diff).filter((d) => d != null);
    const diff = judged.some((r) => r.diff == null) ? null : Math.max(...diffs);
    out.push({ ...base, diff, result: judged.every((r) => r.result === 'looks-fixed') ? 'looks-fixed' : 'still-different', layouts });
  }
  return out;
}
