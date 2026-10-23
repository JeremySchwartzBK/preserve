// Captures a live page: every network response, the server HTML, and the rendered DOM at desktop and mobile widths.
// Usage: node capture.mjs <url> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROFILES, launch, sleep, OVERLAY_SELECTORS, markPromos } from './lib.mjs';
import { captureVideos } from './video.mjs';

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// Serialize CSSOM-only rules (insertRule) back into <style> text so the DOM snapshot keeps them.
function snapshotDom() {
  for (const st of document.querySelectorAll('style')) {
    try {
      const rules = [...st.sheet.cssRules].map((r) => r.cssText).join('\n');
      if (rules.length > (st.textContent || '').length) st.textContent = rules;
    } catch {}
  }
  // Swiper slideshows: how the site set them up (fade or slide, speed, autoplay, loop), for our slider script.
  for (const el of document.querySelectorAll('.swiper, .swiper-container')) {
    const w = el.swiper; if (!w || !w.params) continue;
    const p = w.params, ap = p.autoplay && w.autoplay && w.autoplay.running ? p.autoplay.delay || 3000 : 0;
    el.setAttribute('data-pv-swiper', JSON.stringify({ effect: p.effect, speed: p.speed, loop: !!p.loop, autoplay: ap, autoHeight: !!p.autoHeight, spv: typeof p.slidesPerView === 'number' ? p.slidesPerView : null, gap: typeof p.spaceBetween === 'number' ? p.spaceBetween : null }));
  }
  // Record live form/input state and the current src chosen from srcset.
  for (const img of document.querySelectorAll('img')) {
    if (img.currentSrc) img.setAttribute('data-preserve-current', img.currentSrc);
  }
  const dt = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>';
  return dt + '\n' + document.documentElement.outerHTML;
}

async function scrollThrough(page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = await page.evaluate(() => innerHeight);
  for (let y = 0; y < h + vh; y += Math.round(vh * 0.6)) {
    await page.evaluate((y) => scrollTo(0, y), y);
    await sleep(350);
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(1500);
}

// Widgets built as web components (e.g. a third-party search box) draw inside a shadow root, which a DOM snapshot can't
// keep, so the copy would show nothing there. Photograph each visible one now, as the visitor sees it, and mark the
// element so the export puts the picture in its place (same size; clicking it shows the replica note).
async function shadowStills(page, outDir, prof, info) {
  const n = await page.evaluate(() => {
    let i = 0;
    for (const el of document.querySelectorAll('*')) {
      // Custom elements whose drawing lives in a shadow root (open or closed): defined, sized, and no light-DOM content.
      const tag = el.tagName.toLowerCase();
      if (!tag.includes('-') || /^(sqs-|preserve-)/.test(tag) || !(el.shadowRoot || (customElements.get(tag) && !el.textContent.trim() && !el.children.length))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || getComputedStyle(el).visibility === 'hidden') continue;
      el.setAttribute('data-preserve-still', `${i++}`);
    }
    return i;
  });
  if (!n) return;
  fs.mkdirSync(path.join(outDir, 'stills'), { recursive: true });
  info.shadowStills = info.shadowStills || {};
  for (let i = 0; i < n; i++) {
    const el = await page.$(`[data-preserve-still="${i}"]`);
    if (!el) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {}); await sleep(600);
    // Fixed headers and badges that don't contain the widget would otherwise land in the photo.
    await page.evaluate((i) => { const w = document.querySelector(`[data-preserve-still="${i}"]`); for (const e of document.querySelectorAll('body *')) if (getComputedStyle(e).position === 'fixed' && !e.contains(w)) { e.dataset.preserveHid = e.style.visibility || '-'; e.style.visibility = 'hidden'; } }, i);
    const box = await el.boundingBox();
    const file = `${prof}-${i}.png`;
    const ok = box && await el.screenshot({ path: path.join(outDir, 'stills', file), timeout: 15000 }).then(() => true, () => false);
    await page.evaluate(() => { for (const e of document.querySelectorAll('[data-preserve-hid]')) { e.style.visibility = e.dataset.preserveHid === '-' ? '' : e.dataset.preserveHid; delete e.dataset.preserveHid; } });
    await el.evaluate((e, f) => { if (f) e.setAttribute('data-preserve-still', f); else e.removeAttribute('data-preserve-still'); }, ok ? file : null);
    if (ok) info.shadowStills[file] = { tag: await el.evaluate((e) => e.tagName.toLowerCase()), w: Math.round(box.width), h: Math.round(box.height) };
  }
  await page.evaluate(() => scrollTo(0, 0)); await sleep(500);
}

