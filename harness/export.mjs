// Exports a copy as one self-contained HTML file (images, fonts and CSS inlined) that opens straight from disk.
// Usage: node export.mjs <siteDir> <variant> <outFile.html> [desktop|mobile]
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { startServer } from './server.mjs';
import { serverVariants, VARIANTS } from './build.mjs';
import { PROFILES, launch, sleep } from './lib.mjs';

const [siteDir, variant, outFile, prof = 'desktop'] = process.argv.slice(2);
const port = 8900 + Math.floor(Math.random() * 90);
const srv = await startServer(siteDir, port, serverVariants());
const base = `http://127.0.0.1:${port}`;
const pageUrl = VARIANTS[variant].source === 'server' ? `${base}/${variant}/` : `${base}/${variant}/${prof}.html`;

// 1. Let a real browser lay out the page and pick each image's size, then pin those choices.
const browser = await launch();
const ctx = await browser.newContext({ ...PROFILES[prof].context });
await ctx.route((u) => !/^(localhost|127\.0\.0\.1)$/.test(new URL(u).hostname), (r) => r.abort());
const page = await ctx.newPage();
await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
for (let y = 0; y < 30; y++) { await page.evaluate(() => scrollBy(0, innerHeight * 0.8)); await sleep(150); }
await page.evaluate(() => scrollTo(0, 0)); await sleep(1500);
let html = await page.evaluate(() => {
  for (const img of document.images) {
    const cur = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src');
    if (cur) img.setAttribute('src', cur);
    img.removeAttribute('srcset'); img.removeAttribute('sizes'); img.removeAttribute('loading');
  }
  document.querySelectorAll('picture source, video source').forEach((s) => s.remove());
  // Entrance animations were played during the scroll above; reset them so they play again for the viewer.
  document.querySelectorAll('.preFade,.preSlide,.preScale,.preClip,.preFlex').forEach((el) => el.classList.remove('fadeIn', 'slideIn', 'scaleIn', 'clipIn', 'flexIn'));
  return '<!doctype html>\n' + document.documentElement.outerHTML;
});
await browser.close();

// 2. Inline everything the page needs.
const cache = new Map();
async function get(u, accept = 'image/webp,image/*,*/*') {
  const abs = new URL(u, base).href;
  if (!abs.startsWith(base)) return null;
  if (cache.has(abs)) return cache.get(abs);
  const r = await fetch(abs, { headers: { accept, 'accept-encoding': 'identity' } }).catch(() => null);
  const v = r && r.ok ? { buf: Buffer.from(await r.arrayBuffer()), ct: (r.headers.get('content-type') || 'application/octet-stream').split(';')[0], url: abs } : null;
  cache.set(abs, v); return v;
}
const dataUri = (v) => `data:${v.ct};base64,${v.buf.toString('base64')}`;
async function inlineCssUrls(css, from) {
  const refs = [...new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]))].filter((r) => !r.startsWith('data:') && !r.startsWith('#'));
  for (const r of refs) {
    const v = await get(new URL(r, from).href);
    css = css.split(r).join(v ? dataUri(v) : 'about:blank');
  }
  // @import "x.css"
  for (const m of [...css.matchAll(/@import\s+(['"])([^'"]+)\1\s*;/g)]) {
    const v = await get(new URL(m[2], from).href, 'text/css');
    css = css.replace(m[0], v ? await inlineCssUrls(v.buf.toString('utf8'), v.url) : '');
  }
  return css;
}
const $ = cheerio.load(html);
$('script:not(#preserve-replica):not(#preserve-motion):not(#preserve-width)').filter((_, el) => !/json/.test($(el).attr('type') || '')).remove();
$('noscript').remove();
// Third-party embeds (signup widgets etc.) would reach outside servers; a severed copy drops them.
$('iframe').remove();
$('link[rel=preload][as=font], link[rel=preload][as=image], link[rel=modulepreload], link[rel=preload][as=script]').remove();
for (const el of $('link[rel=stylesheet], link[rel=preload][as=style]').toArray()) {
  const href = $(el).attr('href'); const v = href && (await get(href, 'text/css'));
  $(el).replaceWith(v ? `<style>${await inlineCssUrls(v.buf.toString('utf8'), v.url)}</style>` : '');
}
for (const el of $('style').toArray()) $(el).text(await inlineCssUrls($(el).text(), pageUrl));
for (const el of $('[style*="url("]').toArray()) $(el).attr('style', await inlineCssUrls($(el).attr('style'), pageUrl));
for (const el of $('img[src], video[poster], link[rel*=icon]').toArray()) {
  const attr = el.tagName === 'video' ? 'poster' : el.tagName === 'link' ? 'href' : 'src';
  const s = $(el).attr(attr); if (!s || s.startsWith('data:')) continue;
  const v = await get(s); if (v) $(el).attr(attr, dataUri(v)); else $(el).removeAttr(attr);
}
// Downloaded copies sit side by side as <site>-desktop.html / <site>-mobile.html: switch between those names.
$('#preserve-width').text(`(function(){var m=${prof === 'mobile'},t;addEventListener('resize',function(){clearTimeout(t);t=setTimeout(function(){if((innerWidth<768)!==m)location.replace(location.href.replace(m?'-mobile.html':'-desktop.html',m?'-desktop.html':'-mobile.html'))},250)})})();`);
// Leftover pointers into the copy server (data-* attributes etc.) do nothing offline.
for (const el of $('*').toArray()) for (const [a, val] of Object.entries(el.attribs || {})) if (/^data-/.test(a) && /\/x\//.test(val)) $(el).attr(a, "");
fs.writeFileSync(outFile, $.html());
// <site>.html: opens the layout that fits the window or frame it is shown in.
const stem = path.basename(outFile).replace(/-(desktop|mobile)\.html$/, '');
fs.writeFileSync(path.join(path.dirname(outFile), stem + '.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>location.replace('${stem}-'+(innerWidth<768?'mobile':'desktop')+'.html')</script></head><body></body></html>`);
srv.server.close();
console.log(outFile, Math.round(fs.statSync(outFile).size / 1024) + ' KB');
process.exit(0);
