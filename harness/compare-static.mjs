// Compares the static export with the frozen-opt copy served by the copy server: 404s and full-page pixel difference.
// Usage: node compare-static.mjs <siteDir> <site> <staticBase>
import fs from 'node:fs'; import { PNG } from 'pngjs'; import pixelmatch from 'pixelmatch';
import { startServer } from './server.mjs'; import { serverVariants } from './build.mjs'; import { PROFILES, launch, sleep } from './lib.mjs';
const [siteDir, site, sbase] = process.argv.slice(2);
const port = 8800 + Math.floor(Math.random() * 90);
const srv = await startServer(siteDir, port, serverVariants());
const browser = await launch();
async function shot(url, prof) {
  const ctx = await browser.newContext({ ...PROFILES[prof].context });
  const bad = []; const page = await ctx.newPage();
  page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 140)); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  for (let i = 0; i < 25; i++) { await page.evaluate(() => scrollBy(0, innerHeight * 0.8)); await sleep(120); }
  await page.evaluate(() => scrollTo(0, 0)); await sleep(1500);
  const final = page.url();
  const buf = await page.screenshot({ fullPage: true, animations: 'disabled' }); await ctx.close();
  return { png: PNG.sync.read(buf), bad, final };
}
for (const prof of ['desktop', 'mobile']) {
  const a = await shot(`http://127.0.0.1:${port}/frozen-opt/${prof}.html`, prof);
  const b = await shot(`${sbase}/${site}/`, prof);
  const w = Math.min(a.png.width, b.png.width), h = Math.min(a.png.height, b.png.height, 12000);
  const crop = (p) => { const o = new PNG({ width: w, height: h }); PNG.bitblt(p, o, 0, 0, w, h, 0, 0); return o; };
  const diff = pixelmatch(crop(a.png).data, crop(b.png).data, null, w, h, { threshold: 0.15 });
  console.log(site, prof, 'final', b.final, 'heights', a.png.height, b.png.height, 'diff%', (100 * diff / (w * h)).toFixed(2), '404s', b.bad.length, b.bad.slice(0, 8));
  fs.writeFileSync(`/tmp/claude-0/cmp-${site}-${prof}.png`, PNG.sync.write(b.png));
}
await browser.close(); srv.server.close(); process.exit(0);
