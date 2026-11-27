// Custom code stage two: owner code written for jQuery runs on our own copy of jQuery, and owner code that would build
// again what the copy already shows is frozen (steady.mjs). Usage: node test-owner-jquery.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { ownerScriptKind } from './build.mjs';
import { steady } from './steady.mjs';
import { PROFILES, launch } from './lib.mjs';

const kind = (code) => { const $ = cheerio.load(`<body><script>${code}</script></body>`); return ownerScriptKind($, $('script')[0]); };
assert.equal(kind(`document.querySelector('.a').classList.add('b')`), 'plain');
assert.equal(kind(`$(function(){ $('#b a').on('click', function(){ $('section').slideDown() }) })`), 'jquery');
assert.equal(kind(`jQuery(document).ready(function(){})`), 'jquery');
assert.equal(kind('const s = `${a}`; console.log(s)'), 'plain');
assert.equal(kind(`$.getJSON('/api', function(){})`), null, 'jQuery network calls stay out');
assert.equal(kind(`$('.x').load('/other-page .y')`), null);
assert.equal(kind(`$(function(){ Y.use('node') })`), null, 'Squarespace scripts are not in copies');
assert.equal(kind(`Squarespace.afterBodyLoad(Y);`), null);
assert.equal(kind(`$('#b').click(function(){ window.location.href = '/shop'; })`), null, 'sending the visitor elsewhere stays out');
assert.equal(kind(`$('.r').click(function(){ window.location=$(this).attr('href'); return false; })`), null);
assert.equal(kind(`if (location.hash === '#x') { document.body.classList.add('x') }`), 'plain');
assert.equal(kind(`var _0x270b=['a','b']; (function(_0x1d2e){})(_0x270b)`), null, 'scrambled paid-plugin code is not shipped');

// A stage as the copy step leaves it: Samuel Sparrow-style code that adds links once (already in the copy), and
// Xanadu-style code that opens a section on a click. The copy shows a stand-in phone number; the code holds the real one.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pvjq-'));
fs.mkdirSync(path.join(stage, 'a'));
fs.copyFileSync('vendor/jquery-3.7.1.min.js', path.join(stage, 'a', 'jq.js'));
const wrap = (i, code) => `<script data-pv-owner="${i}" data-pv-lib="jquery">document.addEventListener('DOMContentLoaded',function(){{const Date=window.__pvDate||window.Date,Math=window.__pvMath||window.Math;try{${code}\n}catch(e){}}});</script>`;
const page = `<!doctype html><html><head><script id="preserve-lib-jquery" defer src="a/jq.js"></script></head><body>
<div class="menu"><div class="mobile-custom-info"><p><a href="tel:+15555550100">(555) 555-0100</a></p></div><div class="actions"></div></div>
<a id="btn" href="#">Open</a><section id="s1" style="display:none"><p>Hidden part</p></section>
${wrap(0, `$('<div class="mobile-custom-info"><p><a href="tel:">+44(0)7707326000</a></p></div>').insertBefore('.actions');`)}
${wrap(1, `$('#btn').on('click', function(e){ e.preventDefault(); $('#s1').show(); });`)}
<div class="card"><div class="wrap"><div class="hint">swipe</div></div></div><div class="card"><div class="wrap"><div class="hint">swipe</div></div></div>
<a id="next" href="#">Next</a><div id="track" data-at="0"></div>
<script data-pv-owner="2">{const Date=window.__pvDate||window.Date,Math=window.__pvMath||window.Math;try{
document.querySelectorAll('.card .wrap').forEach(function(w){ var h=document.createElement('div'); h.className='hint'; h.textContent='swipe'; w.appendChild(h); });
document.getElementById('next').addEventListener('click', function(e){ e.preventDefault(); var t=document.getElementById('track'); t.setAttribute('data-at', String(+t.getAttribute('data-at')+1)); });
}catch(e){}}</script>
</body></html>`;
for (const l of ['desktop', 'mobile']) fs.writeFileSync(path.join(stage, `${l}.html`), page);
const rep = await steady(stage);
const out = fs.readFileSync(path.join(stage, 'desktop.html'), 'utf8');
assert.ok(!/data-pv-owner="0"/.test(out), 'code that would write the real phone number back in is frozen');
assert.ok(/data-pv-owner="1"/.test(out), 'code that waits for a click keeps running');
assert.ok(/preserve-lib-jquery/.test(out), 'jQuery stays while code uses it');
assert.equal(rep.frozen.filter((f) => f.why).length, 2, 'frozen once per layout');
// Breathpod-style code that adds a hint to each card and also drives a carousel: started from the page as it first
// arrived (the hints it built at capture are taken out), so it builds them once and the carousel keeps working.
assert.ok(/data-pv-owner="2"/.test(out), 'code that builds and drives is kept');
assert.equal(rep.restarted?.length, 2, 'restarted once per layout');

// The kept click code works in a sealed page, on our jQuery.
const browser = await launch();
const http = await import('node:http');
const { policyHeaders } = await import('./policy.mjs');
const srv = http.createServer((q, r) => { const p = path.join(stage, q.url.split('?')[0]); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); } const ext = p.split('.').pop(); r.writeHead(200, { 'content-type': ext === 'html' ? 'text/html' : 'application/javascript', ...policyHeaders(ext) }); fs.createReadStream(p).pipe(r); }).listen(0);
await new Promise((ok) => srv.once('listening', ok));
const pg = await (await browser.newContext({ ...PROFILES.desktop.context })).newPage();
await pg.goto(`http://127.0.0.1:${srv.address().port}/desktop.html`, { waitUntil: 'load' });
assert.equal(await pg.locator('.mobile-custom-info').count(), 1, 'links shown once');
assert.equal(await pg.isVisible('#s1'), false);
await pg.click('#btn');
assert.equal(await pg.isVisible('#s1'), true, 'click opens the section');
assert.equal(await pg.locator('.hint').count(), 2, 'one hint per card');
await pg.click('#next');
assert.equal(await pg.getAttribute('#track', 'data-at'), '1', 'the carousel code still runs');
await browser.close(); srv.close();
console.log('owner-jquery: ok');
