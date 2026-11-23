// The quick Adobe Fonts check at submit (src/adobe-sniff.js). Run: node test-adobe-sniff.mjs
import { pageUsesAdobe, adobeCheck } from './src/adobe-sniff.js';

let fails = 0;
const ok = (name, cond) => { if (!cond) fails++; console.log(cond ? 'PASS' : 'FAIL', name); };
const PRE = '<link rel="preconnect" href="https://use.typekit.net" crossorigin><link rel="preconnect" href="https://p.typekit.net" crossorigin>';

ok('Squarespace font-menu kit counts', pageUsesAdobe(`${PRE}<script type="text/javascript" src="//use.typekit.net/ik/FZXc2P5OO7rQKB5Le-HxBHzL4yXN5.js" async></script>`));
ok('a site\'s own web project counts', pageUsesAdobe('<link rel="stylesheet" href="https://use.typekit.net/abc1def.css">'));
ok('a typekitId in the site settings counts', pageUsesAdobe('{"typekitId":"xyz1234","websiteType":4}'));
ok('preconnect alone does not', !pageUsesAdobe(PRE));
ok('an empty typekitId does not', !pageUsesAdobe('{"timeZone":"Pacific/Auckland","typekitId":"","websiteType":4}'));
ok('uploaded and Google fonts do not', !pageUsesAdobe("font-family: 'gilmer-un3uon'; @import url(https://fonts.googleapis.com/css2?family=Poppins)"));

const req = (copy, origin = 'https://app.preserve.studio') => new Request(`https://host/adobe-check?copy=${copy}`, { headers: { origin } });
const page = (html, status = 200) => async () => new Response(html, { status });
const lookup = async (id) => (id === 'k7f2qx9m' ? 'https://www.example.com/' : null);
{
  const r = await adobeCheck(req('k7f2qx9m'), { lookup, fetch: page('<script src="//use.typekit.net/ik/abc.js"></script>') });
  ok('yes for a page with Adobe fonts, with CORS for the app', (await r.json()).adobe === true && r.headers.get('access-control-allow-origin') === 'https://app.preserve.studio');
}
{
  const r = await adobeCheck(req('k7f2qx9m', 'https://evil.example'), { lookup, fetch: page(PRE) });
  ok('no for a page without, and no CORS for other sites', (await r.json()).adobe === false && !r.headers.get('access-control-allow-origin'));
}
ok('unknown or old Preserve: 404', (await adobeCheck(req('zzzzzzzz'), { lookup, fetch: page('') })).status === 404);
ok('malformed id: 400, nothing fetched', (await adobeCheck(req('../x'), { lookup: async () => { throw new Error('looked up'); }, fetch: page('') })).status === 400);
{
  const slow = (u, { signal }) => new Promise((_, no) => signal.addEventListener('abort', () => no(signal.reason)));
  const hold = setTimeout(() => {}, 1000);  // Node doesn't wait on AbortSignal.timeout by itself
  const r = await adobeCheck(req('k7f2qx9m'), { lookup, fetch: slow, timeoutMs: 50 }); clearTimeout(hold);
  ok('a slow page gives "don\'t know", not an error', (await r.json()).adobe === null);
}
ok('a blocked page gives "don\'t know"', (await (await adobeCheck(req('k7f2qx9m'), { lookup, fetch: page('denied', 403) })).json()).adobe === null);
console.log(fails ? `${fails} failed` : 'adobe check at submit: all pass');
process.exit(fails ? 1 : 0);
