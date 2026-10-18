// End-to-end test of the serving Worker on Miniflare (local R2 + KV), with a real browser.
// Usage: node test-local.mjs <copyFolder> [<harnessDir>]
import path from 'node:path';
import { Miniflare } from 'miniflare';
import { bindingStore, uploadVersion, setCopy, setNames } from './copy-store.mjs';

const [dir, harness = new URL('../../harness', import.meta.url).pathname] = process.argv.slice(2);
const { launch, PROFILES, sleep } = await import(path.join(harness, 'lib.mjs'));
const mf = new Miniflare({ modules: true, scriptPath: new URL('./src/index.js', import.meta.url).pathname, r2Buckets: ['COPIES'], kvNamespaces: ['LOOKUP'], port: 8787, compatibilityDate: '2025-09-01' });
const base = (await mf.ready).origin;
const store = bindingStore({ bucket: await mf.getR2Bucket('COPIES'), kv: await mf.getKVNamespace('LOOKUP') });

const id = 'k7f2qx9m';
const up = await uploadVersion(store, { dir, id, version: 1 });
await setCopy(store, { id, version: 1, studio: 'acme', name: 'minaab' });
await setNames(store, { studio: 'acme', id, current: 'minaab' });
console.log('uploaded', up);

const results = [];
const ok = (name, cond, detail = '') => { results.push(cond); console.log(cond ? 'PASS' : 'FAIL', name, detail); };
const get = (p, h = {}) => fetch(base + p, { headers: h, redirect: 'manual' });

let r = await get(`/c/${id}`); ok('id without slash redirects', r.status === 301 && r.headers.get('location').endsWith(`/c/${id}/`));
r = await get(`/c/${id}/`, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
const phoneHtml = await r.text(); ok('phone gets mobile layout', r.status === 200 && phoneHtml.includes("var m=true"), r.headers.get('vary'));
r = await get(`/c/${id}/`, { 'user-agent': 'Mozilla/5.0 (Macintosh)' }); ok('desktop gets desktop layout', (await r.text()).includes('var m=false'));
ok('noindex header', r.headers.get('x-robots-tag')?.includes('noindex'));
r = await get(`/acme/minaab/desktop`); ok('friendly name serves copy', r.status === 200);
r = await get(`/nope/minaab/`); ok('unknown name 404', r.status === 404);
r = await get(`/c/${id}/../../etc`); ok('no path tricks', r.status === 404 || r.status === 301);

// Browser: load by id and by friendly name, both layouts; every request must stay on our host and succeed.
const browser = await launch();
for (const [label, p] of [['id', `/c/${id}/`], ['name', `/acme/minaab/`], ['embed desktop', `/c/${id}/desktop`]]) {
  for (const prof of ['desktop', 'mobile']) {
    const ctx = await browser.newContext({ ...PROFILES[prof].context });
    const page = await ctx.newPage();
    const bad = [], outside = new Set(); let n = 0;
    page.on('response', (res) => { n++; if (res.status() >= 400) bad.push(res.status() + ' ' + res.url().slice(base.length, base.length + 80)); });
    page.on('request', (q) => { const u = new URL(q.url()); if (/^http/.test(u.protocol) && u.origin !== base) outside.add(u.host); });
    await page.goto(base + p, { waitUntil: 'load' });
    for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 800); await sleep(100); }
    await sleep(1000);
    const imgs = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getBoundingClientRect().height > 20).length);
    ok(`browser ${label} ${prof}`, !bad.length && !outside.size && imgs === 0, `${n} requests, final ${page.url().slice(base.length)}, errors ${bad.slice(0, 3)}, outside ${[...outside]}, broken images ${imgs}`);
    await ctx.close();
  }
}
await browser.close();

// Rename: old name redirects to new; embeds by id are unaffected.
await setNames(store, { studio: 'acme', id, current: 'minaa-b', old: ['minaab'] });
await setCopy(store, { id, version: 1, studio: 'acme', name: 'minaa-b' });
r = await get(`/acme/minaab/mobile`); ok('old name redirects after rename', r.status === 301 && r.headers.get('location').endsWith('/acme/minaa-b/mobile'));
r = await get(`/c/${id}/desktop`); ok('id still works after rename', r.status === 200);

// New version: upload v2, flip the pointer.
await uploadVersion(store, { dir, id, version: 2 });
await setCopy(store, { id, version: 2, studio: 'acme', name: 'minaa-b' });
r = await get(`/c/${id}/desktop`); ok('serves new version after flip', r.status === 200);

// Pause and delete.
await setCopy(store, { id, version: 2, status: 'paused', studio: 'acme', name: 'minaa-b' });
r = await get(`/c/${id}/`); const t = await r.text(); ok('paused page', r.status === 200 && t.includes('paused'));
r = await get(`/c/${id}/a/x.webp`); ok('paused copy hides files', r.status === 404);
await setCopy(store, { id, version: 2, status: 'review', studio: 'acme', name: 'minaa-b' });
r = await get(`/c/${id}/desktop`); ok('copy in review hidden from visitors', r.status === 200 && (await r.text()).includes('paused'));
r = await get(`/c/${id}/desktop?review=1`); ok('copy in review shown in review frame', r.status === 200 && (await r.text()).includes('preserve-review'));
await setCopy(store, { id, version: 2, status: 'paused', studio: 'acme', name: 'minaa-b' });
await setCopy(store, { id, version: 2, status: 'deleted', studio: 'acme', name: 'minaa-b' });
r = await get(`/acme/minaa-b/`); ok('deleted copy is gone', r.status === 410);

// Video range requests (Safari).
await setCopy(store, { id, version: 2, studio: 'acme', name: 'minaa-b' });
const anyAsset = (await (await mf.getR2Bucket('COPIES')).list({ prefix: `copies/${id}/v2/a/` })).objects[0].key.split('/v2/')[1];
r = await get(`/c/${id}/${anyAsset}`, { range: 'bytes=0-99' }); ok('byte ranges', r.status === 206 && (await r.arrayBuffer()).byteLength === 100, anyAsset);
r = await get('/robots.txt'); ok('robots.txt', (await r.text()).includes('GPTBot'));

await mf.dispose();
console.log(results.filter(Boolean).length, 'of', results.length, 'passed');
process.exit(results.every(Boolean) ? 0 : 1);
