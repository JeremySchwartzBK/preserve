// Serves every copy from R2. One Worker for all studios; nothing here knows about accounts or billing beyond a
// small lookup record per copy and per friendly name, which the app writes to KV whenever something changes.
//
//   /c/<copyId>/                 the copy, phone or desktop layout picked from the request (shared links)
//   /c/<copyId>/desktop|mobile   one layout (embed snippets point here; the page switches if its width disagrees)
//   /c/<copyId>/a/<file>         the copy's files (content-hashed names, cached for a year)
//   /c/<copyId>/<path>/...       another page of the copy, same rules (copies in the page layout only)
//   /<studio>/<name>/...         the same, by friendly name; an old name redirects to the current one
//
// Lookup records (written by the copy runner, see platform/README.md):
//   copy:<copyId>           {"v": 3, "status": "live" | "review" | "paused" | "deleted", "studio": "acme", "name": "minaab",
//                            "fmt": 2, "pages": {"": "<pageId>", "about": "<pageId>"}}   (fmt and pages: page layout only)
//   name:<studio>/<name>    {"id": "k7f2qx9m", "current": "minaab"}   (current != name means a renamed copy)
// R2 layouts:
//   original (no fmt):   copies/<copyId>/v<version>/{desktop.html, mobile.html, a/<file>}
//   page layout (fmt 2): copies/<copyId>/a/<file>, shared by every page and version,
//                        copies/<copyId>/v<version>/p/<pageId>/{desktop,mobile}.html
//   In the page layout any request ending in /a/<file> is a shared file, whatever page path comes before it, so pages
//   keep their relative a/... references at any depth.
//
// Copies are previews, never stand-ins for the real sites: every response says "don't index".

const ROBOTS = 'noindex, nofollow, noarchive, nosnippet, noimageindex';
const ID = /^[a-z0-9]{8}$/;
const SLUG = /^[a-z0-9](?:-?[a-z0-9])*$/;
const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff', txt: 'text/plain; charset=utf-8', ttf: 'font/ttf', otf: 'font/otf' };
const AI_BOTS = ['GPTBot', 'ChatGPT-User', 'CCBot', 'ClaudeBot', 'anthropic-ai', 'Google-Extended', 'Applebot-Extended', 'PerplexityBot', 'Bytespider', 'Amazonbot', 'meta-externalagent', 'cohere-ai', 'Diffbot', 'ia_archiver', 'archive.org_bot'];

const url = (req) => new URL(req.url);

// Small lookup records (copy:<id>, name:<studio>/<name>, tour:<id>) live in R2 at lookup/<kind>/<key>.json.
// They moved out of KV on 2026-10-16: KV's free tier allows only 1,000 writes a day, which normal use can exceed.
async function lookup(env, key) {
  const obj = await env.COPIES.get(`lookup/${key.replace(':', '/')}.json`);
  return obj ? obj.json() : null;
}

