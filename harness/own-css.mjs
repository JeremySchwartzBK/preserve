// Our own stylesheet for a copy (Jeremy, 2026-10-19, plan: product/own-stylesheet/plan.md). A copy should carry no
// more of Squarespace's code than a screenshot does: the look is the designer's, the stylesheet text is Squarespace's.
// So, for each layout page of an exported copy, this asks the browser which declarations win the cascade on every
// element (own-css-engine.js), with Squarespace's variables replaced by their values, and writes a new stylesheet from
// the answers: elements that end up styled the same share one generated class. Everything that changes with width,
// reduced motion, hover or our own scripts (phone menu and its folders, accordions, entrance animations, the header
// that turns solid on scroll) is captured the same way and written as rules for just what changes. Every original
// stylesheet is then removed, Squarespace's names in the page (sqs-… classes, its component data attributes) are
// replaced or dropped, and the rebuilt page is compared with the original, pixel by pixel, at rest and with the phone
// menu open. Behind a switch for now: make-copy.mjs runs it when OWN_CSS=1.
//
// Usage: node own-css.mjs <stageDir>   (prints a report: sizes, timings, rules per state, pixel differences)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as cheerio from 'cheerio';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { launch, PROFILES, sleep } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ENGINE = fs.readFileSync(new URL('./own-css-engine.js', import.meta.url), 'utf8');
const SKIP = new Set(['script', 'style', 'link', 'meta', 'title', 'noscript', 'base', 'head', 'template']);
const RANGE = { desktop: [768, 2560], mobile: [320, 767] };
// Attributes Squarespace's own scripts and editor read; nothing in a copy does. Dropped unless a script in the page
// mentions them.
const DROP_ATTR = /^data-(definition-name|block-scripts|block-css|block-json|sqsp?-.*|controller|controllers-bound|loader|load|image|image-.*|src|current-styles|current-context|website-component-id|licensed-asset-preview|test|testid|bpo|breakpoints|component-id|stack-component-id|child-ref-id|text-attribute-id|m-id|block-animations-prerender|has-block-animations|fluid-engine.*|preserve-current)$/;
// Squarespace class prefixes, renamed to neutral ones in the page, its scripts and the generated stylesheet.
const rename = (c) => c.replace(/^sqsrte-/, 'rte-').replace(/^sqsp-/, 'ps-').replace(/^sqs-/, 'ps-').replace(/^tweak-/, 'tw-');
const renameText = (t) => t.replace(/data-sqsp?-/g, 'data-ps-').replace(/(^|[^\w-])sqsrte-/g, '$1rte-').replace(/(^|[^\w-])sqsp-/g, '$1ps-').replace(/(^|[^\w-])sqs-/g, '$1ps-').replace(/(^|[^\w-])tweak-/g, '$1tw-');

// Attribute changes our scripts make that are motion, not state.
const IGNORE_ATTR = new Set(['style', 'startoffset', 'stroke-dashoffset', 'data-pz', 'data-pzh', 'tabindex', 'data-is-item-animating']);

const ser = (d) => d.map(([k, v, im]) => `${k}:${v}${im ? '!important' : ''}`).join(';');
const esc = (s) => s.replace(/([^\w-])/g, '\\$1');

