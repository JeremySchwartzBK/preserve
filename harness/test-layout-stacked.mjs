// A heading over a slideshow whose slides' pictures are stacked in one spot (The Lurk Shop, 2026-11-28): each spot a
// block draws counts once, so the live page (every slide there) and the copy (one slide kept) read the heading as
// lying on the pictures to the same extent, and the check doesn't call it moved off them (layout.mjs).
// Usage: node test-layout-stacked.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { launch } from './lib.mjs';
import { probeLayout, compareLayout } from './layout.mjs';

const pic = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><rect width="900" height="500" fill="#a63"/></svg>');
const page = (slides) => `<!doctype html><title>Home</title><style>body{margin:0;background:#222}section{position:relative;height:900px}
#block-head{position:absolute;left:200px;top:100px;width:1000px;font:bold 120px sans-serif;color:#f73;z-index:2}
#block-show{position:absolute;left:260px;top:180px;width:900px;height:500px}#block-show img{position:absolute;left:0;top:0;width:900px;height:500px}</style>
<section data-section-id="s1"><div id="block-head" class="sqs-block"><h1 style="margin:0">PROJECTS</h1></div>
<div id="block-show" class="sqs-block">${Array.from({ length: slides }, () => `<img src="${pic}">`).join('')}</div></section>`;
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page(q.url.includes('copy') ? 1 : 3)); }).listen(0);
await new Promise((o) => srv.once('listening', o));
const b = await launch(), u = `http://127.0.0.1:${srv.address().port}`;
const live = await probeLayout(b, `${u}/live`), copy = await probeLayout(b, `${u}/copy`, { isCopy: true });
await b.close(); srv.close();
const pair = Object.keys(live.overlaps).find((k) => k.includes('block-head') && k.includes('block-show'));
assert.ok(pair, `the heading lies on the slideshow (${JSON.stringify(live.overlaps)} ${live.error || ''})`);
assert.ok(Math.abs(live.overlaps[pair] - (copy.overlaps[pair] || 0)) < 0.03, `the same share on both (${live.overlaps[pair]} vs ${copy.overlaps[pair]})`);
assert.deepEqual(compareLayout(live, copy)['parts-overlap-differently'], []);
console.log('layout-stacked: ok');
process.exit(0);