// Talks to the app that frames the copy (review, tour and credits editing, problem reports). In pin mode a clear layer
// covers the page, so a tap never presses a button or follows a link; it reports the Squarespace block under it and
// where inside the block (0-1), which is the same in the phone and desktop layouts. The block under the pointer is
// outlined while choosing. Pins sent by the app are drawn inside their blocks, so they scroll with the page.
const REVIEW_BRIDGE = `<script id="preserve-review">(function(){var on=false,P=window.parent,layer=null,box=null,COL={issue:'#e5484d',tour:'#111',credit:'#b07d10',finding:'#6e56cf','finding-done':'#8b8d98'};
function blk(e){return e&&e.closest&&(e.closest('[id^="block-"],.sqs-block,[data-block-id],section[data-section-id]')||e.closest('header,footer')||document.body)}
function idOf(b){if(b===document.body)return 'el:body';if(/^(HEADER|FOOTER)$/.test(b.tagName)&&!b.id)return 'el:'+b.tagName.toLowerCase();return b.id||b.getAttribute('data-block-id')||('section:'+b.getAttribute('data-section-id'))}
function find(id){if(id.indexOf('el:')===0)return document.querySelector(id.slice(3));if(id.indexOf('section:')===0)return document.querySelector('section[data-section-id="'+id.slice(8)+'"]');return document.getElementById(id)||document.querySelector('[data-block-id="'+id+'"]')}
function under(x,y){layer.style.pointerEvents='none';box.style.display='none';var e=document.elementFromPoint(x,y);layer.style.pointerEvents='auto';return blk(e)}
function mode(v){on=v;if(on&&!layer){layer=document.createElement('div');layer.style.cssText='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent;touch-action:pan-y';
box=document.createElement('div');box.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;outline:2px dashed #e5484d;outline-offset:2px;background:rgba(229,72,77,.06);display:none;border-radius:4px';
layer.addEventListener('mousemove',function(e){var b=under(e.clientX,e.clientY);if(!b)return;var r=b.getBoundingClientRect();box.style.cssText+=';display:block;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px'});
layer.addEventListener('mouseleave',function(){box.style.display='none'});
layer.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var b=under(e.clientX,e.clientY);if(!b)return;var r=b.getBoundingClientRect();
P.postMessage({type:'preserve-pin',blockId:idOf(b),x:+Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)).toFixed(3),y:+Math.min(1,Math.max(0,(e.clientY-r.top)/r.height)).toFixed(3),layout:innerWidth<768?'mobile':'desktop',page:location.pathname,label:(b.innerText||b.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,80)},'*')});
document.body.appendChild(box);document.body.appendChild(layer)}
if(layer){layer.style.display=on?'block':'none';if(!on)box.style.display='none'}}
addEventListener('message',function(m){var d=m.data||{};if(d.type==='preserve-pin-mode')mode(!!d.on);
if(d.type==='preserve-pins'){document.querySelectorAll('.preserve-pin').forEach(function(x){x.remove()});var miss=[];(d.pins||[]).forEach(function(p,i){var b=p.blockId&&find(p.blockId);if(!b){if(p.blockId)miss.push(p.blockId);return}if(getComputedStyle(b).position==='static')b.style.position='relative';var dot=document.createElement('div');dot.className='preserve-pin';dot.textContent=p.n||i+1;dot.title=p.body||'';dot.style.cssText='position:absolute;z-index:2147483640;left:'+(p.x*100)+'%;top:'+(p.y*100)+'%;transform:translate(-50%,-50%);width:26px;height:26px;border-radius:50%;background:'+(COL[p.kind]||COL.issue)+';color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 3px rgba(255,255,255,.9),0 2px 8px rgba(0,0,0,.3);pointer-events:none';b.appendChild(dot)});P.postMessage({type:'preserve-missing',blockIds:miss},'*')}
if(d.type==='preserve-scroll-to'){var b=find(d.blockId);if(b)b.scrollIntoView({behavior:'smooth',block:'center'})}});
P.postMessage({type:'preserve-ready',layout:innerWidth<768?'mobile':'desktop'},'*')})();</script>`;

// Visitors' Tour and Credits: the copy's notes (KV tour:<id>, written by the runner from the app's database) plus the
// small tour script (R2 platform/tour.js). Not added in the app's frame, which draws its own pins.
const tourTags = (data) => `<script id="preserve-tour-data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script><script src="/_p/tour.js" defer></script>`;

const page = (status, title, text) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${ROBOTS}"><title>${title}</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;color:#555;background:#f7f6f3;text-align:center;padding:0 24px}p{max-width:28em}</style></head><body><p>${text}</p></body></html>`, { status, headers: { 'content-type': TYPES.html, 'cache-control': 'no-store', 'x-robots-tag': ROBOTS } });
const notFound = () => page(404, 'Not found', 'There is no preview at this address.');

function isPhone(req) {
  return req.headers.get('sec-ch-ua-mobile') === '?1' || /iPhone|iPod|Android.*Mobile|Mobile.*Firefox|Windows Phone|Mobi/i.test(req.headers.get('user-agent') || '');
}

