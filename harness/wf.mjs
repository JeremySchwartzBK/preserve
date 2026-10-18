import { launch, PROFILES, applyThrottle } from './lib.mjs';
const [url, prof] = process.argv.slice(2);
const b = await launch(); const ctx = await b.newContext({ ...PROFILES[prof].context }); const p = await ctx.newPage();
await applyThrottle(p, PROFILES[prof]);
const t0 = Date.now(); const rows = [];
p.on('requestfinished', async (r) => { const s = await r.sizes().catch(() => ({})); const tm = r.timing(); rows.push([Math.round(tm.startTime - t0 + tm.responseEnd), Math.round((s.responseBodySize || 0) / 1024), r.url().slice(-60)]); });
await p.goto(url, { waitUntil: 'load' });
const lcp = await p.evaluate(() => new Promise((res) => new PerformanceObserver((l) => { const e = l.getEntries().at(-1); res({ t: Math.round(e.startTime), el: e.element?.tagName, url: e.url?.slice(-60), size: e.size }); }).observe({ type: 'largest-contentful-paint', buffered: true })));
rows.sort((a, b) => a[0] - b[0]).forEach((r) => console.log(r.join('\t'))); console.log('LCP', lcp); await b.close();
