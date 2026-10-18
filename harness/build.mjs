// Builds the copy variants from a capture.
//   frozen        rendered DOM, every site script removed, assets as captured
//   frozen-opt    frozen + modern right-sized images, critical CSS, font preload/swap, image priority hints
//   opt-rendered  rendered DOM + only Squarespace look-and-feel scripts + the same optimizations
//   opt-server    original server HTML (pre-JavaScript) + Squarespace look-and-feel scripts + the same optimizations
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { rewriteUrls } from './server.mjs';
import { OVERLAY_SELECTORS } from './lib.mjs';

export const VARIANTS = {
  frozen: { source: 'rendered', scripts: 'none', optimize: false },
  'frozen-opt': { source: 'rendered', scripts: 'none', optimize: true },
  'opt-rendered': { source: 'rendered', scripts: 'visual', optimize: true },
  'opt-server': { source: 'server', scripts: 'visual', optimize: true },
};

// Server options per variant (see server.mjs).
export function serverVariants() {
  const fontSwap = (t, ct) => (/css/.test(ct) ? t.replace(/font-display:\s*(auto|block)/g, 'font-display:swap').replace(/@font-face\s*{(?![^}]*font-display)/g, '@font-face{font-display:swap;') : t);
  return Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, { resizeImages: v.optimize, transformText: v.optimize ? fontSwap : null }]));
}

