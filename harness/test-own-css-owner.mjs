// Our own stylesheet's check photographs the copy with the owner's code off: code that builds parts when the page opens
// (Samuel Sparrow's phone-menu links) would build them again, and the new parts carry none of our stylesheet's classes,
// so the check held copies over parts no visitor sees (58-site re-run, 2026-11-28). Usage: node test-own-css-owner.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ownCss } from './own-css.mjs';

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'pvoco-'));
fs.mkdirSync(path.join(stage, 'a'));
const page = `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif;background:#fafaf8} .info{padding:20px;letter-spacing:.1em;text-transform:uppercase;color:#222} .info a{color:#222;text-decoration:none}</style></head><body>
<div class="menu"><div class="info"><a href="#">Instagram</a></div><div class="actions">Next shop</div></div>
<script data-pv-owner="0">{const Date=window.__pvDate||window.Date,Math=window.__pvMath||window.Math;try{
var d=document.createElement('div');d.className='info';d.innerHTML='<a href="#">Instagram</a>';document.querySelector('.actions').before(d);
}catch(e){}}</script>
</body></html>`;
for (const l of ['desktop', 'mobile']) fs.writeFileSync(path.join(stage, `${l}.html`), page);
const r = await ownCss(stage);
for (const [l, x] of Object.entries(r.layouts)) {
  assert.ok(!x.error, `${l}: ${x.error}`);
  assert.equal(x.diffPct, 0, `${l}: the two stylesheets look the same (${x.diffPct}%)`);
}
assert.ok(/data-pv-owner="0"/.test(fs.readFileSync(path.join(stage, 'desktop.html'), 'utf8')), 'the owner code itself stays in the copy');
console.log('own-css owner code: ok');
