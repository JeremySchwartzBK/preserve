// A churning gradient section background caught flat (off screen, the drawing stops on whatever it last showed) is
// looked at again with the section on screen, so the copy gets the gradient, not a plain band (capture.mjs
// canvasStills; The Garret Group's top section, 2026-11-28). Usage: node test-capture-gradient.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { capture } from './capture.mjs';

const styles = JSON.stringify({ backgroundMode: 'generative', generative: { type: 'gradient', gradientType: 'linear', distortionIntensity: 34, distortionSpeed: 5, distortionMorphSpeed: 25, distortionDirection: 321, distortionComplexity: 6, distortionSmoothness: 100, distortionSeed: 50 } }).replace(/"/g, '&quot;');
// The drawing shows the gradient only while on screen; off screen it is one flat grey.
const page = `<!doctype html><title>Home</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}.pad{height:3000px;background:#fff}section{position:relative;height:300px}canvas{position:absolute;left:0;top:0;width:100%;height:100%}</style>
<div class="pad"></div><section data-current-styles="${styles}"><div class="section-background"><canvas id="c" width="800" height="300"></canvas></div></section><div class="pad"></div>
<script>var c=document.getElementById('c'),g=c.getContext('2d');function flat(){g.fillStyle='#ccc';g.fillRect(0,0,800,300)}
function grad(){var l=g.createLinearGradient(0,0,0,300);l.addColorStop(0,'#000');l.addColorStop(1,'#eee');g.fillStyle=l;g.fillRect(0,0,800,300)}
flat();new IntersectionObserver(function(es){var on=es[es.length-1].isIntersecting;if(on)grad();else flat()}).observe(c);</script>`;
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page); }).listen(0);
await new Promise((o) => srv.once('listening', o));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pvgrad-'));
await capture(`http://127.0.0.1:${srv.address().port}/`, out);
srv.close();
for (const l of ['desktop', 'mobile']) {
  const html = fs.readFileSync(path.join(out, `rendered-${l}.html`), 'utf8');
  const m = /data-preserve-canvas="([^"]+\.png)"/.exec(html);
  assert.ok(m, `${l}: the gradient's photo is kept`);
  assert.match(html, /data-preserve-liquid=/, `${l}: noted for our churning stand-in`);
  const st = await sharp(path.join(out, 'stills', m[1])).stats();
  assert.ok(st.channels[0].max - st.channels[0].min > 100, `${l}: the photo shows the gradient, not a flat band`);
}
console.log('capture-gradient: ok');
process.exit(0);