// Third-party and non-visual scripts. Anything matching is dropped from the "visual" variants.
const DROP_SRC = [
  /google-analytics|googletagmanager|gtag\/js|doubleclick|google\.com\/recaptcha|gstatic\.com\/recaptcha/,
  /facebook\.net|fbevents|connect\.facebook/,
  /hotjar|clarity\.ms|segment\.(io|com)|mixpanel|heap(analytics)?|fullstory|amplitude|intercom|drift|hubspot|hs-scripts|klaviyo|mailchimp|pinterest|pinimg|tiktok|snap(chat)?\.com|linkedin|twitter\.com\/oct|ads-twitter|bing\.com|bat\.bing|criteo|taboola|outbrain|quantserve|scorecardresearch|newrelic|nr-data|sentry|datadog|bugsnag|cookiebot|onetrust|termly|iubenda|osano|usercentrics|cookieyes|tawk|crisp\.chat|zendesk|olark|livechat|elfsight|privy|justuno|optinmonster|sumo\.com/,
  /squarespace\.com\/.*(performance|census|analytics|rum|cookie-banner|popup-overlay|announcement-bar|commerce-checkout|member-areas|scheduling|acuity)/i,
];
const DROP_INLINE = [/gtag\(|dataLayer|fbq\(|_gaq|ga\(\s*['"]create|hotjar|_hjSettings|clarity|klaviyo|pintrk|ttq\.|snaptr|_linkedin|twq\(/, /SQUARESPACE_LAUNCH_TIME|Static\.COOKIE_BANNER|SQS_RUM|RecordHit|census/];

const REPLICA_SCRIPT = `<script id="preserve-replica">(function(){
var t;function toast(){if(!t){t=document.createElement('div');t.setAttribute('role','status');t.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);opacity:0;transition:all .25s;z-index:2147483647;background:#111;color:#fff;font:500 14px/1.4 system-ui,sans-serif;padding:12px 18px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;max-width:90vw;text-align:center';t.textContent='This is a preview copy of the site, so this action is turned off.';document.body.appendChild(t)}var bg=document.elementFromPoint(innerWidth/2,innerHeight-40),c='';for(;bg&&bg.nodeType===1;bg=bg.parentElement){c=getComputedStyle(bg).backgroundColor;if(c&&!/rgba\\(.*,\\s*0\\)|transparent/.test(c))break;c=''}var m=(c||'rgb(255,255,255)').match(/\\d+/g)||[255,255,255],dark=(+m[0]*299+ +m[1]*587+ +m[2]*114)/1000<128;t.style.background=dark?'#fff':'#111';t.style.color=dark?'#111':'#fff';requestAnimationFrame(function(){t.style.opacity=1;t.style.transform='translateX(-50%)'});clearTimeout(t._h);t._h=setTimeout(function(){t.style.opacity=0;t.style.transform='translateX(-50%) translateY(20px)'},2600)}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href],button[type=submit],input[type=submit],form button,[class*="klaviyo-form"] button,button[class*="form-button"],.sqs-add-to-cart-button,[data-add-to-cart],.sqs-block-button-element');if(!a)return;
if(a.matches('[data-folder-id],[data-folder],.header-nav-folder-title,[data-action],[aria-controls]'))return;
if(a.tagName==='A'){if(a.hasAttribute('data-pv-internal'))return;var h=a.getAttribute('href')||'';if(h===''||h[0]==='#'||/^javascript:/i.test(h))return;var u=new URL(h,location.href);if(u.origin===location.origin&&u.pathname===location.pathname&&u.hash)return}
e.preventDefault();e.stopImmediatePropagation();toast()},true);
document.addEventListener('submit',function(e){e.preventDefault();e.stopImmediatePropagation();toast()},true);
})();</script>`;

// Squarespace look-and-feel motion, replayed without Squarespace's scripts (~2 KB instead of ~1.5 MB):
//  - entrance animations: elements carry preFade/preSlide/preScale/preClip/preFlex (hidden start state); Squarespace adds
//    fadeIn/slideIn/... when they enter the screen. The capture saw them all revealed, so the build strips the "In"
//    class and this script adds it back as each element scrolls into view (first-screen ones animate on load).
//  - scrolling text (Marquee block): the text slides along its SVG path; the loop shifts textPath startOffset.
const MOTION_SCRIPT = `<script id="preserve-motion">(function(){
var M={preFade:'fadeIn',preSlide:'slideIn',preScale:'scaleIn',preClip:'clipIn',preFlex:'flexIn'};
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var els=document.querySelectorAll('.preFade,.preSlide,.preScale,.preClip,.preFlex');
function show(el){for(var k in M)if(el.classList.contains(k))el.classList.add(M[k])}
if(reduce||!('IntersectionObserver' in window)){els.forEach(show)}else{
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){show(e.target);io.unobserve(e.target)}})},{rootMargin:'0px 0px -5% 0px'});
els.forEach(function(el){io.observe(el)})}
if(reduce)return;
document.querySelectorAll('.Marquee').forEach(function(m){
var tp=m.querySelector('textPath.Marquee-svg-text'),path=m.querySelector('path.Marquee-path');if(!tp)return;
var ts=tp.querySelectorAll('tspan');var w=ts.length>1?parseFloat(ts[1].getAttribute('x'))-parseFloat(ts[0].getAttribute('x')):0;if(!(w>0))return;
var sp=parseFloat(m.getAttribute('data-animation-speed')||'1')||1;var dir=m.getAttribute('data-animation-direction')==='right'?-1:1;
var p=-parseFloat(tp.getAttribute('startOffset')||'0')||0;var last=0;
function tick(t){var dt=last?Math.min(50,t-last):16.7;last=t;p+=dir*sp*dt/16.7;var i=((p%w)+w)%w;tp.setAttribute('startOffset',String(-i));if(path)path.setAttribute('stroke-dashoffset',String(i));requestAnimationFrame(tick)}
requestAnimationFrame(tick)});
})();
// Accordion blocks (FAQ dropdowns): same attributes and classes Squarespace's own script sets, with its height slide.
(function(){
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.accordion-item__click-target');if(!b)return;
var li=b.closest('.accordion-item'),dd=li&&li.querySelector('.accordion-item__dropdown');if(!dd||li.hasAttribute('data-is-item-animating'))return;e.preventDefault();
var list=li.closest('.accordion-items-container'),multi=list&&list.getAttribute('data-should-allow-multiple-open-items')==='true';
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function set(item,open){var d=item.querySelector('.accordion-item__dropdown'),t=item.querySelector('.accordion-item__click-target');if(!d)return;
if(open)item.setAttribute('data-is-open','true');else item.removeAttribute('data-is-open');if(t)t.setAttribute('aria-expanded',open?'true':'false');
if(reduce){d.classList.toggle('accordion-item__dropdown--open',open);return}
item.setAttribute('data-is-item-animating','true');d.classList.add('accordion-item__dropdown--open');var h=d.scrollHeight;
d.style.height=(open?0:h)+'px';d.style.transition='height 300ms ease';d.offsetHeight;d.style.height=(open?h:0)+'px';
setTimeout(function(){d.style.removeProperty('height');d.style.removeProperty('transition');if(!open)d.classList.remove('accordion-item__dropdown--open');item.removeAttribute('data-is-item-animating')},300)}
var open=li.getAttribute('data-is-open')!=='true';
if(open&&!multi&&list)list.querySelectorAll('.accordion-item[data-is-open="true"]').forEach(function(o){if(o!==li)set(o,false)});
set(li,open)},true);
})();</script>`;

// Header menus, replayed without Squarespace's scripts: the phone menu (burger button opens the full-screen menu,
// folders slide in with a Back link) and folder dropdowns in the desktop bar on touch screens. Same classes and
// attributes Squarespace's header script sets, so the site's own CSS draws and animates everything. Page links inside
// the menu still get the "preview copy" notice; while open, the header takes the menu's colour theme as Squarespace does; links to a spot on this page close the menu first.
const MENU_SCRIPT = `<script id="preserve-menu">(function(){
var b=document.body,mq=window.matchMedia;
function btns(){return document.querySelectorAll('.header-burger-btn')}
function isOpen(){return b.classList.contains('header--menu-open')}
function folders(){return document.querySelectorAll('.header-menu-nav-folder')}
function show(f,on){f.querySelectorAll('a,button').forEach(function(a){a.setAttribute('tabindex',on?'0':'-1')})}
function reset(){folders().forEach(function(f){var r=f.getAttribute('data-folder')==='root';f.classList.toggle('header-menu-nav-folder--active',r);f.classList.remove('header-menu-nav-folder--open');show(f,r)})}
function set(open){if(open===isOpen())return;b.classList.toggle('header--menu-open',open);
btns().forEach(function(x){x.classList.toggle('burger--active',open);x.setAttribute('aria-expanded',open?'true':'false');
var o=x.querySelector('.js-header-burger-open-title'),c=x.querySelector('.js-header-burger-close-title');if(o)o.hidden=open;if(c)c.hidden=!open});
var m=document.querySelector('.header-menu');if(m)m.setAttribute('aria-hidden',open?'false':'true');
var hd=m&&m.closest('header');if(hd&&m.hasAttribute('data-section-theme')){if(open){hd._pt=hd.getAttribute('data-section-theme');hd._pc=hd.className;var th=m.getAttribute('data-section-theme');if(hd._pt)hd.classList.remove(hd._pt);if(th)hd.classList.add(th);hd.setAttribute('data-section-theme',th)}else if(hd._pc!=null){hd.className=hd._pc;if(hd._pt!=null)hd.setAttribute('data-section-theme',hd._pt)}}
if(open)reset();else setTimeout(function(){if(!isOpen())reset()},600)}
btns().forEach(function(x){x.setAttribute('aria-expanded','false');x.removeAttribute('tabindex')});
document.addEventListener('click',function(e){var t=e.target.closest&&e.target;if(!t)return;
if(t.closest('.header-burger-btn')){e.preventDefault();set(!isOpen());return}
var a=t.closest('.header-menu a');if(a){
var id=a.getAttribute('data-folder-id');if(id!=null){var to=document.querySelector('.header-menu-nav-folder[data-folder="'+id.replace(/"/g,'\\\\"')+'"]');if(to){e.preventDefault();e.stopImmediatePropagation();var from=a.closest('.header-menu-nav-folder');
if(from){from.classList.add('header-menu-nav-folder--open');show(from,false)}to.classList.add('header-menu-nav-folder--active');show(to,true)}return}
if(a.getAttribute('data-action')==='back'){e.preventDefault();e.stopImmediatePropagation();var cur=a.closest('.header-menu-nav-folder');if(cur){cur.classList.remove('header-menu-nav-folder--active');show(cur,false)}
var prev=document.querySelectorAll('.header-menu-nav-folder--open');prev=prev[prev.length-1];if(prev){prev.classList.remove('header-menu-nav-folder--open');show(prev,true)}return}
var h=a.getAttribute('href')||'';if(h[0]==='#'&&h.length>1){set(false)}return}
var f=t.closest('.header-nav button.header-nav-folder-title[aria-controls]');if(f){e.preventDefault();var ex=f.getAttribute('aria-expanded')!=='true';
document.querySelectorAll('.header-nav button.header-nav-folder-title[aria-expanded="true"]').forEach(function(o){o.setAttribute('aria-expanded','false')});f.setAttribute('aria-expanded',ex?'true':'false');return}
if(!t.closest('.header-nav-item--folder'))document.querySelectorAll('.header-nav button.header-nav-folder-title[aria-expanded="true"]').forEach(function(o){o.setAttribute('aria-expanded','false')})},true);
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&isOpen()){set(false);var x=btns();for(var i=0;i<x.length;i++)if(x[i].offsetParent){x[i].focus();break}}});
})();</script>`;

// Rendered copies come in two layouts, captured at phone and desktop width (Squarespace's breakpoint is 768px).
// index.html picks one by the width it is given: the browser window when opened as a link, or the frame's own width
// when embedded in a portfolio page. Each page switches if its width later crosses the breakpoint (rotation, resize).
const BREAKPOINT = 768;
const LOADER_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script>location.replace((innerWidth<${BREAKPOINT}?'mobile':'desktop')+'.html'+location.search+location.hash)</script></head>
<body><noscript><a href="desktop.html">Open the preview</a></noscript></body></html>`;
const widthScript = (layout) => `<script id="preserve-width">(function(){var m=${layout === 'mobile' ? 'true' : 'false'},t;
addEventListener('resize',function(){clearTimeout(t);t=setTimeout(function(){if((innerWidth<${BREAKPOINT})!==m)location.replace((m?'desktop':'mobile')+'.html'+location.search+location.hash)},250)})})();</script>`;

const OVERLAY_CSS = `<style id="preserve-overlays">${OVERLAY_SELECTORS.join(',')}{display:none!important}</style>`;

function classifyScript($, el) {
  const src = $(el).attr('src');
  const type = ($(el).attr('type') || '').toLowerCase();
  if (type && !/javascript|module|^text\/ecmascript/.test(type)) return { keep: true, kind: 'data', what: type }; // JSON / templates, inert
  if (src) {
    const abs = src.startsWith('//') ? 'https:' + src : src;
    if (DROP_SRC.some((r) => r.test(abs))) return { keep: false, kind: 'tracker/non-visual', what: abs };
    if (/^\/[^/]/.test(src)) return { keep: true, kind: 'site-origin', what: src };
    if (/squarespace(-cdn)?\.com|sqspcdn\.com/.test(abs)) return { keep: true, kind: 'squarespace', what: abs };
    return { keep: false, kind: 'third-party (unknown)', what: abs };
  }
  const txt = $(el).html() || '';
  if (DROP_INLINE.some((r) => r.test(txt))) return { keep: false, kind: 'inline tracker/non-visual', what: txt.trim().slice(0, 100) };
  return { keep: true, kind: 'inline', what: txt.trim().slice(0, 100) };
}

// The site owner's own code (code blocks, footer injection): small inline scripts in the page body that only move
// things on the page, such as counters, carousels and scrolling rows. They're kept in script-free copies when they
// make no network calls and don't depend on Squarespace's or jQuery's scripts, which those copies don't load.
function isOwnerScript($, el) {
  if ($(el).attr('src') || !$(el).parents('body').length) return false;
  const type = ($(el).attr('type') || '').toLowerCase();
  if (type && !/javascript|module|ecmascript/.test(type)) return false;
  const t = $(el).html() || '';
  if (!t.trim() || DROP_INLINE.some((r) => r.test(t))) return false;
  if (/fetch\(|XMLHttpRequest|sendBeacon|\$\.ajax|WebSocket|importScripts|document\.write|\.src\s*=\s*['"]https?:/.test(t)) return false;
  if (/(^|[^\w.$])(Y|Static|Squarespace|jQuery|SQS)\s*\.|(^|[^\w.])\$\s*\(|window\.Static|fbq|gtag/.test(t)) return false;
  return true;
}

export { MENU_SCRIPT };

export function buildVariant(siteDir, name, { hosts, siteHost }) {
  const v = VARIANTS[name];
  const outDir = path.join(siteDir, 'variants', name);
  fs.mkdirSync(outDir, { recursive: true });
  const pages = v.source === 'server' ? { 'index.html': 'server.html' } : { 'desktop.html': 'rendered-desktop.html', 'mobile.html': 'rendered-mobile.html' };
  const report = { scripts: [] };
  for (const [outName, src] of Object.entries(pages)) {
    let html = fs.readFileSync(path.join(siteDir, src), 'utf8');
    const $ = cheerio.load(html);
    // Marketing overlays.
    $(OVERLAY_SELECTORS.join(',')).remove();
    $('head').prepend(OVERLAY_CSS);
    // Spam-protection and tracking frames (reCAPTCHA on forms etc.) do nothing on a copy and throw errors offline.
    $('iframe').filter((_, el) => /recaptcha|doubleclick|facebook\.com\/tr|googletagmanager/.test($(el).attr('src') || '')).remove();
    $('.grecaptcha-badge, [class*="recaptcha"]').remove();
    // Scripts.
    $('script').each((_, el) => {
      const c = v.scripts === 'none' ? (/ld\+json|application\/json/.test($(el).attr('type') || '') ? { keep: true, kind: 'data' } : isOwnerScript($, el) ? { keep: true, kind: 'site owner code (self-contained)', what: ($(el).html() || '').trim().slice(0, 100) } : { keep: false, kind: 'all scripts dropped' }) : classifyScript($, el);
      if (c.kind === 'site owner code (self-contained)') $(el).html(`try{${$(el).html()}\n}catch(e){}`);
      if (outName !== 'mobile.html') report.scripts.push({ keep: c.keep, kind: c.kind, what: (c.what || '').slice(0, 140) });
      if (!c.keep) $(el).remove();
    });
    if (v.scripts === 'none') {
      $('noscript').remove();
      $('link[rel=preload][as=script],link[rel=modulepreload]').remove();
      $('*').each((_, el) => { for (const a of Object.keys(el.attribs || {})) if (/^on/i.test(a)) $(el).removeAttr(a); });
    }
    // Turn off overlay features in the Squarespace context so its scripts don't create them later.
    $('script').each((_, el) => {
      const t = $(el).html();
      if (t && t.includes('SQUARESPACE_CONTEXT')) {
        $(el).html(t.replace(/"isCookieBannerEnabled":true/g, '"isCookieBannerEnabled":false')
          .replace(/"announcementBarSettings":\{/g, '"announcementBarSettings":{"disabled":true,')
          .replace(/"popupOverlaySettings":\{/g, '"_popupOverlaySettings":{'));
      }
    });
    // Connections to hosts the copy never uses.
    $('link[rel=preconnect],link[rel=dns-prefetch]').remove();
    $('base').remove();
    if (v.optimize) {
      // Below-the-fold images can wait; the first-screen pass (atf.mjs) sets priority on the hero.
      $('img').each((_, el) => { if (!$(el).attr('loading')) $(el).attr('loading', 'lazy'); $(el).attr('decoding', 'async'); });
    }
    if (v.scripts === 'none') {
      // Put entrance animations back to their start state; MOTION_SCRIPT plays them.
      $('.preFade,.preSlide,.preScale,.preClip,.preFlex').removeClass('fadeIn slideIn scaleIn clipIn flexIn');
      $('body').append(MOTION_SCRIPT);
      $('body').append(MENU_SCRIPT);
    }
    $('body').append(REPLICA_SCRIPT);
    if (outName !== 'index.html') $('body').append(widthScript(outName.replace('.html', '')));
    html = rewriteUrls($.html(), name, hosts, siteHost);
    fs.writeFileSync(path.join(outDir, outName), html);
  }
  if (v.source !== 'server') fs.writeFileSync(path.join(outDir, 'index.html'), LOADER_HTML);
  fs.writeFileSync(path.join(outDir, 'build-report.json'), JSON.stringify(report, null, 1));
  return report;
}
