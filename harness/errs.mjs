import { PROFILES, launch, sleep } from './lib.mjs';
const b = await launch();
for (const s of process.argv.slice(2)) for (const prof of ['desktop', 'mobile']) {
  const ctx = await b.newContext({ ...PROFILES[prof].context }); const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 100)));
  await p.goto(`http://127.0.0.1:8099/${s}/`, { waitUntil: 'load' }); for (let i = 0; i < 15; i++) { await p.mouse.wheel(0, 800); await sleep(100); } await sleep(1500);
  console.log(s, prof, p.url().split('/').slice(3).join('/'), errs); await ctx.close();
}
await b.close();