export async function capture(url, outDir) {
  fs.mkdirSync(path.join(outDir, 'raw'), { recursive: true });
  const manifest = {}; // url -> { status, ct, file, size, type }
  const browser = await launch();
  const info = { url, finalUrl: null, inlineScripts: [], scripts: [], errors: [] };

  const record = (page) => page.on('response', async (r) => {
    const u = r.url();
    if (u.startsWith('data:') || manifest[u]) return;
    const status = r.status();
    if (status >= 300 && status < 400) return;
    let body;
    try { body = await r.body(); } catch { return; }
    const file = hash(u);
    fs.writeFileSync(path.join(outDir, 'raw', file), body);
    manifest[u] = { status, ct: r.headers()['content-type'] || '', file, size: body.length, type: r.request().resourceType() };
  });

  for (const prof of ['desktop', 'mobile']) {
    const ctx = await browser.newContext({ ...PROFILES[prof].context, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    record(page);
    page.on('pageerror', (e) => info.errors.push(`${prof}: ${e.message.slice(0, 200)}`));
    // Widgets that keep polling (chat, bot checks) can stop the network from ever going quiet: fall back to the load
    // event plus a bounded wait instead of giving up on the page.
    let resp = await page.goto(url, { waitUntil: 'load', timeout: 90000 }).catch((e) => { info.errors.push(String(e.message).split('\n')[0]); return null; });
    if (resp) await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => info.errors.push(`${prof}: network never went idle (continued after 20 s)`));
    if (!resp) { await ctx.close(); continue; }
    info.finalUrl = page.url();
    info.status = resp.status();
    if (prof === 'desktop') fs.writeFileSync(path.join(outDir, 'server.html'), await resp.body());
    await sleep(2000);
    // Reference shot of the first screen exactly as a visitor sees it (overlays included).
    await page.screenshot({ path: path.join(outDir, `orig-asis-${prof}.png`) });
    await scrollThrough(page);
    await shadowStills(page, outDir, prof, info);
    info.promos = (info.promos || 0) + await page.evaluate(markPromos).catch(() => 0);
    // Squarespace pads the first section (and the menu overlay) by the header's height, in pixels, for the width it
    // saw. The copy redoes that sum at other widths (build.mjs HEADER_PAD_SCRIPT), so it needs the header's height that
    // the padding was worked out from: measured here as Squarespace saw it, announcement bar included.
    await page.evaluate(() => {
      const h = document.querySelector('header#header') || document.querySelector('header');
      if (h) h.setAttribute('data-pv-h0', String(Math.round(h.getBoundingClientRect().height * 100) / 100));
    }).catch(() => {});
    fs.writeFileSync(path.join(outDir, `rendered-${prof}.html`), await page.evaluate(snapshotDom));
    // Reference shots with marketing overlays hidden, to compare copies against.
    await page.addStyleTag({ content: OVERLAY_SELECTORS.join(',') + '{display:none!important}' });
    await sleep(300);
    await page.screenshot({ path: path.join(outDir, `ref-${prof}.png`) });
    await page.screenshot({ path: path.join(outDir, `ref-full-${prof}.png`), fullPage: true }).catch(() => {});
    if (prof === 'desktop') {
      Object.assign(info, await page.evaluate(() => ({
        scripts: [...document.scripts].filter((s) => s.src).map((s) => s.src),
        inlineScripts: [...document.scripts].filter((s) => !s.src).map((s) => (s.type || '') + ' | ' + s.textContent.trim().slice(0, 160)),
        generator: document.querySelector('meta[name=generator]')?.content || '',
        overlaysFound: [...document.querySelectorAll('.sqs-announcement-bar-dropzone *, .sqs-popup-overlay, .sqs-cookie-banner-v2, #sqs-cookie-banner, .sqs-announcement-bar')].map((e) => e.className).slice(0, 10),
        templateHints: [...document.body.classList].slice(0, 40),
      })));
    }
    await ctx.close();
  }

  // Fetch the largest version of every Squarespace CDN image so copies can make their own sizes.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const imgBases = new Set(Object.keys(manifest).filter((u) => /images\.squarespace-cdn\.com|static1\.squarespace\.com\/static\/.+\.(jpe?g|png|webp|gif)/i.test(u)).map((u) => u.split('?')[0]));
  // Also images referenced in the HTML but never requested (lazy or responsive variants).
  for (const f of ['server.html', 'rendered-desktop.html', 'rendered-mobile.html']) {
    const p = path.join(outDir, f);
    if (!fs.existsSync(p)) continue;
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/https?:\/\/images\.squarespace-cdn\.com\/[^"'\s?)&,]+/g)) imgBases.add(m[0]);
  }
  for (const base of imgBases) {
    const key = 'orig:' + base;
    if (manifest[key]) continue;
    try {
      const r = await ctx.request.get(base + '?format=2500w', { timeout: 30000 });
      if (!r.ok()) continue;
      const body = await r.body();
      const file = hash(key);
      fs.writeFileSync(path.join(outDir, 'raw', file), body);
      manifest[key] = { status: 200, ct: r.headers()['content-type'] || '', file, size: body.length, type: 'image-original' };
    } catch {}
  }
  // Squarespace video blocks and background videos, as plain files (see video.mjs).
  info.videos = await captureVideos(outDir, manifest, ctx.request);
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(outDir, 'capture-info.json'), JSON.stringify(info, null, 1));
  return { manifest, info };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, out] = process.argv.slice(2);
  const { manifest, info } = await capture(url, out);
  console.log(Object.keys(manifest).length, 'resources;', info.status, info.finalUrl, info.errors.slice(0, 3));
}
