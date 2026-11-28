// A shape block's drawing (Squarespace draws it in pixels for its block's size, with no viewBox) is given that size as
// its viewBox before the page is saved, so in a narrower window it shrinks with its block instead of running past it
// (Minaa B, 2026-11-28; capture.mjs fitShapes).
// Usage: node test-capture-shapes.mjs
import assert from 'node:assert/strict';
import { launch } from './lib.mjs';
import { fitShapes } from './capture.mjs';

const html = `<!doctype html><style>body{margin:0}.blk{width:40vw;height:30vw;position:relative}</style>
<div class="blk" id="b"><svg xmlns="http://www.w3.org/2000/svg" class="ps-shape ps-shape-rectangle" style="width:100%;height:100%" preserveAspectRatio="none">
<path fill="#9a8b3f" d="M10,0 H566 A10,10 0 0 1 576,10 V422 A10,10 0 0 1 566,432 H10 A10,10 0 0 1 0,422 V10 A10,10 0 0 1 10,0 Z"></path></svg></div>
<div class="blk"><svg class="ps-shape" viewBox="0 0 10 10" id="own"><path d="M0,0 H10 V10 Z"></path></svg></div>`;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.setContent(html);
const box = (p) => p.evaluate(() => { const b = document.getElementById('b').getBoundingClientRect(), r = document.querySelector('#b path').getBoundingClientRect(); return { bw: b.width, bh: b.height, pw: r.width, ph: r.height }; });
const before = await box(page);
assert.ok(Math.abs(before.pw - before.bw) < 1 && Math.abs(before.ph - before.bh) < 1, `drawn for its block at the start (${JSON.stringify(before)})`);
assert.equal(await page.evaluate(fitShapes), 1, 'only the shape with no viewBox of its own is changed');
assert.equal(await page.evaluate(() => document.getElementById('own').getAttribute('viewBox')), '0 0 10 10');
// Saved and opened in a narrower window.
const saved = await page.evaluate(() => document.documentElement.outerHTML);
const narrow = await browser.newPage({ viewport: { width: 1024, height: 900 } });
await narrow.setContent(saved);
const after = await box(narrow);
await browser.close();
assert.ok(Math.abs(after.pw - after.bw) < 1 && Math.abs(after.ph - after.bh) < 1, `the shape still fills its block, no more (${JSON.stringify(after)})`);
console.log('capture-shapes: ok');
