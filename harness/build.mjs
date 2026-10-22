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

// Slideshows built with Swiper (section sliders from plugins such as Will Myers', carousels in code blocks): the
// capture froze them at the capture width (each slide "1440px" wide, moved by pixel offsets), so a narrower or wider
// window showed them shifted, and nothing advanced. This script lays them out again for the window's own width on
// load and on every resize, and plays them the way the site did: fade or slide, its speed, autoplay delay and loop
// (read at capture into data-pv-swiper; without it, fade from the class name and no autoplay), arrows and dots.
// The look of the active slide and dot comes from the classes the capture saw on them, swapped as the active one moves.
const SLIDER_SCRIPT = `<script id="preserve-slider">(function(){
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function own(c){return /^[zu][0-9a-z]+$/.test(c)&&c[0]==='z'}
function tpl(list,isA){var a=null,b=null;list.forEach(function(e){if(isA(e)&&!a)a=e;else if(!isA(e)&&!b)b=e});
var z=function(e){return e?[].filter.call(e.classList,own):[]};return{on:z(a),off:z(b)}}
function setOn(e,on,t,cls){if(t.on.length&&t.off.length){t.on.concat(t.off).forEach(function(c){e.classList.remove(c)});(on?t.on:t.off).forEach(function(c){e.classList.add(c)})}e.classList.toggle(cls,on)}
document.querySelectorAll('.swiper.swiper-initialized,.swiper-container-initialized').forEach(function(sw){
var wr=sw.querySelector('.swiper-wrapper');if(!wr||sw.classList.contains('swiper-vertical'))return;
var sl=[].filter.call(wr.children,function(e){return e.classList.contains('swiper-slide')});var n=sl.length;if(n<2)return;
var cfg={};try{cfg=JSON.parse(sw.getAttribute('data-pv-swiper')||'{}')}catch(e){}
var fade=cfg.effect?cfg.effect==='fade':sw.classList.contains('swiper-fade');
var W0=sw.clientWidth,w0=sl[0].getBoundingClientRect().width;
var gap=cfg.gap!=null?cfg.gap:(parseFloat(sl[0].style.marginRight)||0);
var spv=fade?1:typeof cfg.spv==='number'?cfg.spv:Math.max(1,Math.round((W0+gap)/(w0+gap)));
var speed=cfg.speed!=null?cfg.speed:400,loop=!!cfg.loop,autoH=cfg.autoHeight||sw.classList.contains('swiper-autoheight');
var cur=0;sl.forEach(function(e,i){if(e.classList.contains('swiper-slide-active'))cur=i});
var root=sw.parentElement||sw;
var dots=[].slice.call(sw.querySelectorAll('.swiper-pagination-bullet'));
var tS=tpl(sl,function(e){return e.classList.contains('swiper-slide-active')}),tD=tpl(dots,function(e){return e.classList.contains('swiper-pagination-bullet-active')});
function draw(anim){var W=sw.clientWidth,sw1=(W-gap*(spv-1))/spv,d=anim&&!reduce?speed:0;
sl.forEach(function(e,i){e.style.width=sw1+'px';e.classList.remove('swiper-slide-next','swiper-slide-prev');
if(fade){e.style.transform='translate3d('+(-i*sw1)+'px,0px,0px)';e.style.opacity=i===cur?'1':'0';e.style.transitionDuration=d+'ms';e.style.pointerEvents=i===cur?'auto':'none'}
setOn(e,i===cur,tS,'swiper-slide-active')});
var nx=sl[(cur+1)%n],pv=sl[(cur+n-1)%n];if(nx)nx.classList.add('swiper-slide-next');if(pv)pv.classList.add('swiper-slide-prev');
if(!fade){wr.style.transitionDuration=d+'ms';wr.style.transform='translate3d('+(-Math.min(cur,n-spv)*(sw1+gap))+'px,0px,0px)'}
else{wr.style.transform='translate3d(0px,0px,0px)'}
if(autoH){var h=sl[cur].scrollHeight;sl[cur].style.height='';h=sl[cur].offsetHeight;if(h)wr.style.height=h+'px';wr.style.transitionDuration=d+'ms'}
dots.forEach(function(b,i){setOn(b,i===cur%dots.length,tD,'swiper-pagination-bullet-active');if(i===cur%dots.length)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current')})}
function go(i){var last=Math.max(0,n-spv);cur=loop||cfg.autoplay?((i%(last+1))+(last+1))%(last+1):Math.max(0,Math.min(last,i));draw(true)}
function find(sel){var e=sw.querySelector(sel);if(e)return e;return root.querySelector(sel)}
var nb=find('.swiper-button-next'),pb=find('.swiper-button-prev');
if(nb)nb.addEventListener('click',function(e){e.preventDefault();e.stopImmediatePropagation();go(cur+1);restart()},true);
if(pb)pb.addEventListener('click',function(e){e.preventDefault();e.stopImmediatePropagation();go(cur-1);restart()},true);
dots.forEach(function(b,i){b.addEventListener('click',function(e){e.preventDefault();e.stopImmediatePropagation();go(i);restart()},true)});
var timer=null;function restart(){if(!cfg.autoplay||reduce||window.__pvStill)return;clearInterval(timer);timer=setInterval(function(){if(!document.hidden)go(cur+1)},cfg.autoplay)}
var rt;addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){draw(false)},60)});
draw(false);restart();
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){draw(false)});
addEventListener('load',function(){draw(false)});
});
})();</script>`;

