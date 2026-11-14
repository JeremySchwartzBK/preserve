// Builds the copy variants from a capture.
//   frozen        rendered DOM, every site script removed, assets as captured
//   frozen-opt    frozen + modern right-sized images, critical CSS, font preload/swap, image priority hints
//   opt-rendered  rendered DOM + only Squarespace look-and-feel scripts + the same optimizations
//   opt-server    original server HTML (pre-JavaScript) + Squarespace look-and-feel scripts + the same optimizations
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { rewriteUrls } from './server.mjs';
import { OVERLAY_SELECTORS, PROFILES } from './lib.mjs';

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
var t,LINK='You\\u2019re viewing a snapshot of how this page looks and feels. Links to other pages have been disabled.',FORM='You\\u2019re viewing a snapshot of how this page looks and feels. Forms and checkout have been disabled.';function toast(msg){if(!t){t=document.createElement('div');t.setAttribute('role','status');t.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);opacity:0;transition:all .25s;z-index:2147483647;background:#111;color:#fff;font:500 14px/1.4 system-ui,sans-serif;padding:12px 18px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;max-width:90vw;text-align:center';document.body.appendChild(t)}t.textContent=msg||FORM;var bg=document.elementFromPoint(innerWidth/2,innerHeight-40),c='';for(;bg&&bg.nodeType===1;bg=bg.parentElement){c=getComputedStyle(bg).backgroundColor;if(c&&!/rgba\\(.*,\\s*0\\)|transparent/.test(c))break;c=''}var m=(c||'rgb(255,255,255)').match(/\\d+/g)||[255,255,255],dark=(+m[0]*299+ +m[1]*587+ +m[2]*114)/1000<128;t.style.background=dark?'#fff':'#111';t.style.color=dark?'#111':'#fff';requestAnimationFrame(function(){t.style.opacity=1;t.style.transform='translateX(-50%)'});clearTimeout(t._h);t._h=setTimeout(function(){t.style.opacity=0;t.style.transform='translateX(-50%) translateY(20px)'},2600)}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href],button[type=submit],input[type=submit],form button,[class*="klaviyo-form"] button,button[class*="form-button"],.sqs-add-to-cart-button,[data-add-to-cart],.sqs-block-button-element');if(!a)return;
if(a.matches('[data-folder-id],[data-folder],.header-nav-folder-title,[data-action],[aria-controls]'))return;
if(a.tagName==='A'){if(a.hasAttribute('data-pv-internal'))return;var h=a.getAttribute('href')||'';if(h===''||h[0]==='#'||/^javascript:/i.test(h))return;var u=new URL(h,location.href);if(u.origin===location.origin&&u.pathname===location.pathname&&u.hash)return}
e.preventDefault();e.stopImmediatePropagation();toast(a.tagName==='A'?LINK:FORM)},true);
document.addEventListener('submit',function(e){e.preventDefault();e.stopImmediatePropagation();toast(FORM)},true);
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
var tp=m.querySelector('textPath.Marquee-svg-text'),path=m.querySelector('path.Marquee-path'),svg=m.querySelector('svg.Marquee-svg');if(!tp)return;
var ts=[].slice.call(tp.querySelectorAll('tspan')),n=m.querySelectorAll('textPath.Marquee-svg-group tspan').length||1;
var X0=ts.map(function(t){return parseFloat(t.getAttribute('x'))||0});if(ts.length<=n)return;
var w0=X0[n]-X0[0];if(!(w0>0))return;
// The spacing, the path and the bar's height were written for the text size at capture. The text size follows the
// width, so all of it is scaled by how much the text itself grew or shrank (item lengths are in the path's dashes).
var D0=path&&path.getAttribute('d'),A0=path&&(path.getAttribute('stroke-dasharray')||'').trim().split(/[\\s,]+/).map(parseFloat);
var L0=0;if(A0)for(var k=0;k<2*n&&k<A0.length;k+=2)L0+=A0[k]||0;
var H0=svg&&parseFloat(svg.style.height),T0=svg&&/translateY\\(([-\\d.]+)px\\)/.exec(svg.style.transform||'');
var sc=1,w=w0;
function fit(){var L=0;for(var k=0;k<n;k++)try{L+=ts[k].getComputedTextLength()}catch(e){}
var s=L0>0&&L>0?L/L0:1;if(!(s>0.2&&s<5)||Math.abs(s-sc)<0.01&&sc!==1)return;
p=p*s/sc;sc=s;w=w0*s;ts.forEach(function(t,i){t.setAttribute('x',String(X0[i]*s))});
if(path&&D0){path.setAttribute('d',D0.replace(/(-?[\\d.]+),(-?[\\d.]+)/g,function(_,x,y){return x+','+(parseFloat(y)*s)}));if(A0)path.setAttribute('stroke-dasharray',A0.map(function(a){return a*s}).join(' '))}
if(H0>0)svg.style.height=(H0*s)+'px';if(T0)svg.style.transform='translateY('+(parseFloat(T0[1])*s)+'px)'}
var sp=parseFloat(m.getAttribute('data-animation-speed')||'1')||1;var dir=m.getAttribute('data-animation-direction')==='right'?-1:1;
var p=-parseFloat(tp.getAttribute('startOffset')||'0')||0;var last=0;
var rt;addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(fit,80)});if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fit);fit();
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
// the menu still get the "snapshot" notice; while open, the header takes the menu's colour theme as Squarespace does; links to a spot on this page close the menu first.
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

