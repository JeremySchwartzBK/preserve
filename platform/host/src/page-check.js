// The quick address check on "Create Preserve" (Jeremy, 2026-11-24: tell the person at once when an address won't work,
// instead of after the copy starts). The same test as the copy's first step (harness/make-copy.mjs checkUrl): the page
// answers, isn't behind a password, and is on Squarespace. When it can't tell in time it says nothing, and the copy's own
// first step still checks.

// Same patterns as harness/make-copy.mjs checkUrl; keep the two in step.
export function pageProblem(status, html, url) {
  const squarespace = /<!-- This is Squarespace\. -->|static1\.squarespace\.com|assets\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/i.test(html);
  const passwordPage = /sqs-slide-container|squarespace-locked|lock-screen|password-page/i.test(html) && !/<main|<article/i.test(html);
  // An address with ?password= is opened with the password during the copy; this check can't, so it lets it through.
  if (passwordPage) return /[?&]password=/.test(url) ? null : 'password-protected';
  if (status >= 400) return 'page-unreachable';
  if (!squarespace) return 'not-squarespace';
  return null;
}

// What the person reads (the same words as platform/runner.mjs FAILED).
export const PROBLEM_TEXT = {
  'not-squarespace': 'This page isn’t on Squarespace. For now we can only preserve Squarespace sites.',
  'page-unreachable': 'We couldn’t open this page. Check the address and that the site is public.',
  'password-protected': 'This page is password protected, so we couldn’t preserve it.',
};

const ORIGINS = ['https://app.preserve.studio', 'https://preserve-app.pages.dev', 'https://test.preserve-app.pages.dev'];
const MAX_BYTES = 6e6;
// Same address rules as request_copy (schema-actions.sql): a public web address, no local or test names.
const OK_URL = /^https?:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]([/?#:]|$)/i;
const LOCAL = /^https?:\/\/([^/?#]*\.)?(localhost|local|internal|lan|home|corp|test|invalid|example)([/?#:]|$)/i;

// GET /page-check?url=<address> from the app, signed in (the person's sign-in token, checked with Supabase), so it isn't
// a way for anyone to have us fetch pages. Answers { problem: code or null, message }.
export async function pageCheck(req, { signedIn, fetch: f = fetch, timeoutMs = 8000 }) {
  const origin = req.headers.get('origin') || '';
  const cors = ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization', vary: 'origin' } : {};
  const answer = (body, status = 200) => Response.json(body, { status, headers: { ...cors, 'cache-control': 'no-store' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url).searchParams.get('url') || '';
  if (url.length > 2000 || !OK_URL.test(url) || LOCAL.test(url)) return answer({ error: 'bad-url' }, 400);
  if (!(await signedIn((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')).catch(() => false))) return answer({ error: 'not-signed-in' }, 401);
  try {
    const r = await f(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', accept: 'text/html' } });
    const html = (await r.text()).slice(0, MAX_BYTES);
    const problem = pageProblem(r.status, html, url);
    return answer({ problem, message: problem ? PROBLEM_TEXT[problem] : null });
  } catch { return answer({ problem: null }); }  // slow or a network hiccup: let the copy's own check decide
}

// Is this a live sign-in token for our Supabase project? Asks Supabase (its user endpoint), with the public key.
export const supabaseSignedIn = (env, f = fetch) => async (token) => {
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_KEY) return false;
  const r = await f(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_KEY, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  return r.ok;
};
