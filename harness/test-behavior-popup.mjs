// An email-signup popup that opens a few seconds in (Klaviyo's, on Honeybelle, 2026-11-28) is hidden on the live page
// while the check scrolls it, so the popup sitting still over the sections isn't taken for a scroll effect the copy lost.
// Usage: node test-behavior-popup.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { launch } from './lib.mjs';
import { probeBehavior, SCROLL_REACT } from './behavior.mjs';

const page = `<!doctype html><title>Home</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}section{height:900px}section:nth-child(odd){background:linear-gradient(#fa8,#8af)}section:nth-child(even){background:linear-gradient(#8fa,#f8a)}
.pop{position:fixed;inset:0;background:rgba(20,20,20,.6);z-index:9}.pop div{position:absolute;left:25%;top:20%;width:50%;height:60%;background:#fff}</style>
<section data-section-id="a1"></section><section data-section-id="a2"></section><section data-section-id="a3"></section><section data-section-id="a4"></section>
<script>setTimeout(function(){var d=document.createElement('div');d.className='pop needsclick';d.setAttribute('role','dialog');
d.setAttribute('data-kl-scroll-locking-modal','true');d.innerHTML='<div></div>';document.body.appendChild(d)},2500)</script>`;
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page); }).listen(0);
await new Promise((o) => srv.once('listening', o));
const b = await launch();
const r = await probeBehavior(b, `http://127.0.0.1:${srv.address().port}/`, 'desktop');
await b.close(); srv.close();
const scroll = Object.entries(r.scroll || {}).filter(([k]) => k.startsWith('section:'));
assert.ok(scroll.length >= 2, `sections were scrolled (${JSON.stringify(r.scroll)} ${r.error || ''})`);
for (const [k, s] of scroll) assert.ok(s.scrolled < SCROLL_REACT, `${k}: nothing changes as the page scrolls (${s.scrolled})`);
console.log('behavior-popup: ok');
process.exit(0);
