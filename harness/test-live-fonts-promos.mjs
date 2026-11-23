// The quality check's two comparison rules from 2026-11-23: a pinned popup that asks for an email address is marked
// as a promotion (dropped from the copy, hidden on the live page), a signup form in the page is not; and with
// swapLiveFonts set, the live page gets the copy's font file in place of the original one.
import fs from 'node:fs';
import path from 'node:path';
import { launch, markPromos, swapLiveFonts } from './lib.mjs';

let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failed++; };

const html = `<!doctype html><body style="margin:0">
<div class="fd-modal" style="position:fixed;top:10%;left:10%;width:50%;height:50%;background:#fff;display:none"><form><input type="email"></form></div>
<div class="animation-not-started" style="position:fixed;bottom:0;right:0;width:300px;height:200px"><button aria-label="Close dialog">x</button><form><input type="email"></form></div>
<footer><form class="newsletter-form"><input type="email" placeholder="Email address"></form></footer>
<div id="menu" class="header-menu" style="position:fixed;inset:0;background:#000"><a href="#">About</a></div>
<p id="t" style="font-family:probe">abc</p></body>`;

{
  const b = await launch();
  const p = await b.newPage();
  await p.setContent(html);
  await p.evaluate(() => { const h = document.createElement('div'); h.className = 'shadow-host'; document.body.appendChild(h); h.attachShadow({ mode: 'open' }).innerHTML = '<div style="position:fixed;inset:20%"><button>×</button><input placeholder="Your Email Address"></div>'; });
  const n = await p.evaluate(markPromos);
  const marked = await p.evaluate(() => [...document.querySelectorAll('[data-preserve-promo]')].map((e) => e.className || e.tagName));
  ok(marked.some((c) => /fd-modal/.test(c)), 'pinned email popup is marked as a promotion, even while still closed');
  ok(marked.some((c) => /animation-not-started/.test(c)), 'pinned email box with a close button is marked (The Dial)');
  ok(marked.some((c) => /shadow-host/.test(c)), 'email popup drawn in a shadow root marks its host');
  ok(!marked.some((c) => /newsletter-form|FOOTER/.test(c)), 'signup form in the page is left alone');
  ok(!marked.some((c) => /header-menu/.test(c)), 'pinned layer without an email box is left alone');
  ok(n === marked.length, 'count matches');
  await b.close();
}

{
  // Any font file will do: the first of the platform's own.
  const font = fs.readdirSync(path.join(import.meta.dirname, '..', 'platform', 'fonts')).find((f) => f.endsWith('.woff2'));
  const file = path.join(import.meta.dirname, '..', 'platform', 'fonts', font);
  const url = 'https://fonts.preserve-test.invalid/orig.woff2';
  const page = `<!doctype html><style>@font-face{font-family:probe;src:url(${url}) format("woff2")}</style><p style="font-family:probe">abc</p>`;
  for (const [swap, want] of [[{ [url]: { path: file, ct: 'font/woff2' } }, 'loaded'], [null, 'error']]) {
    swapLiveFonts(swap);
    const b = await launch();
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.setContent(page);
    const st = await p.evaluate(async () => { await document.fonts.ready; return [...document.fonts].find((f) => f.family === 'probe')?.status; });
    ok(st === want, `${swap ? 'with' : 'without'} the swap the original font address ${want === 'loaded' ? 'loads the copy\'s file' : 'is left alone'} (${st})`);
    await b.close();
  }
  swapLiveFonts(null);
}
process.exit(failed ? 1 : 0);
