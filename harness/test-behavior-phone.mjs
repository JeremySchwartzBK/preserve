// On a phone the check's pictures are taken in the window's own units, like the boxes it measures, so a still
// section isn't read as changing when the page scrolls (Colorize, 2026-11-28: a phone's picture is three times as wide
// as its window, and a still sign-up section read as 56% changed).
// Usage: node test-behavior-phone.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { launch } from './lib.mjs';
import { probeBehavior, SCROLL_REACT } from './behavior.mjs';

const band = (a, b) => `repeating-linear-gradient(180deg,${a} 0 23px,${b} 23px 41px)`;
const page = `<!doctype html><title>Home</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}section{height:1100px}</style>
<section data-section-id="a1" style="background:${band('#fa8', '#36c')}"></section><section data-section-id="a2" style="background:${band('#8fa', '#c36')}"></section>
<section data-section-id="a3" style="background:${band('#ff8', '#639')}"></section><section data-section-id="a4" style="background:${band('#8ff', '#963')}"></section>`;
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page); }).listen(0);
await new Promise((o) => srv.once('listening', o));
const b = await launch();
const r = await probeBehavior(b, `http://127.0.0.1:${srv.address().port}/`, 'mobile');
await b.close(); srv.close();
const scroll = Object.entries(r.scroll || {}).filter(([k]) => k.startsWith('section:'));
assert.ok(scroll.length >= 2, `sections were scrolled (${JSON.stringify(r.scroll)} ${r.error || ''})`);
for (const [k, s] of scroll) assert.ok(s.scrolled < SCROLL_REACT, `${k}: nothing changes as the page scrolls (${s.scrolled})`);
console.log('behavior-phone: ok');
process.exit(0);
