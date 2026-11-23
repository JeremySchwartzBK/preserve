// What a visitor does with the page, done the same way on the live page and on the copy (Jeremy, 2026-11-23: "the check
// needs to cover typical user actions or interactions"). His spot-check of the 28 "ready" showcase sites found what the
// check never tried: pictures that fade in as you scroll (Caylon Hackwith, La Playa), a product photo that swaps on hover
// (Archive 07), a desktop menu button that doesn't open (Camptown), a contact link left as it was (Colorize). This pass
// tries each kind of thing a visitor does and asks one question per thing: did something visible happen on the live
// page, and does the same happen on the copy?
//
//   appear   scrolling down slowly, block by block: does the block fade or slide in as it comes into view?
//   hover    the mouse over each picture link, product, button and menu item (desktop)
//   click    menu buttons (desktop and phone), menu folders, accordions, tabs, gallery arrows, pictures that open
//            full size, video play buttons: does the screen change?
//   jump     links to another place on the same page, back-to-top included: does the page move?
//   contact  (copy only) contact details still showing as text: emails, phone numbers, web addresses
//
// Things are matched between the two pages by kind, block and order within the block (__preserveAnchor), because the
// copy renames classes. Links that go to another page are never clicked; the live page is kept from navigating away.
import { PNG } from 'pngjs';
import { PROFILES, sleep, OVERLAY_SELECTORS, markPromos, NEXT_SEL, PREV_SEL } from './lib.mjs';
import { ANCHOR } from './check.mjs';

const PX = 48;
const MAX = { hover: 36, click: 28, jump: 8 };
const BUDGET_MS = 150e3;  // per page and layout; what isn't reached in time is left out on both sides alike

function changed(a, b, r) {
  let n = 0, c = 0;
  for (let y = Math.max(0, r.y); y < Math.min(a.height, b.height, r.y + r.h); y += 2)
    for (let x = Math.max(0, r.x); x < Math.min(a.width, b.width, r.x + r.w); x += 2) {
      const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
      n++; if (Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]) > PX) c++;
    }
  return n ? c / n : 0;
}
const shot = async (page) => PNG.sync.read(await page.screenshot());
// A 12 x 12 grey thumbnail of a box, to tell whether the live page and the copy end up looking alike after a hover
// (Archive 07's products change on hover in the copy too, but only zoom; live swaps in a second photo).
function thumb(img, r, n = 12) {
  const out = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    const x0 = Math.max(0, r.x + Math.floor(i * r.w / n)), x1 = Math.min(img.width, r.x + Math.floor((i + 1) * r.w / n));
    const y0 = Math.max(0, r.y + Math.floor(j * r.h / n)), y1 = Math.min(img.height, r.y + Math.floor((j + 1) * r.h / n));
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const k = (y * img.width + x) * 4; s += (img.data[k] + img.data[k + 1] + img.data[k + 2]) / 3; c++; }
    out.push(c ? Math.round(s / c) : 0);
  }
  return out;
}
const thumbDiff = (a, b) => (a && b && a.length === b.length ? a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length : null);
const r3 = (v) => +v.toFixed(3);

