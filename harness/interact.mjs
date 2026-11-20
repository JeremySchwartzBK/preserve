// Clicks and hovers that plugins drive (plugin replay step 2b; Jeremy approved 2026-11-18, thread "Plan support for
// Squarespace plugins"). A plugin (Will Myers, Ghost Plugins, Square Refresh, SquareKicker, an owner's own code) opens
// a mega menu on hover, a slide-out panel or an accordion on click, swaps a picture under the pointer. The copy drops
// the plugin's script, so none of that happened in the Preserve: the quality check held such sites for "hover effect
// lost" or "dropdown doesn't open" (Field Theory, Ela House, Honeybelle, Samuel Sparrow in the Nov 16 run).
//
// Watch and replay, never the plugin's code: while capturing, we note which elements plugin code (anything that isn't
// Squarespace's own) listens on for clicks or the pointer (LISTEN_INIT, installed before the page's scripts run). Each
// one is hovered (desktop) and clicked or tapped, and we record what the plugin changed: class names, other attributes
// and inline styles on elements already there, and elements it added. Only changes that show on screen are kept, and
// nothing that changes by itself while we wait (a slideshow) counts. We also note how each one closes again: when the
// pointer leaves, a second click, Escape, or a click elsewhere. The elements involved are numbered (data-pv-at), the
// recorded states go in the page as data (script#preserve-acts-data, of a type of our own: the scrub step drops JSON data), elements a plugin added go back in the page
// hidden (inline display:none, its own display kept in data-pv-hide) so every later step (pictures, our own stylesheet) treats them as part of the page, and our
// stand-in (build.mjs ACT_SCRIPT) makes the same changes on the same gestures. Our own stylesheet (own-css.mjs) shows
// each state once and writes its look as rules, as it does for galleries.

// Installed with addInitScript, before any of the page's scripts: remembers which elements code from outside
// Squarespace listens on, for clicks ("c") or the pointer arriving ("h"). The caller is read from the call stack: a
// frame from a plugin's address, or from the page itself (code the owner pasted in), makes it a plugin's listener.
export const LISTEN_INIT = `(() => {
  if (window.__pvL) return;
  const SQ = /(^|\\.)(squarespace\\.com|sqspcdn\\.com|squarespace-cdn\\.com)(:|\\/|$)/;
  const KIND = { click: 'c', mousedown: 'c', mouseup: 'c', pointerdown: 'c', pointerup: 'c', touchstart: 'c', touchend: 'c',
    mouseenter: 'h', mouseover: 'h', pointerenter: 'h', pointerover: 'h' };
  const reg = new Map(), deleg = { c: 0, h: 0 };
  window.__pvL = { reg, deleg };
  const orig = EventTarget.prototype.addEventListener;
  const fromPlugin = () => {
    const lim = Error.stackTraceLimit; Error.stackTraceLimit = 40;
    const st = new Error().stack || ''; Error.stackTraceLimit = lim;
    const hosts = [];
    for (const l of st.split('\\n').slice(2)) { const m = /(https?:\\/\\/[^/\\s)]+)[^\\s)]*:\\d+:\\d+/.exec(l); if (m) hosts.push(m[1].replace(/^https?:\\/\\//, '')); }
    return hosts.some((h) => !SQ.test(h));
  };
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    try {
      const k = KIND[type];
      if (k && fromPlugin()) {
        if (this instanceof Element) { const r = reg.get(this) || {}; r[k] = 1; reg.set(this, r); }
        else if (this === document || this === window) deleg[k]++;
      }
    } catch (e) { /* never get in the page's way */ }
    return orig.call(this, type, fn, o);
  };
})();`;

import { OVERLAY_SELECTORS } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PX = 48;
// Attributes a picture's loader sets when it comes into view.
const LAZY_ATTR = /^(src|srcset|sizes|loading|data-src|data-srcset|data-loader|data-load|data-loaded|data-image-.*|data-image)$/; // a pixel counts as changed past this sum of channel differences (behavior.mjs)

