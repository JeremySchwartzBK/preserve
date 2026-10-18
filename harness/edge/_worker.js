// Runs only on each copy's root URL (see _routes.json). Picks the phone or desktop layout from the request headers and
// serves it directly, so a shared link costs one round trip. The page itself switches if its real width disagrees.
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const site = u.pathname.split('/')[1];
    if (!site || !/^[a-z0-9-]+$/.test(site)) return env.ASSETS.fetch(req);
    if (!u.pathname.endsWith('/')) return Response.redirect(`${u.origin}/${site}/${u.search}`, 301);
    const ua = req.headers.get('user-agent') || '';
    const mobile = req.headers.get('sec-ch-ua-mobile') === '?1' || /iPhone|iPod|Android.*Mobile|Mobile.*Firefox|Windows Phone|Mobi/i.test(ua);
    const r = await env.ASSETS.fetch(new URL(`/${site}/${mobile ? 'mobile' : 'desktop'}`, u.origin));
    const h = new Headers(r.headers);
    h.set('vary', 'User-Agent, Sec-CH-UA-Mobile');
    h.set('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
    return new Response(r.body, { status: r.status, headers: h });
  },
};