// Galleries, carousels and slideshows (Squarespace gallery and summary blocks, gallery and list sections): the capture
// stepped each one through its slides and wrote down what every step changes (capture.mjs recordGalleries, in
// data-pv-gal). This plays those steps back: on its "next" / "previous" arrows, and on the site's own timer when the
// site played it by itself (paused while our checks compare pictures, and for visitors who ask for less motion).
// Classes are the ones this copy gives to the classes the capture saw (renamed as our stylesheet renames them), learned
// from the first step, where both the shown and the hidden slides' classes are present. Positions were measured at the
// capture width; at any other width they are scaled by how much wider or narrower the gallery is. Squarespace moved
// some galleries with its own animation code rather than CSS, so moving parts get a short slide of their own, played
// as the visitor sees it (2026-11-11, backbipoc and sunnie): a slide waiting far off to the side comes in from the edge
// the others move away from, one leaving goes the same way before it is parked, and one that wraps round from the
// front of the line to the back comes in from the edge too, never sweeping back across the gallery.
const GALLERY_SCRIPT = `<script id="preserve-gallery">(function(){
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
[].forEach.call(document.querySelectorAll('[data-pv-gal]'),function(g){
var cfg;try{cfg=JSON.parse(g.getAttribute('data-pv-gal'))}catch(e){return}
var steps=cfg.steps||[],n=steps.length;if(n<2)return;
var els=[];[].forEach.call(g.querySelectorAll('[data-pv-gi]'),function(e){els[+e.getAttribute('data-pv-gi')]=e});
if(g.hasAttribute('data-pv-gi'))els[+g.getAttribute('data-pv-gi')]=g;
var map={},base=[];
els.forEach(function(e,j){if(!e)return;var c=steps[0][j][0];if(!(c in map))map[c]=e.getAttribute('class')||'';base[j]=e.getAttribute('style')||''});
function cls(e,j,c){if(c in map)return e.setAttribute('class',map[c]);var was=steps[0][j][0].split(/\\s+/),now=c.split(/\\s+/);
was.forEach(function(x){if(x&&now.indexOf(x)<0)e.classList.remove(x)});now.forEach(function(x){if(x&&was.indexOf(x)<0)e.classList.add(x)})}
function scale(css){var k=g.getBoundingClientRect().width/(cfg.w||1);if(!k||Math.abs(k-1)<0.01)return css;
return css.replace(/(^|;)\\s*(left|right|transform|translate|margin-left|margin-right)\\s*:[^;]*/g,function(d){return d.replace(/(-?\\d*\\.?\\d+)px/g,function(_,v){return(+v*k).toFixed(2)+'px'})})}
var cur=0;
function decl(css){var o={};(css||'').split(';').forEach(function(d){var k=d.indexOf(':');if(k>0)o[d.slice(0,k).trim().toLowerCase()]=d.slice(k+1).trim()});return o}
var first=steps[0].map(function(s){return decl(s[1])});
function put(i){steps[i].forEach(function(s,j){var e=els[j];if(!e)return;cls(e,j,s[0]);
e.setAttribute('style',base[j]);if(!base[j])e.removeAttribute('style');
if(i){var to=decl(scale(s[1]||''));for(var k in first[j])if(!(k in to))e.style.removeProperty(k);
for(k in to){var v=to[k],imp=/!important$/.test(v);e.style.setProperty(k,v.replace(/\\s*!important$/,''),imp?'important':'')}}
var a0=kv(steps[0][j][2]),a1=kv(s[2]);for(var a in a0)if(!(a in a1))e.removeAttribute(a);for(a in a1)e.setAttribute(a,a1[a]);
});order(i)}
var E='.65s cubic-bezier(.215,.61,.355,1)',ends=[];
function draw(i,anim,dir){ends.forEach(clearTimeout);ends=[];
if(!anim||reduce){els.forEach(function(e){if(e){e.style.transition='none';e.style.translate=''}});put(i);return}
var gl=g.getBoundingClientRect(),W=gl.width||1,x=function(e){return e?e.getBoundingClientRect().left-gl.left:0};
var b4=els.map(function(e){if(e){e.style.transition='opacity '+E;e.style.translate=''}return x(e)});
put(i);els.forEach(function(e){if(e)e.style.transition='opacity '+E});var af=els.map(x),near=function(v){return v>-2*W&&v<3*W};
var ds=[];els.forEach(function(e,j){var d=af[j]-b4[j];if(e&&near(b4[j])&&near(af[j])&&Math.abs(d)>1&&Math.abs(d)<1.5*W)ds.push(d)});
var sg=dir||(ds.length?(ds.filter(function(d){return d<0}).length>=ds.length/2?1:-1):1);ds=ds.filter(function(d){return (d<0)===(sg>0)});
ds.sort(function(a,b){return Math.abs(a)-Math.abs(b)});var D=ds.length?ds[ds.length>>1]:-sg*W;
els.forEach(function(e,j){if(!e)return;var a=af[j],b=b4[j],d=a-b,from=0,to=0,park=false;if(Math.abs(d)<1)return;
if(near(a)&&near(b)&&(d<0)===(D<0)&&Math.abs(d)<1.5*W){from=-d}
else if(near(a)){from=-D}
else if(near(b)){from=-d;to=-d+D;park=true}
else return;
e.style.transition='opacity '+E;e.style.translate=from+'px 0';e.getBoundingClientRect();
e.style.transition='translate '+E+',opacity '+E;e.style.translate=to?to+'px 0':'0px 0';
if(park)ends.push(setTimeout(function(){e.style.transition='none';e.style.translate=''},700))})}
function kv(t){var o={};(t||'').split('\u001f').forEach(function(x){var k=x.indexOf('=');if(k>0)o[x.slice(0,k)]=x.slice(k+1)});return o}
function order(i){var ps=[];els.forEach(function(e){if(e&&e.parentElement&&ps.indexOf(e.parentElement)<0)ps.push(e.parentElement)});
ps.forEach(function(p){var kids=[];els.forEach(function(e,j){if(e&&e.parentElement===p)kids.push(j)});if(kids.length<2)return;
var moved=kids.some(function(j){return steps[i][j][3]!==steps[0][j][3]})||i===0;if(!moved)return;
var anchor=null;kids.forEach(function(j){var nx=els[j].nextSibling;while(nx&&kids.some(function(k){return els[k]===nx}))nx=nx.nextSibling;if(!anchor||(nx&&anchor.compareDocumentPosition(nx)&4))anchor=nx});
kids.sort(function(a,b){return steps[i][a][3]-steps[i][b][3]}).forEach(function(j){p.insertBefore(els[j],anchor)})})}
function go(i,dir){cur=((i%n)+n)%n;draw(cur,true,dir)}
// A recorded rhythm (dt: ms before each step) can split one slide change into quick steps; an arrow plays a whole one.
var dt=cfg.dt||null;function wait(i){return dt?dt[i]||cfg.auto:cfg.auto}function major(i){return !dt||dt[i]>=900}
var timer=null,sub=null;function restart(){clearTimeout(timer);if(!cfg.auto||reduce||window.__pvStill)return;
timer=setTimeout(function tick(){if(!document.hidden)go(cur+1,1);timer=setTimeout(tick,wait((cur+1)%n))},wait((cur+1)%n))}
function slide(d){clearTimeout(sub);var i=cur;if(d>0){do{i=(i+1)%n}while(!major(i)&&i!==cur)}else{while(!major(i)&&i)i--;do{i=(i-1+n)%n}while(!major(i)&&i!==cur)}
go(i,d);(function more(){var j=(cur+1)%n;if(!major(j)&&j){sub=setTimeout(function(){go(j,d);more()},Math.min(wait(j),900))}})()}
function bind(sel,d){[].forEach.call(document.querySelectorAll('['+sel+'="'+cfg.id+'"]'),function(b){b.addEventListener('click',function(e){e.preventDefault();e.stopImmediatePropagation();slide(d);restart()},true)})}
bind('data-pv-gal-next',1);bind('data-pv-gal-prev',-1);
// Drag or swipe: Squarespace lets visitors slide carousels and slideshows with the mouse held down or a finger, so a
// sideways drag of more than 40 pixels plays one step, like the arrow on that side. A drag doesn't count as a click.
var sx=null,sy=0,moved=false;
g.addEventListener('pointerdown',function(e){if(e.button)return;sx=e.clientX;sy=e.clientY;moved=false},true);
g.addEventListener('pointermove',function(e){if(sx!==null&&Math.abs(e.clientX-sx)>8)moved=true},true);
g.addEventListener('pointerup',function(e){if(sx===null)return;var dx=e.clientX-sx,dy=e.clientY-sy;sx=null;
if(Math.abs(dx)>40&&Math.abs(dx)>Math.abs(dy)){slide(dx<0?1:-1);restart()}},true);
g.addEventListener('pointercancel',function(){sx=null},true);
g.addEventListener('click',function(e){if(moved){e.preventDefault();e.stopImmediatePropagation();moved=false}},true);
g.addEventListener('dragstart',function(e){e.preventDefault()},true);
if(!g.style.touchAction)g.style.touchAction='pan-y';
var rt;addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){if(cur)draw(cur,false)},60)});
restart();
});
})();</script>`;