// Already replayed by our own stand-ins, or not this step's job: galleries, plugin carousels (one click is one step of
// many, a later step's job), video players, sliders, tickers, followers, scroll effects,
// forms, checkout, and Squarespace's own header menus (MENU_SCRIPT).
const SKIP_IN = '.accordion-items-container,.flickity-enabled,.slick-slider,.swiper,.splide,.glide,.owl-carousel,.sqs-video-icon,.sqs-video-wrapper,.video-player,[data-pv-gal],[data-pv-swiper],[data-pv-tick],[data-pv-pointer],[data-pv-scroll],[data-pv-scrollshow],form,.sqs-add-to-cart-button,[data-add-to-cart],.header-burger,.header-menu,iframe';

// The changes between two attribute records, per element: class names added and removed, inline style properties,
// other attributes.
function splitChange(attr, ov, nv) {
  if (attr === 'class') {
    const o = new Set((ov || '').split(/\s+/).filter(Boolean)), n = new Set((nv || '').split(/\s+/).filter(Boolean));
    const add = [...n].filter((x) => !o.has(x)), rem = [...o].filter((x) => !n.has(x));
    return add.length || rem.length ? { c: [add, rem] } : null;
  }
  if (attr === 'style') {
    const parse = (t) => Object.fromEntries((t || '').split(';').map((x) => { const i = x.indexOf(':'); return i < 0 ? null : [x.slice(0, i).trim().toLowerCase(), x.slice(i + 1).trim()]; }).filter((x) => x && x[0]));
    const o = parse(ov), n = parse(nv), s = {};
    for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) if (o[k] !== n[k]) s[k] = [o[k] ?? null, n[k] ?? null];
    return Object.keys(s).length ? { s } : null;
  }
  return ov === nv ? null : { a: { [attr]: [ov, nv] } };
}

// Share of pixels that changed between b and c but not between a and b (what moves by itself doesn't count).
function changedPixels(a, b, c) {
  let n = 0;
  for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
    const i = (y * c.width + x) * 4;
    const d = (p, q) => Math.abs(p.data[i] - q.data[i]) + Math.abs(p.data[i + 1] - q.data[i + 1]) + Math.abs(p.data[i + 2] - q.data[i + 2]);
    if (d(b, c) > PX && d(a, b) <= PX) n++;
  }
  return n / ((c.width / 2) * (c.height / 2));
}