// Text highlights drawn as shapes (Squarespace's marker, underline, wave, scribble, circle...): absolutely placed SVG
// strokes, sized by Squarespace's script for the width it was drawn at. At any other width the text wraps differently,
// so this script places them again from where the highlighted text now falls, on load and on resize. Every shape is
// handled: a marker's stroke is redrawn; a wave's pattern is repeated and cut to length; any other shape is stretched
// from its drawn size. Shapes that ring the whole phrase (circle, box) cover the phrase, the rest go one per line.
const SHAPES_SCRIPT = `<script id="preserve-shapes">(function(){
var RING=/circle|oval|ellipse|box|rect|bracket|bubble|cloud/i;
function lines(el,hr){var out=[];[].forEach.call(el.getClientRects(),function(q){if(q.width<1)return;var l=out[out.length-1];
if(l&&Math.abs(l.top-(q.top-hr.top))<2){l.right=Math.max(l.right,q.right-hr.left);l.left=Math.min(l.left,q.left-hr.left)}
else out.push({left:q.left-hr.left,right:q.right-hr.left,top:q.top-hr.top,height:q.height})});return out}
function orig(n){var d=n.dataset;if(!d.pvW){d.pvW=parseFloat(n.style.width)||n.offsetWidth;d.pvH=parseFloat(n.style.height)||n.offsetHeight;var p=n.querySelector('path');if(p)d.pvD=p.getAttribute('d')||''}return{w:+d.pvW,h:+d.pvH,d:d.pvD||''}}
function draw(n,shape,fs,w,h){var p=n.querySelector('path'),svg=n.querySelector('svg');if(!p||!svg)return;
if(shape==='marker'){var y=h*0.55;p.setAttribute('d','M 0,'+y+' c '+w/8+',0 '+w/4+',0 '+w/2+',0 c '+w/4+',0 '+3*w/8+',0 '+w/2+',0');p.setAttribute('stroke-dasharray',String(w));p.setAttribute('stroke-dashoffset',String(2*w));return}
var o=orig(n);svg.style.width=w+'px';svg.style.height=h+'px';svg.style.overflow='hidden';
if(/wave|zigzag/i.test(shape)){var sc=h/o.h||1,vw=w/sc,m=/^\\s*(M[^cCsSlLqQ]*)([\\s\\S]*)$/.exec(o.d),d=o.d;if(m&&o.w>0)for(var i=1;i*o.w<vw;i++)d+=' '+m[2];p.setAttribute('d',d);svg.setAttribute('viewBox','0 0 '+vw+' '+o.h);svg.setAttribute('preserveAspectRatio','none')}
else{svg.setAttribute('viewBox','0 0 '+o.w+' '+o.h);svg.setAttribute('preserveAspectRatio','none')}
p.removeAttribute('stroke-dasharray');p.removeAttribute('stroke-dashoffset');p.style.strokeDasharray='none';p.style.strokeDashoffset='0'}
function place(){var hosts=new Set();document.querySelectorAll('.TextShape-node').forEach(function(n){orig(n);hosts.add(n.parentElement)});
hosts.forEach(function(host){var hr=host.getBoundingClientRect();if(!hr.width)return;
var spans=host.querySelectorAll('[class*="text-highlight"]');var nodes=[].filter.call(host.children,function(n){return n.classList.contains('TextShape-node')});
var groups=[];nodes.forEach(function(n){if(n.getAttribute('data-index')==='0'||!groups.length)groups.push([]);groups[groups.length-1].push(n)});
groups.forEach(function(grp,g){if(g>=spans.length)grp.forEach(function(n){n.style.display='none'})});
[].forEach.call(spans,function(sp,g){var grp=groups[g];if(!grp||!grp.length)return;var shape=grp[0].getAttribute('data-shape')||'',fs=parseFloat(getComputedStyle(sp).fontSize)||16;
var ls=lines(sp,hr);if(!ls.length)return;
if(RING.test(shape)){var o=orig(grp[0]),L=Math.min.apply(null,ls.map(function(l){return l.left})),R=Math.max.apply(null,ls.map(function(l){return l.right})),T=ls[0].top,B=ls[ls.length-1].top+ls[ls.length-1].height;
var px=Math.max(0,(o.w-(R-L))/2),py=Math.max(0,(o.h-(B-T))/2);if(ls.length>1||o.w<R-L){px=fs*0.3;py=fs*0.2}
ls=[{left:L-px,right:R+px,top:T-py,height:B-T+2*py,ring:1}]}
while(grp.length<ls.length){var c=grp[grp.length-1].cloneNode(true);c.setAttribute('data-index',String(grp.length));grp[grp.length-1].after(c);grp.push(c)}
var k=shape==='marker'?fs*0.369:-fs*0.08;
grp.forEach(function(n,i){var l=ls[i];if(!l){n.style.display='none';return}n.style.display='';var o=orig(n);
var w=l.ring?l.right-l.left:Math.max(0,l.right-l.left-2*k),h=l.height,top=l.top;
n.style.fontSize=fs+'px';n.style.left=(l.ring?l.left:l.left+k)+'px';n.style.top=top+'px';n.style.width=w+'px';n.style.height=h+'px';draw(n,shape,fs,w,h)})})})}
var t;addEventListener('resize',function(){clearTimeout(t);t=setTimeout(place,60)});
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(place);addEventListener('load',place);place();
})();</script>`;

