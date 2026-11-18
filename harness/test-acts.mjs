// Clicks and hovers plugins drive (interact.mjs + build.mjs ACT_SCRIPT): a made-up site whose "plugin" (served from
// another address) opens a menu on hover, toggles a panel on click and adds a tooltip on click. The recorder finds them
// from the listeners, keeps what shows; a page with the plugin's script gone and our stand-in does the same things.
// Usage: node test-acts.mjs   (needs Playwright's Chromium)
import assert from 'node:assert/strict';
import { launch, sleep } from './lib.mjs';
import { LISTEN_INIT, recordInteractions } from './interact.mjs';
import { ACT_SCRIPT } from './build.mjs';

const SITE = `<!doctype html><html><head><style>
body{margin:0;font:16px sans-serif} nav{height:60px;background:#eee} .menu{display:none;height:200px;background:#c33}
.menu.open{display:block} .panel{height:0;overflow:hidden;background:#33c;transition:none} .panel.is-open{height:240px}
.tip{background:#3c3;height:80px} .quiet{height:900px}
</style></head><body>
<nav><a id="shop" href="/shop">Shop</a></nav><div class="menu" id="menu">Mega menu</div>
<button id="toggle" type="button">More</button><div class="panel" id="panel">Panel</div>
<button id="tipper" type="button">Tip</button><div id="tipbox"></div>
<button id="dead" type="button">Does nothing</button>
<div class="quiet"></div>
<script src="https://plugin.test/p.js"></script></body></html>`;
const PLUGIN = `
const shop = document.getElementById('shop'), menu = document.getElementById('menu');
shop.addEventListener('mouseenter', () => menu.classList.add('open'));
shop.addEventListener('mouseleave', () => setTimeout(() => { if (!menu.matches(':hover')) menu.classList.remove('open'); }, 50));
menu.addEventListener('mouseleave', () => menu.classList.remove('open'));
document.getElementById('toggle').addEventListener('click', () => document.getElementById('panel').classList.toggle('is-open'));
document.getElementById('tipper').addEventListener('click', () => { const b = document.getElementById('tipbox'); if (b.firstChild) b.firstChild.remove(); else { const t = document.createElement('div'); t.className = 'tip'; t.textContent = 'Hello'; b.appendChild(t); } });
document.getElementById('dead').addEventListener('click', () => {});
`;

const browser = await launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.route('https://site.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SITE }));
  await ctx.route('https://plugin.test/p.js', (r) => r.fulfill({ contentType: 'text/javascript', body: PLUGIN }));
  await ctx.addInitScript(LISTEN_INIT);
  const page = await ctx.newPage();
  await page.goto('https://site.test/');
  const rec = await recordInteractions(page, 'desktop');
  assert.equal(page.url(), 'https://site.test/', 'the recorder never leaves the page');
  const kinds = rec.states.map((s) => s.k).sort().join('');
  assert.equal(rec.kept, 3, JSON.stringify(rec));
  assert.equal(kinds, 'cch', JSON.stringify(rec));
  assert.ok(rec.states.find((s) => s.k === 'h').u.leave, 'the menu closes when the pointer leaves');
  assert.ok(rec.states.filter((s) => s.k === 'c').every((s) => s.u.again), 'clicking again closes');
  assert.equal(rec.states.reduce((n, s) => n + s.added, 0), 1, 'the tooltip the plugin added is kept');
  // The copy: the page as recorded, the plugin's script gone, our stand-in instead.
  let html = await page.evaluate(() => '<!doctype html>' + document.documentElement.outerHTML);
  html = html.replace(/<script src="https:\/\/plugin\.test\/p\.js"><\/script>/, '').replace('</body>', ACT_SCRIPT + '</body>');
  assert.ok(!html.includes('plugin.test'));
  const copy = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  await copy.setContent(html);
  const h = (sel) => copy.evaluate((s) => document.querySelector(s).getBoundingClientRect().height, sel);
  assert.equal(await h('#menu'), 0, 'menu closed at rest');
  assert.equal(await h('#panel'), 0, 'panel closed at rest');
  assert.equal(await copy.evaluate(() => document.querySelectorAll('.tip').length), 1, 'tooltip in the page, hidden');
  assert.equal(await h('.tip'), 0);
  // Hover opens the menu, leaving closes it.
  const shop = await copy.locator('#shop').boundingBox();
  await copy.mouse.move(shop.x + 5, shop.y + 5); await sleep(100);
  assert.equal(await h('#menu'), 200, 'hover opens the menu');
  await copy.mouse.move(600, 700); await sleep(300);
  assert.equal(await h('#menu'), 0, 'leaving closes it');
  // Click toggles the panel; the link-is-disabled note doesn't show for it.
  await copy.click('#toggle'); await sleep(50);
  assert.equal(await h('#panel'), 240, 'click opens the panel');
  await copy.click('#toggle'); await sleep(50);
  assert.equal(await h('#panel'), 0, 'second click closes it');
  await copy.click('#tipper'); await sleep(50);
  assert.equal(await h('.tip'), 80, 'click shows the tooltip');
  await copy.click('#tipper'); await sleep(50);
  assert.equal(await h('.tip'), 0, 'and hides it again');
  console.log('acts: ok', JSON.stringify(rec.skipped));
} finally { await browser.close(); }
