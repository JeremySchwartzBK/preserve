// The "Your site" and "Preserve" pictures beside each suspected issue in review (Jeremy, 2026-11-20: show it, don't
// tell it). Both pages are opened the way a visitor sees them (the live page, and the Preserve as served with the rules
// visitors get), scrolled through once so anything that appears on scroll has appeared, then each finding's part of the
// page is brought on screen and photographed in both, around the same block. The check's full-page screenshots aren't
// good enough for this: they miss what appears on scroll and can draw a first screen blank (kosa, 2026-11-20).
// A finding whose block can't be found is taken at its height on the page; the first screen is taken whole. If a page
// can't be opened at all, its pictures are cut from those full-page screenshots instead (ref-full-<layout>.png,
// gate-full-<layout>.png), which is better than none.
//   node finding-crops.mjs <siteDir> <copyDir> <liveUrl> <pins.json> <outDir>
// pins.json: [{ i, layout: 'desktop'|'mobile', blockId, pageY, firstScreen? }]. Writes <i>-site.webp and
// <i>-preserve.webp and prints the list of i it made both pictures for.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { PROFILES, launch, sleep, OVERLAY_SELECTORS, markPromos } from './lib.mjs';
import { serve } from './gate.mjs';

const CSS_WIDTH = { desktop: 1440, mobile: 390 };
const WINDOW = { desktop: 440, mobile: 560 };   // how much of the page each picture shows, in CSS pixels
const OUT_WIDTH = { desktop: 720, mobile: 300 };
const SCALE = { desktop: 1, mobile: 2 };         // enough for a 300-pixel-wide picture

async function openPage(browser, layout, url, live) {
  const ctx = await browser.newContext({ ...PROFILES[layout].context, deviceScaleFactor: SCALE[layout] });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60e3 });
  if (live) {
    await page.evaluate(markPromos).catch(() => {});
    await page.addStyleTag({ content: `${OVERLAY_SELECTORS.join(',')}{display:none!important}` }).catch(() => {});
  }
  // Scroll through once, so pictures that load late and blocks that fade in on scroll are there.
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < Math.min(h, 40000); y += 500) { await page.evaluate((v) => scrollTo(0, v), y); await sleep(120); }
  await page.evaluate(() => scrollTo(0, 0)); await sleep(800);
  return { ctx, page };
}

// Bring the finding's part of the page on screen and photograph a window around it.
async function shoot(page, layout, p, file) {
  const vh = PROFILES[layout].context.viewport.height, w = CSS_WIDTH[layout], win = Math.min(WINDOW[layout], vh);
  let clip;
  if (p.firstScreen) {
    await page.evaluate(() => scrollTo(0, 0)); await sleep(600);
    clip = { x: 0, y: 0, width: w, height: vh };
  } else {
    // The same lookup the review frame uses to place its dots (worker REVIEW_BRIDGE find).
    const mid = await page.evaluate(([id, py]) => {
      let e = null;
      if (id && id !== 'el:body') e = id.startsWith('el:') ? document.querySelector(id.slice(3))
        : id.startsWith('section:') ? document.querySelector(`section[data-section-id="${id.slice(8)}"]`)
        : document.getElementById(id) || document.querySelector(`[data-block-id="${id}"]`);
      const r = e && e.getBoundingClientRect();
      const at = r && r.height ? scrollY + r.top + r.height / 2 : py;
      if (!Number.isFinite(at)) return null;
      scrollTo(0, Math.max(0, at - innerHeight / 2));
      return at - scrollY;
    }, [p.blockId, p.pageY]);
    if (mid == null) return false;
    await sleep(600);
    clip = { x: 0, y: Math.max(0, Math.min(vh - win, Math.round(mid - win / 2))), width: w, height: win };
  }
  await sharp(await page.screenshot({ clip })).resize({ width: OUT_WIDTH[layout] }).webp({ quality: 72 }).toFile(file);
  return true;
}

// The fallback: cut from the full-page screenshot the check took.
async function cut(siteDir, which, layout, p, file) {
  const src = path.join(siteDir, `${which === 'site' ? 'ref' : 'gate'}-${p.firstScreen ? '' : 'full-'}${layout}.png`);
  if (!fs.existsSync(src)) return false;
  const m = await sharp(src, { limitInputPixels: false }).metadata();
  const k = m.width / CSS_WIDTH[layout];
  const h = Math.min(m.height, p.firstScreen ? m.height : Math.round(WINDOW[layout] * k));
  if (!p.firstScreen && !(Number.isFinite(p.pageY) && p.pageY * k < m.height)) return false;
  const top = Math.max(0, Math.min(m.height - h, Math.round((p.pageY || 0) * k - h / 2)));
  await sharp(src, { limitInputPixels: false }).extract({ left: 0, top, width: m.width, height: h }).resize({ width: OUT_WIDTH[layout] }).webp({ quality: 72 }).toFile(file);
  return true;
}

export async function findingCrops({ siteDir, copyDir, url, pins, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const made = [];
  const srv = await serve(path.dirname(copyDir));
  const base = `http://127.0.0.1:${srv.address().port}/${path.basename(copyDir)}`;
  const browser = await launch();
  try {
    for (const layout of ['desktop', 'mobile']) {
      const mine = pins.filter((p) => (p.layout === 'mobile' ? 'mobile' : 'desktop') === layout);
      if (!mine.length) continue;
      const pages = {};
      for (const [which, u, live] of [['site', url, true], ['preserve', `${base}/${layout}`, false]]) {
        pages[which] = await openPage(browser, layout, u, live).catch((e) => { console.error(`${which} ${layout} not opened: ${e.message.split('\n')[0]}`); return null; });
      }
      for (const p of mine) {
        let ok = true;
        for (const which of ['site', 'preserve']) {
          const file = path.join(outDir, `${p.i}-${which}.webp`);
          const done = (pages[which] && await shoot(pages[which].page, layout, p, file).catch(() => false)) || await cut(siteDir, which, layout, p, file).catch(() => false);
          if (!done) { ok = false; break; }
        }
        if (ok) made.push(p.i);
        else for (const w of ['site', 'preserve']) fs.rmSync(path.join(outDir, `${p.i}-${w}.webp`), { force: true });
      }
      for (const x of Object.values(pages)) await x?.ctx.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
  return made;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [siteDir, copyDir, url, pinsFile, outDir] = process.argv.slice(2);
  console.log(JSON.stringify(await findingCrops({ siteDir, copyDir, url, pins: JSON.parse(fs.readFileSync(pinsFile, 'utf8')), outDir })));
}
