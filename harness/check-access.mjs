// Preflight: loads each test site and lists every host the page tried to reach that failed (e.g. blocked by the
// network allowlist). Run this before run-all.mjs. Usage: node check-access.mjs [url ...]
import { launch, sleep } from './lib.mjs';

const urls = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://www.minaab.com/', 'https://www.breathpod.com/', 'https://hello-world-kosa.squarespace.com/',
  'https://www.designforward.live/', 'https://www.xanadu.nyc/',
];
const browser = await launch();
const allBlocked = new Map();
for (const url of urls) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const ok = new Set(), failed = new Set();
  page.on('requestfinished', (r) => ok.add(new URL(r.url()).host));
  page.on('requestfailed', (r) => { try { failed.add(new URL(r.url()).host); } catch {} });
  let status = 'error';
  try { status = (await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }))?.status(); await sleep(2000); } catch (e) { status = String(e.message).split('\n')[0]; }
  const blocked = [...failed].filter((h) => !ok.has(h));
  for (const h of blocked) allBlocked.set(h, [...(allBlocked.get(h) || []), new URL(url).host]);
  console.log(`${url}  status=${status}  reached=${ok.size} hosts  failed=${blocked.join(', ') || 'none'}`);
  await ctx.close();
}
await browser.close();
console.log('\nHosts that failed (add the ones in the "needed" list of README.md to the allowlist):');
for (const [h, sites] of allBlocked) console.log(`  ${h}   (${sites.join(', ')})`);
