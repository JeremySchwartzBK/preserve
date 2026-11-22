// The quick Adobe Fonts check right after "Create Preserve" (Jeremy, 2026-11-22: ask to connect Adobe Fonts as early as
// possible, before any lookalike choice). It reads only the submitted page's own HTML, which says whether the page
// loads Adobe fonts: Squarespace's font menu loads them through a use.typekit.net/ik/... script, and a site with its
// own Adobe web project links use.typekit.net/<project>.css or .js. The full capture still finds every font; the
// Fonts step at first review stays the fallback for anything this misses.

// True when the page's HTML loads Adobe fonts. A "preconnect" to Adobe alone doesn't count: Squarespace adds it to
// every page, and it loads no fonts.
export function pageUsesAdobe(html) {
  if (/use\.typekit\.net\/(ik\/[\w-]+\.js|[a-z0-9]{4,20}\.(css|js))/i.test(html)) return true;
  return /"typekitId"\s*:\s*"[a-z0-9]{4,20}"/i.test(html);
}

const ID = /^[a-z0-9]{8}$/;
// Where the app runs. Only these pages may ask.
const ORIGINS = ['https://app.preserve.studio', 'https://preserve-app.pages.dev', 'https://test.preserve-app.pages.dev'];
const MAX_BYTES = 6e6;

// GET /adobe-check?copy=<id> from the app. It answers only for a Preserve made in the last 15 minutes and reads the
// address from the database, so it can't be used to fetch other pages. The answer is only yes or no.
export async function adobeCheck(req, { lookup, fetch: f = fetch, timeoutMs = 6000 }) {
  const origin = req.headers.get('origin') || '';
  const cors = ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
  const answer = (body, status = 200) => Response.json(body, { status, headers: { ...cors, 'cache-control': 'no-store' } });
  const id = new URL(req.url).searchParams.get('copy') || '';
  if (!ID.test(id)) return answer({ error: 'bad-copy' }, 400);
  const url = await lookup(id);
  if (!url || !/^https?:\/\//i.test(url)) return answer({ error: 'not-found' }, 404);
  try {
    const r = await f(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', accept: 'text/html' } });
    if (!r.ok) return answer({ adobe: null });
    const html = (await r.text()).slice(0, MAX_BYTES);
    return answer({ adobe: pageUsesAdobe(html) });
  } catch { return answer({ adobe: null }); }  // slow or unreachable: the Fonts step at first review asks instead
}
