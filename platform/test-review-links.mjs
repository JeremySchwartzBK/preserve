// Private review links: the runner's tokens, the database's tokens and the viewer's check agree, and a Preserve in
// review opens only with a good one once the viewer has its secret. Run: node test-review-links.mjs
import worker, { reviewTokenOk } from './worker/src/index.js';
import { mintReviewToken } from './review-token.mjs';

const results = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); console.log(cond ? 'PASS' : 'FAIL', name, detail); };
const S = 'test-secret', ID = 'abcd1234';
// The same fixed example is checked against the database's own signing in test-db.sql.
const FIXED = '2000000000.86861552fd66e66dcb51ea4e4a8dea4ac86c7be192fe65d8104b1670929e29ff';

const now = Date.UTC(2026, 10, 11);
ok('fixed example matches', mintReviewToken(S, ID, 0, 2000000000 * 1000) === FIXED, mintReviewToken(S, ID, 0, 2000000000 * 1000));
ok('fixed example is accepted', await reviewTokenOk(S, ID, FIXED, now));
const t = mintReviewToken(S, ID, 3600, now);
ok('a fresh token is accepted', await reviewTokenOk(S, ID, t, now));
ok('not after it expires', !(await reviewTokenOk(S, ID, t, now + 3601e3)));
ok('not for another Preserve', !(await reviewTokenOk(S, 'zzzz9999', t, now)));
ok('not with another secret', !(await reviewTokenOk('other', ID, t, now)));
ok('not with a later expiry written in', !(await reviewTokenOk(S, ID, t.replace(/^\d+/, (e) => String(+e + 99999)), now)));
for (const bad of ['', '1', 'true', '2000000000.', '2000000000.zz', null]) ok(`"${bad}" is refused`, !(await reviewTokenOk(S, ID, bad, now)));

// The viewer itself, with stand-in storage: one Preserve in review, one live.
const files = {
  'lookup/copy/abcd1234.json': JSON.stringify({ v: 1, status: 'review' }),
  'lookup/copy/live5678.json': JSON.stringify({ v: 1, status: 'live' }),
  'copies/abcd1234/v1/desktop.html': '<html><body>review page</body></html>',
  'copies/live5678/v1/desktop.html': '<html><body>live page</body></html>',
};
const COPIES = { get: async (k) => (k in files ? { text: async () => files[k], json: async () => JSON.parse(files[k]), body: files[k], httpEtag: '"x"' } : null) };
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const get = async (p, env) => { const r = await worker.fetch(new Request('https://view.test' + p), { COPIES, ...env }, { waitUntil() {} }); return { status: r.status, text: await r.text() }; };
const fresh = mintReviewToken(S, ID, 3600), old = mintReviewToken(S, ID, -60);

let r = await get('/c/abcd1234/desktop?review=1', {});
ok('before the secret is set, the plain parameter still works', r.status === 200 && r.text.includes('review page') && r.text.includes('preserve-review'));
r = await get('/c/abcd1234/desktop', { REVIEW_SECRET: S }); ok('no token: hidden', r.text.includes('paused') && !r.text.includes('review page'));
r = await get('/c/abcd1234/desktop?review=1', { REVIEW_SECRET: S }); ok('plain parameter: refused', r.status === 403 && !r.text.includes('review page'));
r = await get('/c/abcd1234/desktop?review', { REVIEW_SECRET: S }); ok('bare parameter: refused', r.status === 403);
r = await get(`/c/abcd1234/desktop?review=${old}`, { REVIEW_SECRET: S }); ok('expired token: refused', r.status === 403 && r.text.includes('expired'));
r = await get(`/c/abcd1234/desktop?review=${mintReviewToken(S, 'live5678', 3600)}`, { REVIEW_SECRET: S }); ok('token for another Preserve: refused', r.status === 403);
r = await get(`/c/abcd1234/desktop?review=${fresh}`, { REVIEW_SECRET: S }); ok('good token: shown with the pin tools', r.status === 200 && r.text.includes('review page') && r.text.includes('preserve-review'));
r = await get('/c/live5678/desktop', { REVIEW_SECRET: S }); ok('live Preserve needs no token', r.status === 200 && r.text.includes('live page'));
r = await get('/c/live5678/desktop?review=1', { REVIEW_SECRET: S }); ok('live Preserve in the app frame (Tour, Credits) needs no token', r.status === 200 && r.text.includes('preserve-review'));

const failed = results.filter((x) => !x).length;
console.log(failed ? `${failed} FAILED` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
