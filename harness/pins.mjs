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
const forLayout = (pins, prof) => pins.map((p, i) => ({ ...p, i })).filter((p) => !p.layout || p.layout === prof);

// Same lookup as the review bridge (platform/worker/src/index.js find()): block ids, el:<selector>, section:<id>.
const FIND = (id) => {
  if (id.indexOf('el:') === 0) return document.querySelector(id.slice(3));
  if (id.indexOf('section:') === 0) return document.querySelector('section[data-section-id="' + id.slice(8) + '"]');
  return document.getElementById(id) || document.querySelector('[data-block-id="' + id + '"]');
};

// Capture: scroll each pinned block into view and wait there, so what the person pointed at has loaded and played.
export async function focusPins(page, prof, pins = loadPins(), wait = 3000) {
  let found = 0;
  for (const p of forLayout(pins, prof)) {
    const ok = await page.evaluate(([find, id]) => { const el = eval(`(${find})`)(id); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; }, [FIND.toString(), p.block_id]).catch(() => false);
    if (ok) { found++; await sleep(wait); }
  }
  return found;
}

// A picture of each pinned block on this page (live or copy), at most 1500 px tall.
export async function shootPins(page, prof, dir, prefix, pins = loadPins()) {
  for (const p of forLayout(pins, prof)) {
    const file = path.join(dir, `${prefix}-pin${p.i}-${prof}.png`);
    fs.rmSync(file, { force: true });
    const box = await page.evaluate(([find, id]) => { const el = eval(`(${find})`)(id); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }, [FIND.toString(), p.block_id]).catch(() => null);
    if (!box || box.w < 4 || box.h < 4) continue;
    await sleep(1500);
    await page.screenshot({ path: file, fullPage: true, clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.w, height: Math.min(box.h, 1500) } }).catch(() => {});
  }
}

// Each pin's result, from the two pictures. A block the page varies by itself (self) gets that much more leeway.
export async function comparePins(dir, limitPct, self = {}, pins = loadPins()) {
  const out = [];
  for (const [i, p] of pins.entries()) {
    const prof = p.layout || 'desktop';
    const live = path.join(dir, `live-pin${i}-${prof}.png`), copy = path.join(dir, `copy-pin${i}-${prof}.png`);
    const base = { block_id: p.block_id, layout: prof, at: p.at, from: p.from || 'person' };
    if (!fs.existsSync(copy)) { out.push({ ...base, result: 'not-found' }); continue; }
    if (!fs.existsSync(live)) { out.push({ ...base, result: 'no-live-block' }); continue; }
    const diff = (await diffPct(live, copy, null, [], 1, null, { shift: 40 }))?.pct ?? null;
    const allowed = limitPct + (self[prof]?.fullPage?.pct || 0);
    out.push({ ...base, diff, result: diff != null && diff <= allowed ? 'looks-fixed' : 'still-different' });
  }
  return out;
}