// Rendered copies come in two layouts, captured at phone and desktop width (Squarespace's breakpoint is 768px).
// index.html picks one by the width it is given: the browser window when opened as a link, or the frame's own width
// when embedded in a portfolio page. Each page switches if its width later crosses the breakpoint (rotation, resize).
// The width is the layout viewport's (clientWidth), not innerWidth: on a phone, anything wider than the screen makes
// the browser zoom out and innerWidth grow past the breakpoint, which flipped a phone page to desktop and back
// forever (Dreamsake, Borrachito, 2026-10-22). A switch back within a few seconds of the last one is also refused.
const BREAKPOINT = 768;
const LOADER_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script>location.replace(((document.documentElement.clientWidth||innerWidth)<${BREAKPOINT}?'mobile':'desktop')+'.html'+location.search+location.hash)</script></head>
<body><noscript><a href="desktop.html">Open the preview</a></noscript></body></html>`;
const widthScript = (layout) => `<script id="preserve-width">(function(){var m=${layout === 'mobile' ? 'true' : 'false'},t;
function w(){return document.documentElement.clientWidth||innerWidth}
addEventListener('resize',function(){clearTimeout(t);t=setTimeout(function(){if((w()<${BREAKPOINT})===m)return;
var k='pv-switch',last=0;try{last=+sessionStorage.getItem(k)||0;sessionStorage.setItem(k,String(Date.now()))}catch(e){}
if(Date.now()-last<5000)return;location.replace((m?'desktop':'mobile')+'.html'+location.search+location.hash)},250)})})();</script>`;

// Nothing on a page reaches past the screen's right edge: the live site clips it (with its own script or styles),
// and on a phone a copy that didn't would let the page zoom out to show it.
const CLIP_CSS = '<style id="preserve-clip">html,body{overflow-x:clip}</style>';

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
  // Loaders for outside code (tag managers, referral widgets, ad pixels): they inject a script or image from another
  // host, which a copy blocks, leaving a failed request on every load. Owner code that only moves things has none.
  // Tag-manager-injected tags carry an empty id and a charset attribute.
  if ($(el).attr('id') === '' && $(el).attr('charset') !== undefined) return false;
  if (/createElement\(\s*[\w'"]+\s*\)[\s\S]{0,400}\.(src|async)\s*=|new\s+Image\s*\(|AnalyticsObject/.test(t)) return false;
  if (/(^|[^\w.$])(Y|Static|Squarespace|jQuery|SQS)\s*\.|(^|[^\w.])\$\s*\(|window\.Static|fbq|gtag/.test(t)) return false;
  return true;
}

export { MENU_SCRIPT, SLIDER_SCRIPT, SHAPES_SCRIPT, isOwnerScript };

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
    if (outName !== 'index.html') $('head').append(CLIP_CSS);
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
      $('body').append(SLIDER_SCRIPT);
      $('body').append(SHAPES_SCRIPT);
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