// Text highlights drawn as shapes (Squarespace's marker, underline, wave, scribble, circle...): absolutely placed SVG
// strokes, sized by Squarespace's script for the width it was drawn at. At any other width the text wraps differently,
// so this script places them again from where the highlighted text now falls, on load and on resize. Every shape is
// handled: a marker's stroke is redrawn; a wave's pattern is repeated and cut to length; any other shape is stretched
// from its drawn size. Shapes that ring the whole phrase (circle, box) cover the phrase, the rest go one per line.
// Shapes are placed where the text sits once its entrance animation is over: an animation partway through (myrtle-green's headings rise
// 18px into place) moves the text but not the shapes, which then sat a line-third low on every heading (2026-11-11).
// Strokes may run past their box, as live (not crispy enough's scribbled underline lost its loops, 2026-11-13); only a
// repeated wave is cut to length.
const SHAPES_SCRIPT = `<script id="preserve-shapes">(function(){
var RING=/circle|oval|ellipse|box|rect|bracket|bubble|cloud/i;
function lines(el,hr){var out=[];[].forEach.call(el.getClientRects(),function(q){if(q.width<1)return;var l=out[out.length-1];
if(l&&Math.abs(l.top-(q.top-hr.top))<2){l.right=Math.max(l.right,q.right-hr.left);l.left=Math.min(l.left,q.left-hr.left)}
else out.push({left:q.left-hr.left,right:q.right-hr.left,top:q.top-hr.top,height:q.height})});return out}
function moved(el,host){var x=0,y=0;for(var e=el;e&&e!==host;e=e.parentElement){var t=getComputedStyle(e).transform;if(t&&t!=='none'&&window.DOMMatrix){var m=new DOMMatrix(t);x+=m.e;y+=m.f}}return{x:x,y:y}}
function orig(n){var d=n.dataset;if(!d.pvW){d.pvW=parseFloat(n.style.width)||n.offsetWidth;d.pvH=parseFloat(n.style.height)||n.offsetHeight;var p=n.querySelector('path');if(p)d.pvD=p.getAttribute('d')||''}return{w:+d.pvW,h:+d.pvH,d:d.pvD||''}}
function draw(n,shape,fs,w,h){var p=n.querySelector('path'),svg=n.querySelector('svg');if(!p||!svg)return;
if(shape==='marker'){var y=h*0.55;p.setAttribute('d','M 0,'+y+' c '+w/8+',0 '+w/4+',0 '+w/2+',0 c '+w/4+',0 '+3*w/8+',0 '+w/2+',0');p.setAttribute('stroke-dasharray',String(w));p.setAttribute('stroke-dashoffset',String(2*w));return}
var o=orig(n);svg.style.width=w+'px';svg.style.height=h+'px';svg.style.overflow=/wave|zigzag/i.test(shape)?'hidden':'visible';
if(/wave|zigzag/i.test(shape)){var sc=h/o.h||1,vw=w/sc,m=/^\\s*(M[^cCsSlLqQ]*)([\\s\\S]*)$/.exec(o.d),d=o.d;if(m&&o.w>0)for(var i=1;i*o.w<vw;i++)d+=' '+m[2];p.setAttribute('d',d);svg.setAttribute('viewBox','0 0 '+vw+' '+o.h);svg.setAttribute('preserveAspectRatio','none')}
else{svg.setAttribute('viewBox','0 0 '+o.w+' '+o.h);svg.setAttribute('preserveAspectRatio','none')}
p.removeAttribute('stroke-dasharray');p.removeAttribute('stroke-dashoffset');p.style.strokeDasharray='none';p.style.strokeDashoffset='0'}
function place(){var hosts=new Set();document.querySelectorAll('.TextShape-node').forEach(function(n){orig(n);hosts.add(n.parentElement)});
hosts.forEach(function(host){var hr=host.getBoundingClientRect();if(!hr.width)return;
var spans=host.querySelectorAll('[class*="text-highlight"]');var nodes=[].filter.call(host.children,function(n){return n.classList.contains('TextShape-node')});
var groups=[];nodes.forEach(function(n){if(n.getAttribute('data-index')==='0'||!groups.length)groups.push([]);groups[groups.length-1].push(n)});
groups.forEach(function(grp,g){if(g>=spans.length)grp.forEach(function(n){n.style.display='none'})});
[].forEach.call(spans,function(sp,g){var grp=groups[g];if(!grp||!grp.length)return;var shape=grp[0].getAttribute('data-shape')||'',fs=parseFloat(getComputedStyle(sp).fontSize)||16;
var ls=lines(sp,hr);if(!ls.length)return;var sh=moved(sp,host);ls.forEach(function(l){l.left-=sh.x;l.right-=sh.x;l.top-=sh.y});
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

// Squarespace's portfolio "hover" layouts (a list of titles; hovering one shows its picture, in "follow" mode trailing the
// pointer): its script is dropped, so the pictures never showed (backbipoc, 2026-11-10). Ours shows the hovered title's
// picture with a short fade, and in follow mode moves the picture box to the pointer as Squarespace does. A tap on a
// phone has no hover, as live.
const HOVER_SCRIPT = `<script id="preserve-hover">(function(){
document.querySelectorAll('.portfolio-hover').forEach(function(root){
var items=[].slice.call(root.querySelectorAll('.portfolio-hover-item')),bgs=[].slice.call(root.querySelectorAll('.portfolio-hover-bg')),box=root.querySelector('.portfolio-hover-backgrounds');
if(!items.length||!bgs.length||!box)return;
var follow=/translate3d/.test(box.getAttribute('style')||'')||/hover-follow/.test(document.body.className)&&!/hover-static/.test(root.className);
bgs.forEach(function(b){var w=b.querySelector('.portfolio-hover-bg-img'),i=b.querySelector('img');if(i){i.style.display='block';if(!i.getAttribute('src')&&i.dataset.src)i.src=i.dataset.src;i.loading='eager'}if(w){w.style.transition='opacity .3s,visibility .3s,transform .3s'}});
function show(k){box.setAttribute('data-active',k<0?'false':'true');box.style.opacity=k<0?'0':'1';bgs.forEach(function(b,j){var on=j===k,w=b.querySelector('.portfolio-hover-bg-img');b.setAttribute('data-active',on?'true':'false');if(w){w.style.opacity=on?'1':'0';w.style.visibility=on?'visible':'hidden';w.style.transform=on?'none':''}})}
items.forEach(function(it,k){it.addEventListener('mouseenter',function(){show(k)});it.addEventListener('focus',function(){show(k)})});
var list=root.querySelector('.portfolio-hover-items')||root;list.addEventListener('mouseleave',function(){show(-1)});
if(follow){var host=box.parentElement||root;root.addEventListener('mousemove',function(e){var r=host.getBoundingClientRect();box.style.transform='translate3d('+(e.clientX-r.left-box.offsetWidth/2)+'px,'+(e.clientY-r.top-box.offsetHeight/2)+'px,0)'})}
show(-1)});
})();</script>`;

// Squarespace's radial gradient background set to follow the pointer (backbipoc's orange glow, 2026-11-10): capture
// keeps a still of the glow where it sat and its settings (capture.mjs canvasStills, data-pv-follow). Ours lays a CSS
// gradient over the still the first time the pointer moves in the section, drawn to match it (the same colours, a
// radius of the setting's percent of the section's shorter side, a smooth fall-off, the position measured from the
// bottom left as Squarespace does), then eases the glow to the pointer. Until then the still shows, as it looked.
const FOLLOW_SCRIPT = `<script id="preserve-follow">(function(){
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
document.querySelectorAll('img[data-pv-follow]').forEach(function(im){
var c;try{c=JSON.parse(im.getAttribute('data-pv-follow'))}catch(e){return}
function rgb(s){var m=String(s).match(/[\\d.]+/g)||[];return[+m[0]||0,+m[1]||0,+m[2]||0,m[3]==null?1:+m[3]]}
var a=rgb(c.c0),b=rgb(c.c1);if(c.inv){var t=a;a=b;b=t}
function mix(t){t=t*t*(3-2*t);return'rgba('+[0,1,2].map(function(k){return Math.round(a[k]+(b[k]-a[k])*t)}).join(',')+','+(a[3]+(b[3]-a[3])*t).toFixed(3)+')'}
var stops=[];for(var i=0;i<=8;i++)stops.push(mix(i/8)+' '+(i*12.5)+'%');stops=stops.join(',');
var d=document.createElement('div');if(im.className)d.className=im.className;d.setAttribute('style',im.getAttribute('style')||'');d.setAttribute('aria-hidden','true');
d.style.opacity='0';d.style.pointerEvents='none';im.parentNode.insertBefore(d,im.nextSibling);
var host=im.closest('section')||im.parentNode,px=(c.x||0)/100,py=1-(c.y||0)/100,tx=px,ty=py,on=false,raf=0,k=reduce?1:Math.min(1,0.04+0.16*(c.s==null?100:c.s)/100);
function paint(){var r=d.getBoundingClientRect(),R=Math.max(1,Math.min(r.width,r.height)*(c.r||30)/100);
d.style.background='radial-gradient(circle '+R.toFixed(1)+'px at '+(px*r.width).toFixed(1)+'px '+(py*r.height).toFixed(1)+'px,'+stops+')'}
function step(){raf=0;px+=(tx-px)*k;py+=(ty-py)*k;if(Math.abs(tx-px)<0.0005&&Math.abs(ty-py)<0.0005){px=tx;py=ty}paint();if(px!==tx||py!==ty)raf=requestAnimationFrame(step)}
host.addEventListener('pointermove',function(e){var r=d.getBoundingClientRect();if(!r.width||!r.height)return;
tx=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));ty=Math.max(0,Math.min(1,(e.clientY-r.top)/r.height));
if(!on){on=true;paint();d.style.opacity='1';im.style.visibility='hidden'}if(!raf)raf=requestAnimationFrame(step)});
addEventListener('resize',function(){if(on)paint()})});
})();</script>`;

// Pieces that show once the visitor scrolls down, such as "back to top" buttons (capture.mjs scrollShown,
// data-pv-scrollshow: how far down they show, how they display, whether clicking goes back to the top).
const SCROLL_SHOW_SCRIPT = `<script id="preserve-scroll-show">(function(){
[].forEach.call(document.querySelectorAll('[data-pv-scrollshow]'),function(el){
var c;try{c=JSON.parse(el.getAttribute('data-pv-scrollshow'))}catch(e){return}
var y=Math.max(1,c.y||1)*0.75,on=null;
function set(){var v=scrollY>=y;if(v===on)return;on=v;
if(v){if(getComputedStyle(el).display==='none')el.style.display=c.d||'block';el.style.visibility='visible';el.style.opacity='1';el.style.pointerEvents='auto'}
else{el.style.opacity='0';el.style.visibility='hidden';el.style.pointerEvents='none'}}
set();addEventListener('scroll',set,{passive:true});
if(c.top){el.style.cursor='pointer';el.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();scrollTo({top:0,behavior:'smooth'})},true)}
});
})();</script>`;

// Pointer followers (hello world studio's 3D cursor, not crispy enough's little pictures over some blocks; 2026-11-13):
// capture finds what moves with the mouse and marks it (capture.mjs pointerFollowers, data-pv-pointer; the block that
// shows it, data-pv-ptrig). Ours moves it with the pointer, shows it only over its block when it has one, and hides the
// arrow where the site did. Hidden until the pointer moves, and never on touch screens, which have no pointer.
const POINTER_SCRIPT = `<script id="preserve-pointer">(function(){
if(!(window.matchMedia&&matchMedia('(hover: hover) and (pointer: fine)').matches))return;
var css='';
[].forEach.call(document.querySelectorAll('[data-pv-pointer]'),function(el){
var c;try{c=JSON.parse(el.getAttribute('data-pv-pointer'))}catch(e){return}
var trig=c.on!=null?document.querySelector('[data-pv-ptrig="'+c.on+'"]'):null;if(c.on!=null&&!trig)return;
if(c.cur==='none'){var t=trig?'[data-pv-ptrig="'+c.on+'"]':'body>:not([id^="preserve"]):not([class*="preserve"])';css+=(trig?'':'html,body,')+t+','+t+' *{cursor:none!important}'}
var base=null,on=false;el.style.transition='none';el.style.visibility='hidden';
function show(){if(on)return;on=true;if(getComputedStyle(el).display==='none')el.style.display='block';el.style.visibility='visible';el.style.opacity='1'}
function hide(){on=false;el.style.visibility='hidden'}
function place(e){show();if(!base){el.style.left='0px';el.style.top='0px';el.style.right='auto';el.style.bottom='auto';var r=el.getBoundingClientRect();base={x:r.left,y:r.top}}
el.style.left=(e.clientX+c.dx-base.x)+'px';el.style.top=(e.clientY+c.dy-base.y)+'px'}
if(trig){trig.addEventListener('pointermove',place);trig.addEventListener('pointerleave',hide)}
else{document.addEventListener('pointermove',place);document.documentElement.addEventListener('pointerleave',hide)}
addEventListener('resize',function(){base=null});
});
if(css){var st=document.createElement('style');st.textContent=css;document.head.appendChild(st)}
})();</script>`;

// Squarespace's "film grain" image effect (field theory, 2026-11-10): the picture under a fine noise that flickers. The
// capture keeps the picture with one frame of grain in it (data-pv-fx="film-grain"); ours lays a few frames of our own
// noise over it (made here from a fixed seed, so every visit is the same) and steps through them, so it flickers as
// live. Still for visitors who ask for less motion and while our checks compare pictures.
// Strength and grain size are matched to the live effect (2026-11-11: frame-to-frame change ~4.6 levels, grains ~1.5 px);
// the first version drew sub-pixel grains so faint they averaged out and no one could see the flicker.
const GRAIN_SCRIPT = `<script id="preserve-grain">(function(){
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches,S=160,N=6,seed=7,urls=[];
function rnd(){seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff}
for(var f=0;f<N;f++){var cv=document.createElement('canvas');cv.width=cv.height=S;var x=cv.getContext('2d');if(!x)return;var im=x.createImageData(S,S);
for(var i=0;i<im.data.length;i+=4){var v=rnd()*255|0;im.data[i]=im.data[i+1]=im.data[i+2]=v;im.data[i+3]=255}x.putImageData(im,0,0);urls.push(cv.toDataURL())}
var layers=[];document.querySelectorAll('img[data-pv-fx="film-grain"]').forEach(function(im){var d=document.createElement('div');if(im.className)d.className=im.className;
d.setAttribute('style',im.getAttribute('style')||'');d.setAttribute('aria-hidden','true');d.style.pointerEvents='none';d.style.objectFit='';
d.style.backgroundImage='url('+urls[0]+')';d.style.backgroundSize=S*1.25+'px';d.style.mixBlendMode='overlay';d.style.opacity='0.24';im.parentNode.insertBefore(d,im.nextSibling);layers.push(d)});
if(!layers.length||reduce)return;var k=0;
setInterval(function(){if(window.__pvStill||document.hidden)return;k=(k+1)%N;layers.forEach(function(d){d.style.backgroundImage='url('+urls[k]+')'})},90);
})();</script>`;

// Width and height capture added to images that had none (capture.mjs: so a lazy image has its shape before it loads).
// Once the picture is in, they go again: the site's own rules size it from the picture, as live. Otherwise a rule that
// sets only the width at a narrower window (backbipoc's rotating badge, 170px) met our fixed height and the circle
// became an oval (2026-11-10).
// Freed as soon as the picture is in, even when it reports no pixel size: an SVG drawn from its viewBox alone does,
// and waiting on it kept backbipoc's 12px-high footer wordmark 200px wide, pushing the footer off the side (2026-11-11).
const DIMS_SCRIPT = `<script id="preserve-dims">(function(){
function free(i){i.removeAttribute('width');i.removeAttribute('height');i.removeAttribute('data-pv-dims')}
function each(){document.querySelectorAll('img[data-pv-dims]').forEach(function(i){if(i.complete)free(i);else i.addEventListener('load',function(){free(i)},{once:true})})}
each();addEventListener('DOMContentLoaded',each);
})();</script>`;

// Text Squarespace scales to fill its box ("sqsrte-scaled-text", renamed later by scrub; a heading set to fit the width): its script writes a
// pixel font size for the width it saw. At the capture width that size is kept as is; at any other width the text is
// scaled so it fills its box again (Myrtle Village Green's title, 2026-10-22, found by the size check).
const fitScript = (captureWidth) => `<script id="preserve-fit">(function(){
// Lines stay as the owner broke them (only their own line breaks): a size within a hair of the box edge must never wrap
// the last letter onto a line of its own (backbipoc's footer wordmark, 2026-11-10). At the capture width the size shrinks
// only if the line no longer fits; at other widths it is scaled so the widest line fills the box.
// The box itself claims no width of its own (width 0, at least its parent's): an unbreakable line sized for a wider
// window otherwise propped the whole section open, and backbipoc's footer ran off the right side below 1440 (2026-11-11).
var st=document.createElement('style');st.textContent='[class*="rte-scaled-text"]:not([class*="container"]),[class*="rte-scaled-text"]:not([class*="container"]) *{white-space:nowrap!important}[class*="rte-scaled-text-container"]{width:0!important;min-width:100%}';document.head.appendChild(st);
function fit(){var cw=document.documentElement.clientWidth;document.querySelectorAll('[class*="rte-scaled-text"]').forEach(function(s){if(/scaled-text-container/.test(s.className))return;var box=s.parentElement;if(!box)return;
var f0=+s.dataset.pvF0||parseFloat(s.style.fontSize)||parseFloat(getComputedStyle(s).fontSize);s.dataset.pvF0=f0;s.style.fontSize=f0+'px';
var w=s.scrollWidth||s.offsetWidth,b=box.clientWidth;if(!w||!b)return;
if(Math.abs(cw-${captureWidth})<2){if(w>b+0.5)s.style.fontSize=(f0*b/w)+'px';return}
s.style.fontSize=(f0*b/w)+'px'})}
var t;addEventListener('resize',function(){clearTimeout(t);t=setTimeout(fit,60)});
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fit);addEventListener('load',fit);fit();
})();</script>`;

// Squarespace pads the first section and the menu overlay by the header's height, written in pixels for the width it
// saw (the header sits over the page). At another width the header is a different height (the menu wraps, the logo
// scales), so the frozen padding left a gap or hid content under the header (Fireside, Luigi's, Frankly, 2026-10-23,
// found by the size check). At the capture width the padding is kept as is; at any other width it is the header's
// height now, plus whatever the padding had beyond the header's height at capture (data-pv-h0, see capture.mjs). The
// header's height now leaves out the announcement bar the copy drops, as the live site does once the bar is gone.
const HEADER_PAD_SCRIPT = (captureWidth) => `<script id="preserve-header-pad">(function(){
if(window.__pvNoHeaderPad)return;var h=document.querySelector('[data-pv-h0]')||document.querySelector('header');if(!h)return;
var els=[].slice.call(document.querySelectorAll('[data-pv-hpad]'));if(!els.length)return;
var h0=parseFloat(h.getAttribute('data-pv-h0'));
els.forEach(function(e){e.dataset.pvP0=parseFloat(e.style.paddingTop)||0});
function fit(){var cw=document.documentElement.clientWidth,hh=h.getBoundingClientRect().height;els.forEach(function(e){var p0=+e.dataset.pvP0;
if(Math.abs(cw-${captureWidth})<2||!(p0>0)){e.style.paddingTop=p0+'px';return}
e.style.paddingTop=(hh+(h0>0?Math.max(0,p0-h0):0))+'px'})}
var t;addEventListener('resize',function(){clearTimeout(t);t=setTimeout(fit,60)});
if(window.ResizeObserver)new ResizeObserver(function(){fit()}).observe(h);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fit);addEventListener('load',fit);fit();
})();</script>`;

// Squarespace's image blocks in its grid layout carry their box height as a pixel number in a style variable
// (--image-component-container-height), worked out from the grid cell at the width it saw. At another width the
// cell is a different height, so the image stayed its capture-width size and pushed the rest of the section down
// (Luigi's logo, Fireside's title, 2026-10-23, found by the size check; 27 of the 58 showcase sites have one).
// At any width other than the capture width the number is worked out again the same way: the height the cell takes
// with the image box out of the way. A cell that has no height of its own (sized by its content) keeps the capture
// height scaled by the page width.
const FLUID_IMAGE_SCRIPT = (captureWidth) => `<script id="preserve-image-boxes">(function(){
var V='--image-component-container-height';
var els=[].filter.call(document.querySelectorAll('[style*="'+V+'"]'),function(e){return /px/.test(e.style.getPropertyValue(V))&&e.closest('.fe-block')});if(!els.length)return;
// The box itself (our stylesheet writes the number in as its height), or the element holding the number.
var box=els.map(function(e){return e.querySelector('.fluid-image-container')||e});
els.forEach(function(e){e.dataset.pvIh0=parseFloat(e.style.getPropertyValue(V))});
function set(i,h){els[i].style.setProperty(V,h+'px');box[i].style.height=h+'px'}
function fit(){var cw=document.documentElement.clientWidth;
if(Math.abs(cw-${captureWidth})<2){els.forEach(function(e,i){e.style.setProperty(V,e.dataset.pvIh0+'px');box[i].style.height=''});return}
els.forEach(function(e,i){set(i,0)});
var hs=els.map(function(e){return e.closest('.fe-block').getBoundingClientRect().height});
els.forEach(function(e,i){var h=hs[i];if(!(h>=2))h=e.dataset.pvIh0*cw/${captureWidth};set(i,h)})}
var t;addEventListener('resize',function(){clearTimeout(t);t=setTimeout(fit,60)});addEventListener('load',fit);fit();
})();</script>`;

// Rendered copies come in two layouts, captured at phone and desktop width (Squarespace's breakpoint is 768px).
// index.html picks one by the width it is given: the browser window when opened as a link, or the frame's own width
// when embedded in a portfolio page. Each page switches if its width later crosses the breakpoint (rotation, resize).
// The width is the layout viewport's (clientWidth), not innerWidth: on a phone, anything wider than the screen makes
// the browser zoom out and innerWidth grow past the breakpoint, which flipped a phone page to desktop and back
// forever (Dreamsake, Borrachito, 2026-10-22). A switch back within a few seconds of the last one is also refused.
// Inside a frame the page never switches: the embed code picks the layout and scales it (Jeremy, 2026-11-03), and a
// page switching on its own raced it and left the wrong layout showing.
const BREAKPOINT = 768;
const LOADER_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script>location.replace(((document.documentElement.clientWidth||innerWidth)<${BREAKPOINT}?'mobile':'desktop')+'.html'+location.search+location.hash)</script></head>
<body><noscript><a href="desktop.html">Open the preview</a></noscript></body></html>`;
const widthScript = (layout) => `<script id="preserve-width">(function(){if(window.top!==window)return;var m=${layout === 'mobile' ? 'true' : 'false'},t;
function w(){return document.documentElement.clientWidth||innerWidth}
addEventListener('resize',function(){clearTimeout(t);t=setTimeout(function(){if((w()<${BREAKPOINT})===m)return;
var k='pv-switch',last=0;try{last=+sessionStorage.getItem(k)||0;sessionStorage.setItem(k,String(Date.now()))}catch(e){var n=/pv-switch:(\\d+)/.exec(window.name);last=n?+n[1]:0;window.name='pv-switch:'+Date.now()}
if(Date.now()-last<5000)return;location.replace((m?'desktop':'mobile')+'.html'+location.search+location.hash)},250)})})();</script>`;

