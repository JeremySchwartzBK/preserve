// A section background a plugin pins behind the page and fades in as its section comes up (Naughty Nancy, 2026-11-28)
// is replayed in step with the scroll (capture.mjs scrollLinked), not popped on at one point like a "back to top"
// button (scrollShown), which still is.
// Usage: node test-capture-backdrop.mjs
import assert from 'node:assert/strict';
import { launch } from './lib.mjs';
import { scrollShown, scrollLinked } from './capture.mjs';

const html = `<!doctype html><style>body{margin:0}section{height:1400px;position:relative}
.bg{position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;pointer-events:none}
#up{position:fixed;right:20px;bottom:20px;width:40px;height:40px;background:#000;display:none}</style>
<section id="s0"><div class="bg" style="background:#fc8;opacity:1"></div></section>
<section id="s1"><div class="bg" id="b1" style="background:#8cf;opacity:0"></div></section>
<section id="s2"><div class="bg" id="b2" style="background:#c8f;opacity:0"></div></section>
<section id="s3"></section>
<a id="up" href="#"></a>
<script>function f(){[1,2].forEach(function(i){var s=document.getElementById('s'+i),t=s.getBoundingClientRect().top;
var k=Math.min(1,Math.max(0,(200-t)/200));document.getElementById('b'+i).style.opacity=String(k)});
document.getElementById('up').style.display=scrollY>600?'block':'none'}
addEventListener('scroll',f);f()</script>`;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.setContent(html);
await scrollShown(page);
await scrollLinked(page);
const got = await page.evaluate(() => ({
  up: document.getElementById('up').getAttribute('data-pv-scrollshow'),
  b1: [document.getElementById('b1').getAttribute('data-pv-scrollshow'), document.getElementById('b1').getAttribute('data-pv-scroll')],
  b2: [document.getElementById('b2').getAttribute('data-pv-scrollshow'), document.getElementById('b2').getAttribute('data-pv-scroll')],
}));
await browser.close();
assert.ok(got.up, 'the back-to-top button still shows once you scroll down');
for (const k of ['b1', 'b2']) {
  assert.equal(got[k][0], null, `${k}: a screen-filling backdrop is not treated as a button`);
  assert.ok(got[k][1], `${k}: its fade is replayed with the scroll`);
  const pts = JSON.parse(got[k][1]);
  assert.ok(pts.some((p) => p[2] < 0.05) && pts.some((p) => p[2] > 0.95), `${k}: it goes from hidden to shown (${got[k][1]})`);
}
console.log('capture-backdrop: ok');
