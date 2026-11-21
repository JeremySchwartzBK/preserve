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

// Every Preserve page is served with these rules: no network, and sealed off from other Preserves (custom code stage
// one). Same text as harness/policy.mjs, which the quality check serves copies with (harness/test-policy.mjs checks).
// Every word we lay over an owner's page, in one place. Served when the page is viewed, so a change here reaches every
// Preserve, accepted ones included, on the next viewer deploy. This is the one exception to "accepted Preserves never
// change", and it covers only our own wording (Jeremy, 2026-11-19). The Tour and Talent panel's words are in
// platform/tour/tour.js, which is served the same way.
const WORDING = {
  linkNote: 'You’re viewing a snapshot of how this page looks and feels. Links to other pages have been disabled.',
  formNote: 'You’re viewing a snapshot of how this page looks and feels. Forms and checkout have been disabled.',
  removed: ['Preserve removed', 'This Preserve has been removed.'],
  paused: ['Preserve paused', 'This Preserve is paused for now.'],
  notFound: ['Not found', 'There’s no Preserve at this address.'],
  reviewExpired: ['Review link expired', 'This review link has expired. Open the Preserve from your dashboard to review it.'],
};
// Our type (Plum style, 2026-11-20): our own copies of Inter and Newsreader, under names no site uses, served from
// /_p/fonts/ on the Preserve's own address (the page's rules allow fonts only from there). Browsers fetch a font only
// when text on screen uses it.
const UI_FONTS = '@font-face{font-family:"Preserve Inter";src:url(/_p/fonts/inter.woff2) format("woff2");font-weight:100 900;font-display:swap}@font-face{font-family:"Preserve Newsreader";src:url(/_p/fonts/newsreader.woff2) format("woff2");font-weight:500;font-display:swap}';
const UI_SANS = '"Preserve Inter",system-ui,-apple-system,"Segoe UI",sans-serif';
// A string as a JavaScript literal that is safe inside an inline script.
const js = (s) => JSON.stringify(s).replace(/[\u0080-\uffff<>]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
// The "this is a snapshot" note for clicks on links, forms and checkout. Every Preserve page carries the copy of this
// script from when it was made (harness/build.mjs REPLICA_SCRIPT), with that day's wording. The viewer swaps it for
// this one, so all Preserves show today's wording. Keep the behaviour in step with build.mjs.
const REPLICA_SCRIPT = `<script id="preserve-replica">(function(){
var t,LINK=${js(WORDING.linkNote)},FORM=${js(WORDING.formNote)};function toast(msg){if(!t){var f=document.createElement('style');f.textContent=${js(UI_FONTS)};document.head.appendChild(f);t=document.createElement('div');t.setAttribute('role','status');t.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);opacity:0;transition:all .25s;z-index:2147483647;background:#1d1a24;color:#fff;font:500 14px/1.4 ${UI_SANS.replace(/"/g, '\\"')};padding:12px 18px;border-radius:14px;box-shadow:0 6px 24px rgba(29,26,36,.25);pointer-events:none;max-width:90vw;text-align:center';document.body.appendChild(t)}t.textContent=msg||FORM;var bg=document.elementFromPoint(innerWidth/2,innerHeight-40),c='';for(;bg&&bg.nodeType===1;bg=bg.parentElement){c=getComputedStyle(bg).backgroundColor;if(c&&!/rgba\\(.*,\\s*0\\)|transparent/.test(c))break;c=''}var m=(c||'rgb(255,255,255)').match(/\\d+/g)||[255,255,255],dark=(+m[0]*299+ +m[1]*587+ +m[2]*114)/1000<128;t.style.background=dark?'#fff':'#1d1a24';t.style.color=dark?'#1d1a24':'#fff';requestAnimationFrame(function(){t.style.opacity=1;t.style.transform='translateX(-50%)'});clearTimeout(t._h);t._h=setTimeout(function(){t.style.opacity=0;t.style.transform='translateX(-50%) translateY(20px)'},2600)}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href],button[type=submit],input[type=submit],form button,[class*="klaviyo-form"] button,button[class*="form-button"],.sqs-add-to-cart-button,[data-add-to-cart],.sqs-block-button-element');if(!a)return;
if(a.matches('[data-folder-id],[data-folder],.header-nav-folder-title,[data-action],[aria-controls]')||a.closest('[data-pv-actc]'))return;
if(a.tagName==='A'){if(a.hasAttribute('data-pv-internal'))return;var h=a.getAttribute('href')||'';if(h===''||h[0]==='#'||/^javascript:/i.test(h))return;var u=new URL(h,location.href);if(u.origin===location.origin&&u.pathname===location.pathname&&u.hash)return}
e.preventDefault();e.stopImmediatePropagation();toast(a.tagName==='A'?LINK:FORM)},true);
document.addEventListener('submit',function(e){e.preventDefault();e.stopImmediatePropagation();toast(FORM)},true);
})();</script>`;
const currentReplica = (html) => html.replace(/<script id="preserve-replica">[\s\S]*?<\/script>/, () => REPLICA_SCRIPT);

const PRESERVE_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; frame-src 'self' https://player.vimeo.com https://www.youtube-nocookie.com; connect-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation";

const url = (req) => new URL(req.url);

// Small lookup records (copy:<id>, name:<studio>/<name>, tour:<id>) live in R2 at lookup/<kind>/<key>.json.
// They moved out of KV on 2026-10-16: KV's free tier allows only 1,000 writes a day, which normal use can exceed.
async function lookup(env, key) {
  const obj = await env.COPIES.get(`lookup/${key.replace(':', '/')}.json`);
  return obj ? obj.json() : null;
}

// Talks to the app that frames the copy (review, Tour and Talent editing, problem reports). In pin mode a clear layer
// covers the page, so a tap never presses a button or follows a link; it reports the Squarespace block under it and
// where inside the block (0-1), which is the same in the phone and desktop layouts. The block under the pointer is
// outlined while choosing. Pins sent by the app are drawn inside their blocks, so they scroll with the page.
const REVIEW_BRIDGE = `<script id="preserve-review">(function(){var on=false,P=window.parent,layer=null,box=null,COL={issue:'#e5484d',tour:'#111',credit:'#b07d10',finding:'#6e56cf','finding-done':'#8b8d98'};function lum(r,g,b){return(r*299+g*587+b*114)/1000}var cv=null;function dark(dot){var r=dot.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,st=document.elementsFromPoint(x,y);for(var i=0;i<st.length;i++){var e=st[i];if(e.className==='preserve-pin'||e===layer||(layer&&layer.contains(e)))continue;if(e.tagName==='IMG'||e.tagName==='VIDEO'){var w=e.naturalWidth||e.videoWidth,h=e.naturalHeight||e.videoHeight;if(w&&h){try{var q=e.getBoundingClientRect();cv=cv||document.createElement('canvas');cv.width=cv.height=1;var cx=cv.getContext('2d');cx.drawImage(e,Math.max(0,Math.min(w-1,(x-q.left)/q.width*w)),Math.max(0,Math.min(h-1,(y-q.top)/q.height*h)),1,1,0,0,1,1);var px=cx.getImageData(0,0,1,1).data;if(px[3]>128)return lum(px[0],px[1],px[2])<110}catch(err){}}}for(var a=e;a&&a!==document.documentElement;a=a.parentElement){var c=getComputedStyle(a).backgroundColor,m=c&&c.match(/[0-9.]+/g);if(m&&(m.length<4||+m[3]>.5))return lum(+m[0],+m[1],+m[2])<110}return false}return false}
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
if(d.type==='preserve-pins'){document.querySelectorAll('.preserve-pin').forEach(function(x){x.remove()});var miss=[];(d.pins||[]).forEach(function(p,i){if(p.wide){var c=COL[p.kind]||COL.issue,band=document.createElement('div'),tag=document.createElement('div');band.className='preserve-pin';band.title=p.body||'';band.style.cssText='position:absolute;z-index:2147483639;left:0;right:0;top:'+(+p.top||0)+'px;height:'+(+p.top?160:innerHeight)+'px;border:3px solid '+c+';background:'+c+'14;box-sizing:border-box;pointer-events:none';tag.textContent=p.n||i+1;tag.style.cssText='position:absolute;left:12px;top:12px;min-width:26px;height:26px;padding:0 6px;box-sizing:border-box;border-radius:13px;background:'+c+';color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 3px rgba(255,255,255,.9),0 2px 8px rgba(0,0,0,.3)';band.appendChild(tag);document.documentElement.appendChild(band);return}var b=p.blockId&&find(p.blockId);if(!b){if(p.blockId)miss.push(p.blockId);return}if(getComputedStyle(b).position==='static')b.style.position='relative';var dot=document.createElement('div');dot.className='preserve-pin';dot.textContent=p.n||i+1;dot.title=p.body||'';dot.style.cssText='position:absolute;z-index:2147483640;left:'+(p.x*100)+'%;top:'+(p.y*100)+'%;transform:translate(-50%,-50%);width:26px;height:26px;border-radius:50%;background:'+(COL[p.kind]||COL.issue)+';color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 3px rgba(255,255,255,.9),0 2px 8px rgba(0,0,0,.3);pointer-events:none';b.appendChild(dot);if(p.kind==='tour'&&dark(dot)){dot.style.background='#fff';dot.style.color='#111';dot.style.boxShadow='0 0 0 3px rgba(17,17,17,.9),0 2px 8px rgba(0,0,0,.3)'}});var ds=[].slice.call(document.querySelectorAll('.preserve-pin')).map(function(d,i){var r=d.getBoundingClientRect(),cx=r.left+r.width/2,dx=Math.max(0,18-cx)-Math.max(0,cx-(document.documentElement.clientWidth-18));return{d:d,i:i,x:cx+dx,y:r.top+scrollY+r.height/2,o:0,dx:dx}});ds.forEach(function(m,i){for(var k=0;k<40;k++){var hit=false;for(var j=0;j<i;j++){var q=ds[j];if(Math.abs(q.x-m.x)<30&&Math.abs(q.y+q.o-(m.y+m.o))<30){hit=true;break}}if(!hit)break;m.o+=30}if(m.o||m.dx)m.d.style.transform='translate(calc(-50% + '+m.dx+'px),calc(-50% + '+m.o+'px))'});P.postMessage({type:'preserve-missing',blockIds:miss},'*')}
if(d.type==='preserve-fonts'){var fs=document.getElementById('preserve-fonts');if(!fs){fs=document.createElement('style');fs.id='preserve-fonts';document.body.appendChild(fs)}fs.textContent=d.css||''}
if(d.type==='preserve-scroll-to'){var b=find(d.blockId);if(b)b.scrollIntoView({behavior:'smooth',block:'center'})}
if(d.type==='preserve-show-font'){var q=function(x){return String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'')},want=q(d.name).slice(0,6),hit=[];document.querySelectorAll('.preserve-font-hit').forEach(function(x){x.classList.remove('preserve-font-hit')});if(want){document.querySelectorAll('body *').forEach(function(el){if(!el.childNodes.length||![].some.call(el.childNodes,function(n){return n.nodeType===3&&n.textContent.trim()}))return;if(q(getComputedStyle(el).fontFamily.split(',')[0]).indexOf(want)===0){el.classList.add('preserve-font-hit');hit.push(el)}});if(!document.getElementById('preserve-font-css')){var st=document.createElement('style');st.id='preserve-font-css';st.textContent='.preserve-font-hit{outline:2px solid #e8a33d!important;outline-offset:2px}';document.head.appendChild(st)}if(hit[0])hit[0].scrollIntoView({behavior:'smooth',block:'center'})}}});
P.postMessage({type:'preserve-ready',layout:innerWidth<768?'mobile':'desktop'},'*')})();</script>`;

// Visitors' Tour and Talent (stored under the older key `credits`): the copy's notes (KV tour:<id>, written by the runner from the app's database) plus the
// small tour script (R2 platform/tour.js). Not added in the app's frame, which draws its own pins.
// Embeds shrink a Preserve to fit (a desktop layout on a phone is about a quarter size). The embed code tells the page
// its scale ({type:'preserve-scale',scale}); this grows our own small UI back to normal size: the "snapshot" toast
// (baked into each page by harness/build.mjs, found by its role and z-index) and the tour's pill, panel and cards. Uses
// the separate `scale` property so the toast's own transforms still work. Visitor pages only; the captured page is untouched.
const FRAME_SCALE = `<style id="preserve-frame-scale-css">.preserve-scaled .preserve-toast{scale:var(--preserve-k);transform-origin:0 100%;box-sizing:border-box;bottom:calc(24px * var(--preserve-k))!important;max-width:calc(90vw / var(--preserve-k))!important}.preserve-scaled .pt-pill{scale:var(--preserve-k);transform-origin:0 100%}.preserve-scaled .pt-panel{scale:var(--preserve-k);transform-origin:0 100%;bottom:calc(12px + 50px * var(--preserve-k));max-height:calc((100vh - 24px) / var(--preserve-k) - 62px)}.preserve-scaled .pt-card{scale:var(--preserve-k);transform-origin:0 0;max-width:calc((100vw - 24px) / var(--preserve-k))}</style><script id="preserve-frame-scale">(function(){if(window.top===window)return;var d=document.documentElement;function mark(n){if(n.nodeType===1&&n.getAttribute('role')==='status'&&n.style.zIndex==='2147483647')n.classList.add('preserve-toast')}addEventListener('message',function(e){var m=e.data;if(e.source!==parent||!m||m.type!=='preserve-scale')return;var k=1/Math.min(1,Math.max(.1,+m.scale||1));d.style.setProperty('--preserve-k',k);d.classList.toggle('preserve-scaled',k>1.01)});[].forEach.call(document.body.children,mark);new MutationObserver(function(r){r.forEach(function(x){[].forEach.call(x.addedNodes,mark)})}).observe(document.body,{childList:true})})()</script>`;
const tourTags = (data) => `<script id="preserve-tour-data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script><script src="/_p/tour.js" defer></script>`;

// Font choices from review (KV fonts:<id>, written by the runner, schema-fonts.sql): the lookalike or the person's
// licensed file in place of a font on the page. Added last, so these @font-face rules win over the page's own of the
// same name; the files sit beside the copy's other files (a/...).
const css = (s) => String(s).replace(/[\\"<>\n]/g, '');
const fontTags = (list) => `<style id="preserve-fonts">${list.map((f) => `@font-face{font-family:"${css(f.family)}";font-weight:${css(f.weight)};font-style:${css(f.style)};font-display:swap;src:url(a/${css(f.src)})}`).join('')}</style>`;

// Our scripts go just before the page's own closing body tag: the LAST one, since a saved widget frame (srcdoc) can carry
// its own </body> earlier in the file. No closing tag: the page is served as it is.
const beforeBodyEnd = (html, add) => {
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i < 0 ? html : html.slice(0, i) + add + html.slice(i);
};
const page = (status, title, text) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${ROBOTS}"><title>${title}</title><style>${UI_FONTS}html,body{height:100%;margin:0}body{display:grid;place-items:center;font:16px/1.5 ${UI_SANS};color:#6c6878;background:#f7f7f9;text-align:center;padding:0 24px;-webkit-font-smoothing:antialiased}p{max-width:28em}</style></head><body><p>${text}</p></body></html>`, { status, headers: { 'content-type': TYPES.html, 'cache-control': 'no-store', 'x-robots-tag': ROBOTS } });
const notFound = () => page(404, ...WORDING.notFound);

function isPhone(req) {
  return req.headers.get('sec-ch-ua-mobile') === '?1' || /iPhone|iPod|Android.*Mobile|Mobile.*Firefox|Windows Phone|Mobi/i.test(req.headers.get('user-agent') || '');
}

// Review links. A token is "<expiry in seconds>.<signature>", the signature being HMAC-SHA256 of "<copyId>.<expiry>"
// in hex. The app gets one from the database (review_link, schema-review-links.sql); the runner and the team make
// their own with the same secret (platform/review-token.mjs). A token opens one Preserve until it expires.
export async function reviewTokenOk(secret, id, token, now = Date.now()) {
  const m = /^(\d{9,11})\.([0-9a-f]{64})$/.exec(token || '');
  if (!m || Number(m[1]) * 1000 < now) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(m[2].match(/../g), (b) => parseInt(b, 16)), enc.encode(`${id}.${m[1]}`));
}

async function serveCopy(req, env, ctx, id, rest) {
  const rec = await lookup(env, `copy:${id}`);
  if (!rec || rec.status === 'deleted') return rec ? page(410, ...WORDING.removed) : notFound();
  // A copy waiting for its owner's approval is shown only in the app's review frame (and its files, by hashed name).
  const sharedFile = rec.fmt === 2 ? /(?:^|\/)a\/([\w.-]+)$/.exec(rest) : null;
  const asset = rec.fmt === 2 ? !!sharedFile : rest.startsWith('a/');
  // With REVIEW_SECRET set, the page itself needs a signed, time-limited link (reviewTokenOk below); knowing the
  // address is not enough. Without the secret (before it is switched on) the bare parameter still works.
  const asked = url(req).searchParams.get('review');
  const signed = asked !== null && (!env.REVIEW_SECRET || await reviewTokenOk(env.REVIEW_SECRET, id, asked));
  if (rec.status === 'review' && !asset && asked !== null && !signed) {
    return page(403, ...WORDING.reviewExpired);
  }
  const inReview = rec.status === 'review' && (asset || signed);

  // The desktop still (desktop-still.mjs, made by the runner in review and again when a Preserve goes live): what the
  // Desktop embed shows on phones and tablets, which can't run a live 1440-wide page in a frame, and the app
  // dashboard's thumbnail. Anyone may see a Live one's; otherwise it takes the owner's signed link, as the page does.
  if (rest === 'desktop-still.webp') {
    if (rec.status !== 'live' && !signed) return new Response(null, { status: 404 });
    const sk = rec.fmt === 2 ? `copies/${id}/v${rec.v}/p/${(rec.pages || {})['']}/desktop-still.webp` : `copies/${id}/v${rec.v}/desktop-still.webp`;
    const so = await env.COPIES.get(sk);
    if (!so) return new Response(null, { status: 404 });
    return new Response(so.body, { headers: { 'content-type': 'image/webp', 'cache-control': rec.status === 'live' ? 'public, max-age=3600' : 'private, max-age=3600', 'x-robots-tag': ROBOTS, 'access-control-allow-origin': '*' } });
  }
  // The "Your site" and "Preserve" pictures beside each suspected issue in review (finding-crops.mjs, kept by the
  // runner with the version that found it). Only on the owner's signed link: they show the live site.
  const crop = /^findings\/v(\d+)\/(\d+)-(site|preserve)\.webp$/.exec(rest);
  if (crop) {
    if (!signed || rec.fmt !== 2) return new Response(null, { status: 404 });
    const co = await env.COPIES.get(`copies/${id}/v${crop[1]}/p/${(rec.pages || {})['']}/findings/${crop[2]}-${crop[3]}.webp`);
    if (!co) return new Response(null, { status: 404 });
    return new Response(co.body, { headers: { 'content-type': 'image/webp', 'cache-control': 'private, max-age=86400', 'x-robots-tag': ROBOTS } });
  }
  if (rec.status !== 'live' && !inReview) return asset ? new Response(null, { status: 404 }) : page(200, ...WORDING.paused);
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
  // v2: files gained a CORS header (2026-10-29); older cached copies lack it.
  const cacheKey = new Request(new URL(`/__r2v2/${key}`, req.url));
  if (asset) { const hit = await cache.match(cacheKey); if (hit) return withRange(req, hit); }
  const obj = await env.COPIES.get(key);
  if (!obj) return notFound();
  const h = new Headers({ 'content-type': TYPES[file.split('.').pop()] || 'application/octet-stream', 'x-robots-tag': ROBOTS, 'etag': obj.httpEtag, 'accept-ranges': 'bytes' });
  h.set('cache-control', asset ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
  if (vary) h.set('vary', 'User-Agent, Sec-CH-UA-Mobile');
  // The page's rules (review and visitors alike); a sealed page asks for its own files from no origin, so they allow
  // any (fonts and images marked crossorigin load only that way).
  // Pages made before stage one (no preserve-steady script) point at SVG icon files, which a sealed page can't use:
  // they keep the no-network rules without the seal, so they look exactly as they did when accepted.
  const text = asset ? null : currentReplica(await obj.text());
  // Sealed (sandboxed) when it runs the owner's kept code, except where a background video plays through Vimeo's or
  // YouTube's player, which can't start in a sealed page (Jeremy 2026-11-17). The rest of the policy still applies.
  if (file.endsWith('.html')) h.set('content-security-policy', text.includes('id="preserve-steady"') && !text.includes('data-pv-bgvideo=') ? PRESERVE_CSP : PRESERVE_CSP.replace(/; sandbox .*$/, ''));
  else h.set('access-control-allow-origin', '*');
  // Review mode (the app's review and pin editor): add the small bridge that lets the app place pins on blocks.
  const fonts = asset ? null : await lookup(env, `fonts:${id}`);
  const fontCss = fonts?.length ? fontTags(fonts) : '';
  if (!asset && url(req).searchParams.has('review')) {
    h.set('cache-control', 'no-store');
    const html = beforeBodyEnd(text, fontCss + REVIEW_BRIDGE);
    return new Response(html, { headers: h });
  }
  // ?full=1 on a desktop page (opened from the Desktop embed on a phone): lay it out 1440 wide whatever the screen, so
  // a phone shows the real desktop layout shrunk to fit. Only the viewport tag changes; the page stays as captured.
  let body = text;
  if (!asset && /\/desktop\.html$/.test(key) && url(req).searchParams.get('full') === '1') {
    const vp = '<meta name="viewport" content="width=1440">';
    body = /<meta[^>]+name=["']?viewport["']?[^>]*>/i.test(body) ? body.replace(/<meta[^>]+name=["']?viewport["']?[^>]*>/i, vp) : body.replace(/<head[^>]*>/i, (m) => m + vp);
  }
  if (!asset) {
    const tour = await lookup(env, `tour:${id}`);
    // Tour stops belong to a page (credits are for the whole copy): show only this page's stops.
    if (tour && pageId) tour.spots = (tour.spots || []).filter((p) => !p.page || p.page === pageId);
    const hasTour = tour && ((tour.spots || []).length || (tour.credits || []).length);
    if (file.endsWith('.html') || hasTour || fontCss) {
      const html = beforeBodyEnd(body, fontCss + (hasTour ? tourTags(tour) : '') + (file.endsWith('.html') ? FRAME_SCALE : ''));
      return new Response(html, { headers: h });
    }
  }
  const res = new Response(asset ? obj.body : body, { headers: h });
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

    const font = /^\/_p\/fonts\/(inter|newsreader)\.woff2$/.exec(url.pathname);
    if (font) {
      const obj = await env.COPIES.get(`platform/fonts/${font[1]}.woff2`);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(obj.body, { headers: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable', 'x-robots-tag': ROBOTS } });
    }
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