// Nothing on a phone page reaches past the screen's right edge: the live site clips it (with its own script or
// styles), and a copy that didn't would let the phone zoom out to show it. Phone layout only: on desktop nothing
// zooms out, and clipping there changed how Design Forward's own stylesheet laid out its columns.
// Block hover animations kept by capture (capture.mjs markBlockHovers): the hover's end state, eased in and out. The
// individual rotate/scale/translate properties add to any transform the block already has (entrance animations).
// Added by a script, since the page's own stylesheet is rebuilt from what elements look like at rest.
const HOVER_FX_CSS = `<script id="preserve-hover-fx">(function(){var s=document.createElement('style');s.textContent='@media (hover:hover){[data-pv-hover]{transition:rotate var(--pv-hd),scale var(--pv-hd),translate var(--pv-hd),opacity var(--pv-hd);transform-origin:var(--pv-hog,50% 50%)}[data-pv-hover]:hover{rotate:var(--pv-hr);scale:var(--pv-hs);translate:var(--pv-ht);opacity:var(--pv-ho)}}@media (prefers-reduced-motion:reduce){[data-pv-hover]{transition:none}}';document.head.appendChild(s)})();</script>`;
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

// Kept owner code runs the same on every load (custom code stage one, Jeremy 2026-10-29): it sees a clock that reads
// the moment of capture (moving on with the page's own timer, so its animations still run) and randomness seeded from
// the page, so a "quote of the day" or a shuffled grid shows what the person reviewed. Only owner code sees these: each
// kept script is wrapped in a block that shadows Date and Math, and our own scripts keep the real ones.
const STEADY_SCRIPT = (t0, seed) => `<script id="preserve-steady">(function(){var D=Date,T0=${t0},P=performance;
function now(){return T0+Math.round(P.now())}
function PvDate(){if(!(this instanceof PvDate))return new D(now()).toString();var a=[].slice.call(arguments);return a.length?new(Function.prototype.bind.apply(D,[null].concat(a))):new D(now())}
PvDate.prototype=D.prototype;PvDate.now=now;PvDate.parse=D.parse;PvDate.UTC=D.UTC;
var s=${seed}>>>0;function rnd(){s=(s+0x6D2B79F5)>>>0;var t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}
var M=Object.create(Math);M.random=rnd;window.__pvDate=PvDate;window.__pvMath=M})();</script>`;
const ownerWrap = (code) => `{const Date=window.__pvDate||window.Date,Math=window.__pvMath||window.Math;try{${code}\n}catch(e){}}`;

