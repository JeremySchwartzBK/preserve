// "When in doubt, freeze" (custom code stage one, Jeremy 2026-10-29): a Preserve must look the same on every load,
// so a viewer sees exactly what the person reviewed. Each layout is opened twice, in fresh browsers, with the rules
// visitors get (policy.mjs) and our own slideshows held still; what the page shows (its elements, words, pictures and
// links) is compared. If the two loads differ, the kept owner scripts (build.mjs, data-pv-owner) are tried one at a time
// without each; one whose removal makes the loads agree is frozen: taken out, so the page keeps the look it had at
// capture. If none alone explains it, all of them are frozen. Our own scripts are never touched.
// Runs after scrub, before the quality check. Usage: node steady.mjs <stageDir> [siteDir]   (prints a JSON report)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { PROFILES, launch } from './lib.mjs';
import { policyHeaders } from './policy.mjs';
import * as cheerio from 'cheerio';

const SETTLE_MS = 4000;
const CT = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'application/javascript', webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', ico: 'image/x-icon' };

// What the page shows, without what changes on its own by design (classes and styles, which our slideshows and
// entrance animations set) or what is ours (preserve-* scripts and pins).
function snapshot(withText = true) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { const t = withText && c.textContent.replace(/\s+/g, ' ').trim(); if (t) out.push('"' + t); continue; }
      if (c.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(c.tagName) || /^preserve-/.test(c.id || '')) continue;
      out.push('<' + c.tagName + ['src', 'href', 'alt', 'aria-label'].map((a) => (c.getAttribute(a) ? ` ${a}=${c.getAttribute(a)}` : '')).join(''));
      walk(c);
      out.push('>');
    }
  };
  walk(document.body);
  return out.join('\n');
}

// How many of each kind of part the page has: tag and first class (div.bpim-swipe-thumb), ours left out.
function kinds() {
  const n = {};
  for (const e of document.body.querySelectorAll('*')) {
    if (/^preserve-/.test(e.id || '') || e.closest('[id^="preserve-"]')) continue;
    const c = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/)[0];
    const k = e.tagName.toLowerCase() + (c ? '.' + c : '');
    n[k] = (n[k] || 0) + 1;
  }
  return n;
}

// Where each built part sits on the page, with every animation held at its start: a part rebuilt by the owner's code
// has to land where the copy showed it, at the same size (Breathpod's hints, rebuilt without their styling, came out as
// large hands covering the phone pictures; 58-site re-run, 2026-11-28).
function boxes(list) {
  for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = 0; } catch {} }
  const out = {};
  for (const k of list) {
    const [t, c] = k.split('.');
    out[k] = [...document.querySelectorAll(t + '.' + CSS.escape(c))].filter((e) => !e.closest('[id^="preserve-"]')).map((e) => { const r = e.getBoundingClientRect(); return [r.left + scrollX, r.top + scrollY, r.width, r.height].map(Math.round); });
  }
  return out;
}
const sameBoxes = (a, b) => Object.keys(a).every((k) => a[k].length === (b[k] || []).length && a[k].every((x, j) => x.every((v, n) => Math.abs(v - b[k][j][n]) <= Math.max(8, 0.1 * Math.max(x[2], x[3], b[k][j][2], b[k][j][3])))));

// The owner's own style rules for parts their code builds (Breathpod's swipe hints: placed over each phone picture, a
// small faded hand). Our own stylesheet (own-css.mjs) styles only the parts the copy had when it was made, so parts the
// code builds again from scratch would otherwise show unstyled. Rules that name one of the built kinds, inside any
// @media or @supports they sit in, and the animations they play; never a rule that names Squarespace.
function pickCss({ texts, classes }) {
  const hit = new RegExp('\\.(' + classes.map((c) => c.replace(/[^\w-]/g, '\\$&')).join('|') + ')(?![\\w-])');
  const bad = /sqs|squarespace/i, names = new Set();
  const walk = (rules) => {
    const keep = [];
    for (const r of rules) {
      if (r.type === 1) {
        if (!hit.test(r.selectorText) || bad.test(r.cssText)) continue;
        keep.push(r.cssText);
        for (const n of (r.style.getPropertyValue('animation-name') || '').split(',')) if (n.trim() && n.trim() !== 'none') names.add(n.trim());
      } else if ((r.type === 4 || r.type === 12) && r.cssRules) {
        const inner = walk(r.cssRules);
        if (inner.length) keep.push(r.cssText.slice(0, r.cssText.indexOf('{')) + '{' + inner.join('\n') + '}');
      }
    }
    return keep;
  };
  const sheets = texts.map((t) => { const sh = new CSSStyleSheet(); try { sh.replaceSync(t); } catch {} return sh; });
  const out = [];
  for (const sh of sheets) out.push(...walk(sh.cssRules));
  for (const sh of sheets) for (const r of sh.cssRules) if (r.type === 7 && names.has(r.name)) out.push(r.cssText);
  return out.join('\n');
}

