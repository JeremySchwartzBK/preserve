// Who can see a Preserve's desktop still (the Desktop embed's phone picture and the dashboard thumbnail).
// Live: anyone. In review or archived: only with the owner's signed link. Usage: node test-still.mjs
import { Miniflare } from 'miniflare';
import { mintReviewToken } from '../review-token.mjs';

const SECRET = 'test-secret';
const mf = new Miniflare({ modules: true, scriptPath: new URL('./src/index.js', import.meta.url).pathname, r2Buckets: ['COPIES'], kvNamespaces: ['LOOKUP'], bindings: { REVIEW_SECRET: SECRET }, compatibilityDate: '2025-09-01' });
const base = (await mf.ready).origin;
const r2 = await mf.getR2Bucket('COPIES');
const results = [];
const ok = (name, cond, detail = '') => { results.push(cond); console.log(cond ? 'PASS' : 'FAIL', name, detail); };
const get = (p) => fetch(base + p, { redirect: 'manual' });

for (const [id, status] of [['live0001', 'live'], ['revw0001', 'review'], ['arch0001', 'paused']]) {
  await r2.put(`lookup/copy/${id}.json`, JSON.stringify({ v: 2, status }));
  await r2.put(`copies/${id}/v2/desktop-still.webp`, 'webp-bytes');
}
await r2.put('lookup/copy/none0001.json', JSON.stringify({ v: 1, status: 'review' }));
const tok = (id) => mintReviewToken(SECRET, id, 600);

let r = await get('/c/live0001/desktop-still.webp?v=2'); ok('Live still is public', r.status === 200 && r.headers.get('cache-control').startsWith('public'));
r = await get('/c/revw0001/desktop-still.webp?v=2'); ok('review still hidden without link', r.status === 404);
r = await get('/c/revw0001/desktop-still.webp?v=2&review=1'); ok('review still hidden with unsigned link', r.status >= 400 && !r.headers.get('content-type')?.includes('webp'));
r = await get(`/c/revw0001/desktop-still.webp?v=2&review=${tok('revw0001')}`); ok('review still shown with signed link', r.status === 200 && r.headers.get('cache-control').startsWith('private') && (await r.text()) === 'webp-bytes');
r = await get(`/c/revw0001/desktop-still.webp?v=2&review=${tok('live0001')}`); ok('another Preserve\'s link does not work', r.status >= 400 && !r.headers.get('content-type')?.includes('webp'));
r = await get('/c/arch0001/desktop-still.webp?v=2'); ok('archived still hidden without link', r.status === 404);
r = await get(`/c/arch0001/desktop-still.webp?v=2&review=${tok('arch0001')}`); ok('archived still shown to owner', r.status === 200);
r = await get(`/c/arch0001/desktop?review=${tok('arch0001')}`); ok('archived page itself stays paused', (await r.text()).includes('paused'));
r = await get(`/c/none0001/desktop-still.webp?review=${tok('none0001')}`); ok('missing still is 404', r.status === 404);

await mf.dispose();
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
