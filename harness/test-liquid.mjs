// Our liquid-image stand-in (build.mjs LIQUID_SCRIPT): it ripples a picture that fits inside its box (Xanadu's orbit
// logo, 6850 px wide), drawing only over the picture itself and leaving the page's layout alone; and a picture saved hidden comes back whenever the ripple
// isn't drawn (less motion asked for, or our own stylesheet step), so it is never left blank. Usage: node test-liquid.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { LIQUID_SCRIPT } from './build.mjs';
import { launch } from './lib.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvlq-'));
const browser = await launch();
// A wide picture with stripes, larger than many phones can hold as one WebGL picture.
{
  const p = await browser.newPage();
  const png = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 6000; c.height = 2000; const g = c.getContext('2d'); for (let x = 0; x < 6000; x += 200) { g.fillStyle = (x / 200) % 2 ? '#d33' : '#33d'; g.fillRect(x, 0, 200, 2000); } return c.toDataURL('image/png').split(',')[1]; });
  fs.writeFileSync(path.join(dir, 'p.png'), Buffer.from(png, 'base64'));
  await p.close();
}
const fx = JSON.stringify({ i: 30, s: 2, r: 0, v: 50, m: 5, sh: 0, sm: 100, sd: 1, fx: 0.5, fy: 0.5 }).replace(/"/g, '&quot;');
fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><body style="margin:0">
<div id="box" style="position:relative;width:600px;height:600px;background:#fff"><div class="fit"><img id="im" src="p.png" width="6000" height="2000" data-pv-liquid="${fx}" style="position:absolute;left:0;top:0;display:block;width:100%;height:100%;object-fit:contain;object-position:50% 50%;visibility:hidden"></div></div>
${LIQUID_SCRIPT}</body></html>`);
// A photo of a churning background drawing (capture.mjs canvasStills: The Garret Group's gradient), stretched to its box.
fs.writeFileSync(path.join(dir, 'fill.html'), `<!doctype html><html><body style="margin:0">
<div id="box" style="position:relative;width:600px;height:600px"><img id="im" src="p.png" data-pv-canvas="1" data-pv-liquid="${fx.replace('30', '1')}" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill"></div>
${LIQUID_SCRIPT}</body></html>`);
const srv = http.createServer((q, r) => { const f = path.join(dir, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : 'text/html' }); r.end(fs.readFileSync(f)); }).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/`;
const open = async (opts = {}, init) => {
  const { file, ...o } = opts; const ctx = await browser.newContext({ viewport: { width: 800, height: 700 }, ...o });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage(); await page.goto(url + (opts.file || '')); await page.waitForTimeout(1500);
  const r = await page.evaluate(() => { const im = document.getElementById('im'), cv = document.querySelector('canvas[data-pv-runtime]'); const b = cv && cv.getBoundingClientRect(); return { imH: im.getBoundingClientRect().height, vis: getComputedStyle(im).visibility, cv: b && { top: b.top, height: b.height, width: b.width } }; });
  const shot = r.cv ? await page.screenshot({ clip: { x: 0, y: r.cv.top, width: r.cv.width, height: r.cv.height } }) : null;
  await ctx.close(); return { ...r, shot };
};
try {
  const on = await open();
  assert.ok(on.cv, 'the ripple is drawn');
  assert.equal(on.vis, 'hidden', 'the still picture is hidden under the ripple');
  assert.ok(Math.abs(on.cv.height - 200) <= 2 && Math.abs(on.cv.top - 200) <= 2, `drawn over the picture only, not its whole box: ${JSON.stringify(on.cv)}`);
  assert.ok(on.shot.length > 2000, 'the ripple is not blank');
  assert.equal(on.imH, 600, 'the picture keeps its size: its box, sized by a box further out, is left as it was');
  const calm = await open({ reducedMotion: 'reduce' });
  assert.equal(calm.cv, null); assert.equal(calm.vis, 'visible', 'less motion: the picture shows, though saved hidden');
  const off = await open({}, () => { window.__pvNoLiquid = true; });
  assert.equal(off.cv, null); assert.equal(off.vis, 'visible', 'our stylesheet step: the picture shows');
  // Stretched like the photo itself, not cropped: all 30 stripes across, over the whole box.
  const fill = await open({ file: 'fill.html' }, () => { window.__pvStill = true; });
  assert.ok(fill.cv && Math.abs(fill.cv.width - 600) <= 2 && Math.abs(fill.cv.height - 600) <= 2, `a stretched photo: drawn over its whole box: ${JSON.stringify(fill.cv)}`);
  const { data, info } = await sharp(fill.shot).raw().toBuffer({ resolveWithObject: true });
  let edges = 0; const y = Math.floor(info.height / 2);
  for (let x = 1; x < info.width; x++) { const a = (y * info.width + x - 1) * info.channels, b = a + info.channels; if (Math.abs(data[a] - data[b]) > 100) edges++; }
  assert.ok(edges >= 25 && edges <= 35, `a stretched photo: stretched, not cropped (${edges} stripe edges, 29 expected)`);
  console.log('liquid stand-in: ok');
} finally { srv.close(); await browser.close(); }
