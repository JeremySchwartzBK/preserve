// The quality check's two comparison rules from 2026-11-23: a pinned popup that asks for an email address is marked
// as a promotion (dropped from the copy, hidden on the live page), a signup form in the page is not; and with
// useOriginalFontsInCopy set, copy pages the check opens show the site's original fonts.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { launch, markPromos, useOriginalFontsInCopy } from './lib.mjs';

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
  // A copy page (served from 127.0.0.1) whose own rule for the font points at a file that isn't there, like a
  // substitute we want replaced: with the original fonts set, the check's browser shows the original.
  const font = fs.readdirSync(path.join(import.meta.dirname, '..', 'platform', 'fonts')).find((f) => f.endsWith('.woff2'));
  const b64 = fs.readFileSync(path.join(import.meta.dirname, '..', 'platform', 'fonts', font)).toString('base64');
  const page = `<!doctype html><body><style>@font-face{font-family:probe;src:url(/missing.woff2) format("woff2")}</style><p style="font-family:probe">abc</p></body>`;
  const srv = await new Promise((r) => { const s = http.createServer((q, res) => { res.writeHead(q.url === '/' ? 200 : 404, { 'content-type': 'text/html' }); res.end(q.url === '/' ? page : ''); }).listen(0, '127.0.0.1', () => r(s)); });
  for (const [css, want] of [[`@font-face{font-family:probe;src:url(data:font/woff2;base64,${b64})}`, 'loaded'], [null, 'error']]) {
    useOriginalFontsInCopy(css);
    const b = await launch();
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${srv.address().port}/`);
    await p.waitForTimeout(300);
    const st = await p.evaluate(async () => { await document.fonts.load('16px probe').catch(() => {}); await document.fonts.ready; return [...document.fonts].filter((f) => f.family === 'probe').map((f) => f.status); });
    ok(want === 'loaded' ? st.includes('loaded') : !st.includes('loaded'), `${css ? 'with' : 'without'} the original fonts set, the copy page's font ${want === 'loaded' ? 'shows the original' : 'is left as it is'} (${st})`);
    await b.close();
  }
  useOriginalFontsInCopy(null);
  srv.close();
}
process.exit(failed ? 1 : 0);
