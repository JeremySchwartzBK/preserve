// Loads each hosted copy, scrolls through and clicks around, and lists every request that left the copy's own host.
import { PROFILES, launch, sleep } from './lib.mjs';
const [base, ...sites] = process.argv.slice(2);
const host = new URL(base).host;
const b = await launch();
for (const s of sites) for (const prof of ['desktop', 'mobile']) {
  const ctx = await b.newContext({ ...PROFILES[prof].context }); const p = await ctx.newPage(); const out = new Set(); let n = 0;
  p.on('request', (r) => { n++; const u = new URL(r.url()); if (/^https?:/.test(u.protocol) && u.host !== host) out.add(u.host + u.pathname.slice(0, 50)); });
  for (const path of [`/${s}/`, `/${s}/embed-demo`]) { await p.goto(base + path, { waitUntil: 'load' }); for (let i = 0; i < 25; i++) { await p.mouse.wheel(0, 700); await sleep(120); } await sleep(1500); }
  console.log(s, prof, 'requests', n, 'outside', [...out]); await ctx.close();
}
await b.close();