export async function recordInteractions(page, prof, { budgetMs = prof === 'desktop' ? 120000 : 60000, maxCand = 36 } = {}) {
  const { PNG } = await import('pngjs');
  const shot = async () => PNG.sync.read(await page.screenshot({ scale: 'css' }));
  const t0 = Date.now();
  const out = { candidates: 0, tried: 0, kept: 0, states: [], skipped: {} };
  const skip = (why) => { out.skipped[why] = (out.skipped[why] || 0) + 1; };
  // Candidates: elements plugin code listens on, then (when a plugin listens on the whole page) buttons and other
  // things that look clickable. Visible, a sensible size, and not inside something we already handle.
  // Marketing popups and bars are dropped from the copy (their close buttons have nothing to close there).
  const SKIP = SKIP_IN + ',' + OVERLAY_SELECTORS.join(',');
  const cands = await page.evaluate(([prof, SKIP_IN, maxCand]) => {
    const L = window.__pvL; if (!L) return [];
    const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width >= 8 && r.height >= 8 && r.width * r.height < innerWidth * innerHeight * 0.8 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
    const list = [], seen = { h: new Set(), c: new Set() };
    const add = (e, k, why) => {
      if (seen[k].has(e) || list.length >= maxCand || !e.isConnected || e === document.body || e === document.documentElement) return;
      if (e.closest(SKIP_IN) || !vis(e)) return;
      // Squarespace's own folder dropdowns have our stand-in: only plugin code listening on them makes them a candidate.
      if (why !== 'listener' && e.closest('.header-nav-folder-title,.header-nav-item--folder')) return;
      // A link to another page is a link: clicking it shows the "snapshot" note, whatever a plugin does with it on the
      // way (a booking popup, say); hovering it can still open a plugin's menu.
      if ((k === 'c' || why !== 'listener') && e.closest('a[href]') && !/^(#|javascript:|$)/.test(e.closest('a[href]').getAttribute('href') || '')) return;
      seen[k].add(e); list.push({ e, k, why });
    };
    for (const [e, r] of L.reg) {
      if (r.h && prof === 'desktop') add(e, 'h', 'listener');
      if (r.c) add(e, 'c', 'listener');
    }
    if (L.deleg.c) for (const e of document.querySelectorAll('button:not([type=submit]),[role=button],[aria-expanded],[aria-controls],summary')) add(e, 'c', 'page-listener');
    // Nested candidates on the same element tree with the same gesture: keep the outermost (one hover, one state).
    const keep = list.filter((x) => !list.some((y) => y !== x && y.k === x.k && y.e !== x.e && y.e.contains(x.e)));
    // One element can be both a hover and a click candidate: it carries both numbers.
    return keep.map((x, i) => { x.e.setAttribute('data-preserve-ic', ((x.e.getAttribute('data-preserve-ic') || '') + ' ' + i).trim()); return { i, k: x.k, why: x.why, hover: !!(L.reg.get(x.e)?.h || L.deleg.h), tag: x.e.tagName.toLowerCase(), cls: (x.e.className && x.e.className.toString() || '').slice(0, 60) }; });
  }, [prof, SKIP, maxCand]).catch(() => []);
  out.candidates = cands.length;
  if (!cands.length) return out;

  // Nothing leaves the page while we click: navigations get an empty "no content" answer (the browser then stays on the
  // page; refusing them outright would swap the page for an error page), new windows don't open, forms don't send.
  let navs = 0;
  const block = (route) => (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame() ? (navs++, route.fulfill({ status: 204, body: '' })) : route.fallback());
  await page.route('**/*', block);
  try { return await record(); } finally {
    await page.unroute('**/*', block).catch(() => {});
    await page.evaluate(() => {
      document.querySelectorAll('[data-preserve-ic]').forEach((e) => e.removeAttribute('data-preserve-ic'));
      if (window.__pvOpen) { window.open = window.__pvOpen; removeEventListener('click', window.__pvStopNav); removeEventListener('submit', window.__pvStopSub, true); }
    }).catch(() => {});
  }
  async function record() {
  await page.evaluate(() => {
    window.__pvOpen = window.open; window.open = () => { window.__pvNavs++; return null; };
    window.__pvNavs = 0;
    // Last in line: a link click no script took over would have gone to another page (counted, then stopped).
    window.__pvStopNav = (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a && !/^#/.test(a.getAttribute('href') || '') && !e.defaultPrevented) { window.__pvNavs++; e.preventDefault(); } };
    addEventListener('click', window.__pvStopNav);
    window.__pvStopSub = (e) => e.preventDefault(); addEventListener('submit', window.__pvStopSub, true);
  });
  const y0 = await page.evaluate(() => { window.__pvRec = 1; return scrollY; });
  // The page itself can still start over (a script that rewrites the document): then nothing recorded is kept.
  const alive = () => page.evaluate(() => window.__pvRec === 1).catch(() => false);

  // Attribute changes and added elements under the whole page, from start() to stop().
  const start = () => page.evaluate(() => {
    window.__pvM = { at: new Map(), added: [] };
    window.__pvMo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'attributes') {
          const a = m.attributeName;
          if (/^data-(preserve|pv)-/.test(a)) continue;
          const o = window.__pvM.at.get(m.target) || {}; if (!(a in o)) o[a] = m.oldValue; window.__pvM.at.set(m.target, o);
        } else for (const n of m.addedNodes) if (n.nodeType === 1 && !/^(SCRIPT|STYLE|LINK|IFRAME|NOSCRIPT)$/.test(n.tagName)) window.__pvM.added.push(n);
      }
    });
    window.__pvMo.observe(document.documentElement, { subtree: true, attributes: true, attributeOldValue: true, childList: true });
  });
  // What changed (and is still changed), as { el, attr: [old, new] } on live elements; held in window.__pvLast.
  const stop = (noise) => page.evaluate((noise) => {
    window.__pvMo.takeRecords(); window.__pvMo.disconnect();
    const ch = [];
    for (const [e, o] of window.__pvM.at) {
      if (!e.isConnected || (noise && e.hasAttribute('data-preserve-noise'))) continue;
      const d = {}; for (const a in o) { const nv = e.getAttribute(a); if (nv !== o[a]) d[a] = [o[a], nv]; }
      if (Object.keys(d).length) ch.push([e, d]);
    }
    const added = window.__pvM.added.filter((n) => n.isConnected && !window.__pvM.added.some((p) => p !== n && p.contains(n)));
    for (const n of added) { n.__pvParent = n.parentElement; n.__pvNext = n.nextSibling; }
    window.__pvLast = { ch, added };
    return { n: ch.length, added: added.length };
  }, noise);
  const markNoise = () => page.evaluate(() => { for (const [e] of window.__pvLast.ch) e.setAttribute('data-preserve-noise', ''); });
  // Back to how the page was: attributes as they were, added elements taken out (kept aside for a kept state).
  const revert = () => page.evaluate(() => {
    const L = window.__pvLast; if (!L) return;
    for (const [e, d] of L.ch) for (const a in d) { const v = d[a][0]; if (v === null) e.removeAttribute(a); else e.setAttribute(a, v); }
    for (const n of L.added) if (n.isConnected) n.remove();
  });
  const settle = () => page.evaluate(async () => {
    const t = performance.now();
    while (performance.now() - t < 1500) { const run = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations !== Infinity); if (!run.length) break; await new Promise((r) => setTimeout(r, 100)); }
  });
  const whereNow = (i) => page.evaluate((i) => {
    const e = document.querySelector(`[data-preserve-ic~="${i}"]`); if (!e) return null;
    e.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = e.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return null;
    // A point on the element that the element itself gets (not something drawn over it).
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (top && (top === e || e.contains(top))) return { x, y };
    }
    return null;
  }, i);
  // A header that slides back in after we scroll to an element can leave it covered for a moment: look again once.
  const where = async (i) => (await whereNow(i)) || (await sleep(600), await settle(), await whereNow(i));
  const press = async (p) => { if (prof === 'mobile') await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); };

  const { vw, vh } = await page.evaluate(() => ({ vw: innerWidth, vh: innerHeight }));
  const states = [];
  for (const c of cands) {
    if (Date.now() - t0 > budgetMs) { skip('out of time'); continue; }
    if (!(await alive())) { out.error = 'the page started over while we clicked'; break; }
    const p = await where(c.i); if (!p) { skip('covered or off screen'); continue; }
    // Somewhere far from it (not the top corner: that is often the header, with menus of its own).
    const away = { x: Math.round(vw / 2), y: p.y < vh / 2 ? vh - 3 : Math.max(3, Math.round(p.y - vh * 0.45)) };
    if (c.k === 'h') await page.mouse.move(away.x, away.y);
    // A click with a mouse arrives over the element first. When a plugin opens something on hover too (a "Book now"
    // button that opens a panel on hover, and toggles it on click), the hover would open it and the click close it
    // again, so the click looked like it did nothing. The pointer rests on the element first, so the hover's part
    // counts as the starting point and only what the click itself changes is measured (the hover is its own candidate).
    else if (prof === 'desktop' && c.hover) { await page.mouse.move(p.x, p.y, { steps: 4 }); await sleep(450); await settle(); }
    await sleep(350);
    out.tried++;
    // What changes by itself, first, so it doesn't count.
    await start(); const a = await shot(); await sleep(500); const b = await shot(); await stop(false); await markNoise();
    await start();
    const nav0 = navs + (await page.evaluate(() => window.__pvNavs));
    if (c.k === 'h') await page.mouse.move(p.x, p.y, { steps: 4 }); else await press(p);
    await sleep(450); await settle();
    const s = await stop(true);
    const cshot = await shot();
    // A click that sends the visitor to another page: the "snapshot" note covers it, whatever else it did on the way.
    const left = c.k === 'c' && navs + (await page.evaluate(() => window.__pvNavs)) > nav0;
    const seen = changedPixels(a, b, cshot);
    if (left) skip('goes to another page');
    else if (!s.n && !s.added) { skip('nothing changed'); }
    else if (seen < 0.0015) { skip('nothing visible changed'); }
    let keep = !left && (s.n || s.added) && seen >= 0.0015;
    // How it closes again, as the visitor would close it.
    const undo = {};
    // Closed again = most of what changed on screen is back as it was (attributes such as tabindex can stay changed).
    const closed = async () => { await sleep(500); await settle(); return changedPixels(a, b, await shot()) < seen * 0.3; };
    if (keep) {
      if (c.k === 'h') {
        await page.mouse.move(away.x, away.y, { steps: 3 }); undo.leave = await closed();
        // One that stays changed once the pointer has gone isn't a hover effect we can tell apart from noise: left out.
        if (!undo.leave) { skip('hover that does not undo'); keep = false; }
      }
      else {
        const q = await where(c.i);
        if (q) { await press(q); undo.again = await closed(); }
        if (!undo.again) { await page.keyboard.press('Escape'); undo.esc = await closed(); }
        // A close button in what opened (a slide-out's "x"), then a click well away from it.
        if (!undo.again && !undo.esc) {
          const btn = await page.evaluate(() => {
            const L = window.__pvLast, roots = [...L.added, ...L.ch.map(([e]) => e)].filter((e) => e !== document.body && e !== document.documentElement);
            for (const r of roots) for (const e of [r, ...r.querySelectorAll('*')]) {
              const lab = ((e.getAttribute('aria-label') || '') + ' ' + (e.className && e.className.toString()) + ' ' + (e.children.length ? '' : e.textContent)).toLowerCase();
              if (!/(^|[\s_-])close|^\s*[×✕✖x]\s*$|dismiss/.test(lab)) continue;
              const b = e.getBoundingClientRect(); if (b.width < 6 || b.height < 6) continue;
              const x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y);
              if (top && (top === e || e.contains(top))) { e.setAttribute('data-preserve-close', ''); return { x, y }; }
            }
            return null;
          });
          if (btn) { await press(btn); undo.close = await closed(); }
          if (!undo.close) { await press(away); undo.out = await closed(); }
        }
        // One that can't be closed again and covers much of the screen would trap the visitor: left out.
        if (!undo.again && !undo.esc && !undo.close && !undo.out && seen > 0.1) { skip('opens over the page and does not close'); keep = false; }
      }
    }
    if (keep && !(await alive())) { out.error = 'the page started over while we clicked'; break; }
    let st = null;
    if (keep) {
      // Number what took part, keep the change (the elements a plugin added stay aside until the end).
      st = await page.evaluate(([trig, kind]) => {
        const S = window.__pvActs ||= { n: 0, states: [], hold: [] };
        const id = (e) => { if (!e.hasAttribute('data-pv-at')) e.setAttribute('data-pv-at', String(S.n++)); return e.getAttribute('data-pv-at'); };
        const t = document.querySelector(`[data-preserve-ic~="${trig}"]`); if (!t) return null;
        const ch = window.__pvLast.ch.map(([e, d]) => [id(e), d]);
        const tags = Object.fromEntries(window.__pvLast.ch.map(([e]) => [e.getAttribute('data-pv-at'), e.tagName.toLowerCase()]));
        const added = window.__pvLast.added.map((n) => { S.hold.push(n); return S.hold.length - 1; });
        const cb = document.querySelector('[data-preserve-close]'); const close = cb ? id(cb) : null; if (cb) cb.removeAttribute('data-preserve-close');
        return { t: id(t), k: kind, ch, added, tags, close };
      }, [c.i, c.k]);
      if (!st) { skip('trigger replaced'); keep = false; }
    }
    if (keep) {
      if (undo.close && st.close) undo.close = st.close; else delete undo.close;
      states.push({ ...st, u: undo, why: c.why, what: `${c.tag}.${c.cls}`.slice(0, 70), seen: Math.round(seen * 1000) / 1000 });
    }
    await revert(); await page.mouse.move(away.x, away.y); await sleep(250);
    await page.evaluate(() => document.querySelectorAll('[data-preserve-noise]').forEach((e) => e.removeAttribute('data-preserve-noise')));
  }

  if (out.error) return out;
  // Into the page: the states as data for our stand-in (one change list per state, same triggers merged), elements a
  // plugin added back in their place, hidden.
  const data = [], permanent = {};
  for (const s of states) {
    const ch = {};
    for (const [id, d] of s.ch) for (const [attr, [ov, nv]] of Object.entries(d)) {
      // A picture the state brought in (a lazy image in a menu that opens) loads with the page instead: its address
      // must be one the copy saves, and the state's data never reaches the step that swaps addresses for saved ones.
      if (LAZY_ATTR.test(attr) && /^(img|source|video|picture)$/.test(s.tags[id] || '')) { (permanent[id] ||= {})[attr] = nv; continue; }
      // Any other change that points at an address (a background picture swapped on hover): left out for now.
      if (/https?:|url\(/i.test(nv || '')) { out.skipped['change with an address'] = (out.skipped['change with an address'] || 0) + 1; continue; }
      const x = splitChange(attr, ov, nv); if (!x) continue;
      const o = (ch[id] ||= {});
      if (x.c) o.c = x.c; if (x.s) o.s = { ...(o.s || {}), ...x.s }; if (x.a) o.a = { ...(o.a || {}), ...x.a };
    }
    if (!Object.keys(ch).length && !s.added.length) continue;
    const sig = s.k + JSON.stringify(ch) + s.added.length;
    const same = data.find((x) => x.sig === sig && !s.added.length);
    if (same) { same.t.push(s.t); continue; }
    data.push({ sig, k: s.k, t: [s.t], ch, add: s.added, u: s.u, what: s.what, seen: s.seen });
  }
  const kept = await page.evaluate(([data, permanent]) => {
    const S = window.__pvActs; if (!S) return [];
    for (const id in permanent) { const e = document.querySelector(`[data-pv-at="${id}"]`); if (e) for (const a in permanent[id]) { const v = permanent[id][a]; if (v === null) e.removeAttribute(a); else e.setAttribute(a, v); } }
    const res = [];
    for (const d of data) {
      const add = [];
      for (const h of d.add) {
        const n = S.hold[h]; if (!n || !n.__pvParent || !n.__pvParent.isConnected) continue;
        n.__pvParent.insertBefore(n, n.__pvNext && n.__pvNext.parentNode === n.__pvParent ? n.__pvNext : null);
        if (!n.hasAttribute('data-pv-at')) n.setAttribute('data-pv-at', String(S.n++));
        // Hidden by its own inline style (our stylesheet step reads rules, not inline styles); its own display kept.
        n.setAttribute('data-pv-hide', n.style.getPropertyValue('display') + (n.style.getPropertyPriority('display') ? '!' : ''));
        n.style.setProperty('display', 'none', 'important');
        add.push(n.getAttribute('data-pv-at'));
      }
      res.push({ k: d.k, t: d.t, ch: d.ch, add, u: d.u });
    }
    let el = document.getElementById('preserve-acts-data');
    if (!el) { el = document.createElement('script'); el.type = 'application/x-preserve-acts'; el.id = 'preserve-acts-data'; document.body.appendChild(el); }
    el.textContent = JSON.stringify(res);
    return res.map((r) => ({ k: r.k, triggers: r.t.length, changes: Object.keys(r.ch).length, added: r.add.length, u: r.u }));
  }, [data, permanent]);
  out.kept = kept.length;
  out.states = kept.map((k, i) => ({ ...k, what: data[i].what, seen: data[i].seen }));

  await page.evaluate((y) => scrollTo(0, y), y0); await sleep(400);
  return out;
  }
}
