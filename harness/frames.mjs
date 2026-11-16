// Embedded widgets from other sites (event calendars, booking lists, forms) saved as real content, not pictures
// (Jeremy, 2026-11-13, the Aether Preserve's Eventually widgets: "each card stands alone, and the calendar, list and card
// views are all different").
//
// Capture (live page, each layout): for every visible frame from another site, save what it shows as plain HTML and
// CSS: no scripts, its images and fonts saved with the Preserve. A widget with view buttons (a row of buttons such as
// Calendar / List / Card, or tabs) is clicked through, and each view is saved too.
// Export: the frame shows that saved content (srcdoc), with a small script that switches views when a view button is
// clicked, sizes the frame to its content when the live widget did, and turns any other click into the usual "this is
// a snapshot" note. Nothing loads from the widget's site, so the Preserve keeps zero reliance on it.
// A frame this can't save well (a video player, a map, a drawing, a bot check, nothing drawn) stays on the picture path
// in export-static.mjs embedStills.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sleep } from './lib.mjs';

// Players and maps keep their own handling (a still frame, a picture of the map).
const SKIP = /youtube\.com|youtube-nocookie|youtu\.be|vimeo\.com|google\.[a-z.]+\/maps|maps\.google|mapbox|openstreetmap|recaptcha|hcaptcha|challenges\.cloudflare|doubleclick|googletagmanager|facebook\.com\/(?:tr|plugins\/video)|instagram\.com|tiktok\.com|spotify\.com|soundcloud\.com/i;
const MAX_VIEWS = 6;
const MAX_ASSET_BYTES = 8e6;
// Detail windows saved per frame (each click takes about a second at capture).
const MAX_DETAILS = 24;
const MAX_DETAIL_BYTES = 600000;

