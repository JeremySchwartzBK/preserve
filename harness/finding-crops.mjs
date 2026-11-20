// The "Your site" and "Preserve" pictures beside each suspected issue in review (Jeremy, 2026-11-20: show it, don't
// tell it). Cut from the two full-page screenshots the quality check already compares: the live page's
// (ref-full-<layout>.png, capture.mjs) and the Preserve's (gate-full-<layout>.png, check.mjs via gate.mjs), at the
// same height on the page, so the pair shows exactly what the check looked at.
//   node finding-crops.mjs <siteDir> <pins.json> <outDir>
// pins.json: [{ i, layout: 'desktop'|'mobile', pageY, firstScreen? }]. A first-screen finding gets the whole first
// screen (ref-<layout>.png and gate-<layout>.png) instead of a slice. Writes <i>-site.webp and <i>-preserve.webp and prints the
// list of i it made both pictures for. A pin without both screenshots, or outside them, gets none.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const CSS_WIDTH = { desktop: 1440, mobile: 390 };
const WINDOW = { desktop: 440, mobile: 560 };   // how much of the page each picture shows, in CSS pixels
const OUT_WIDTH = { desktop: 720, mobile: 300 };

export async function findingCrops(siteDir, pins, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const meta = new Map();
  const load = async (file) => {
    if (!meta.has(file)) meta.set(file, fs.existsSync(file) ? await sharp(file, { limitInputPixels: false }).metadata().catch(() => null) : null);
    return meta.get(file);
  };
  const made = [];
  for (const p of pins) {
    const layout = p.layout === 'mobile' ? 'mobile' : 'desktop';
    if (!p.firstScreen && !Number.isFinite(p.pageY)) continue;
    const full = p.firstScreen ? '' : 'full-';
    const files = { site: path.join(siteDir, `ref-${full}${layout}.png`), preserve: path.join(siteDir, `gate-${full}${layout}.png`) };
    const ms = [await load(files.site), await load(files.preserve)];
    if (ms.some((m) => !m?.width)) continue;
    let ok = true;
    for (const [which, file] of Object.entries(files)) {
      const m = which === 'site' ? ms[0] : ms[1];
      const k = m.width / CSS_WIDTH[layout];   // screenshot pixels per CSS pixel (phone screenshots are 3x)
      const h = p.firstScreen ? m.height : Math.round(WINDOW[layout] * k);
      if (m.height < 10) { ok = false; break; }
      const top = Math.max(0, Math.min(m.height - Math.min(h, m.height), Math.round((p.pageY || 0) * k - h / 2)));
      if (!p.firstScreen && p.pageY * k > m.height + h / 2) { ok = false; break; }  // the spot is past the end of this picture
      await sharp(file, { limitInputPixels: false })
        .extract({ left: 0, top, width: m.width, height: Math.min(h, m.height - top) })
        .resize({ width: OUT_WIDTH[layout] })
        .webp({ quality: 70 })
        .toFile(path.join(outDir, `${p.i}-${which}.webp`));
    }
    if (ok) made.push(p.i);
    else for (const w of ['site', 'preserve']) fs.rmSync(path.join(outDir, `${p.i}-${w}.webp`), { force: true });
  }
  return made;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [siteDir, pinsFile, outDir] = process.argv.slice(2);
  console.log(JSON.stringify(await findingCrops(siteDir, JSON.parse(fs.readFileSync(pinsFile, 'utf8')), outDir)));
}