// siteDir: the capture (rendered-<layout>.html), for the owner's own style rules; optional.
export async function steady(stage, siteDir = null) {
  const report = { layouts: {}, frozen: [] };
  const htmlOf = {}, trialOf = {};
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const p = path.join(stage, decodeURIComponent(u.pathname));
      if (!p.startsWith(stage) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      const ext = p.split('.').pop();
      res.writeHead(200, { 'content-type': CT[ext] || 'application/octet-stream', ...policyHeaders(ext) });
      // A trial page: the layout as it stands, without the owner scripts named in ?without=1,3.
      if (ext === 'html' && htmlOf[p] !== undefined) {
        if (u.searchParams.get('trial') && trialOf[p] !== undefined) return res.end(trialOf[p]);
        const without = (u.searchParams.get('without') || '').split(',').filter(Boolean);
        return res.end(without.reduce((h, i) => h.replace(new RegExp(`<script\\b[^>]*data-pv-owner="${i}"[^>]*>[\\s\\S]*?</script>`), ''), htmlOf[p]));
      }
      fs.createReadStream(p).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await launch();
  const load = async (layout, without = [], withText = true, { trial = false, look = snapshot } = {}) => {
    const ctx = await browser.newContext({ ...PROFILES[layout].context });
    await ctx.addInitScript(() => { window.__pvStill = true; });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/${layout}.html?without=${without.join(',')}${trial ? '&trial=1' : ''}`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(SETTLE_MS);
      return await page.evaluate(look, withText);
    } finally { await ctx.close(); }
  };
  const agree = async (layout, without) => (await load(layout, without)) === (await load(layout, without));
  try {
    for (const layout of ['desktop', 'mobile']) {
      const file = path.join(stage, `${layout}.html`);
      if (!fs.existsSync(file)) continue;
      htmlOf[file] = fs.readFileSync(file, 'utf8');
      const owners = [...htmlOf[file].matchAll(/data-pv-owner="(\d+)"/g)].map((m) => m[1]);
      const r = report.layouts[layout] = { ownerScripts: owners.length, steady: true, frozen: [] };
      if (!owners.length || await agree(layout, [])) continue;
      r.steady = false;
      // One at a time, then all at once if no single script explains it.
      let off = null;
      for (const i of owners) if (await agree(layout, [i])) { off = [i]; break; }
      if (!off) off = owners;
      for (const i of off) {
        const m = new RegExp(`<script\\b[^>]*data-pv-owner="${i}"[^>]*>([\\s\\S]*?)</script>`).exec(htmlOf[file]);
        r.frozen.push({ script: i, what: (m?.[1] || '').replace(/^\{const Date=[^;]*;try\{/, '').trim().slice(0, 140) });
      }
      const html = off.reduce((h, i) => h.replace(new RegExp(`<script\\b[^>]*data-pv-owner="${i}"[^>]*>[\\s\\S]*?</script>`), ''), htmlOf[file]);
      fs.writeFileSync(file, html);
      htmlOf[file] = html;
      r.steadyAfter = await agree(layout, []);
      report.frozen.push(...r.frozen.map((f) => ({ layout, ...f })));
    }
    // Owner code already ran once on the live site, and the copy is a picture of the page after it did. Code that builds
    // something when the page opens (Samuel Sparrow's phone-menu links) would build it a second time, so the copy would
    // show it twice. Such code is frozen: what it built is already in the copy. Code that only waits for clicks, runs a
    // timer or changes words (a counter) leaves the page's parts as they are, and keeps running. Parts only, not words.
    for (const layout of ['desktop', 'mobile']) {
      const file = path.join(stage, `${layout}.html`);
      if (!htmlOf[file]) continue;
      const left = [...htmlOf[file].matchAll(/data-pv-owner="(\d+)"/g)].map((m) => m[1]);
      if (!left.length) continue;
      const r = report.layouts[layout];
      const as = await load(layout, [], false);
      if (as === await load(layout, left, false)) continue;
      const redo = [];
      for (const i of left) if (as !== await load(layout, [i], false)) redo.push(i);
      // Better than freezing: start the code from the page as it first arrived. What it builds (Breathpod's swipe hints,
      // added to each phone picture) is taken out of the copy, so it builds it once, and the carousel it also drives
      // keeps working. Kept only when the page it then leaves has exactly the parts and words of the copy as captured: code
      // that writes the owner's own phone number back in (Samuel Sparrow's, which the copy replaced) stays frozen.
      const restarted = [];
      for (const i of redo) {
        const before = await load(layout, [i], false, { look: kinds }), after = await load(layout, [], false, { look: kinds });
        const built = Object.keys(after).filter((k) => (after[k] || 0) > (before[k] || 0) && k.includes('.'));
        if (!built.length) continue;
        const $ = cheerio.load(htmlOf[file]);
        for (const k of built) { const [tag, cls] = k.split('.'); $(`${tag}.${cls.replace(/([^\w-])/g, '\\$1')}`).filter((_, el) => !/^preserve-/.test($(el).attr('id') || '')).remove(); }
        const texts = (() => { const f = siteDir && path.join(siteDir, `rendered-${layout}.html`); if (!f || !fs.existsSync(f)) return []; const c = cheerio.load(fs.readFileSync(f, 'utf8')); return c('style').map((_, e) => c(e).html()).get().filter(Boolean); })();
        if (texts.length) {
          const pg = await browser.newPage();
          const css = await pg.evaluate(pickCss, { texts, classes: built.map((k) => k.split('.')[1]) }).finally(() => pg.close());
          if (css) $('head').append(`<style id="preserve-owner-css-${i}">${css.replace(/</g, '\\3c ')}</style>`);
        }
        trialOf[file] = $.html();
        if (await load(layout, [], true, { trial: true }) !== await load(layout, [i], true)) { delete trialOf[file]; continue; }
        if (!sameBoxes(await load(layout, [i], built, { look: boxes }), await load(layout, [], built, { trial: true, look: boxes }))) { delete trialOf[file]; continue; }
        htmlOf[file] = trialOf[file]; delete trialOf[file];
        restarted.push(i);
        const f = { script: i, why: 'starts from the page as it first arrived', built, styled: new RegExp(`id="preserve-owner-css-${i}"`).test(htmlOf[file]) };
        (r.restarted ||= []).push(f); (report.restarted ||= []).push({ layout, ...f });
      }
      redo.splice(0, redo.length, ...redo.filter((i) => !restarted.includes(i)));
      if (restarted.length && !redo.length) { fs.writeFileSync(file, htmlOf[file]); continue; }
      // Each alone changes nothing, yet together they do: they work as one, so they freeze as one.
      for (const i of redo.length ? redo : left) {
        const m = new RegExp(`<script\\b[^>]*data-pv-owner="${i}"[^>]*>([\\s\\S]*?)</script>`).exec(htmlOf[file]);
        const f = { script: i, why: 'builds again what the copy already shows', what: (m?.[1] || '').replace(/^(document\.addEventListener\('DOMContentLoaded',function\(\)\{)?\{const Date=[^;]*;try\{/, '').trim().slice(0, 140) };
        (r.frozen ||= []).push(f); report.frozen.push({ layout, ...f });
      }
      htmlOf[file] = (redo.length ? redo : left).reduce((h, i) => h.replace(new RegExp(`<script\\b[^>]*data-pv-owner="${i}"[^>]*>[\\s\\S]*?</script>`), ''), htmlOf[file]);
      fs.writeFileSync(file, htmlOf[file]);
    }
    // With all its users frozen, our copy of jQuery has nothing left to do.
    for (const [file, html] of Object.entries(htmlOf)) {
      if (!/data-pv-lib=/.test(html) && /id="preserve-lib-jquery"/.test(html)) fs.writeFileSync(file, html.replace(/<script id="preserve-lib-jquery"[^>]*><\/script>/, ''));
    }
  } finally { await browser.close(); srv.close(); }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await steady(path.resolve(process.argv[2]), process.argv[3] ? path.resolve(process.argv[3]) : null), null, 1));
}