// In the frame: the buttons that switch views. Tabs and toggle buttons (aria-pressed / aria-selected), and rows of two
// to six short-labelled buttons that do nothing else (no form, no link). Each gets data-pv-ctl = its label.
function markControls() {
  const label = (e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(e).visibility !== 'hidden'; };
  for (const e of document.querySelectorAll('[data-pv-ctl]')) e.removeAttribute('data-pv-ctl');
  const c = [...document.querySelectorAll('[role=tab],[aria-pressed],[aria-selected]')];
  for (const p of new Set([...document.querySelectorAll('button')].map((b) => b.parentElement))) {
    const bs = p ? [...p.children] : [];
    if (bs.length >= 2 && bs.length <= 6 && bs.every((b) => b.tagName === 'BUTTON' && b.type !== 'submit' && !b.closest('form') && label(b) && label(b).length <= 24)) c.push(...bs);
  }
  const out = [], seen = new Set();
  for (const e of c) {
    const l = label(e);
    if (!l || seen.has(l) || !vis(e) || e.closest('form') || (e.tagName === 'A' && !/^(#|$)/.test(e.getAttribute('href') || ''))) continue;
    seen.add(l); e.setAttribute('data-pv-ctl', l);
    out.push({ label: l, active: e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-selected') === 'true' || /(^|\s)(active|selected|is-active|current)(\s|$)/.test(e.className || '') });
  }
  return out;
}

// In the frame: what it shows now, as HTML with no scripts, every address made absolute, and the CSS the browser has.
function serialize(opt) {
  const abs = (u, b) => { try { return new URL(u, b || location.href).href; } catch { return u; } };
  const fixCss = (t, b) => t.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (/^(data|blob):/i.test(u) ? m : `url('${abs(u, b).replace(/'/g, '%27')}')`));
  let css = '';
  for (const s of document.styleSheets) {
    let rules; try { rules = s.cssRules; } catch { continue; }
    if (s.disabled) continue;
    const txt = fixCss([...rules].map((r) => r.cssText).join('\n'), s.href || location.href);
    const mt = s.media && s.media.mediaText;
    css += (mt && mt !== 'all' ? `@media ${mt}{${txt}}` : txt) + '\n';
  }
  for (const s of document.adoptedStyleSheets || []) { try { css += fixCss([...s.cssRules].map((r) => r.cssText).join('\n')) + '\n'; } catch {} }
  const live = [...document.body.querySelectorAll('*')];
  const body = document.body.cloneNode(true);
  const copy = [...body.querySelectorAll('*')];
  const drop = [];
  live.forEach((e, i) => {
    const c = copy[i]; if (!c) return;
    const t = e.tagName;
    if (t === 'SCRIPT' || t === 'NOSCRIPT' || t === 'LINK' || t === 'IFRAME' || t === 'OBJECT' || t === 'EMBED' || t === 'TEMPLATE') { drop.push(c); return; }
    if (t === 'SOURCE' && e.parentElement && e.parentElement.tagName === 'PICTURE') { drop.push(c); return; }
    for (const a of [...c.attributes]) if (/^on/i.test(a.name)) c.removeAttribute(a.name);
    if (t === 'IMG') {
      const src = e.currentSrc || e.getAttribute('src');
      if (src) c.setAttribute('src', abs(src)); c.removeAttribute('srcset'); c.removeAttribute('sizes'); c.removeAttribute('loading');
    }
    if (t === 'CANVAS') { try { const im = document.createElement('img'); im.src = e.toDataURL(); im.setAttribute('style', c.getAttribute('style') || ''); im.className = c.className; im.width = e.width; im.height = e.height; c.replaceWith(im); } catch {} }
    if (t === 'INPUT' || t === 'TEXTAREA') c.setAttribute('value', e.value || '');
    if (t === 'A' && c.hasAttribute('href')) c.setAttribute('href', '#');
    if (c.hasAttribute('style')) c.setAttribute('style', fixCss(c.getAttribute('style')));
    for (const a of ['href', 'xlink:href']) if (t.toLowerCase() === 'image' && c.getAttribute(a)) c.setAttribute(a, abs(c.getAttribute(a)));
    if (t === 'VIDEO' || t === 'AUDIO') { c.removeAttribute('src'); c.removeAttribute('autoplay'); }
  });
  drop.forEach((c) => c.remove());
  for (const a of [...body.attributes]) if (/^on/i.test(a.name)) body.removeAttribute(a.name);
  // The content's own height (the frame may be taller or shorter): how far the body's own boxes in the flow reach
  // (not every descendant: content clipped inside a box would count).
  let h = 0;
  for (const e of document.body.children) { const r = e.getBoundingClientRect(), p = getComputedStyle(e).position; if (r.height && p !== 'absolute' && p !== 'fixed') h = Math.max(h, r.bottom + scrollY); }
  const bs = getComputedStyle(document.body);
  h += (parseFloat(bs.marginBottom) || 0) + (parseFloat(bs.paddingBottom) || 0);
  // A detail window (opt.ov): only what it added (marked data-pv-ov at capture), and the page's body attributes then.
  if (opt && opt.ov) {
    const roots = [...body.querySelectorAll('[data-pv-ov]')];
    roots.forEach((r) => r.removeAttribute('data-pv-ov'));
    return {
      ov: roots.map((r) => r.outerHTML).join(''), css,
      text: [...document.querySelectorAll('[data-pv-ov]')].map((r) => r.innerText || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
    };
  }
  return {
    html: [...document.documentElement.attributes].map((a) => [a.name, a.value]),
    body: body.outerHTML, css, h: Math.ceil(h),
    text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
  };
}

// In the frame: whether its look lives somewhere a DOM copy can't keep (a drawing, a video, shadow roots).
function unsavable() {
  const big = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height > 6000; };
  return [...document.querySelectorAll('canvas,video,embed,object')].some(big) || [...document.querySelectorAll('*')].some((e) => e.shadowRoot && big(e));
}

// In the frame: the things that open a detail window in place (an event card, a product tile, a "details" button):
// buttons and button-like elements outside view buttons and forms, with some text, that don't go to another address
// and don't look like paging or menu controls. The outermost of nested ones; each gets data-pv-dc = its number, in a
// fixed order so a second call after the widget redraws numbers them the same.
function markDetails() {
  for (const e of document.querySelectorAll('[data-pv-dc]')) e.removeAttribute('data-pv-dc');
  const nav = /\b(next|prev|previous|back|forward|today|month|week|year|more|load|show|view all|see all|scroll|filter|sort|search|menu|close|share|subscribe|sign ?in|log ?in|cart|checkout|language)\b/i;
  const navText = /^\W*(next|previous|prev|back|forward|today|load more|show more|view all|see all|more|menu|close|share|filter|sort|search|subscribe)( (month|week|page|events|results))?\W*$/i;
  const txt = (e) => (e.innerText || '').trim().replace(/\s+/g, ' ');
  const c = [];
  for (const e of document.body.querySelectorAll('*')) {
    if (e.closest('[data-pv-ctl],form,[data-pv-ov]')) continue;
    const t = e.tagName, role = e.getAttribute('role') || '';
    const href = t === 'A' ? (e.getAttribute('href') || '') : null;
    if (href !== null && !/^(#|javascript:|$)/i.test(href)) continue; // a real link goes somewhere else
    if (e.closest('a[href]:not([href^="#"]):not([href^="javascript:"])')) continue;
    const st = getComputedStyle(e);
    const clicky = role === 'button' || (role === 'link' && t !== 'A') || (t === 'BUTTON' && e.type !== 'submit') || href !== null || e.hasAttribute('onclick')
      || (st.cursor === 'pointer' && (!e.parentElement || getComputedStyle(e.parentElement).cursor !== 'pointer'));
    if (!clicky) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 24 || r.height < 16 || st.visibility === 'hidden') continue;
    const l = txt(e), al = (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '');
    if (l.length < 8 || (al.trim().split(/\s+/).length <= 4 && nav.test(al)) || navText.test(l)) continue;
    c.push(e);
  }
  const top = c.filter((e) => !c.some((o) => o !== e && o.contains(e)));
  top.forEach((e, i) => e.setAttribute('data-pv-dc', String(i)));
  return top.length;
}

// In the frame: remember the view as it is saved (every element, its class and style, and the elements holding text),
// so a detail window can be told apart from it however the widget opens one (a new element, or one it keeps and
// slides in and out, like a phone sheet).
function snapBase() {
  const attrs = (e) => Object.fromEntries([...e.attributes].filter((a) => !/^(on|data-pv)/i.test(a.name)).map((a) => [a.name, a.value]));
  window.__pvAttrs = attrs;
  window.__pvBase = new Map([...document.body.querySelectorAll('*'), document.body, document.documentElement].map((e) => [e, attrs(e)]));
  window.__pvTxt = [...__pvBase.keys()].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
}

// In the frame, after the click: did it only add a window on top of the saved view (no text of the view went away)?
// Then mark what it added (data-pv-ov), its close buttons (data-pv-ctl="pv:close") and the dimmed area around it
// (data-pv-bd), and give where it sits (the path from the body to its parent, counting the elements a saved copy
// keeps) and the view elements whose attributes it changed (a class, a style, inert).
function opened() {
  const B = window.__pvBase;
  if (__pvTxt.some((e) => !e.isConnected)) return null;
  const kept = (e) => !/^(SCRIPT|NOSCRIPT|LINK|IFRAME|OBJECT|EMBED|TEMPLATE)$/.test(e.tagName) && !(e.tagName === 'SOURCE' && e.parentElement?.tagName === 'PICTURE') && !e.hasAttribute('data-pv-ov');
  const shown = (n) => { const r = n.getBoundingClientRect(), s = getComputedStyle(n); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && s.visibility !== 'hidden' && +s.opacity > 0; };
  const roots = [...document.body.querySelectorAll('*')].filter((n) => !B.has(n) && B.has(n.parentElement) && kept(n) && shown(n));
  const text = roots.map((r) => r.innerText || '').join(' ').replace(/\s+/g, ' ').trim();
  if (!roots.length || text.length < 10 || roots.some((r) => r.parentElement !== roots[0].parentElement)) return null;
  const pathOf = (el) => { if (el === document.documentElement) return 'html'; const p = []; for (let e = el; e && e !== document.body; e = e.parentElement) p.unshift([...e.parentElement.children].filter(kept).indexOf(e)); return p; };
  window.__pvRoots = roots;
  roots.forEach((r) => r.setAttribute('data-pv-ov', ''));
  const host = pathOf(roots[0].parentElement);
  if (host === 'html' || host.includes(-1)) return null;
  const ch = [];
  for (const [e, was] of B) {
    if (!e.isConnected) continue;
    const now = __pvAttrs(e), d = [];
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) if (was[k] !== now[k]) d.push([k, k in now ? now[k] : null]);
    if (d.length) ch.push([pathOf(e), d]);
  }
  for (const r of roots) for (const b of r.querySelectorAll('button,[role=button],a')) {
    const l = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).trim(), t = (b.innerText || '').trim();
    if (/\b(close|dismiss)\b/i.test(l) || /^(×|✕|✖|x|close)$/i.test(t)) b.setAttribute('data-pv-ctl', 'pv:close');
  }
  const bd = document.elementFromPoint(3, Math.round(innerHeight / 2));
  if (bd && roots.some((r) => r.contains(bd))) bd.setAttribute('data-pv-bd', '');
  return { host, text, ch: ch.length <= 20 && !ch.some((x) => x[0] !== 'html' && x[0].includes(-1)) ? ch : [] };
}

// In the frame: take the capture's marks off; whether the window is gone (removed, hidden, or no longer showing what it
// showed) and the view's text is all still there.
function unmark() {
  for (const e of document.querySelectorAll('[data-pv-ov],[data-pv-bd],[data-pv-ctl="pv:close"]')) { e.removeAttribute('data-pv-ov'); e.removeAttribute('data-pv-bd'); if (e.getAttribute('data-pv-ctl') === 'pv:close') e.removeAttribute('data-pv-ctl'); }
}
function closed(t) {
  if (__pvTxt.some((e) => !e.isConnected)) return false;
  if (!t) return true;
  const k = t.slice(0, 40);
  return (window.__pvRoots || []).every((n) => {
    if (!n.isConnected) return true;
    const r = n.getBoundingClientRect(), s = getComputedStyle(n);
    if (!r.width || !r.height || r.top >= innerHeight || r.bottom <= 0 || s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return true;
    return !(n.innerText || '').replace(/\s+/g, ' ').includes(k);
  });
}
function pressClose() {
  for (const r of window.__pvRoots || []) for (const b of r.querySelectorAll('button,[role=button],a')) {
    const l = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).trim(), t = (b.innerText || '').trim();
    if (/\b(close|dismiss)\b/i.test(l) || /^(×|✕|✖|x|close)$/i.test(t)) { b.click(); return true; }
  }
  return false;
}

const EXT = { 'image/webp': 'webp', 'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'application/font-woff': 'woff', 'application/font-woff2': 'woff2', 'application/x-font-ttf': 'ttf' };

// Every image and font a saved frame uses, saved beside it (frames/files/), and its address replaced by pfa:<file>.
// From the capture's own record when the browser fetched it, otherwise fetched now. Anything else is dropped.
async function localize(states, outDir, manifest, request) {
  const dir = path.join(outDir, 'frames', 'files');
  fs.mkdirSync(dir, { recursive: true });
  const urls = new Set();
  for (const s of states) for (const t of [s.css || '', s.body || '', s.ov || '']) for (const m of t.matchAll(/(?:url\('|src="|href=")(https?:\/\/[^"']+)["']/g)) urls.add(m[1].replace(/&amp;/g, '&'));
  const map = new Map();
  for (const u of urls) {
    let body = null, ct = '';
    const rec = manifest[u];
    if (rec && rec.status < 300) { try { body = fs.readFileSync(path.join(outDir, 'raw', rec.file)); ct = rec.ct; } catch {} }
    if (!body) { try { const r = await request.get(u, { timeout: 20000 }); if (r.ok()) { body = await r.body(); ct = r.headers()['content-type'] || ''; } } catch {} }
    ct = ct.split(';')[0].trim().toLowerCase();
    const ext = EXT[ct] || (/^(image|font)\//.test(ct) || /\.(woff2?|ttf|otf)(\?|$)/i.test(u) ? (/\.(\w{2,5})(?:\?|$)/.exec(new URL(u).pathname) || [, 'bin'])[1].toLowerCase() : null);
    if (!body || !ext || body.length > MAX_ASSET_BYTES) { map.set(u, null); continue; }
    const name = 'pf-' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 12) + '.' + ext;
    fs.writeFileSync(path.join(dir, name), body);
    map.set(u, name);
  }
  const swap = (t) => t
    .replace(/url\('(https?:\/\/[^']+)'\)/g, (m, u) => { const n = map.get(u.replace(/&amp;/g, '&')); return n ? `url('pfa:${n}')` : 'none'; })
    .replace(/(src|href)="(https?:\/\/[^"]+)"/g, (m, a, u) => { const n = map.get(u.replace(/&amp;/g, '&')); return n ? `${a}="pfa:${n}"` : `${a}=""`; });
  for (const s of states) { s.css = swap(s.css); if (s.body != null) s.body = swap(s.body); if (s.ov != null) s.ov = swap(s.ov); }
  return [...map.values()].filter(Boolean).length;
}

// Capture: save every frame from another site on this layout and mark its <iframe> with data-preserve-frame, so the
// export knows which saved frame belongs where. info.frames says what was saved.
export async function saveFrames(page, outDir, prof, info, manifest, request) {
  const done = (info.frames ||= {})[prof] = [];
  const els = await page.$$('iframe');
  let n = 0;
  for (const el of els) {
    const why = (x) => done.push({ src: '', saved: false, why: x });
    try {
      const src = (await el.getAttribute('src')) || '';
      if (SKIP.test(src)) continue;
      const f = await el.contentFrame();
      if (!f) continue;
      let fu; try { fu = new URL(f.url()); } catch { continue; }
      if (!/^https?:$/.test(fu.protocol) || fu.origin === new URL(page.url()).origin || SKIP.test(fu.href)) continue;
      const box0 = await el.boundingBox();
      if (!box0 || box0.width < 8 || box0.height < 8) continue;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await f.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 16; i++) { if (await f.evaluate(() => (document.body?.innerText || '').trim().length > 0 || document.images.length > 0).catch(() => false)) break; await sleep(500); }
      await sleep(1000);
      if (await f.evaluate(unsavable).catch(() => true)) { why('drawn or played content'); continue; }
      const controls = await f.evaluate(markControls).catch(() => []);
      await f.evaluate(markDetails).catch(() => 0);
      await f.evaluate(snapBase);
      const first = await f.evaluate(serialize);
      if (!first.text && !/<img|<svg/i.test(first.body)) { why('nothing drawn'); continue; }
      if (/verifying (?:you are human|your browser)|checking your browser|security checkpoint|are you (?:a )?(?:robot|human)|just a moment\.\.\.|captcha/i.test(first.text.slice(0, 2000))) { why('bot check'); continue; }
      const startKey = controls.find((c) => c.active)?.label || null;
      const states = [{ key: startKey || '(start)', ...first }];
      const details = [], budget = { n: MAX_DETAILS, bytes: MAX_DETAIL_BYTES, ok: true };
      await exploreDetails(page, el, f, states[0], details, budget);
      // Each view button in turn: a view is kept when it shows something the others don't and the frame stayed put.
      for (const c of controls.slice(0, MAX_VIEWS)) {
        if (c.label === startKey) continue;
        const before = f.url();
        const ok = await f.click(`[data-pv-ctl="${c.label.replace(/["\\]/g, '\\$&')}"]`, { timeout: 4000 }).then(() => true, () => false);
        if (!ok) continue;
        await sleep(800);
        await f.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
        await f.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 4000); })))).catch(() => {});
        await sleep(500);
        if (f.isDetached() || f.url().split('#')[0] !== before.split('#')[0]) break; // it went somewhere: not a view
        await f.evaluate(markControls).catch(() => {});
        await f.evaluate(markDetails).catch(() => 0);
        await f.evaluate(snapBase);
        const s = await f.evaluate(serialize);
        if (states.some((x) => x.text === s.text && x.body.length === s.body.length)) continue;
        states.push({ key: c.label, ...s });
        await exploreDetails(page, el, f, states[states.length - 1], details, budget);
      }
      for (const s of states) s.body = s.body.replace(/ data-pv-dc="\d+"/g, '');
      // Back to the view the visitor first saw, for the reference pictures the quality check compares against.
      if (startKey && states.length > 1 && !f.isDetached()) {
        await f.evaluate(markControls).catch(() => {});
        await f.click(`[data-pv-ctl="${startKey.replace(/["\\]/g, '\\$&')}"]`, { timeout: 4000 }).catch(() => {});
        await sleep(1000);
      }
      states.push(...details);
      const files = await localize(states, outDir, manifest, request);
      const box = await el.boundingBox();
      const key = `${prof}-${n++}`;
      // A widget that sized its frame to its content (it told the page its height) gets the same: the frame follows the
      // content when the view changes. Otherwise the frame keeps the size the page gave it.
      const autosize = !!box && Math.abs(box.height - first.h) <= 8;
      fs.writeFileSync(path.join(outDir, 'frames', `${key}.json`), JSON.stringify({ src: fu.origin + fu.pathname, autosize, height: Math.round(box?.height || box0.height), states }));
      await el.evaluate((e, k) => e.setAttribute('data-preserve-frame', k), key);
      done.push({ src: fu.host, saved: true, key, views: states.filter((s) => s.ov == null).map((s) => s.key), details: details.length, files });
    } catch (e) {
      why(String(e.message || e).split('\n')[0].slice(0, 120));
    }
  }
  return done.filter((d) => d.saved).length;
}

