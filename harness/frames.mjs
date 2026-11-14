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
function serialize() {
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

const EXT = { 'image/webp': 'webp', 'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'application/font-woff': 'woff', 'application/font-woff2': 'woff2', 'application/x-font-ttf': 'ttf' };

// Every image and font a saved frame uses, saved beside it (frames/files/), and its address replaced by pfa:<file>.
// From the capture's own record when the browser fetched it, otherwise fetched now. Anything else is dropped.
async function localize(states, outDir, manifest, request) {
  const dir = path.join(outDir, 'frames', 'files');
  fs.mkdirSync(dir, { recursive: true });
  const urls = new Set();
  for (const s of states) for (const t of [s.css, s.body]) for (const m of t.matchAll(/(?:url\('|src="|href=")(https?:\/\/[^"']+)["']/g)) urls.add(m[1].replace(/&amp;/g, '&'));
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
  for (const s of states) { s.css = swap(s.css); s.body = swap(s.body); }
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
      const first = await f.evaluate(serialize);
      if (!first.text && !/<img|<svg/i.test(first.body)) { why('nothing drawn'); continue; }
      if (/verifying (?:you are human|your browser)|checking your browser|security checkpoint|are you (?:a )?(?:robot|human)|just a moment\.\.\.|captcha/i.test(first.text.slice(0, 2000))) { why('bot check'); continue; }
      const startKey = controls.find((c) => c.active)?.label || null;
      const states = [{ key: startKey, ...first }];
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
        const s = await f.evaluate(serialize);
        if (states.some((x) => x.text === s.text && x.body.length === s.body.length)) continue;
        states.push({ key: c.label, ...s });
      }
      // Back to the view the visitor first saw, for the reference pictures the quality check compares against.
      if (startKey && states.length > 1 && !f.isDetached()) {
        await f.evaluate(markControls).catch(() => {});
        await f.click(`[data-pv-ctl="${startKey.replace(/["\\]/g, '\\$&')}"]`, { timeout: 4000 }).catch(() => {});
        await sleep(1000);
      }
      const files = await localize(states, outDir, manifest, request);
      const box = await el.boundingBox();
      const key = `${prof}-${n++}`;
      // A widget that sized its frame to its content (it told the page its height) gets the same: the frame follows the
      // content when the view changes. Otherwise the frame keeps the size the page gave it.
      const autosize = !!box && Math.abs(box.height - first.h) <= 8;
      fs.writeFileSync(path.join(outDir, 'frames', `${key}.json`), JSON.stringify({ src: fu.origin + fu.pathname, autosize, height: Math.round(box?.height || box0.height), states }));
      await el.evaluate((e, k) => e.setAttribute('data-preserve-frame', k), key);
      done.push({ src: fu.host, saved: true, key, views: states.map((s) => s.key || '(start)'), files });
    } catch (e) {
      why(String(e.message || e).split('\n')[0].slice(0, 120));
    }
  }
  return done.filter((d) => d.saved).length;
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
  for (const s of saved.states) if (s.key) views[s.key] = { body: local(s.body), css: s === start || s.css !== start.css ? local(s.css) : null };
  const json = JSON.stringify(views).replace(/</g, '\\u003c');
  const attrs = (start.html || []).filter(([a]) => !/^on/i.test(a)).map(([a, v]) => ` ${a}="${esc(v)}"`).join('');
  const doc = `<!doctype html><html${attrs}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="pv-css">${local(start.css).replace(/<\/style/gi, '<\\/style')}</style></head>${local(start.body)}<script>${FRAME_SCRIPT.replace('__VIEWS__', json)}</script></html>`;
  return { doc, autosize: saved.autosize, views: Object.keys(views).length || 1, extra: rest.length };
}

// Inside the saved frame: view buttons switch views; any other link or button asks the page for the snapshot note; the
// frame tells the page its content height.
const FRAME_SCRIPT = `(function(){var V=__VIEWS__;
function h(){var m=0,b=document.body;[].forEach.call(b.children,function(e){var r=e.getBoundingClientRect(),p=getComputedStyle(e).position;if(r.height&&p!=='absolute'&&p!=='fixed')m=Math.max(m,r.bottom+scrollY)});var s=getComputedStyle(b);m+=(parseFloat(s.marginBottom)||0)+(parseFloat(s.paddingBottom)||0);parent.postMessage({preserveFrame:1,h:Math.ceil(m)},'*')}
function show(k){var v=V[k];if(!v)return false;var d=new DOMParser().parseFromString('<!doctype html><html>'+v.body+'</html>','text/html');document.documentElement.replaceChild(document.adoptNode(d.body),document.body);if(v.css!=null)document.getElementById('pv-css').textContent=v.css;setTimeout(h,30);setTimeout(h,400);return true}
document.addEventListener('click',function(e){var t=e.target;if(!t.closest)return;var c=t.closest('[data-pv-ctl]');if(c&&show(c.getAttribute('data-pv-ctl'))){e.preventDefault();e.stopImmediatePropagation();return}var a=t.closest('a,button,input[type=submit],input[type=button],[role=button],[role=link],label');if(!a)return;e.preventDefault();e.stopImmediatePropagation();parent.postMessage({preserveFrame:1,replica:a.tagName==='A'||/^(link|button)$/.test(a.getAttribute('role')||'')&&a.tagName!=='BUTTON'?'link':'form'},'*')},true);
document.addEventListener('submit',function(e){e.preventDefault();parent.postMessage({preserveFrame:1,replica:'form'},'*')},true);
addEventListener('load',h);document.addEventListener('load',h,true);addEventListener('resize',function(){clearTimeout(h.t);h.t=setTimeout(h,60)});setTimeout(h,0)})();`;

// On the page: size each saved frame that asks, and show the snapshot note (the page's own preserve-replica script, by
// a click it turns into the note) for clicks inside a frame.
export const PAGE_SCRIPT = `<script id="preserve-frames">addEventListener('message',function(e){var d=e.data;if(!d||d.preserveFrame!==1)return;var f=[].filter.call(document.querySelectorAll('iframe[data-preserve-frame]'),function(x){return x.contentWindow===e.source})[0];if(!f)return;if(d.h&&f.hasAttribute('data-pv-autosize'))f.style.height=d.h+'px';if(d.replica&&document.getElementById('preserve-replica')){var x=document.createElement(d.replica==='link'?'a':'button');if(d.replica==='link')x.href='https://snapshot.invalid/';else x.type='submit';x.style.display='none';document.body.appendChild(x);x.click();x.remove()}})</script>`;
