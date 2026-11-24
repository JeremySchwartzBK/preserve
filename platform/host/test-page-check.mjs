// The quick address check on "Create Preserve" (src/page-check.js). Run: node test-page-check.mjs
import { pageProblem, pageCheck } from './src/page-check.js';

let fails = 0;
const ok = (name, cond) => { if (!cond) fails++; console.log(cond ? 'PASS' : 'FAIL', name); };
const SQS = '<!-- This is Squarespace. --><html><main>Hello</main></html>';
const LOCK = '<html><div class="squarespace-locked">Enter password</div></html>';

ok('a Squarespace page is fine', pageProblem(200, SQS, 'https://www.clientsite.com/') === null);
ok('another platform is named', pageProblem(200, '<html><main>Wix</main></html>', 'https://www.clientsite.com/') === 'not-squarespace');
ok('a missing page is unreachable', pageProblem(404, SQS, 'https://www.clientsite.com/x') === 'page-unreachable');
ok('a lock screen is named before its 401', pageProblem(401, LOCK, 'https://www.clientsite.com/') === 'password-protected');
ok('a locked page with ?password= is let through', pageProblem(401, LOCK, 'https://www.clientsite.com/?password=abc') === null);

const req = (url, { token = 'good', origin = 'https://app.preserve.studio' } = {}) => new Request(`https://host/page-check?url=${encodeURIComponent(url)}`, { headers: { origin, authorization: `Bearer ${token}` } });
const signedIn = async (t) => t === 'good';
const page = (html, status = 200) => async () => new Response(html, { status });
{
  const r = await pageCheck(req('https://www.clientsite.com/'), { signedIn, fetch: page('<html>Shopify</html>') });
  const j = await r.json();
  ok('says what is wrong, in words, with CORS for the app', j.problem === 'not-squarespace' && /Squarespace/.test(j.message) && r.headers.get('access-control-allow-origin') === 'https://app.preserve.studio');
}
{
  const r = await pageCheck(req('https://www.clientsite.com/', { token: 'bad' }), { signedIn, fetch: page(SQS) });
  ok('refuses without a sign-in', r.status === 401);
}
{
  const r = await pageCheck(req('http://localhost/'), { signedIn, fetch: page(SQS) });
  ok('refuses local addresses', r.status === 400);
}
{
  const r = await pageCheck(req('https://www.clientsite.com/'), { signedIn, fetch: async () => { throw new Error('timeout'); } });
  ok('says nothing when it cannot tell', (await r.json()).problem === null);
}
{
  const r = await pageCheck(req('https://www.clientsite.com/'), { signedIn, fetch: page(SQS) });
  ok('fine page: no problem', (await r.json()).problem === null);
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