// Capture: open each detail window a view has (markDetails), save what it adds on top, and close it again. The view's
// saved body gets data-pv-ctl="pv:d<n>" on what opened it, so in the Preserve the same click opens the same window.
// The same window opened twice in a view is saved once. Stops for the frame when a window won't close or the frame moved.
async function exploreDetails(page, el, f, view, details, budget) {
  if (!budget.ok) return;
  const count = (view.body.match(/ data-pv-dc="\d+"/g) || []).length;
  const keys = new Map();
  for (let i = 0; i < count && budget.n > 0 && budget.bytes > 0; i++) {
    const before = f.url(), pages = page.context().pages().length, box0 = await el.boundingBox();
    if (await f.evaluate(markDetails).catch(() => -1) !== count) { budget.ok = false; break; } // it redrew differently
    const hit = await f.click(`[data-pv-dc="${i}"]`, { timeout: 3000 }).then(() => true, () => false);
    if (!hit) continue;
    await sleep(700);
    await f.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 3000); })))).catch(() => {});
    await sleep(200);
    for (const p of page.context().pages().slice(pages)) await p.close().catch(() => {});
    if (f.isDetached() || f.url().split('#')[0] !== before.split('#')[0]) { budget.ok = false; await f.goto(before).catch(() => {}); break; }
    const o = await f.evaluate(opened).catch(() => null);
    // Some widgets have the page make their frame fill the screen while the window is open (a phone sheet).
    const vp = page.viewportSize(), box1 = await el.boundingBox();
    const take = !!(o && box0 && box1 && vp && Math.abs(box1.width - box0.width) + Math.abs(box1.height - box0.height) > 4
      && box1.width >= vp.width * 0.9 && box1.height >= vp.height * 0.9 && Math.abs(box1.y) < 4);
    if (o) {
      const d = await f.evaluate(serialize, { ov: true });
      let k = details.find((x) => x.text === d.text && x.view === view.key)?.key; // the same window over another view is saved again: it sits in that view
      if (!k && d.ov.length < budget.bytes) {
        k = `pv:d${details.length}`;
        details.push({ key: k, ov: d.ov.replace(/ data-pv-dc="\d+"/g, ''), host: o.host, ch: o.ch, view: view.key, take, css: d.css, text: d.text, h: 0 });
        budget.n--; budget.bytes -= d.ov.length;
      }
      if (k) keys.set(i, k);
    }
    // Close it the way a visitor would: Escape, else its close button. Then the view must be as it was.
    await f.evaluate(unmark).catch(() => {});
    const gone = () => f.evaluate(closed, o ? o.text : '').catch(() => false);
    if (o && !(await gone())) {
      await page.keyboard.press('Escape').catch(() => {}); await sleep(500);
      if (!(await gone())) { await f.evaluate(pressClose).catch(() => {}); await sleep(600); }
    }
    for (let t = 0; t < 6 && !(await gone()); t++) await sleep(250);
    if (!(await gone())) {
      keys.delete(i); budget.ok = false; break;
    }
  }
  view.body = view.body.replace(/ data-pv-dc="(\d+)"/g, (m, i) => (keys.has(+i) ? ` data-pv-ctl="${keys.get(+i)}"` : ''));
}

