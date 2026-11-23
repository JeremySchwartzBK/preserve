// Adobe Fonts calls (adobe.mjs) against a stand-in for Adobe's API, shaped like its documented answers.
// Run: node platform/test-adobe.mjs
import { adobe, ensureKit, syncFamilies, checkConnection } from './adobe.mjs';

let fails = 0;
const ok = (name, cond) => { if (!cond) fails++; console.log(cond ? 'PASS' : 'FAIL', name); };

function fakeAdobe({ token = 'good', lapsed = false, fontsGone = false } = {}) {
  const kits = new Map(), calls = [];
  const fam = { 'proxima-nova': 'vcsm', 'freight-sans-pro': 'ftnk', 'commuters-sans': 'plan' };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const f = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    if (u.host === 'use.typekit.net') {
      if (u.pathname.endsWith('.css')) return new Response(lapsed ? '' : `@font-face{font-family:"proxima-nova";src:url("https://use.typekit.net/af/abc/000/l?primer=x&fvd=n4&v=3") format("woff2")}`, { status: kits.has(u.pathname.slice(1, -4)) ? 200 : 404 });
      return new Response('', { status: fontsGone ? 403 : 200 });
    }
    if ((init.headers || {})['X-Typekit-Token'] !== token || lapsed) return json(401, { errors: ['Not authorized'] });
    const p = u.pathname.replace('/api/v1/json/', '');
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    let m;
    if (p === 'kits' && method === 'GET') return json(200, { kits: [...kits.values()].map((k) => ({ id: k.id, link: `/api/v1/json/kits/${k.id}` })) });  // ids only, like Adobe's
    if (p === 'kits' && method === 'POST' && !form.domains) return json(400, { errors: ["Missing 'domains' parameter"] });
    if (p === 'kits' && method === 'POST') { const k = { id: 'kit' + (kits.size + 1) + 'ab', name: form.name, families: [] }; kits.set(k.id, k); return json(200, { kit: k }); }
    if ((m = /^kits\/(\w+)$/.exec(p))) return kits.has(m[1]) ? json(200, { kit: kits.get(m[1]) }) : json(404, { errors: ['Not found'] });
    if ((m = /^kits\/(\w+)\/families\/(\w+)$/.exec(p))) { if (form.variations) return json(400, { errors: [`The font family '${form.variations}' is not allowed by your account`] }); if (m[2] === 'plan') return json(400, { errors: [`The font family 'plan' is not allowed by your account`] }); kits.get(m[1]).families.push({ id: m[2], css_names: [`${Object.keys(fam).find((k) => fam[k] === m[2])}-1`] }); return json(200, { family: { id: m[2] } }); }
    if ((m = /^kits\/(\w+)\/publish$/.exec(p))) return json(200, { published: '2026-11-22T00:00:00Z' });
    if ((m = /^families\/([\w-]+)$/.exec(p))) return fam[m[1]] ? json(302, { family: { id: fam[m[1]] } }, { location: `/api/v1/json/families/${fam[m[1]]}` }) : json(404, { errors: ['Not found'] });
    return json(404, { errors: ['Not found'] });
  };
  return { f, kits, calls };
}

{
  const a = fakeAdobe(), api = adobe('good', { fetch: a.f });
  const kit = await ensureKit(api, null);
  ok('makes a "Preserve" kit', a.kits.get(kit)?.name === 'Preserve');
  ok('finds it again instead of making another', (await ensureKit(api, null)) === kit && a.kits.size === 1);
  const r = await syncFamilies(api, kit, ['proxima-nova', 'gopher', 'commuters-sans'], {});
  ok('adds the families Adobe has, with their names in the kit', r.families['proxima-nova']?.id === 'vcsm' && r.families['proxima-nova'].css === 'proxima-nova-1' && r.added === 1);
  ok('records the one Adobe lacks and the one the plan doesn\'t include', r.families.gopher === null && r.families['commuters-sans']?.plan === false && !r.families['commuters-sans'].css && r.notAllowed.join() === 'commuters-sans');
  ok('then published', a.calls.includes(`POST /api/v1/json/kits/${kit}/publish`));
  const before = a.calls.length;
  const again = await syncFamilies(api, kit, ['proxima-nova', 'gopher', 'commuters-sans'], r.families);
  const later = a.calls.slice(before);
  ok('nothing new: no lookups, no publish; only the font outside the plan is tried again', again.added === 0 && !later.some((c) => c.startsWith('GET /api/v1/json/families/') || c.includes('publish')) && later.filter((c) => c.includes('/families/')).join() === `POST /api/v1/json/kits/${kit}/families/plan` && again.families['commuters-sans']?.plan === false);
  ok('daily check: ok', (await checkConnection(api, kit, { fetch: a.f })).state === 'ok');
}
{
  const a = fakeAdobe({ fontsGone: true }), api = adobe('good', { fetch: a.f });
  const kit = await ensureKit(api, null);
  ok('a kit with no fonts yet is fine (Adobe has no stylesheet for it)', (await checkConnection(api, kit, { fetch: a.f })).state === 'ok');
}
{
  const a = fakeAdobe(), api = adobe('good', { fetch: a.f });
  const kit = await ensureKit(api, null); await syncFamilies(api, kit, ['proxima-nova']);
  const wrong = adobe('revoked', { fetch: a.f });
  ok('a refused key shows as key-refused', (await checkConnection(wrong, kit, { fetch: a.f })).state === 'key-refused');
  let threw = null; try { await ensureKit(wrong, kit); } catch (e) { threw = e; }
  ok('a refused key is not mistaken for a missing kit', threw?.refused === true);
}
{
  const a = fakeAdobe({ fontsGone: true }), api = adobe('good', { fetch: a.f });
  const kit = await ensureKit(api, null); await syncFamilies(api, kit, ['proxima-nova']);
  ok('fonts that stop loading show as not-loading', (await checkConnection(api, kit, { fetch: a.f })).state === 'not-loading');
}
{
  const a = fakeAdobe(), api = adobe('good', { fetch: a.f });
  const kit = await ensureKit(api, null);
  const down = async () => { throw new TypeError('fetch failed'); };
  let threw = false; try { await checkConnection(adobe('good', { fetch: down }), kit, { fetch: down }); } catch { threw = true; }
  ok('a network problem on our side throws (the state is kept)', threw);
}
console.log(fails ? `${fails} failed` : 'adobe: all checks pass');
process.exit(fails ? 1 : 0);
