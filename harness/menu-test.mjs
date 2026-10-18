// Phone-menu check on exported copies: tap the burger, open a folder, go back, tap a page link, close.
// Usage: node menu-test.mjs <baseUrl> <shotsDir> [site ...]
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const [base, shots, ...only] = process.argv.slice(2);
const sites = only.length ? only : ['minaab', 'breathpod', 'kosa', 'xanadu', 'designforward'];
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '<-loopback>,localhost,127.0.0.1' } : undefined;
const browser = await chromium.launch({ proxy });
const out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(site, mode, device) { try { await run1(site, mode, device); } catch (e) { out.push({ site, mode, device: device.viewport.width, error: e.message.split('\n')[0] }); } }
async function run1(site, mode, device) {
  const ctx = await browser.newContext({ ...device });
  const page = await ctx.newPage();
  const outside = new Set();
  page.on('request', (r) => { const u = new URL(r.url()); if (!/^(127\.0\.0\.1|localhost|preserve-copies\.pages\.dev)$/.test(u.hostname) && !/^(data|blob):/.test(r.url())) outside.add(u.hostname); });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const url = mode === 'embed' ? `${base}/${site}/embed-demo` : `${base}/${site}/`;
  await page.goto(url, { waitUntil: 'load' }); await sleep(1500);
  let f = page.mainFrame();
  if (mode === 'embed') { f = page.frames().find((x) => x !== page.mainFrame() && /\/(mobile|desktop)/.test(x.url())) || page.frames()[1]; await sleep(800); }
  const r = { site, mode, device: device.viewport.width, layout: f.url().split('/').pop() };
  const burger = f.locator('.header-burger-btn:visible').first();
  if (!(await burger.count())) { r.result = 'no burger on page'; out.push(r); await ctx.close(); return; }
  if (mode === 'embed') await burger.scrollIntoViewIfNeeded();
  await burger.tap(); await sleep(900);
  r.opened = await f.evaluate(() => { const m = document.querySelector('.header-menu'); const cs = getComputedStyle(m); return document.body.classList.contains('header--menu-open') && cs.visibility === 'visible' && +cs.opacity > 0.9; });
  // Is the menu actually on top (a tap at a menu item hits the menu)?
  r.onTop = await f.evaluate(() => { const a = [...document.querySelectorAll('.header-menu-nav-folder[data-folder=root] a')].find((x) => x.getBoundingClientRect().height); if (!a) return 'no items'; const b = a.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!hit && a.contains(hit) || a === hit; });
  await page.screenshot({ path: `${shots}/${site}-${mode}-${device.viewport.width}-open.png` });
  const folder = f.locator('.header-menu-nav-folder[data-folder=root] a[data-folder-id]').first();
  if (await folder.count()) {
    await folder.tap(); await sleep(800);
    r.folder = await f.evaluate(() => { const a = document.querySelector('.header-menu-nav-folder--active:not([data-folder=root])'); if (!a) return false; const b = a.getBoundingClientRect(); return Math.abs(b.left) < 2; });
    await page.screenshot({ path: `${shots}/${site}-${mode}-${device.viewport.width}-folder.png` });
    await f.locator('.header-menu-nav-folder--active:not([data-folder=root]) [data-action=back]').tap(); await sleep(800);
    r.back = await f.evaluate(() => { const a = document.querySelector('.header-menu-nav-folder[data-folder=root]'); return Math.abs(a.getBoundingClientRect().left) < 2 && !document.querySelector('.header-menu-nav-folder--active:not([data-folder=root])'); });
  }
  const link = f.locator('.header-menu-nav-folder[data-folder=root] a[href]:not([data-folder-id])').first();
  const before = f.url();
  if (await link.count()) { await link.tap(); await sleep(700); r.linkToast = await f.evaluate(() => [...document.querySelectorAll('[role=status]')].some((t) => /preview copy/.test(t.textContent) && +getComputedStyle(t).opacity > 0.5)); r.stayed = f.url() === before; }
  await sleep(2800);
  await f.locator('.header-burger-btn:visible').first().tap(); await sleep(900);
  r.closed = await f.evaluate(() => !document.body.classList.contains('header--menu-open') && getComputedStyle(document.querySelector('.header-menu')).visibility === 'hidden');
  r.outside = [...outside]; r.errors = errs;
  out.push(r); await ctx.close();
}
const phone = devices['iPhone 13'], android = devices['Pixel 7'], ipad = devices['iPad Mini'];
for (const s of sites) for (const mode of ['link', 'embed']) { await run(s, mode, phone); }
for (const s of sites) await run(s, 'link', android);
for (const s of sites) await run(s, 'link', ipad);
await browser.close();
console.log(JSON.stringify(out, null, 0).replace(/},{/g, '},\n{'));
fs.writeFileSync(`${shots}/menu-test.json`, JSON.stringify(out, null, 1));