function serve(root) {
  const CT = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', ico: 'image/x-icon' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': CT[p.split('.').pop()] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// The page's elements in document order, the same way every time (marking and rewriting must agree).
function elements($) {
  return $('html, html *').toArray().filter((el) => el.type === 'tag' && !SKIP.has(el.tagName) && !$(el).closest('head').length && !$(el).parents('svg style, noscript, template').length);
}

// What changed between two captures of one element: the declarations to write for the new state.
// will-change is only a hint to the browser (nothing on screen depends on it), so a state that only flips it is no change.
const NO_LOOK = new Set(['will-change']);
function diffDecls(a = [], z = []) {
  a = a.filter((x) => !NO_LOOK.has(x[0])); z = z.filter((x) => !NO_LOOK.has(x[0]));
  const am = new Map(a.map((x) => [x[0], x])), zm = new Map(z.map((x) => [x[0], x]));
  const out = [];
  for (const [k, x] of zm) { const y = am.get(k); if (!y || y[1] !== x[1] || y[2] !== x[2]) out.push([k, x[1], x[2] || !!(y && y[2])]); }
  for (const [k, y] of am) if (!zm.has(k)) out.push([k, 'unset', y[2]]);
  return out;
}
function diffAll(rest, now, only) {
  const out = {};
  for (const i of only || Object.keys(now)) {
    const r = rest[i] || {}, n = now[i] || {};
    for (const ps of new Set([...Object.keys(r), ...Object.keys(n)])) {
      const d = diffDecls(r[ps], n[ps]);
      if (d.length) (out[i] ||= {})[ps] = d;
    }
  }
  return out;
}

async function layoutCss(base, stage, layout, report) {
  const file = path.join(stage, `${layout}.html`);
  const src = fs.readFileSync(file, 'utf8');
  const $m = cheerio.load(src);
  const els = elements($m);
  els.forEach((el, i) => $m(el).attr('data-pz', String(i)));
  const marked = path.join(stage, `.oc-${layout}.html`);
  fs.writeFileSync(marked, $m.html());

  const browser = await launch();
  const t0 = Date.now();
  try {
    const ctx = await browser.newContext({ ...PROFILES[layout].context });
    const page = await ctx.newPage();
    await page.goto(`${base}/.oc-${layout}.html`, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(500);
    const W = PROFILES[layout].context.viewport.width, H = PROFILES[layout].context.viewport.height;
    // At rest: every entrance animation finished (our motion script plays them from the "not yet shown" state).
    const IN = { preFade: 'fadeIn', preSlide: 'slideIn', preScale: 'scaleIn', preClip: 'clipIn', preFlex: 'flexIn' };
    await page.evaluate((IN) => { for (const k in IN) document.querySelectorAll('.' + k).forEach((e) => e.classList.add(IN[k])); }, IN);
    await page.addScriptTag({ content: ENGINE });
    report.collected = await page.evaluate(() => window.__oc.collect());
    const rest = await page.evaluate(() => window.__oc.capture());

    // Width: one capture inside each range of widths the stylesheets distinguish (within this layout's widths).
    const [lo, hi] = RANGE[layout];
    const bps = (await page.evaluate(() => window.__oc.breakpoints())).filter((b) => b > lo && b <= hi);
    const ranges = [];
    let start = lo;
    for (const b of [...bps, hi + 1]) { if (b - start >= 4 || !ranges.length) ranges.push([start, b - 1]); else ranges[ranges.length - 1][1] = b - 1; start = b; }
    const widthRules = [];
    for (const [a, z] of ranges) {
      if (W >= a && W <= z) continue;
      const w = Math.min(z, Math.max(a, Math.round((a + Math.min(z, a + 400)) / 2)));
      await page.setViewportSize({ width: w, height: H }); await sleep(250);
      const now = await page.evaluate(() => window.__oc.capture());
      const d = diffAll(rest, now);
      if (Object.keys(d).length) widthRules.push({ media: `(min-width:${a}px)${z < hi ? ` and (max-width:${z}px)` : ''}`, d });
    }
    await page.setViewportSize({ width: W, height: H }); await sleep(250);
    report.widths = ranges.map(([a, z]) => `${a}-${z}`);

    // Reduced motion (people who ask their system for less movement).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const rm = diffAll(rest, await page.evaluate(() => window.__oc.capture()));
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // Ancestors and preceding siblings, for placing state rules on the element whose attributes changed.
    const tree = await page.evaluate(() => [...document.querySelectorAll('[data-pz]')].map((e) => {
      const up = []; for (let x = e; x && x.nodeType === 1; x = x.parentElement) if (x.hasAttribute('data-pz')) up.push(+x.getAttribute('data-pz'));
      const sib = up.map((a) => { const s = []; for (let x = document.querySelector(`[data-pz="${a}"]`).previousElementSibling; x; x = x.previousElementSibling) if (x.hasAttribute('data-pz')) s.push(+x.getAttribute('data-pz')); return s; });
      return { i: +e.getAttribute('data-pz'), up, sib };
    }));
    const T = new Map(tree.map((t) => [t.i, t]));
    const unique = new Set();
    const stateRules = [];
    const startObs = () => page.evaluate((ign) => {
      window.__mut = new Map();
      window.__mo = new MutationObserver((ms) => { for (const m of ms) { const e = m.target; if (!e.hasAttribute || !e.hasAttribute('data-pz') || ign.includes(m.attributeName.toLowerCase())) continue; const k = e.getAttribute('data-pz'); const o = window.__mut.get(k) || {}; if (!(m.attributeName in o)) o[m.attributeName] = m.oldValue; window.__mut.set(k, o); } });
      window.__mo.observe(document.documentElement, { subtree: true, attributes: true, attributeOldValue: true });
    }, [...IGNORE_ATTR]);
    const endObs = () => page.evaluate(() => { window.__mo.takeRecords().forEach(() => {}); window.__mo.disconnect(); const out = {}; for (const [k, o] of window.__mut) { const e = document.querySelector(`[data-pz="${k}"]`); const ch = {}; for (const a in o) { const nv = e.getAttribute(a); const same = a === 'class' ? [...new Set((nv || '').split(/\s+/).filter(Boolean))].sort().join(' ') === [...new Set((o[a] || '').split(/\s+/).filter(Boolean))].sort().join(' ') : nv === o[a]; if (!same) ch[a] = [o[a], nv]; } if (Object.keys(ch).length) out[k] = ch; } return out; });
    const revert = (changed) => page.evaluate((changed) => { for (const k in changed) { const e = document.querySelector(`[data-pz="${k}"]`); for (const a in changed[k]) { const v = changed[k][a][0]; if (v === null) e.removeAttribute(a); else e.setAttribute(a, v); } } }, changed);
    const stateSel = (E, ch) => {
      let s = `.u${E}`;
      for (const [attr, [ov, nv]] of Object.entries(ch)) {
        if (attr === 'class') {
          const o = new Set((ov || '').split(/\s+/).filter(Boolean)), n = new Set((nv || '').split(/\s+/).filter(Boolean));
          for (const x of n) if (!o.has(x)) s += '.' + esc(x);
          for (const x of o) if (!n.has(x)) s += `:not(.${esc(x)})`;
        } else s += nv === null ? `:not([${attr}])` : `[${attr}="${nv.replace(/["\\]/g, '\\$&')}"]`;
      }
      return s;
    };
    // Rules for one state: each changed element gets the declarations it has in that state, keyed on the nearest
    // element whose attributes changed (itself, an ancestor, or a preceding sibling of either).
    function addState(name, d, changed, prefix = '') {
      let n = 0, orphan = 0;
      for (const i in d) {
        const t = T.get(+i); if (!t) continue;
        let sel = null;
        for (let k = 0; k < t.up.length && !sel; k++) {
          const a = t.up[k];
          if (changed[a]) sel = stateSel(a, changed[a]) + (a === +i ? '' : ` .u${i}`), unique.add(a);
          else { const s = t.sib[k].find((x) => changed[x]); if (s !== undefined) { sel = stateSel(s, changed[s]) + ` ~ .u${a}` + (a === +i ? '' : ` .u${i}`); unique.add(s); unique.add(a); } }
        }
        if (!sel) { orphan++; (report.orphanSamples ||= []).length < 6 && report.orphanSamples.push(`${name}: ${i} ${d[i][''] ? ser(d[i]['']).slice(0, 120) : Object.keys(d[i]).join(',')}`); continue; }
        unique.add(+i);
        for (const ps in d[i]) { stateRules.push(`${prefix}${sel}${ps}{${ser(d[i][ps])}}`); n++; }
      }
      report.states[name] = { changed: Object.keys(changed).length, rules: n, orphans: orphan };
    }
    report.states = {};
    const capture = () => page.evaluate(() => window.__oc.capture());

    // Entrance animations: the "not yet shown" state.
    if (await page.evaluate(() => !!document.querySelector('.preFade,.preSlide,.preScale,.preClip,.preFlex'))) {
      await startObs();
      await page.evaluate((IN) => { for (const k in IN) document.querySelectorAll('.' + k).forEach((e) => e.classList.remove(IN[k])); }, IN);
      const ch = await endObs(); addState('entrance', diffAll(rest, await capture()), ch); await revert(ch);
    }
    // Phone menu open, and each of its folders.
    if (await page.evaluate(() => !!document.querySelector('.header-burger-btn') && !!document.querySelector('.header-menu'))) {
      await startObs();
      await page.evaluate(() => document.querySelector('.header-burger-btn').click()); await sleep(200);
      const ch = await endObs(); const open = await capture(); addState('menu', diffAll(rest, open), ch);
      const folders = await page.evaluate(() => [...document.querySelectorAll('.header-menu a[data-folder-id]')].map((a) => a.getAttribute('data-pz')).filter(Boolean));
      for (const f of folders) {
        await startObs();
        await page.evaluate((f) => document.querySelector(`[data-pz="${f}"]`).click(), f); await sleep(100);
        const fc = await endObs();
        // Folder rules only apply with the menu open: key them under the menu's own change too.
        const bodyKey = Object.keys(ch).find((k) => ch[k].class) ;
        addState('menu-folder-' + f, diffAll(open, await capture()), fc, bodyKey ? stateSel(bodyKey, ch[bodyKey]) + ' ' : '');
        if (bodyKey) unique.add(+bodyKey);
        await revert(fc);
      }
      await page.evaluate(() => document.querySelector('.header-burger-btn').click()); await sleep(800);
      await revert(ch);
    }
    // Accordions open.
    if (await page.evaluate(() => !!document.querySelector('.accordion-item'))) {
      await startObs();
      await page.evaluate(() => document.querySelectorAll('.accordion-item').forEach((li) => { li.setAttribute('data-is-open', 'true'); const d = li.querySelector('.accordion-item__dropdown'); if (d) d.classList.add('accordion-item__dropdown--open'); const t = li.querySelector('.accordion-item__click-target'); if (t) t.setAttribute('aria-expanded', 'true'); }));
      const ch = await endObs(); addState('accordion', diffAll(rest, await capture()), ch); await revert(ch);
    }
    // Desktop menu folders opened by tap.
    if (await page.evaluate(() => !!document.querySelector('.header-nav button.header-nav-folder-title[aria-controls]'))) {
      await startObs();
      await page.evaluate(() => document.querySelectorAll('.header-nav button.header-nav-folder-title[aria-controls]').forEach((b) => b.setAttribute('aria-expanded', 'true')));
      const ch = await endObs(); addState('nav-folder', diffAll(rest, await capture()), ch); await revert(ch);
    }
    // Header turning solid once the page scrolls.
    if (await page.evaluate(() => document.body.classList.contains('tweak-fixed-header') && !!document.querySelector('header.header,#header'))) {
      await startObs();
      await page.evaluate(() => document.querySelector('header.header,#header').classList.add('shrink'));
      const ch = await endObs(); addState('header-scrolled', diffAll(rest, await capture()), ch); await revert(ch);
    }

    // Hover: each element a :hover rule can apply to, hovered in turn (it and its ancestors match :hover).
    const targets = await page.evaluate(() => window.__oc.hoverTargets(400));
    const cdp = await ctx.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    let hoverRules = 0;
    for (const t of targets.list) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-pz="${t}"]` });
      if (!nodeId) continue;
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      const r = await page.evaluate((t) => window.__oc.captureHover(t), t);
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
      const d = diffAll(rest, r);
      for (const i in d) {
        const ti = T.get(+i); if (!ti) continue;
        let rel = null;
        if (+i === t) rel = `.u${t}:hover`;
        else if (ti.up.includes(t)) rel = `.u${t}:hover .u${i}`;
        else { const k = ti.up.findIndex((a, k) => ti.sib[k].includes(t)); if (k >= 0) rel = `.u${t}:hover ~ ` + (ti.up[k] === +i ? `.u${i}` : `.u${ti.up[k]} .u${i}`), unique.add(ti.up[k]); }
        if (!rel) continue;
        unique.add(t); unique.add(+i);
        for (const ps in d[i]) { stateRules.push(`${rel}${ps}{${ser(d[i][ps])}}`); hoverRules++; }
      }
    }
    report.hover = { targets: targets.list.length, of: targets.total, rules: hoverRules };

    const inline = await page.evaluate(() => window.__oc.inlineVars());
    const fontFaces = await page.evaluate(() => window.__oc.fontFaces());

    // Assemble. Elements styled alike share a class.
    const sig = new Map(), classOf = {};
    let css = '';
    for (const i of Object.keys(rest).sort((a, b) => a - b)) {
      const key = Object.entries(rest[i]).map(([ps, d]) => ps + '|' + ser(d)).join('\n');
      if (!sig.has(key)) {
        const cls = 'z' + sig.size.toString(36);
        sig.set(key, cls);
        for (const [ps, d] of Object.entries(rest[i])) css += `.${cls}${ps}{${ser(d)}}\n`;
      }
      classOf[i] = sig.get(key);
    }
    // Width and reduced-motion differences: on the shared class when every element of it changes alike.
    const members = {};
    for (const i in classOf) (members[classOf[i]] ||= []).push(i);
    function block(d) {
      const byCls = {}; let out = '';
      for (const i in d) for (const ps in d[i]) ((byCls[classOf[i]] ||= {})[ps + '|' + ser(d[i][ps])] ||= []).push(i);
      for (const cls in byCls) for (const [k, list] of Object.entries(byCls[cls])) {
        const ps = k.slice(0, k.indexOf('|')), body = k.slice(k.indexOf('|') + 1);
        if (list.length === members[cls].length) out += `.${cls}${ps}{${body}}\n`;
        else for (const i of list) { unique.add(+i); out += `.u${i}${ps}{${body}}\n`; }
      }
      return out;
    }
    for (const w of widthRules) css += `@media ${w.media}{\n${block(w.d)}}\n`;
    if (Object.keys(rm).length) css += `@media (prefers-reduced-motion:reduce){\n${block(rm)}}\n`;
    css += stateRules.join('\n') + '\n';
    // Animations still in use, under our own names.
    const used = [...new Set([...css.matchAll(/animation(?:-name)?:([^;}]*)/g)].flatMap((m) => m[1].split(/[\s,]+/)).filter((x) => /^[a-zA-Z_][\w-]*$/.test(x)))];
    const kf = await page.evaluate((u) => window.__oc.keyframes(u), used);
    let kfCss = '', kn = 0;
    for (const [name, text] of Object.entries(kf)) {
      const nn = 'k' + (kn++).toString(36);
      kfCss += text.replace(/^@(-webkit-)?keyframes\s+\S+/, `@keyframes ${nn}`) + '\n';
      css = css.replace(new RegExp(`(animation(?:-name)?:[^;}]*?)(^|[\\s,:])${name.replace(/[-]/g, '\\-')}(?=[\\s,;}!]|$)`, 'g'), `$1$2${nn}`);
    }
    // Fonts the exported page couldn't load either (a file the capture never got) are left out: same look, no address.
    const loadable = (f) => [...f.matchAll(/url\(\s*["']?([^"')]+)/g)].some((m) => m[1].startsWith('data:') || (m[1].startsWith(base + '/') && fs.existsSync(path.join(stage, decodeURIComponent(m[1].slice(base.length + 1).split(/[?#]/)[0])))));
    report.fontFacesDropped = fontFaces.filter((f) => !loadable(f)).length;
    css = fontFaces.filter(loadable).join('\n') + '\n' + kfCss + css;
    // Addresses: everything the stylesheet points at sits beside the page.
    css = css.split(base + '/').join('');
    css = iconFont(css, stage, report);
    css = renameText(css);
    report.cssBytes = Buffer.byteLength(css);
    report.classes = sig.size;
    report.seconds = +((Date.now() - t0) / 1000).toFixed(1);

    // Rewrite the page.
    const $ = cheerio.load(src);
    const list = elements($);
    if (list.length !== els.length) throw new Error(`element count changed (${els.length} -> ${list.length})`);
    const scriptText = $('script').toArray().map((s) => $(s).html() || '').join('\n');
    report.origCssBytes = 0;
    $('link[rel~=stylesheet], link[rel=preload][as=style]').each((_, el) => { const h = $(el).attr('href'); if (h && fs.existsSync(path.join(stage, h))) report.origCssBytes += fs.statSync(path.join(stage, h)).size; });
    $('style').each((_, el) => { report.origCssBytes += Buffer.byteLength($(el).html() || ''); });
    $('link[rel~=stylesheet], link[rel=preload][as=style], style').remove();
    $('noscript').filter((_, el) => /stylesheet/.test($(el).html() || '')).remove();
    list.forEach((el, i) => {
      const e = $(el);
      const cls = (e.attr('class') || '').split(/\s+/).filter(Boolean).map(rename);
      if (classOf[i]) cls.push(classOf[i]);
      if (unique.has(i)) cls.push('u' + i);
      if (cls.length) e.attr('class', cls.join(' ')); else e.removeAttr('class');
      if (inline[i] !== undefined) e.attr('style', inline[i]);
      for (const a of Object.keys(el.attribs)) {
        if (DROP_ATTR.test(a) && !scriptText.includes(a)) e.removeAttr(a);
        else if (/^data-sqsp?-/.test(a)) { const v = el.attribs[a]; e.removeAttr(a); e.attr(renameText(a), v); }
      }
    });
    $('script').each((_, el) => { const t = $(el).html(); if (t && /sqs(rte|p)?-|tweak-/.test(t)) $(el).html(renameText(t)); });
    // Comments ("This is Squarespace." and the like) carry nothing the copy needs.
    $('*').contents().add($.root().contents()).filter((_, n) => n.type === 'comment').remove();
    $('head').append(`<style id="pv-css">${css}</style>`);
    let out = $.html();
    // Markup the element walk doesn't reach (template and noscript contents): same renames.
    out = out.replace(/(\sclass=")([^"]*)"/g, (_, a, c) => `${a}${c.split(/(\s+)/).map((x) => (/\S/.test(x) ? rename(x) : x)).join('')}"`);
    out = out.replace(/\sdata-sqsp?-/g, (m) => m.replace(/sqsp?-/, 'ps-')).replace(/data-definition-name/g, 'data-component');
    fs.writeFileSync(file, out);
    return { css };
  } finally {
    await browser.close();
    fs.rmSync(marked, { force: true });
  }
}

