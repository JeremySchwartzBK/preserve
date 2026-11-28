// A page that scrolls itself during capture (a signup box in the footer taking the cursor, as Xanadu's did) is put
// back at the top before it is saved, so the pictures of the live page show what a visitor first sees (capture.mjs).
// Usage: node test-capture-scroll.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { capture } from './capture.mjs';

// A red first screen, a long grey middle and a blue footer whose email box keeps taking the cursor until it loses it.
const page = `<!doctype html><title>Home</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}.top{height:1200px;background:#d22}.mid{height:4000px;background:#888}.foot{height:1200px;background:#22d}</style>
<div class="top"></div><div class="mid"></div><div class="foot"><input type="email" id="e"></div>
<script>var e=document.getElementById('e'),done=false;e.addEventListener('blur',function(){done=true});
setInterval(function(){if(!done&&document.activeElement!==e)e.focus()},1500)</script>`;
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page); }).listen(0);
await new Promise((o) => srv.once('listening', o));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pvscroll-'));
await capture(`http://127.0.0.1:${srv.address().port}/`, out);
srv.close();
for (const l of ['desktop', 'mobile']) {
  const { data, info: m } = await sharp(path.join(out, `ref-${l}.png`)).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(m.height / 2) * m.width + Math.floor(m.width / 2)) * m.channels;
  assert.ok(data[i] > 180 && data[i + 2] < 80, `${l}: the reference picture shows the top of the page (got rgb ${data[i]},${data[i + 1]},${data[i + 2]})`);
}
console.log('capture-scroll: ok');
process.exit(0);