// Export: the saved frame as a document for srcdoc, its files copied in with asset(name, file) -> page-relative path.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
export function frameDoc(siteDir, key, asset) {
  const f = path.join(siteDir, 'frames', `${key}.json`);
  if (!fs.existsSync(f)) return null;
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  const local = (t) => t.replace(/pfa:([\w.-]+)/g, (m, n) => asset(n, path.join(siteDir, 'frames', 'files', n)) || '');
  const [start, ...rest] = saved.states;
  const views = {};
  for (const s of saved.states) {
    const k = s.key || '(start)', css = s === start || s.css !== start.css ? local(s.css) : null;
    views[k] = s.ov != null ? { ov: local(s.ov), host: s.host || [], ch: s.ch || [], view: s.view, take: !!s.take, css } : { body: local(s.body), css };
  }
  const json = JSON.stringify(views).replace(/</g, '\\u003c');
  const attrs = (start.html || []).filter(([a]) => !/^on/i.test(a)).map(([a, v]) => ` ${a}="${esc(v)}"`).join('');
  const doc = `<!doctype html><html${attrs}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="pv-css">${local(start.css).replace(/<\/style/gi, '<\\/style')}</style></head>${local(start.body)}<script>${FRAME_SCRIPT.replace('__START__', () => JSON.stringify(start.key || '(start)').replace(/</g, '\\u003c')).replace('__VIEWS__', () => json)}</script></html>`;
  const nd = saved.states.filter((s) => s.ov != null).length;
  return { doc, autosize: saved.autosize, views: saved.states.length - nd, details: nd, extra: rest.length - nd };
}