// Squarespace's UI icon font (arrows, close buttons, share icons) -> our own drawing of each icon (icons.py), same code
// points and widths so nothing moves. Its @font-face rules are replaced and its name is gone from the stylesheet.
const ICON_FAMILY = /(['"]?)squarespace-ui-font\1/g;
function iconFont(css, stage, report) {
  if (!/squarespace-ui-font/.test(css)) return css;
  const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]).filter((f) => /squarespace-ui-font/.test(f));
  const src = faces.map((f) => (f.match(/url\(\s*["']?([^"')]+)/) || [])[1]).find((u) => u && fs.existsSync(path.join(stage, u)));
  for (const f of faces) css = css.replace(f, '');
  if (src) {
    const tmp = path.join(stage, '.pv-icons.woff2');
    const out = JSON.parse(execFileSync('python3', [path.join(HERE, 'icons.py'), path.join(stage, src), tmp], { encoding: 'utf8' }));
    const name = `a/pv-icons-${crypto.createHash('sha1').update(fs.readFileSync(tmp)).digest('hex').slice(0, 12)}.woff2`;
    fs.renameSync(tmp, path.join(stage, name));
    css = `@font-face{font-family:pv-icons;src:url("${name}") format("woff2");font-display:block}\n` + css;
    report.icons = { drawn: out.drawn.length, blank: out.blank };
  }
  // (No file in the copy: the exported page never loaded the font either and showed the fallback font there too.)
  return css.replace(ICON_FAMILY, 'pv-icons');
}

// Screenshots of a page at rest (and with the phone menu open), with motion off so they compare like for like. One
// pixel per CSS pixel: very tall phone pages at 3x come back with tiles left unpainted.
async function shots(base, layout, name) {
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ ...PROFILES[layout].context, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${base}/${name}`, { waitUntil: 'load', timeout: 60000 });
    // Every image loaded before the photo, so lazy loading can't make the two differ.
    await page.evaluate(() => Promise.race([new Promise((r) => setTimeout(r, 15000)), Promise.all([...document.images].map((i) => { i.loading = 'eager'; return i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }); }))]));
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += 600) { await page.evaluate((y) => scrollTo(0, y), y); await sleep(60); }
    await page.evaluate(() => { scrollTo(0, 0); document.querySelectorAll('video').forEach((v) => { try { v.pause(); v.currentTime = 0; } catch {} }); });
    await page.evaluate(() => document.fonts.ready); await sleep(1200);
    // Loaded (scrolling can start more) and decoded, not just downloaded: a big page photographed mid-decode shows empty boxes.
    // CSS background pictures too: they load when first drawn, so a page with ours (one stylesheet, drawn sooner or later
    // than Squarespace's) can be photographed with a different set still missing.
    const ready = () => page.evaluate(() => {
      const bg = new Set();
      for (const e of document.querySelectorAll('*')) for (const ps of [null, '::before', '::after']) for (const m of getComputedStyle(e, ps).backgroundImage.matchAll(/url\("([^"]+)"\)/g)) bg.add(m[1]);
      const imgs = [...document.images].concat([...bg].map((u) => { const i = new Image(); i.src = u; return i; }));
      return Promise.race([new Promise((r) => setTimeout(r, 15000)), Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = i.onerror = r; })).then(() => i.decode()).catch(() => {})))]);
    });
    await ready(); await sleep(300);
    // A full-page photo can itself make images reload; take it until two in a row agree.
    let shot = await page.screenshot({ fullPage: true });
    for (let k = 0; k < 3; k++) { await ready(); await sleep(500 + 500 * k); const again = await page.screenshot({ fullPage: true }); if (again.equals(shot)) break; shot = again; }
    const out = { rest: shot, height: await page.evaluate(() => document.documentElement.scrollHeight) };
    if (await page.evaluate(() => { const b = [...document.querySelectorAll('.header-burger-btn')].find((x) => x.getBoundingClientRect().width > 0); if (b) b.click(); return !!b; })) { await sleep(800); out.menu = await page.screenshot(); }
    return out;
  } finally { await browser.close(); }
}
function pctDiff(a, b) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
  const crop = (I) => { const o = new PNG({ width: w, height: h }); PNG.bitblt(I, o, 0, 0, w, h, 0, 0); return o; };
  return +(100 * pixelmatch(crop(A).data, crop(B).data, null, w, h, { threshold: 0.1 }) / (w * h)).toFixed(2);
}

export async function ownCss(stage) {
  stage = path.resolve(stage);
  const srv = await serve(stage);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const report = { layouts: {} };
  try {
    for (const layout of ['desktop', 'mobile']) {
      const r = report.layouts[layout] = {};
      const orig = path.join(stage, `.orig-${layout}.html`);
      fs.copyFileSync(path.join(stage, `${layout}.html`), orig);
      try {
        let before = await shots(base, layout, `.orig-${layout}.html`);
        await layoutCss(base, stage, layout, r);
        let after = await shots(base, layout, `${layout}.html`);
        r.height = [before.height, after.height];
        r.diffPct = pctDiff(before.rest, after.rest);
        // A busy machine sometimes photographs a page before every image is painted: look again before calling it different.
        for (let k = 0; k < 2 && (r.diffPct > 1 || (before.menu && after.menu && pctDiff(before.menu, after.menu) > 1)); k++) {
          const b2 = await shots(base, layout, `.orig-${layout}.html`), a2 = await shots(base, layout, `${layout}.html`);
          const d2 = pctDiff(b2.rest, a2.rest);
          if (d2 <= r.diffPct) { before = b2; after = a2; r.diffPct = d2; r.height = [b2.height, a2.height]; }
          r.looks = (r.looks || 1) + 1;
        }
        if (process.env.OC_DEBUG) for (const [k, v] of [['before', before], ['after', after]]) { fs.writeFileSync(path.join(process.env.OC_DEBUG, `${layout}-${k}.png`), v.rest); if (v.menu) fs.writeFileSync(path.join(process.env.OC_DEBUG, `${layout}-${k}-menu.png`), v.menu); }
        if (before.menu && after.menu) r.menuDiffPct = pctDiff(before.menu, after.menu);
      } catch (e) {
        // This layout keeps Squarespace's stylesheets as exported; the quality check reports it.
        fs.copyFileSync(orig, path.join(stage, `${layout}.html`));
        r.error = String(e.message || e).split('\n')[0].slice(0, 300);
      }
      fs.rmSync(orig, { force: true });
    }
  } finally { srv.close(); }
  const html = ['desktop', 'mobile'].map((l) => fs.readFileSync(path.join(stage, `${l}.html`), 'utf8')).join('\n');
  let removed = 0;
  // Stylesheets and fonts nothing uses any more (Squarespace's, copied at export; its icon font, now redrawn).
  for (const f of fs.readdirSync(path.join(stage, 'a'))) if (/\.(css|woff2?|ttf|otf)$/.test(f) && !html.includes(f)) { fs.rmSync(path.join(stage, 'a', f)); removed++; }
  report.removedFiles = removed;
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = await ownCss(process.argv[2]);
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
}