// Targets, in page order, with a key that means the same thing on both pages. Run in the page.
function findTargets([kinds, NEXT, PREV, isMobile]) {
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width >= 12 && r.height >= 12 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const here = location.href.split('#')[0];
  const offPage = (a) => { const h = a.getAttribute('href'); if (!h || /^(#|javascript:)/i.test(h)) return false; try { return new URL(h, location.href).href.split('#')[0] !== here; } catch { return true; } };
  const SEL = {
    // Menu buttons and folders: Squarespace's own names (sqs- becomes ps- in the copy), and anything that says it opens.
    menu: '.header-burger-btn, .header-burger button, button[aria-label*="menu" i], [role="button"][aria-label*="menu" i], .header-nav-folder-title, .header-nav-item--folder > a, .header-nav-item--folder > button, .header-menu-nav-folder-title, nav [aria-haspopup="true"]',
    accordion: '.accordion-item__click-target, [aria-expanded]:is(button,[role="button"]), [role="tab"], details > summary',
    arrow: `${NEXT}, ${PREV}`,
    lightbox: '[data-lightbox] img, .lightbox-trigger, .gallery-grid-item img, .gallery-masonry-item img, .gallery-strips-item img, .sqs-gallery-design-grid-slide img, .ps-gallery-design-grid-slide img, .image-block-outer-wrapper[data-lightbox-theme] img, a[href$=".jpg" i] img, a[href*="format="] img',
    play: '.sqs-video-overlay, .ps-video-overlay, .video-player button, .plyr__control--overlaid, button[aria-label*="play" i], .sqs-video-icon, .ps-video-icon',
    hover: 'a:has(img), .product-list-item, .grid-item, .summary-item, .list-item, .user-items-list-item-container, .sqs-block-button-element, .ps-block-button-element, .btn, button:not([aria-label*="menu" i]), header nav a, .header-nav-item > a, .portfolio-hover-item, .image-block-outer-wrapper.design-layout-card, figure:has(img)',
    jump: 'a[href^="#"]:not([href="#"]):not([href="#!"]), a[href*="#"]',
    // Anything else made to be clicked, custom code included (Camptown's menu is a label for a hidden checkbox). Never
    // inside a form or a buy button: those would act on the live site.
    other: 'button, [role="button"], label[for], [onclick], summary',
  };
  const out = [], used = new Set(), count = {};
  for (const kind of kinds) {
    for (const e of document.querySelectorAll(SEL[kind])) {
      if (used.has(e) || e.closest('[data-preserve-promo], .sqs-block-map, .ps-block-map, .map-block, .gm-style, [class*="map-block"]') || !vis(e)) continue;
      if (kind === 'other' && (e.closest('form, .sqs-add-to-cart-button, .ps-add-to-cart-button, [data-add-to-cart], .product-add-to-cart, .newsletter-form, [class*="cart"]') || e.matches('[type="submit"]') || [...used].some((u) => u.contains(e) || e.contains(u)))) continue;
      if (kind === 'hover' && (isMobile || offPage(e) === false && e.tagName === 'A' && /^#/.test(e.getAttribute('href') || ''))) continue;
      if (kind === 'jump') { const h = e.getAttribute('href') || ''; const id = h.split('#')[1]; if (!id || offPage(e) || !document.getElementById(decodeURIComponent(id))) continue; }
      // Clicked things must not leave the page.
      if (kind !== 'hover' && kind !== 'jump') { const a = e.closest('a[href]'); if (a && offPage(a)) continue; }
      if (kind === 'menu' && !isMobile && e.closest('.header-menu')) continue;  // the open phone menu's own items
      const at = window.__preserveAnchor(e);
      const k = `${kind}|${at.blockId || '-'}`; count[k] = (count[k] || 0) + 1;
      if (kind === 'hover' && ![1, 2, 3, 5, 9, 17, 33].includes(count[k])) continue;  // a spread per block, so one long list doesn't use up the turns
      used.add(e); e.setAttribute('data-pv-visit', String(out.length));
      out.push({ i: out.length, kind, key: `${k}|${count[k]}`, at, text: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('alt') || '').trim().slice(0, 40) });
    }
  }
  return out;
}

export async function probeVisitor(browser, url, profileName, { isCopy = false, allowHost = null } = {}) {
  const prof = PROFILES[profileName], mobile = profileName === 'mobile';
  const ctx = await browser.newContext({ ...prof.context, ignoreHTTPSErrors: true });
  let loaded = false;
  await ctx.route('**/*', (r) => {
    const req = r.request(), u = new URL(req.url());
    if (isCopy && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname) && u.hostname !== allowHost && /^http/.test(u.protocol)) return r.abort();
    // Once the page is up, it may not navigate away (a click that leaves the page is undone, not followed).
    if (loaded && req.isNavigationRequest()) { let main = true; try { main = req.frame() === page.mainFrame(); } catch { /* a new window: not followed either */ } if (main) return r.abort(); }
    return r.continue();
  });
  await ctx.addInitScript(ANCHOR);
  const page = await ctx.newPage();
  const out = { appear: {}, act: {}, contact: [], at: {} };
  const t0 = Date.now();
  const setup = async () => {
    loaded = false;
    await page.goto(url, { waitUntil: 'load', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    loaded = true;
    if (!isCopy) { await page.evaluate(markPromos).catch(() => 0); await page.addStyleTag({ content: OVERLAY_SELECTORS.join(',') + '{display:none!important}' }).catch(() => {}); }
    await page.addStyleTag({ content: 'html,body{scroll-behavior:auto!important} *{user-select:none!important}' }).catch(() => {});
    await page.mouse.move(0, 0);
  };
  try {
    await setup();
    const vh = await page.evaluate(() => innerHeight);

    // 1. Appear: the first time down the page, slowly. A block "appears" when, as it comes into view, it is faded or
    // shifted and then settles (read from the page's styles, so a picture still loading doesn't count).
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    const looks = () => page.evaluate(() => {
      // Units: pictures, videos and blocks of text big enough to see, keyed by their block and order in it (galleries
      // and portfolio grids have no blocks of their own, so pictures are counted, not only blocks).
      const res = {}, n = {};
      const units = document.querySelectorAll('img, video, picture, [id^="block-"] p, [id^="block-"] h1, [id^="block-"] h2, [id^="block-"] h3, .sqs-html-content, .ps-html-content');
      for (const u of units) {
        const r = u.getBoundingClientRect();
        if (r.width < 60 || r.height < 16) continue;
        // A picture still loading fades in when it arrives, on any page; not a scroll effect.
        if (u.tagName === 'IMG' && (!u.complete || !u.naturalWidth)) continue;
        const at = window.__preserveAnchor(u), k = at.blockId || '-'; n[k] = (n[k] || 0) + 1;
        if (r.bottom < innerHeight * 0.1 || r.top > innerHeight * 0.9) continue;
        let op = 1, t = 0;
        for (let a = u; a && a !== document.documentElement; a = a.parentElement) {
          const s = getComputedStyle(a); op *= +s.opacity;
          const m = s.transform.match(/matrix\(([^)]+)\)/); if (m) { const v = m[1].split(',').map(Number); t += Math.abs(v[4]) + Math.abs(v[5]) + Math.abs(1 - v[0]) * r.width; }
        }
        res[`${k}#${n[k]}`] = { op, t, at };
      }
      return res;
    });
    for (let y = 0; y < H - vh * 0.5 && Date.now() - t0 < BUDGET_MS * 0.35; y += Math.round(vh * 0.45)) {
      await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), y);
      await sleep(40);
      const early = await looks().catch(() => ({}));
      await sleep(1300);
      const late = await looks().catch(() => ({}));
      for (const [k, e] of Object.entries(early)) {
        if (k in out.appear || !late[k]) continue;
        const l = late[k];
        out.appear[k] = r3(Math.max(0, l.op - e.op) + Math.min(1, Math.max(0, e.t - l.t) / 40));
        out.at[k] ||= e.at;
      }
    }
    await page.evaluate(() => scrollTo(0, 0)); await sleep(800);

    // 2. Contact details still showing (the copy only; the live page has them by design).
    if (isCopy) out.contact = await page.evaluate(() => {
      const t = document.body.innerText, found = [];
      for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) if (!/^name@yourcompany\.com$/i.test(m[0])) found.push(m[0]);
      for (const m of t.matchAll(/(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]\d{4}\b/g)) if (!/555[\s.-]?0100/.test(m[0])) found.push(m[0]);
      for (const m of t.matchAll(/\b(?:https?:\/\/|www\.)[^\s"<>]{4,}/gi)) if (!/yourcompany\.com/i.test(m[0])) found.push(m[0]);
      return [...new Set(found)].slice(0, 8);
    }).catch(() => []);

    // 3. Hover, click and jump, one target at a time.
    const kinds = ['menu', 'accordion', 'arrow', 'lightbox', 'play', 'other', 'jump', 'hover'];
    let targets = await page.evaluate(findTargets, [kinds, NEXT_SEL, PREV_SEL, mobile]);
    const per = {};
    targets = targets.filter((t) => { const g = t.kind === 'hover' ? 'hover' : t.kind === 'jump' ? 'jump' : 'click'; per[g] = (per[g] || 0) + 1; return per[g] <= MAX[g]; });
    let dirty = false;
    for (const t of targets) {
      if (Date.now() - t0 > BUDGET_MS) break;
      if (dirty) { await setup().catch(() => {}); await page.evaluate(findTargets, [kinds, NEXT_SEL, PREV_SEL, mobile]).catch(() => {}); dirty = false; }
      const el = page.locator(`[data-pv-visit="${t.i}"]`).first();
      try {
        await el.scrollIntoViewIfNeeded({ timeout: 3000 });
        await page.mouse.move(0, 0); await sleep(250);
        const box = await el.boundingBox(); if (!box) continue;
        if (t.kind === 'jump') {
          const y0 = await page.evaluate(() => scrollY);
          await el.click({ timeout: 3000, noWaitAfter: true }); await sleep(1200);
          const y1 = await page.evaluate(() => scrollY);
          out.act[t.key] = { kind: t.kind, moved: Math.round(Math.abs(y1 - y0)), text: t.text }; out.at[t.key] = t.at;
          if (Math.abs(y1 - y0) > 20) await page.evaluate((y) => scrollTo(0, y), y0);
          continue;
        }
        let a = await shot(page), idle = 0;
        // What changes on screen by itself in the same time (a slideshow, a ticker), so it isn't taken for the click.
        if (t.kind !== 'hover') { await sleep(1000); const a2 = await shot(page); idle = changed(a, a2, { x: 0, y: 0, w: a.width, h: a.height }); a = a2; }
        if (t.kind === 'hover') { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 }); await sleep(700); }
        else { await el.click({ timeout: 3000, noWaitAfter: true }); await sleep(1000); }
        const b = await shot(page);
        // Pictures the hover brought forward that have nothing to show (Archive 07: the second photo is loaded by
        // Squarespace's script on hover, which the copy doesn't have, so the product went blank).
        const blank = t.kind === 'hover' ? await el.evaluate((e) => { const box = e.closest('.product-list-item, .grid-item, .summary-item, .list-item') || e;
          const imgs = [...box.querySelectorAll('img')].filter((i) => i.getBoundingClientRect().width > 20);
          if (!imgs.length) return 0;
          const seen = (i) => { let o = 1; for (let a = i; a && a !== box.parentElement; a = a.parentElement) o *= +getComputedStyle(a).opacity; return o > 0.5 && i.currentSrc && i.complete && i.naturalWidth > 0; };
          return imgs.some(seen) ? 0 : 1; }).catch(() => 0) : 0;
        const pad = 16, r = { x: Math.round(box.x - pad), y: Math.round(box.y - pad), w: Math.round(box.width + 2 * pad), h: Math.round(box.height + 2 * pad) };
        const f = t.kind === 'hover' ? changed(a, b, r) : changed(a, b, { x: 0, y: 0, w: a.width, h: a.height });
        let back;
        if (t.kind === 'hover' && f > 0.02) { await page.mouse.move(0, 0, { steps: 4 }); await sleep(900); back = r3(changed(a, await shot(page), r)); }
        out.act[t.key] = { kind: t.kind, changed: r3(Math.max(0, f - (t.kind === 'hover' ? 0 : idle))), text: t.text, ...(t.kind === 'hover' ? { before: thumb(a, r), after: thumb(b, r), back, blank } : {}) }; out.at[t.key] = t.at;
        if (t.kind !== 'hover' && f > 0.005) {
          // Put it back: Escape, then the same click again (menus, accordions); otherwise start over.
          await page.keyboard.press('Escape'); await sleep(500);
          let c = await shot(page);
          if (changed(a, c, { x: 0, y: 0, w: a.width, h: a.height }) > 0.01 && /menu|accordion|other/.test(t.kind)) { await el.click({ timeout: 2000, noWaitAfter: true }).catch(() => {}); await sleep(800); c = await shot(page); }
          if (changed(a, c, { x: 0, y: 0, w: a.width, h: a.height }) > 0.01) dirty = true;
        }
      } catch { /* not clickable here: left out */ }
    }
    out.tried = targets.length;
  } catch (e) { out.error = String(e.message).split('\n')[0]; }
  finally { await ctx.close(); }
  return out;
}

// What a visitor sees happen on the live page and not on the copy. A thing "does" something on the live page past these
// shares: of its own box for hover, of the screen for a click; the copy keeps it at a third of that (a stand-in needn't
// match frame for frame). Appear: live fades or slides a block in, the copy shows it plainly.
export const HOVER_APART = 20, HOVER_REACT = 0.08, CLICK_REACT = 0.02, APPEAR_REACT = 0.3, JUMP_MIN = 200;
const WHAT = { other: 'a button', menu: 'a menu button', accordion: 'something that opens', arrow: 'a gallery arrow', lightbox: 'a picture that opens full size', play: 'a video play button' };
export function compareVisitor(live, copy) {
  const lost = { 'appear-effect-lost': [], 'hover-effect-lost': [], 'click-does-nothing': [], 'video-does-not-play': [], 'jump-link-broken': [], 'contact-details-left': [] };
  // Blocks with video play buttons on the live page: a click there that does nothing in the copy is a video that doesn't
  // play (a known limitation, shown as a note), not a broken button.
  const videoBlocks = new Set(Object.entries(live.act || {}).filter(([, v]) => v.kind === 'play').map(([k]) => k.split('|')[1]));
  if (!live || !copy || live.error || copy.error) return lost;
  const at = (k) => copy.at?.[k] || live.at?.[k] || { blockId: k.split('|')[1] };
  // Counted per block: a gallery of 20 pictures that fade in is one place, not twenty.
  const appear = {};
  for (const [k, v] of Object.entries(live.appear || {})) {
    const c = copy.appear?.[k];
    if (v >= APPEAR_REACT && c != null && c < v / 3) { const b = k.split('#')[0]; (appear[b] ||= { n: 0, at: copy.at?.[k] || live.at?.[k] }).n++; }
  }
  for (const [b, { n, at: a }] of Object.entries(appear)) lost['appear-effect-lost'].push({ at: a || { blockId: b }, detail: `${n} part${n > 1 ? 's' : ''} in ${b} fade${n > 1 ? '' : 's'} or slide${n > 1 ? '' : 's'} in on the live page, not in the copy` });
  for (const [k, v] of Object.entries(live.act || {})) {
    const c = copy.act?.[k];
    if (v.kind === 'hover') {
      // Changes on both, but to something else: the copy's hover ends up looking unlike the live page's, by far more
      // than the two looked unlike before the mouse came.
      const apart = c ? (thumbDiff(v.after, c.after) ?? 0) - (thumbDiff(v.before, c.before) ?? 0) : 0;
      if (!c || (v.back != null && v.back > 0.1)) continue;  // gone from the page since, or it moves by itself
      if (c && (c.blank || 0) > (v.blank || 0)) { lost['hover-effect-lost'].push({ at: at(k), detail: `${v.text ? `“${v.text.split('\n')[0]}”` : k.split('|')[1]} shows an empty picture under the mouse; the live page shows a second picture` }); continue; }
      // Changes on both, but the copy doesn't go back when the mouse leaves (Archive 07's second product photo stays).
      if (v.changed >= HOVER_REACT && c && v.back != null && c.back != null && v.back < 0.03 && c.back > Math.max(0.06, v.changed / 3)) lost['hover-effect-lost'].push({ at: at(k), detail: `${v.text ? `“${v.text.split('\n')[0]}”` : k.split('|')[1]} doesn\u2019t go back as it was when the mouse leaves, as it does on the live page` });
      else if (v.changed >= HOVER_REACT && c && c.changed >= v.changed / 3 && apart > HOVER_APART) lost['hover-effect-lost'].push({ at: at(k), detail: `${v.text ? `“${v.text.split('\n')[0]}”` : k.split('|')[1]} changes differently under the mouse than on the live page` });
      else if (v.changed >= HOVER_REACT && (!c || c.changed < v.changed / 3)) lost['hover-effect-lost'].push({ at: at(k), detail: `${v.text ? `“${v.text}”` : k.split('|')[1]} changes under the mouse on the live page (${Math.round(v.changed * 100)}%), ${c ? `not in the copy (${Math.round(c.changed * 100)}%)` : 'and isn’t there in the copy'}` });
    } else if (v.kind === 'jump') {
      if (v.moved >= JUMP_MIN && (!c || c.moved < v.moved / 3)) lost['jump-link-broken'].push({ at: at(k), detail: `the link ${v.text ? `“${v.text}”` : ''} moves the live page, not the copy` });
    } else if (v.changed >= CLICK_REACT && (c ? c.changed < v.changed / 3 : v.kind === 'menu' || v.kind === 'play')) {
      if (v.kind === 'play' || (v.kind === 'lightbox' && videoBlocks.has(k.split('|')[1]))) { lost['video-does-not-play'].push({ at: at(k), detail: `a video ${k.split('|')[1]} plays when clicked on the live page, not in the copy` }); continue; }
      lost['click-does-nothing'].push({ at: at(k), detail: `${WHAT[v.kind]}${v.text ? ` (“${v.text}”)` : ''} changes the screen on the live page (${Math.round(v.changed * 100)}%), ${c ? `not in the copy (${Math.round(c.changed * 100)}%)` : 'and isn’t there in the copy'}` });
    }
  }
  for (const s of copy.contact || []) lost['contact-details-left'].push({ at: null, detail: s });
  return lost;
}
