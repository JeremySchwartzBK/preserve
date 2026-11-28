// Our stand-in for Squarespace's "refracted circles" and "refracted lines" image effects (build.mjs REFRACT_SCRIPT):
// with settings that bend nothing it draws the picture exactly as the page lays it out; with the sites' usual
// settings it visibly bends it; the circles follow the pointer and come back to rest; the lines follow the scroll; and
// visitors who ask for less motion get the plain picture. Usage: node test-refract.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { REFRACT_SCRIPT } from './build.mjs';
import sharp from 'sharp';
import { launch } from './lib.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvrf-'));
const browser = await launch();
{ // A picture with a coloured checkerboard, so any bend shows.
  const p = await browser.newPage();
  const png = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d'); for (let y = 0; y < 800; y += 50) for (let x = 0; x < 1200; x += 50) { g.fillStyle = `hsl(${(x / 1200) * 300},70%,${(x + y) / 50 % 2 ? 25 : 75}%)`; g.fillRect(x, y, 50, 50); } return c.toDataURL('image/png').split(',')[1]; });
  fs.writeFileSync(path.join(dir, 'p.png'), Buffer.from(png, 'base64'));
  await p.close();
}
const CIRCLES = { type: 'refractedCircles', isLimitRings: false, numRings: 5, centerOffsetSize: 55, size: 150, rotation: 2, scaleEven: 100, scaleOdd: 90, scaleTaperEven: 10, scaleTaperOdd: -10, interactionType: 'mouse', shiftIntensity: 50, shiftSpeed: 20, isStepFlipRotation: true, isStepFlipX: false, isStepFlipY: false };
const LINES = { type: 'refractedLines', intensity: -25, size: 120, offsetScaleX: 50, offsetScaleY: 50, rotation: 135, scale: 80, interactionType: 'scroll', shiftIntensity: 25, shiftSpeed: 20 };
const FLAT_C = { ...CIRCLES, rotation: 0, scaleEven: 100, scaleOdd: 100, scaleTaperEven: 0, scaleTaperOdd: 0, interactionType: 'none' };
const FLAT_L = { ...LINES, intensity: 0, scale: 100, interactionType: 'none' };
const esc = (o) => JSON.stringify({ ...o, fx: 0.5, fy: 0.5 }).replace(/"/g, '&quot;');
const page = (fx) => `<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0}section{position:relative;height:600px;overflow:hidden}img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}</style>
<section id="s"><img id="im" src="p.png" data-pv-refract="${esc(fx)}"></section><div style="height:2000px"></div>${REFRACT_SCRIPT}`;
const srv = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/p.png') { r.writeHead(200, { 'content-type': 'image/png' }); return r.end(fs.readFileSync(path.join(dir, 'p.png'))); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(page(JSON.parse(u.searchParams.get('fx'))));
}).listen(0);
await new Promise((o) => srv.once('listening', o));
const base = `http://127.0.0.1:${srv.address().port}/`;
async function open(fx, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, ...opts });
  const p = await ctx.newPage();
  await p.goto(base + '?fx=' + encodeURIComponent(JSON.stringify(fx)), { waitUntil: 'load' });
  await p.waitForTimeout(800);
  return { p, ctx };
}
// What the visitor sees of the section, at 180 x 120; and the same spot with the drawing taken away.
const look = async (p) => { const { data } = await sharp(await p.screenshot({ clip: { x: 0, y: 0, width: 900, height: 600 } })).resize(180, 120).raw().toBuffer({ resolveWithObject: true }); return [...data].flatMap((v, i) => (i % 3 === 2 ? [v, 255] : [v])); };
const grab = async (p) => ((await p.evaluate(() => !!document.querySelector('canvas[data-pv-runtime]'))) ? look(p) : null);
const plain = async (p) => {
  await p.evaluate(() => { const c = document.querySelector('canvas[data-pv-runtime]'); if (c) c.style.visibility = 'hidden'; document.getElementById('im').style.visibility = 'visible'; });
  const out = await look(p);
  await p.evaluate(() => { const c = document.querySelector('canvas[data-pv-runtime]'); if (c) c.style.visibility = ''; document.getElementById('im').style.visibility = 'hidden'; });
  return out;
};
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 40) n++; return n / (a.length / 4); };

for (const [name, fx] of [['circles', FLAT_C], ['lines', FLAT_L]]) {
  const { p, ctx } = await open(fx);
  const d = await grab(p); assert.ok(d, `${name}: drawn`);
  assert.equal(await p.evaluate(() => document.getElementById('im').style.visibility), 'hidden', `${name}: picture hidden under the drawing`);
  const k = diff(d, await plain(p)); assert.ok(k < 0.03, `${name}: settings that bend nothing draw the plain picture (${(k * 100).toFixed(1)}% differs)`);
  await ctx.close();
}
{
  const { p, ctx } = await open(CIRCLES);
  const rest = await grab(p);
  assert.ok(diff(rest, await plain(p)) > 0.2, 'circles: the picture is visibly bent');
  await p.mouse.move(800, 100); for (let i = 0; i < 10; i++) { await p.mouse.move(800 + i, 100 + i); await p.waitForTimeout(60); }
  assert.ok(diff(await grab(p), rest) > 0.05, 'circles: follow the pointer');
  await p.waitForTimeout(4500);
  assert.ok(diff(await grab(p), rest) < 0.02, 'circles: back to rest after the pointer stops');
  await ctx.close();
}
{
  const { p, ctx } = await open(LINES);
  const top = await grab(p);
  assert.ok(diff(top, await plain(p)) > 0.2, 'lines: the picture is visibly bent');
  await p.evaluate(() => scrollTo(0, 400)); await p.waitForTimeout(2500);
  assert.ok(diff(await grab(p), top) > 0.05, 'lines: follow the scroll');
  await ctx.close();
}
{
  const { p, ctx } = await open(CIRCLES, { reducedMotion: 'reduce' });
  assert.equal(await grab(p), null, 'less motion: no drawing');
  assert.notEqual(await p.evaluate(() => document.getElementById('im').style.visibility), 'hidden', 'less motion: the plain picture shows');
  await ctx.close();
}
srv.close(); await browser.close();
console.log('ok: refracted circles and lines');
