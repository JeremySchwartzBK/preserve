// Our own stylesheet's cascade (own-css-engine.js) on two cases that went wrong in the Nov 16 showcase re-run:
// container queries (The Dial's book box took its narrow layout on desktop) and transform-origin wiped out by a later
// transform (Margaret Rajic's turned captions sat on the pictures).
// Usage: node test-own-css-cascade.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { launch } from './lib.mjs';

const ENGINE = fs.readFileSync(new URL('./own-css-engine.js', import.meta.url), 'utf8');
const b = await launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
await page.setContent(`<style>
.wide{container-type:inline-size;width:1300px} .narrow{container-type:inline-size;width:600px} .named{container:card/inline-size;width:800px}
.body{display:flex}
@container (max-width: 900px){.body{display:contents}}
@container (width > 1000px) and (min-width: 50em){.body{color:rgb(1,2,3)}}
@container card (max-width: 900px){.body{order:2}}
.cap{transform-origin:0 0} .cap{transform:rotate(-90deg)}
</style>
<div class=wide><div class=body data-pz=1>a</div></div>
<div class=narrow><div class=body data-pz=2>b</div></div>
<div class=named><div class=wide><div class=body data-pz=3>c</div></div></div>
<div class=body data-pz=4>d</div>
<div class=cap data-pz=5>e</div>`);
await page.addScriptTag({ content: ENGINE });
const cap = await page.evaluate(() => window.__oc.capture());
const get = (pz, prop) => (cap[pz][''] || []).find(([k]) => k === prop)?.[1];
assert.equal(get(1, 'display'), 'flex', 'wide container: the narrow rule must not apply');
assert.ok(/rgb\(1,\s*2,\s*3\)/.test(get(1, 'color') || ''), 'wide container: the wide rule applies');
assert.equal(get(2, 'display'), 'contents', 'narrow container: the narrow rule applies');
assert.equal(get(2, 'color'), undefined);
assert.equal(get(3, 'order'), '2', 'named container: found past the nearer unnamed one');
assert.equal(get(3, 'display'), 'flex', 'unnamed query: nearest container is the wide one');
assert.equal(get(4, 'display'), 'flex', 'no container: size queries do not apply');
assert.ok(/^0(px)? 0(px)?$/.test(get(5, 'transform-origin') || ''), 'transform must not wipe out transform-origin');
await b.close();
console.log('own-css cascade: ok');
