// Checks the deployed copies: both addresses, both layouts, embedded in a page on another host; every request stays on
// our host and succeeds; first screen paint time (LCP) next to the old Pages copy. Usage: node test-live.mjs <base> <live-copies.json>
import fs from 'node:fs'; import http from 'node:http';
const { launch, PROFILES, sleep, applyThrottle } = await import(new URL('../../harness/lib.mjs', import.meta.url).pathname);
const [base, mapFile] = process.argv.slice(2);
const copies = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
// A portfolio-style page on a different origin, embedding by permanent ID (what a designer pastes).
const portfolio = http.createServer((req, res) => { const id = req.url.slice(1); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;padding:16px"><h1>Project</h1><div style="position:relative;width:100%;aspect-ratio:16/10"><iframe id=f style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe><script>f.src='${base}/c/${id}/'+(f.parentNode.offsetWidth<768?'mobile':'desktop')</script></div>`); }).listen(8131);
const browser = await launch();
let fails = 0;
const lcp = async (page) => page.evaluate(() => new Promise((r) => { let v = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) v = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); setTimeout(() => r(Math.round(v)), 1500); }));
for (const [name, c] of Object.entries(copies)) {
  for (const prof of ['desktop', 'mobile']) {
    for (const [label, url] of [['id', `${base}/c/${c.id}/`], ['name', `${base}/demo/${name}/`], ['embedded', `http://127.0.0.1:8131/${c.id}`], ['old pages', `https://preserve-copies.pages.dev/${name}/`]]) {
      const ctx = await browser.newContext({ ...PROFILES[prof].context });
      const page = await ctx.newPage();
      const bad = [], outside = new Set();
      page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 90)); });
      page.on('request', (q) => { const u = new URL(q.url()); if (/^http/.test(u.protocol) && ![new URL(base).host, '127.0.0.1:8131', 'preserve-copies.pages.dev'].includes(u.host)) outside.add(u.host); });
      // Warm the edge once (first visitor), then time a cold browser.
      await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await ctx.close();
      const ctx2 = await browser.newContext({ ...PROFILES[prof].context }); const p2 = await ctx2.newPage();
      p2.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 90)); });
      p2.on('request', (q) => { const u = new URL(q.url()); if (/^http/.test(u.protocol) && ![new URL(base).host, '127.0.0.1:8131', 'preserve-copies.pages.dev'].includes(u.host)) outside.add(u.host); });
      await applyThrottle(p2, { network: { latency: 85, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 }, cpu: prof === 'mobile' ? 4 : 1 });
      await p2.goto(url, { waitUntil: 'load', timeout: 60000 }).catch((e) => bad.push(String(e.message).split('\n')[0]));
      const target = label === 'embedded' ? p2.frames()[1] || p2 : p2;
      const t = label === 'embedded' ? null : await lcp(p2);
      for (let i = 0; i < 15; i++) { await p2.mouse.wheel(0, 900); await sleep(100); }
      await sleep(800);
      const broken = await target.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getBoundingClientRect().height > 20).length).catch(() => -1);
      const okk = !bad.length && !outside.size && broken === 0;
      if (!okk && label !== 'old pages') fails++;
      console.log(okk ? 'ok  ' : 'FAIL', name.padEnd(13), prof.padEnd(7), label.padEnd(9), t != null ? `LCP ${t} ms` : '', bad.slice(0, 2).join(' '), [...outside].join(','), broken ? `broken ${broken}` : '');
      await ctx2.close();
    }
  }
}
await browser.close(); portfolio.close();
console.log('failures', fails); process.exit(fails ? 1 : 0);
