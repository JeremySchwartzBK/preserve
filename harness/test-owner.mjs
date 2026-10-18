import { startServer } from './server.mjs'; import { serverVariants } from './build.mjs'; import { PROFILES, launch, sleep } from './lib.mjs';
const [dir, prof = 'desktop'] = process.argv.slice(2);
const port = 8750 + Math.floor(Math.random() * 40); const srv = await startServer(dir, port, serverVariants());
const b = await launch(); const ctx = await b.newContext({ ...PROFILES[prof].context }); const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
await p.goto(`http://127.0.0.1:${port}/frozen-opt/${prof}.html`, { waitUntil: 'load' });
const q = (sel, f) => p.evaluate(([sel, f]) => { const e = document.querySelector(sel); return e ? (f === 'text' ? e.textContent.trim() : e.style.transform) : 'none'; }, [sel, f]);
await p.evaluate(() => document.querySelector('.bpst-card')?.scrollIntoView({ block: 'center' })); await sleep(600);
console.log('counter at 0.6s', await q('.bpst-num', 'text')); await sleep(4000); console.log('counter at 4.6s', await q('.bpst-num', 'text'));
await p.evaluate(() => document.querySelector('.bptm2-track')?.scrollIntoView({ block: 'center' }));
const t1 = await q('.bptm2-track'); await sleep(1000); console.log('testimonial row', t1, '->', await q('.bptm2-track'));
for (const [btn, tr] of [['#bpim-next', '#bpim-track'], ['#bpw-next', '#bpw-track']]) {
  const vis = await p.$(btn); if (!vis || !(await vis.isVisible())) { console.log(btn, 'not visible'); continue; }
  await vis.scrollIntoViewIfNeeded(); await vis.click(); await sleep(700); console.log(btn, '->', await q(tr));
}
for (const dot of ['#bp7d-dots .bp7d-dot-nav:nth-child(2)', '#bpsc-dots .bpsc-dot-nav:nth-child(2)', '#bpim-dots .bpim-dot:nth-child(2)']) { const d = await p.$(dot); if (d && await d.isVisible()) { await d.click(); await sleep(600); console.log(dot, '->', await q(dot.split(' ')[0].replace('dots', 'track'))); } }
console.log('errors', errs); await b.close(); srv.server.close(); process.exit(0);