async function serveCopy(req, env, ctx, id, rest) {
  const rec = await lookup(env, `copy:${id}`);
  if (!rec || rec.status === 'deleted') return rec ? page(410, 'Preview removed', 'This preview has been removed.') : notFound();
  // A copy waiting for its owner's approval is shown only in the app's review frame (and its files, by hashed name).
  const sharedFile = rec.fmt === 2 ? /(?:^|\/)a\/([\w.-]+)$/.exec(rest) : null;
  const asset = rec.fmt === 2 ? !!sharedFile : rest.startsWith('a/');
  const inReview = rec.status === 'review' && (asset || url(req).searchParams.has('review'));
  if (rec.status !== 'live' && !inReview) return asset ? new Response(null, { status: 404 }) : page(200, 'Preview paused', 'This preview is paused for now.');

  let key, vary = false, pageId = null;
  if (rec.fmt === 2) {
    if (sharedFile) key = `copies/${id}/a/${sharedFile[1]}`;
    else {
      // <path>/ is a page (layout picked from the request); <path>/desktop or <path>/mobile is one layout of it.
      const m = /^(?:(.*)\/)?(desktop|mobile)$/.exec(rest);
      const pagePath = m ? m[1] || '' : rest.replace(/\/$/, '');
      pageId = Object.hasOwn(rec.pages || {}, pagePath) ? rec.pages[pagePath] : null;
      if (!pageId) return notFound();
      if (!m && rest !== '' && !rest.endsWith('/')) { const u = url(req); u.pathname += '/'; return Response.redirect(u.href, 301); }
      vary = !m;
      key = `copies/${id}/v${rec.v}/p/${pageId}/${m ? m[2] : isPhone(req) ? 'mobile' : 'desktop'}.html`;
    }
  } else {
    let file = rest;
    if (rest === '') { file = isPhone(req) ? 'mobile' : 'desktop'; vary = true; }
    if (file === 'desktop' || file === 'mobile') file += '.html';
    else if (!/^a\/[\w.-]+$/.test(file)) return notFound();
    key = `copies/${id}/v${rec.v}/${file}`;
  }
  const file = key;
  // Assets never change under a given key (content-hashed names inside a numbered version), so the edge cache can
  // keep them; pages are re-read so a new version or a pause shows within a minute.
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/__r2/${key}`, req.url));
  if (asset) { const hit = await cache.match(cacheKey); if (hit) return withRange(req, hit); }
  const obj = await env.COPIES.get(key);
  if (!obj) return notFound();
  const h = new Headers({ 'content-type': TYPES[file.split('.').pop()] || 'application/octet-stream', 'x-robots-tag': ROBOTS, 'etag': obj.httpEtag, 'accept-ranges': 'bytes' });
  h.set('cache-control', asset ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
  if (vary) h.set('vary', 'User-Agent, Sec-CH-UA-Mobile');
  // Review mode (the app's review and pin editor): add the small bridge that lets the app place pins on blocks.
  // Later this requires a signed token from the app; for now the parameter alone turns it on.
  if (!asset && url(req).searchParams.has('review')) {
    h.set('cache-control', 'no-store');
    const html = (await obj.text()).replace(/<\/body>/i, REVIEW_BRIDGE + '</body>');
    return new Response(html, { headers: h });
  }
  if (!asset) {
    const tour = await lookup(env, `tour:${id}`);
    // Tour stops belong to a page (credits are for the whole copy): show only this page's stops.
    if (tour && pageId) tour.spots = (tour.spots || []).filter((p) => !p.page || p.page === pageId);
    if (tour && ((tour.spots || []).length || (tour.credits || []).length)) {
      const html = (await obj.text()).replace(/<\/body>/i, tourTags(tour) + '</body>');
      return new Response(html, { headers: h });
    }
  }
  const res = new Response(obj.body, { headers: h });
  if (asset) { ctx.waitUntil(cache.put(cacheKey, res.clone())); }
  return withRange(req, res);
}

// Safari plays video only from servers that answer byte-range requests.
async function withRange(req, res) {
  const range = req.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || res.status !== 200) return res;
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  let start = m[1] === '' ? size - +m[2] : +m[1];
  let end = m[1] !== '' && m[2] !== '' ? Math.min(+m[2], size - 1) : size - 1;
  if (m[1] === '') end = size - 1;
  if (start < 0) start = 0;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  const h = new Headers(res.headers);
  h.set('content-range', `bytes ${start}-${end}/${size}`);
  h.set('content-length', String(end - start + 1));
  return new Response(buf.slice(start, end + 1), { status: 206, headers: h });
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    const url = new URL(req.url);
    const parts = url.pathname.split('/').slice(1);

    if (url.pathname === '/_p/tour.js') {
      const obj = await env.COPIES.get('platform/tour.js');
      if (!obj) return new Response(null, { status: 404 });
      return new Response(obj.body, { headers: { 'content-type': TYPES.js, 'cache-control': 'public, max-age=300', 'x-robots-tag': ROBOTS } });
    }
    if (url.pathname === '/robots.txt') {
      // Search engines may crawl (that's how they read "don't index"); AI-training crawlers and archives stay out.
      return new Response(AI_BOTS.map((b) => `User-agent: ${b}\nDisallow: /\n`).join('\n') + '\nUser-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain', 'x-robots-tag': ROBOTS } });
    }

    // Permanent address: /c/<id>/...
    if (parts[0] === 'c' && ID.test(parts[1] || '')) {
      if (parts.length === 2) return Response.redirect(`${url.origin}/c/${parts[1]}/${url.search}`, 301);
      return serveCopy(req, env, ctx, parts[1], parts.slice(2).join('/'));
    }

    // Friendly address: /<studio>/<name>/...
    if (SLUG.test(parts[0] || '') && SLUG.test(parts[1] || '')) {
      const rec = await lookup(env, `name:${parts[0]}/${parts[1]}`);
      if (!rec) return notFound();
      if (rec.current && rec.current !== parts[1]) {
        // Renamed: send old links to the current name, keeping the rest of the path.
        return Response.redirect(`${url.origin}/${parts[0]}/${rec.current}/${parts.slice(2).join('/')}${url.search}`, 301);
      }
      if (parts.length === 2) return Response.redirect(`${url.origin}/${parts[0]}/${parts[1]}/${url.search}`, 301);
      return serveCopy(req, env, ctx, rec.id, parts.slice(2).join('/'));
    }
    return notFound();
  },
};