// Inside the saved frame: view buttons switch views; what opened a detail window on the live widget opens the same
// window over the current view (a close button, the dimmed area around it and Escape close it); any other link or
// button asks the page for the snapshot note; the frame tells the page its content height.
const FRAME_SCRIPT = `(function(){var V=__VIEWS__,cur=__START__,R=[].map.call(document.documentElement.attributes,function(a){return [a.name,a.value]}),B=document.getElementById('pv-css').textContent,C=B;
function h(){var m=0,b=document.body;[].forEach.call(b.children,function(e){var r=e.getBoundingClientRect(),p=getComputedStyle(e).position;if(r.height&&p!=='absolute'&&p!=='fixed')m=Math.max(m,r.bottom+scrollY)});var s=getComputedStyle(b);m+=(parseFloat(s.marginBottom)||0)+(parseFloat(s.paddingBottom)||0);parent.postMessage({preserveFrame:1,h:Math.ceil(m)},'*')}
function css(t){t=t!=null?t:B;if(t!==C){document.getElementById('pv-css').textContent=t;C=t}}
function show(k){var v=V[k];if(!v)return false;if(v.ov!=null)return open(v);var d=new DOMParser().parseFromString('<!doctype html><html>'+v.body+'</html>','text/html');document.documentElement.replaceChild(document.adoptNode(d.body),document.body);css(V[k].css);cur=k;setTimeout(h,30);setTimeout(h,400);return true}
function shut(){if(document.querySelector('[data-pv-ov]')){show(cur);var H=document.documentElement;[].slice.call(H.attributes).forEach(function(a){H.removeAttribute(a.name)});R.forEach(function(a){H.setAttribute(a[0],a[1])});parent.postMessage({preserveFrame:1,take:0},'*')}}
function at(path){if(path==='html')return document.documentElement;var p=document.body;path.forEach(function(i){if(p)p=[].filter.call(p.children,function(c){return !c.hasAttribute('data-pv-ov')})[i]||null});return p}
function open(v){shut();var same=v.view===cur,p=same&&at(v.host)||document.body;var d=new DOMParser().parseFromString('<!doctype html><html><body>'+v.ov+'</body></html>','text/html');[].slice.call(d.body.children).forEach(function(n){n.setAttribute('data-pv-ov','');p.appendChild(document.adoptNode(n))});if(same)v.ch.forEach(function(c){var e=at(c[0]);if(e)c[1].forEach(function(a){if(a[1]==null)e.removeAttribute(a[0]);else e.setAttribute(a[0],a[1])})});if(v.css!=null)css(v.css);if(v.take)parent.postMessage({preserveFrame:1,take:1},'*');setTimeout(h,30);return true}
function stop(e){e.preventDefault();e.stopImmediatePropagation()}
document.addEventListener('click',function(e){var t=e.target;if(!t.closest)return;if(t.hasAttribute('data-pv-bd')){stop(e);shut();return}var c=t.closest('[data-pv-ctl]');if(c){var k=c.getAttribute('data-pv-ctl');if(k==='pv:close'){stop(e);shut();return}if(show(k)){stop(e);return}}var x=document.querySelector('[data-pv-ov]')&&t.closest('button,[role=button],a');if(x&&(/\\b(close|dismiss)\\b/i.test((x.getAttribute('aria-label')||'')+' '+(x.getAttribute('title')||''))||/^(\u00d7|\u2715|\u2716|x|close)$/i.test((x.textContent||'').trim()))){stop(e);shut();return}var a=t.closest('a,button,input[type=submit],input[type=button],[role=button],[role=link],label');if(!a)return;stop(e);parent.postMessage({preserveFrame:1,replica:a.tagName==='A'||/^(link|button)$/.test(a.getAttribute('role')||'')&&a.tagName!=='BUTTON'?'link':'form'},'*')},true);
document.addEventListener('keydown',function(e){if(e.key==='Escape')shut()});
document.addEventListener('submit',function(e){e.preventDefault();parent.postMessage({preserveFrame:1,replica:'form'},'*')},true);
addEventListener('load',h);document.addEventListener('load',h,true);addEventListener('resize',function(){clearTimeout(h.t);h.t=setTimeout(h,60)});setTimeout(h,0)})();`;