export { MENU_SCRIPT, SLIDER_SCRIPT, GALLERY_SCRIPT, SHAPES_SCRIPT, FOLLOW_SCRIPT, POINTER_SCRIPT, SCROLL_SHOW_SCRIPT, GRAIN_SCRIPT, isOwnerScript };

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
    if (outName === 'mobile.html') $('head').append(CLIP_CSS);
    if ($('[data-pv-hover]').length) $('body').append(HOVER_FX_CSS);
    // Spam-protection and tracking frames (reCAPTCHA on forms etc.) do nothing on a copy and throw errors offline.
    $('iframe').filter((_, el) => /recaptcha|doubleclick|facebook\.com\/tr|googletagmanager/.test($(el).attr('src') || '')).remove();
    $('.grecaptcha-badge, [class*="recaptcha"]').remove();
    // Scripts.
    let owners = 0;
    $('script').each((_, el) => {
      const c = v.scripts === 'none' ? (/ld\+json|application\/json/.test($(el).attr('type') || '') ? { keep: true, kind: 'data' } : isOwnerScript($, el) ? { keep: true, kind: 'site owner code (self-contained)', what: ($(el).html() || '').trim().slice(0, 100) } : { keep: false, kind: 'all scripts dropped' }) : classifyScript($, el);
      if (c.kind === 'site owner code (self-contained)') { $(el).html(ownerWrap($(el).html())).attr('data-pv-owner', String(owners++)); }
      if (outName !== 'mobile.html') report.scripts.push({ keep: c.keep, kind: c.kind, what: (c.what || '').slice(0, 140) });
      if (!c.keep) $(el).remove();
    });
    // The steady clock and randomness come first, so owner code anywhere on the page finds them.
    if (owners) {
      const t0 = Math.round(fs.statSync(path.join(siteDir, src)).mtimeMs);
      const seed = [...(siteHost || name)].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);
      $('head').prepend(STEADY_SCRIPT(t0, seed));
    }
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
      // An image with no width and height attributes may only get a size from its own pixels; lazy, it would never load
      // (capture.mjs adds the attributes wherever it can, so this is the rare leftover).
      $('img').each((_, el) => { if (!$(el).attr('loading') && ($(el).attr('width') || $(el).attr('height'))) $(el).attr('loading', 'lazy'); $(el).attr('decoding', 'async'); });
    }
    if (v.scripts === 'none') {
      // Put entrance animations back to their start state; MOTION_SCRIPT plays them.
      $('.preFade,.preSlide,.preScale,.preClip,.preFlex').removeClass('fadeIn slideIn scaleIn clipIn flexIn');
      $('body').append(MOTION_SCRIPT);
      $('body').append(MENU_SCRIPT);
      $('body').append(SLIDER_SCRIPT);
      if ($('[data-pv-gal]').length) $('body').append(GALLERY_SCRIPT);
      $('body').append(SHAPES_SCRIPT);
      const pxPad = (_, el) => /padding-top:\s*[\d.]+px/.test($(el).attr('style') || '');
      const padded = [$('.header-menu').filter(pxPad).first(), $('section.page-section').first().filter(pxPad)].filter((x) => x.length);
      if (outName !== 'index.html' && padded.length) { padded.forEach((x) => x.attr('data-pv-hpad', '')); $('body').append(HEADER_PAD_SCRIPT(PROFILES[outName === 'mobile.html' ? 'mobile' : 'desktop'].context.viewport.width)); }
      if (outName !== 'index.html' && $('[style*="--image-component-container-height"]').length) $('body').append(FLUID_IMAGE_SCRIPT(PROFILES[outName === 'mobile.html' ? 'mobile' : 'desktop'].context.viewport.width));
      if ($('img[data-pv-dims]').length) $('body').append(DIMS_SCRIPT);
      if ($('canvas[data-preserve-follow], img[data-pv-follow]').length) $('body').append(FOLLOW_SCRIPT);
      if ($('[data-pv-pointer]').length) $('body').append(POINTER_SCRIPT);
      if ($('[data-pv-scrollshow]').length) $('body').append(SCROLL_SHOW_SCRIPT);
      if ($('canvas[data-preserve-fx="film-grain"], img[data-pv-fx="film-grain"]').length) $('body').append(GRAIN_SCRIPT);
      if ($('.portfolio-hover .portfolio-hover-item').length) $('body').append(HOVER_SCRIPT);
      if (outName !== 'index.html' && $('[class*="rte-scaled-text"]').length) $('body').append(fitScript(PROFILES[outName === 'mobile.html' ? 'mobile' : 'desktop'].context.viewport.width));
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
