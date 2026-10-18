// First-screen pass for optimized variants: inline the CSS the first screen needs, load the rest without
// blocking, preload fonts, and give the hero image top priority. Runs against a page served by server.mjs.
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { PROFILES, launch, sleep } from './lib.mjs';

function analyze() {
  const vh = innerHeight;
  const inView = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if ((r.width === 0 && r.height === 0) || (r.bottom >= 0 && r.top < vh * 1.1)) inView.add(el); // hidden elements too, so their display:none rules are kept
  }
  inView.add(document.documentElement); inView.add(document.body);
  const strip = (sel) => sel.replace(/::?(before|after|placeholder|selection|marker|first-line|first-letter|-webkit-[\w-]+|-moz-[\w-]+)/g, '').replace(/:(hover|focus|focus-visible|focus-within|active|visited|link|target|checked|disabled)/g, '');
  const matches = (sel) => {
    for (const part of sel.split(',')) {
      const s = strip(part).trim() || '*';
      try { for (const el of document.querySelectorAll(s)) if (inView.has(el)) return true; } catch { return true; }
    }
    return false;
  };
  const used = {};
  const walk = (rules, prefix) => {
    [...rules].forEach((r, i) => {
      const id = prefix + '/' + i;
      if (r instanceof CSSStyleRule) { if (r.selectorText.startsWith(':root') || matches(r.selectorText)) used[id] = true; }
      else if (r instanceof CSSMediaRule || r instanceof CSSSupportsRule) { if (r instanceof CSSSupportsRule || matchMedia(r.conditionText || r.media.mediaText).matches || true) walk(r.cssRules, id); }
      else used[id] = true; // @font-face, @keyframes, @import, @property, etc.
    });
  };
  const sheets = {};
  for (const s of document.styleSheets) {
    if (!s.href || !(s.ownerNode instanceof HTMLLinkElement)) continue;
    try { walk(s.cssRules, s.href); sheets[s.href] = true; } catch {}
  }
  // Hero: largest image in the first screen.
  let hero = null, area = 0;
  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    const a = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    if (a > area && img.currentSrc) { area = a; hero = { src: img.getAttribute('src'), current: img.currentSrc }; }
  }
  const fonts = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.(woff2?)(\?|$)|typekit.*\/l\?|fonts\.gstatic/.test(n) || /\/x\/use\.typekit\.net\/af\//.test(n));
  return { used: Object.keys(used), sheets: Object.keys(sheets), hero, fonts };
}

// Re-emit only the used rules of a stylesheet, in their original order and inside their @media/@supports wrappers.
function emit(rules, prefix, used) {
  let out = '';
  [...rules].forEach((r, i) => {
    const id = prefix + '/' + i;
    if (r.cssRules && (r instanceof CSSMediaRule || r instanceof CSSSupportsRule)) {
      const inner = emit(r.cssRules, id, used);
      if (inner) out += `@${r instanceof CSSMediaRule ? 'media ' + r.media.mediaText : 'supports ' + r.conditionText}{${inner}}`;
    } else if (used.has(id)) out += r.cssText;
  });
  return out;
}

export async function optimizeFirstScreen(baseUrl, siteDir, variant, pages) {
  const browser = await launch();
  const results = {};
  for (const [file, profiles] of Object.entries(pages)) {
    const used = new Set(); let sheets = new Set(); const heroes = {}; const fonts = new Set();
    let cssText = '';
    for (const prof of profiles) {
      const ctx = await browser.newContext({ ...PROFILES[prof].context });
      await ctx.route((u) => !/^(localhost|127\.0\.0\.1)$/.test(new URL(u).hostname), (r) => r.abort());
      const page = await ctx.newPage();
      await page.goto(`${baseUrl}/${variant}/${file}`, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await sleep(2500);
      const a = await page.evaluate(analyze);
      a.used.forEach((x) => used.add(x)); a.sheets.forEach((x) => sheets.add(x)); a.fonts.forEach((x) => fonts.add(x));
      heroes[prof] = a.hero;
      await ctx.close();
    }
    // Emit critical CSS from a fresh page so rule ids line up.
    {
      const ctx = await browser.newContext({ ...PROFILES.desktop.context });
      await ctx.route((u) => !/^(localhost|127\.0\.0\.1)$/.test(new URL(u).hostname), (r) => r.abort());
      const page = await ctx.newPage();
      await page.goto(`${baseUrl}/${variant}/${file}`, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await sleep(1000);
      cssText = await page.evaluate(({ used, emitSrc }) => {
        const emit = new Function('return ' + emitSrc)();
        const U = new Set(used); let out = '';
        for (const s of document.styleSheets) {
          if (!s.href || !(s.ownerNode instanceof HTMLLinkElement)) continue;
          try { out += emit(s.cssRules, s.href, U); } catch {}
        }
        return out;
      }, { used: [...used], emitSrc: emit.toString() });
      await ctx.close();
    }
    const p = path.join(siteDir, 'variants', variant, file);
    const $ = cheerio.load(fs.readFileSync(p, 'utf8'));
    const rel = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
    // Non-blocking full stylesheets.
    $('link[rel=stylesheet]').each((_, el) => {
      const href = $(el).attr('href');
      $(el).attr('rel', 'preload').attr('as', 'style').attr('onload', "this.onload=null;this.rel='stylesheet'");
      $(el).after(`<noscript><link rel="stylesheet" href="${href}"></noscript>`);
    });
    const head = [];
    head.push(`<style id="preserve-critical">${cssText.replace(/<\/style/gi, '<\\/style')}</style>`);
    for (const f of [...fonts].slice(0, 4)) head.push(`<link rel="preload" as="font" type="font/woff2" crossorigin href="${rel(f)}">`);
    // Hero image: eager, high priority, preloaded (per-profile pages get their own; shared pages get both with media queries).
    const heroList = Object.entries(heroes).filter(([, h]) => h);
    for (const [prof, h] of heroList) {
      $('img').filter((_, el) => $(el).attr('src') === h.src).attr('loading', 'eager').attr('fetchpriority', 'high').removeAttr('decoding');
      const media = profiles.length > 1 ? (prof === 'mobile' ? ' media="(max-width: 767px)"' : ' media="(min-width: 768px)"') : '';
      head.push(`<link rel="preload" as="image" fetchpriority="high" href="${rel(h.current)}"${media}>`);
    }
    $('head').prepend(head.join('\n'));
    fs.writeFileSync(p, $.html());
    results[file] = { criticalKB: Math.round(cssText.length / 1024), fonts: [...fonts].length, heroes };
  }
  await browser.close();
  return results;
}