// On the page: size each saved frame that asks, let it fill the screen while a detail window that did so live is open, and show the snapshot note (the page's own preserve-replica script, by
// a click it turns into the note) for clicks inside a frame.
export const PAGE_SCRIPT = `<script id="preserve-frames">addEventListener('message',function(e){var d=e.data;if(!d||d.preserveFrame!==1)return;var f=[].filter.call(document.querySelectorAll('iframe[data-preserve-frame]'),function(x){return x.contentWindow===e.source})[0];if(!f)return;if(d.take===1&&!f.hasAttribute('data-pv-take')){f.setAttribute('data-pv-take',f.getAttribute('style')||'');f.style.cssText+=';position:fixed!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;z-index:2147483646!important'}if(d.take===0&&f.hasAttribute('data-pv-take')){f.setAttribute('style',f.getAttribute('data-pv-take'));f.removeAttribute('data-pv-take')}if(d.h&&f.hasAttribute('data-pv-autosize')&&!f.hasAttribute('data-pv-take'))f.style.height=d.h+'px';if(d.replica&&document.getElementById('preserve-replica')){var x=document.createElement(d.replica==='link'?'a':'button');if(d.replica==='link')x.href='https://snapshot.invalid/';else x.type='submit';x.style.display='none';document.body.appendChild(x);x.click();x.remove()}})</script>`;
