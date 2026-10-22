// Exports a frozen-opt copy as a folder of plain files for a static host (Cloudflare Pages).
//   <outRoot>/<site>/desktop.html, mobile.html   the two layouts
//   <outRoot>/<site>/a/<hash>.<ext>              every asset, content-hashed so it can be cached forever
// Images are written at every size the page lists (srcset), as WebP (all current browsers; no per-request negotiation).
// Pages are served extensionless (/site/mobile): Pages redirects *.html, which would cost a round trip.
// Usage: node export-static.mjs <siteDir> <site> <outRoot>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { startServer } from './server.mjs';
import { serverVariants } from './build.mjs';
import { PROFILES, launch, sleep } from './lib.mjs';
import sharp from 'sharp';

const [siteDir, site, outRoot] = process.argv.slice(2);
const VARIANT = 'frozen-opt';
const BREAKPOINT = 768;
const srv = await startServer(siteDir, 0, serverVariants());
const port = srv.port;
const base = `http://127.0.0.1:${port}`;
const assetDir = path.join(outRoot, site, 'a');
fs.mkdirSync(assetDir, { recursive: true });

const EXT = { 'image/webp': 'webp', 'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'text/css': 'css', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/javascript': 'js', 'text/javascript': 'js', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
const memo = new Map();
const misses = [];
let bytes = 0;

// Local copy-server URL -> public path of the exported file (null if the server doesn't have it).
function asset(abs) {
  abs = abs.split('#')[0];
  if (!memo.has(abs)) memo.set(abs, (async () => {
    const r = await fetch(abs, { headers: { accept: 'image/webp,image/*,*/*;q=0.8', 'accept-encoding': 'identity' } }).catch(() => null);
    if (!r || !r.ok) { misses.push(abs.replace(base, '')); return null; }
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
    let buf = Buffer.from(await r.arrayBuffer());
    if (/css/.test(ct)) buf = Buffer.from(await localizeCss(buf.toString('utf8'), abs, '')); // stylesheets sit in a/ beside what they use
    const magic = buf.subarray(0, 4).toString('latin1');
    const ext = magic === 'wOF2' ? 'woff2' : magic === 'wOFF' ? 'woff' : EXT[ct] || (/\.(\w{2,5})$/.exec(new URL(abs).pathname) || [, 'bin'])[1].toLowerCase();
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + '.' + ext;
    const p = path.join(assetDir, name);
    if (!fs.existsSync(p)) { fs.writeFileSync(p, buf); bytes += buf.length; }
    return name;
  })());
  return memo.get(abs);
}

// A reference found in the page or a stylesheet -> its path relative to where it is used (pages: a/<file>; stylesheets,
// which live in a/: <file>). Relative paths let the same folder be served under a permanent copy ID, a friendly name,
// or any folder on a customer's own host. References outside the copy are left alone.
async function ref(u, from, pfx = 'a/') {
  if (!u || /^(data:|#|about:|javascript:|mailto:|tel:)/i.test(u.trim())) return u;
  let abs; try { abs = new URL(u.trim(), from).href; } catch { return u; }
  if (!abs.startsWith(base + '/')) return u;
  const hash = abs.includes('#') ? abs.slice(abs.indexOf('#')) : '';
  const p = await asset(abs);
  return p ? pfx + p + hash : u;
}

async function localizeCss(css, from, pfx = 'a/') {
  const refs = new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]));
  for (const m of css.matchAll(/@import\s+(['"])([^'"]+)\1/g)) refs.add(m[2]);
  for (const r of refs) { const p = await ref(r, from, pfx); if (p !== r) css = css.split(r).join(p); }
  return css;
}

async function srcset(v, from) {
  const parts = [];
  for (const c of v.split(/,\s+/)) { const [u, ...d] = c.trim().split(/\s+/); if (u) parts.push([await ref(u, from), ...d].join(' ')); }
  return parts.join(', ');
}

// Third-party embeds (signup widgets, maps, feeds) would keep a hosted copy talking to outside servers. Photograph each
// one as it looks on the page and put the still image in its place; clicking it shows the replica notice.
async function embedStills(layout, pageUrl) {
  const browser = await launch();
  const ctx = await browser.newContext({ ...PROFILES[layout].context });
  const page = await ctx.newPage();
  await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await sleep(1000);
  // First-screen images: which file the browser picked at this layout's width and pixel density, and which is biggest.
  const firstScreen = await page.evaluate(() => [...document.images].map((img, i) => {
    const r = img.getBoundingClientRect();
    const vis = r.width > 1 && r.height > 1 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
    if (!vis || !img.currentSrc) return null;
    // Smallest srcset candidate that covers the displayed size at this pixel density (cropped images need more width).
    const need = r.width * Math.min(devicePixelRatio, 2) * Math.max(1, (img.naturalWidth / img.naturalHeight) / (r.width / r.height) || 1);
    const cands = (img.getAttribute('srcset') || '').split(/,\s+/).map((c) => c.trim().split(/\s+/)).filter((c) => /w$/.test(c[1] || '')).map((c) => ({ u: c[0], w: parseInt(c[1]) })).sort((a, b) => a.w - b.w);
    const pick = cands.find((c) => c.w >= need) || cands.at(-1);
    const cur = new URL(pick ? pick.u : img.currentSrc, location.href);
    return { i, src: img.getAttribute('src'), current: cur.pathname + cur.search, need: Math.round(need), area: Math.min(r.width, innerWidth) * Math.min(r.height, innerHeight) };
  }).filter(Boolean));
  const out = [];
  out.firstScreen = firstScreen;
  const frames = await page.$$('iframe');
  for (const f of frames) {
    const src = (await f.getAttribute('src')) || '';
    let ext = false; try { ext = new URL(src, pageUrl).origin !== base; } catch {}
    if (!ext) { out.push(null); continue; }
    await f.scrollIntoViewIfNeeded().catch(() => {}); await sleep(4000);
    // Fixed headers and badges would otherwise land in the photo.
    await page.evaluate(() => { for (const el of document.querySelectorAll('body *')) if (getComputedStyle(el).position === 'fixed') el.style.visibility = 'hidden'; });
    const box = await f.boundingBox();
    const shot = box && box.width > 2 && box.height > 2 ? await f.screenshot({ timeout: 15000 }).catch(() => null) : null;
    // A widget that didn't draw (bot checks often stop it in our capture browser) keeps its space as an empty box.
    const st = shot && (await sharp(shot).greyscale().stats()).channels[0];
    if (!shot || st.max - st.min < 12) { out.push({ src, file: null, w: Math.round(box?.width || 0), h: Math.round(box?.height || 0) }); continue; }
    const buf = await sharp(shot).webp({ quality: 80 }).toBuffer();
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + '.webp';
    fs.writeFileSync(path.join(assetDir, name), buf); bytes += buf.length;
    out.push({ src, file: `a/${name}`, w: Math.round(box.width), h: Math.round(box.height) });
  }
  await browser.close();
  return out;
}
const stills = [];
let videoCount = 0;
const firstScreenBytes = {};

// A byte budget for the first screen. Each first-screen image is also written as AVIF (about 30% smaller than WebP);
// the WebP stays as the fallback for the few browsers that can't show AVIF. When the first screen is still over budget,
// the largest images get top priority and the rest wait their turn, so the screen looks complete sooner.
const FIRST_SCREEN_BUDGET = { desktop: 600e3, mobile: 300e3 };
async function firstScreenBudget($, layout) {
  const imgs = $('img[data-pv-fs]').toArray();
  let total = 0, avif = 0;
  const sized = [];
  for (const el of imgs) {
    const src = $(el).attr('src') || '';
    const area = +$(el).attr('data-pv-fs') || 0;
    $(el).removeAttr('data-pv-fs');
    if (!/^a\/[\w.-]+\.webp$/.test(src)) continue;
    const webp = fs.readFileSync(path.join(outRoot, site, src));
    let size = webp.length;
    try {
      const out = await sharp(webp, { animated: true }).avif({ quality: 60, effort: 3 }).toBuffer();
      if (out.length < webp.length * 0.9) {
        const name = crypto.createHash('sha1').update(out).digest('hex').slice(0, 12) + '.avif';
        if (!fs.existsSync(path.join(assetDir, name))) { fs.writeFileSync(path.join(assetDir, name), out); bytes += out.length; }
        $(el).attr('src', `a/${name}`).attr('onerror', `this.onerror=null;this.src='${src}'`);
        $(`link[rel=preload][as=image][href="${src}"]`).attr('href', `a/${name}`).attr('type', 'image/avif');
        size = out.length; avif++;
      }
    } catch {}
    total += size;
    sized.push({ el, area });
  }
  const over = total > FIRST_SCREEN_BUDGET[layout];
  if (over && sized.length > 3) {
    sized.sort((a, b) => b.area - a.area);
    sized.forEach((x, i) => $(x.el).attr('fetchpriority', i < 3 ? 'high' : 'low'));
  }
  return { images: sized.length, avif, kb: Math.round(total / 1024), budgetKb: FIRST_SCREEN_BUDGET[layout] / 1e3, over };
}
// Videos start once the page has loaded: those on the first screen right away (after their poster), the rest when the
// visitor scrolls near them. A video the browser can't autoplay stays on its poster, as it would on the live site.
const MEDIA_SCRIPT = `<script id="preserve-media">(function(){
var vs=[].slice.call(document.querySelectorAll('video[data-pv-defer]'));
function go(v){if(v.__pv)return;v.__pv=1;[].forEach.call(v.querySelectorAll('source[data-pv-src]'),function(s){s.src=s.getAttribute('data-pv-src');s.removeAttribute('data-pv-src')});v.preload='auto';v.load();if(v.hasAttribute('autoplay')){var p=v.play();if(p&&p.catch)p.catch(function(){})}}
function start(){var io='IntersectionObserver' in window?new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){io.unobserve(e.target);go(e.target)}})},{rootMargin:'50% 0px'}):null;vs.forEach(function(v){io?io.observe(v):go(v)})}
function later(){setTimeout(start,0)}
if(document.readyState==='complete')later();else addEventListener('load',later);
})();</script>`;

// Fonts the copy took from Google Fonts (google-fonts.py) ship with their licenses: the OFL asks that its text and each
// font's copyright line go along with the fonts. One text file beside the assets, linked from each page's head.
let licenseFile = null;
const gf = path.join(siteDir, 'fonts-google.json');
const licenses = fs.existsSync(gf) ? JSON.parse(fs.readFileSync(gf, 'utf8')).licenses || {} : {};
if (Object.keys(licenses).length) {
  const text = 'Fonts in this copy, from Google Fonts (https://fonts.google.com), and their licenses.\n\n' +
    Object.entries(licenses).sort().map(([family, l]) => `${'='.repeat(78)}\n${family}\n${'='.repeat(78)}\n\n${l.text.trim()}\n`).join('\n');
  const buf = Buffer.from(text);
  licenseFile = 'fonts-license-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + '.txt';
  fs.writeFileSync(path.join(assetDir, licenseFile), buf);
}

for (const layout of ['desktop', 'mobile']) {
  const pageUrl = `${base}/${VARIANT}/${layout}.html`;
  const $ = cheerio.load(fs.readFileSync(path.join(siteDir, 'variants', VARIANT, `${layout}.html`), 'utf8'));
  const shots = await embedStills(layout, pageUrl);
  // Each first-screen image gets the exact file the browser chose, loads eagerly, and the biggest one is preloaded at
  // top priority. Without this, "sizes=auto" and lazy loading made the hero wait for every stylesheet on a real CDN.
  const imgs = $('img').toArray();
  $('link[rel=preload][as=image]').remove();
  $('img[fetchpriority]').removeAttr('fetchpriority');
  const fs0 = shots.firstScreen.filter((f) => imgs[f.i] && $(imgs[f.i]).attr('src') === f.src);
  const hero = fs0.slice().sort((a, b) => b.area - a.area)[0];
  for (const f of fs0) {
    const el = $(imgs[f.i]);
    el.attr('src', `${base}${f.current}`).removeAttr('srcset').removeAttr('sizes').attr('loading', 'eager').removeAttr('decoding').attr('data-pv-fs', String(Math.round(f.area)));
    if (f === hero) el.attr('fetchpriority', 'high');
  }
  if (hero) $('head').prepend(`<link rel="preload" as="image" fetchpriority="high" href="${base}${hero.current}">`);
  // Full stylesheets load after the first screen at low priority (the first screen's rules are already inlined),
  // so they don't compete with the hero image for bandwidth.
  $('link[rel=preload][as=style]').each((_, el) => { $(el).attr('rel', 'stylesheet').attr('media', 'print').attr('onload', "this.media='all'"); });
  $('iframe').each((i, el) => {
    const s = shots[i]; if (!s) return;
    stills.push({ layout, src: s.src.slice(0, 80), replaced: !!s.file });
    if (!s.file) return $(el).replaceWith(s.h ? `<div class="preserve-embed-blank" style="width:100%;max-width:${s.w}px;height:${s.h}px"></div>` : '');
    $(el).replaceWith(`<img src="${s.file}" alt="" loading="lazy" decoding="async" class="preserve-embed-still" style="display:block;width:100%;max-width:${s.w}px;height:auto;aspect-ratio:${s.w}/${s.h};cursor:pointer" data-preserve-replica="1">`);
  });
  // Squarespace native video (video blocks and section backgrounds). Its player needs Squarespace's scripts, so the
  // copy's <video> was left empty. Point it at the files video.mjs saved (WebM first, then MP4, poster = first frame)
  // and follow the block's own settings (autoplay, loop, muted, controls). Background videos without a <video> get one.
  const vidW = layout === 'mobile' ? 640 : 1280;
  let videosWired = 0;
  for (const el of $('[data-config-video], [data-config-native-video], [data-config-video-background]').toArray()) {
    const cfg = Object.values(el.attribs).find((v) => v.includes('alexandriaUrl')) || '';
    const m = /"alexandriaUrl"\s*:\s*"([^"]+?)\{variant\}"/.exec(cfg.replace(/&quot;/g, '"'));
    if (!m) continue;
    let vb = m[1].replace(/^https?:\/\//, `/${VARIANT}/x/`);
    if (!vb.startsWith('/')) continue;
    const file = (ext) => `${base}${vb}preserve-${vidW}.${ext}`;
    let set = {}; try { set = JSON.parse(($(el).attr('data-config-settings') || '{}').replace(/&quot;/g, '"')); } catch {}
    const background = !$(el).attr('data-config-video') || /background/i.test($(el).attr('class') || '');
    let v = $(el).find('video').first();
    if (!v.length) { $(el).append('<video></video>'); v = $(el).find('video').last(); v.attr('style', 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'); }
    v.empty().removeAttr('src');
    v.attr('playsinline', '').attr('webkit-playsinline', '').attr('preload', 'metadata').attr('poster', file('jpg'));
    const auto = background || set.autoPlay !== false, loop = background || set.loop !== false;
    if (auto) v.attr('autoplay', ''); else v.removeAttr('autoplay');
    if (loop) v.attr('loop', ''); else v.removeAttr('loop');
    v.attr('muted', '');   // saved without sound for now (known limitation #3)
    if (!background && set.controls && set.controls !== 'none') v.attr('controls', '');
    // First screen goes first: the files are attached only after the page has loaded (preserve-media below), so a
    // video never competes with first-screen images. The poster (first frame) shows until then.
    v.attr('preload', 'none').attr('data-pv-defer', '');
    v.append(`<source data-pv-src="${file('webm')}" type="video/webm"><source data-pv-src="${file('mp4')}" type="video/mp4">`);
    $(el).find('.video-player__error').attr('style', 'display:none');
    $(el).find('.plyr').removeClass('plyr--error');
    videosWired++;
  }
  // Web-component widgets photographed during capture (see capture.mjs shadowStills): the picture takes their place.
  for (const el of $('[data-preserve-still]').toArray()) {
    const f = path.join(siteDir, 'stills', $(el).attr('data-preserve-still'));
    if (!fs.existsSync(f)) { $(el).removeAttr('data-preserve-still'); continue; }
    const img = sharp(fs.readFileSync(f)); const meta = await img.metadata();
    const dpr = layout === 'mobile' ? 3 : 1;
    const buf = await img.webp({ quality: 82 }).toBuffer();
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + '.webp';
    if (!fs.existsSync(path.join(assetDir, name))) { fs.writeFileSync(path.join(assetDir, name), buf); bytes += buf.length; }
    const w = Math.round(meta.width / dpr), h = Math.round(meta.height / dpr);
    $(el).replaceWith(`<img src="a/${name}" alt="" decoding="async" class="preserve-embed-still" style="display:block;width:100%;max-width:${w}px;height:auto;aspect-ratio:${w}/${h};cursor:pointer;margin:0 auto" data-preserve-replica="1">`);
    stills.push({ layout, src: 'web component', replaced: true });
  }
  $('meta[property^="og:"], meta[name^="twitter:"], meta[itemprop]').remove();
  for (const el of $('*').toArray()) {
    for (const [a, v] of Object.entries(el.attribs || {})) {
      if (a === 'srcset' || a === 'imagesrcset') $(el).attr(a, await srcset(v, pageUrl));
      else if (a === 'style' && v.includes('url(')) $(el).attr(a, await localizeCss(v, pageUrl));
      else if (a === 'src' || a === 'poster' || a === 'data-pv-src' || ((a === 'href' || a === 'xlink:href') && (el.tagName === 'link' || el.tagName === 'use' || el.tagName === 'image'))) $(el).attr(a, await ref(v, pageUrl));
      // Leftover pointers for Squarespace's loaders (data-src, data-image...) do nothing without its scripts.
      else if (/^data-/.test(a) && v.includes(`/${VARIANT}/x/`)) $(el).attr(a, '');
    }
  }
  for (const el of $('style').toArray()) $(el).text(await localizeCss($(el).text(), pageUrl));
  firstScreenBytes[layout] = await firstScreenBudget($, layout);
  for (const el of $('noscript').toArray()) {
    let t = $(el).html() || '';
    for (const m of t.matchAll(/href="([^"]+)"/g)) t = t.replace(m[1], await ref(m[1].replace(/&amp;/g, '&'), pageUrl));
    $(el).html(t);
  }
  // Switch layout when the width given doesn't match: on load (a frame or window the edge guessed wrong) and on resize.
  $('#preserve-width').text(`(function(){var m=${layout === 'mobile'},t;function c(){if((innerWidth<${BREAKPOINT})!==m)location.replace((m?'desktop':'mobile')+location.search+location.hash)}c();addEventListener('resize',function(){clearTimeout(t);t=setTimeout(c,250)})})();`);
  // Squarespace 7.1 fixed headers turn solid ("shrink") once the page scrolls; its script did that on the live site.
  $('body').append(`<script id="preserve-header">(function(){if(!document.body.classList.contains('tweak-fixed-header'))return;var h=document.querySelector('header.header,#header');if(!h)return;function f(){h.classList.toggle('shrink',scrollY>0)}addEventListener('scroll',f,{passive:true});f()})();</script>`);
  if (videosWired) $('body').append(MEDIA_SCRIPT);
  videoCount += videosWired;
  if (licenseFile) $('head').append(`<link rel="license" href="a/${licenseFile}">`);
  fs.writeFileSync(path.join(outRoot, site, `${layout}.html`), $.html());
}

const left = [...new Set([...fs.readFileSync(path.join(outRoot, site, 'desktop.html'), 'utf8').matchAll(new RegExp(`/${VARIANT}/x/[^"'\\s)<>]{0,120}`, 'g'))].map((m) => m[0]))];
srv.server.close();
console.log(JSON.stringify({ site, videosWired: videoCount, firstScreenBytes, fontLicense: licenseFile, files: fs.readdirSync(assetDir).length, MB: +(bytes / 1e6).toFixed(1), stills, misses: [...new Set(misses)].slice(0, 30), leftoverLocalRefs: left.slice(0, 10) }, null, 1));
process.exit(0);
