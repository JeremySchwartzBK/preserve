// Quality check for a finished copy. Decides one of three outcomes (rules confirmed by Jeremy 2026-10-07):
//   pass            nothing wrong found
//   ship-with-note  only known limitations that known-limitations.md marks "Ship with note" (the note names them)
//   fail            any failed visual/content check, any "Fail" limitation, or anything we can't account for
// There is no "close enough" score: every threshold below guards one specific kind of breakage.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { check, diffPct } from './check.mjs';
import { PROFILES, launch, sleep, OVERLAY_SELECTORS, markPromos } from './lib.mjs';
import { timeCopy, TARGET_MS } from './loadtime.mjs';
import { resizeCheck } from './resize.mjs';

// Thresholds, calibrated on the five hand-checked copies (see gate-calibration in the write-up).
export const LIMITS = {
  // Re-calibrated 2026-10-17 after the comparison started lining rows up (check.mjs diffPct): good copies of the six
  // test sites now differ by at most 3% (first screen) and 5% (whole page); kosa's misplaced stickers by 8-10% and 13-23%.
  firstScreenDiffPct: 6,    // first screen vs the live site with overlays hidden
  fullPageDiffPct: 8,       // whole page, scrolled through
  heightRatio: [0.85, 1.15],// copy page height / live page height: content missing or blown up
  stuckInvisible: 0,        // blocks still invisible after scrolling past them (animations that never ran)
  brokenImages: 0,
};

// How much the live page differs from itself between two visits (random sticker layouts, autoplaying slideshows,
// clocks, video frames). The copy is held to the same pixel limits plus that amount, so a page that is never the same
// twice isn't failed for it, while a still page keeps the strict limits.
async function liveSelfDiff(url, siteDir) {
  const out = {};
  const browser = await launch();
  try {
    for (const prof of ['desktop', 'mobile']) {
      const ctx = await browser.newContext({ ...PROFILES[prof].context, ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 90000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await sleep(2000);
        const h = await page.evaluate(() => document.documentElement.scrollHeight), vh = await page.evaluate(() => innerHeight);
        for (let y = 0; y < h + vh; y += Math.round(vh * 0.6)) { await page.evaluate((y) => scrollTo(0, y), y); await sleep(350); }
        await page.evaluate(() => scrollTo(0, 0)); await sleep(1500);
        await page.evaluate(markPromos).catch(() => 0);
        await page.addStyleTag({ content: OVERLAY_SELECTORS.join(',') + '{display:none!important}' }); await sleep(300);
        await page.screenshot({ path: path.join(siteDir, `live2-${prof}.png`) });
        await page.screenshot({ path: path.join(siteDir, `live2-full-${prof}.png`), fullPage: true });
        out[prof] = { firstScreen: await diffPct(path.join(siteDir, `ref-${prof}.png`), path.join(siteDir, `live2-${prof}.png`)), fullPage: await diffPct(path.join(siteDir, `ref-full-${prof}.png`), path.join(siteDir, `live2-full-${prof}.png`)) };
      } catch (e) { out[prof] = { error: String(e.message).split('\n')[0] }; }
      await ctx.close();
    }
  } finally { await browser.close(); }
  return out;
}

// Known limitations the check can detect, by number in /mnt/project-files/known-limitations.md.
const NOTE = {
  1: 'Videos hosted on YouTube or Vimeo show their still image.',
  3: 'Videos play muted and on a loop.',
  5: 'Some custom animations on the original site are shown frozen.',
  10: 'Embedded widgets (such as maps, feeds or signup forms) are shown as pictures.',
};

function serve(root) {
  const CT = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'application/javascript', webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', ico: 'image/x-icon' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!fs.existsSync(p) && fs.existsSync(p + '.html')) p += '.html';
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'content-type': CT[p.split('.').pop()] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// What the original page contains that maps to a known limitation (read from the captured, rendered page).
export function detect(siteDir, exportReport) {
  const html = ['rendered-desktop.html', 'rendered-mobile.html'].map((f) => { try { return fs.readFileSync(path.join(siteDir, f), 'utf8'); } catch { return ''; } }).join('\n');
  const body = html.replace(/[\s\S]*?<body/i, '<body');
  const found = {};
  if (/(youtube(-nocookie)?\.com\/(embed|watch)|youtu\.be\/|player\.vimeo\.com|vimeo\.com\/\d)/i.test(body)) found[1] = 'YouTube/Vimeo video';
  // Squarespace video blocks meant to be watched (not section backgrounds) lose sound and controls.
  if (/class="[^"]*sqs-block-video|data-block-type="32"|video-player-container/i.test(body)) found[3] = 'video block';
  // Owner code in the page body that relies on jQuery or Squarespace's scripts: dropped from the script-free copy.
  // Site-wide code (footer injection) often targets things that only exist on other pages; it only matters here if the
  // ids, section ids or plugin markers it looks for are on this page.
  const markup = body.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const targetsHere = (t) => {
    const ids = [...t.matchAll(/['"]#([\w-]+)/g)].map((m) => m[1]);
    const secs = [...t.matchAll(/data-section-id=\\?"([\w-]+)/g)].map((m) => m[1]);
    if (!ids.length && !secs.length) return true; // can't tell what it acts on: assume it matters
    return ids.some((x) => markup.includes(`id="${x}"`)) || secs.some((x) => markup.includes(`data-section-id="${x}"`));
  };
  const owner = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, a, t]) => !/src=|type="application\/(ld\+)?json"|type="text\/template"/i.test(a) && t.trim()
    && !/SQUARESPACE_CONTEXT|Static\.|Squarespace\.|Y\.use|SQUARESPACE_ROLLUPS|__templateVersion|window\.dataLayer|gtag\(|fbq\(|_satellite|squarespace-cdn\.com\/content\/v1\/.*\.js/.test(t)
    && /(^|[^\w.$])\$\s*\(|jQuery|(^|[^\w.])Y\s*\./.test(t) && targetsHere(t));
  // Plugin code loaded from code CDNs (Squarespace plugin sellers publish there). Widgets such as chat, email signup or
  // ticketing are not counted: their frames become pictures (#10) and the rest of them draws nothing. Will Myers plugins
  // mark the blocks they act on with data-wm-plugin; one with no marker on this page has nothing to do here, and a
  // secondary nav bar ("subnav") is plain links once drawn, which the capture keeps.
  const wmPlugins = [...markup.matchAll(/data-wm-plugin="([\w-]+)"/g)].map((m) => m[1]).filter((p) => !['subnav'].includes(p));
  const ownerSrc = [...body.matchAll(/<script\b[^>]*src="([^"]+)"/gi)].map((m) => m[1]).filter((s) => /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|assets\.codepen\.io|githack|github\.io|squarewebsites|sqspthemes|squarespacewebsites|ghost-plugins|will-myers|willmyers|kerbco|schwartz-edmisten|spark-plugin|static1\.squarespace\.com\/static\/[0-9a-f]{24}\/t\/.*\.js|storage\.googleapis\.com\/squarestylist/i.test(s) && !/jquery[.-]?[0-9.]*(\.min)?\.js|recaptcha/i.test(s))
    .filter((s) => !/codepen\.io\/3198845|willmyer|willmyethewebsiteguy/i.test(s) || wmPlugins.length);
  if (owner.length || ownerSrc.length) found[5] = `owner code needing jQuery/Squarespace: ${owner.length} inline, ${ownerSrc.length} external (${ownerSrc.slice(0, 3).join(', ').slice(0, 160)})`;
  const stills = (exportReport?.stills || []);
  if (stills.length) found[10] = `${stills.length} embed(s) shown as still: ` + [...new Set(stills.map((s) => (s.src || '').replace(/^https?:\/\//, '').split('/')[0] + (s.replaced ? '' : ' (blank)')))].join(', ');
  if (/sqs-block-map|data-block-type="4"|class="[^"]*map-block/i.test(body)) found[18] = 'map block';
  if (/position:\s*sticky|data-sticky|sticky-/i.test(body)) found[8] = 'sticky element';
  return found;
}

// Counts in notes people read: numbers under 10 written out (Jeremy's style rule, 2026-10-26).
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const count = (n, noun) => `${n < 10 ? WORDS.at(n) : n} ${noun}${n === 1 ? '' : 's'}`;

// How much of a full-page screenshot may differ after the stylesheet swap (antialiasing, a frame of a slideshow).
const OWN_CSS_MAX_DIFF = 1;
// A copy resized to a width should look as it does opened at that width (the scripts re-measure on resize).
const RESIZE_MAX_DIFF = 2;

export async function runGate({ id, url, siteDir, copyDir, exportReport, scrubOutput = '', ownCssReport = null }) {
  const reasons = [], notes = [], warnings = [], info = {};
  // Each finding keeps where it was seen (spots: block + position, per layout) so the app can show it as a pin.
  let layoutSpots = null, layoutName = null;
  const fail = (code, detail, limitation = null) => {
    const spots = layoutSpots?.[code]?.map((p) => ({ ...p, layout: layoutName })) || [];
    const same = reasons.find((r) => r.code === code);
    if (same) { if (spots.length) same.spots = [...(same.spots || []), ...spots]; same.detail += ' / ' + detail; return; }
    reasons.push({ code, detail, limitation, ...(spots.length ? { spots } : {}) });
  };

  // Severed from Squarespace and the original: no remaining addresses in any text file of the copy.
  const left = [];
  for (const f of fs.readdirSync(copyDir, { recursive: true })) {
    if (!/\.(html|css|js|svg)$/.test(f)) continue;
    const t = fs.readFileSync(path.join(copyDir, f), 'utf8');
    for (const m of t.matchAll(/[\w.-]*(squarespace(-cdn)?\.com|sqspcdn\.com|typekit\.net|googleapis\.com|gstatic\.com)/gi)) left.push(`${f}: ${m[0]}`);
  }
  if (left.length) fail('squarespace-addresses-left', [...new Set(left)].slice(0, 5).join('; '));
  // With our own stylesheet (own-css.mjs): none of Squarespace's stylesheet code or naming is left in the copy, and the
  // copy looks the same as before the swap, at rest, with the phone menu open and at other widths the layout serves.
  if (ownCssReport) {
    const names = [];
    for (const f of fs.readdirSync(copyDir, { recursive: true })) {
      if (/\.css$/.test(f)) { names.push(`${f}: stylesheet file`); continue; }
      if (!/\.(html|js|svg)$/.test(f)) continue;
      const t = fs.readFileSync(path.join(copyDir, f), 'utf8');
      for (const m of t.matchAll(/(?<![\w-])(sqsp?-[\w-]+|sqsrte-[\w-]+|tweak-[\w-]+|--tweak-[\w-]+|data-definition-name|squarespace-ui-font|preserve-critical)/g)) names.push(`${f}: ${m[1]}`);
      for (const m of t.matchAll(/<link\b[^>]*rel="?stylesheet[^>]*>/gi)) names.push(`${f}: ${m[0].slice(0, 80)}`);
    }
    if (names.length) fail('squarespace-styles-left', [...new Set(names)].slice(0, 6).join('; '));
    const off = [];
    for (const [layout, r] of Object.entries(ownCssReport.layouts || {})) {
      if (r.error) { off.push(`${layout}: ${r.error}`); continue; }
      if (r.height && r.height[0] !== r.height[1]) off.push(`${layout}: page height ${r.height[0]} -> ${r.height[1]}px`);
      if (r.diffPct > OWN_CSS_MAX_DIFF) off.push(`${layout}: ${r.diffPct}% of the page looks different`);
      if (r.menuDiffPct > OWN_CSS_MAX_DIFF) off.push(`${layout}: open menu ${r.menuDiffPct}% different`);
      for (const [w, d] of Object.entries(r.widthDiffPct || {})) if (d > OWN_CSS_MAX_DIFF) off.push(`${layout} at ${w}px wide: ${d}% different`);
      for (const [name, st] of Object.entries(r.states || {})) if (st.orphans) off.push(`${layout}: ${st.orphans} ${name} change(s) not reproduced`);
      if (r.icons?.blank?.length) off.push(`${layout}: icons not redrawn ${r.icons.blank.join(',')}`);
    }
    info.ownCss = Object.fromEntries(Object.entries(ownCssReport.layouts || {}).map(([l, r]) => [l, { kb: Math.round((r.cssBytes || 0) / 1024), was: Math.round((r.origCssBytes || 0) / 1024), diffPct: r.diffPct, menuDiffPct: r.menuDiffPct, widthDiffPct: r.widthDiffPct, formulas: r.formulas, motionsKept: r.motions?.kept }]));
    if (off.length) fail('own-stylesheet-mismatch', off.slice(0, 6).join('; '));
  }
  // Contact details in a shape we can't rewrite (known limitation #17: hold the copy rather than publish them).
  const unhandled = [...scrubOutput.matchAll(/UNHANDLED address \(not rewritten\): (.*)/g)].map((m) => m[1]);
  if (unhandled.length) fail('unhandled-address', unhandled.slice(0, 3).join(' | '), 17);
  // Squarespace library fonts come from Google Fonts (google-fonts.py). A face Google doesn't have gets a lookalike,
  // which the copy notes; only a face with neither is left out (its text shows in the next font the site's styles list).
  const gfFile = path.join(siteDir, 'fonts-google.json');
  let fontRecord = [];
  if (fs.existsSync(gfFile)) {
    const gf = JSON.parse(fs.readFileSync(gfFile, 'utf8'));
    const gone = [...new Set((gf.missing || []).map((m) => [m.family || 'unknown font', m.weight, m.style !== 'normal' && m.style, '(' + m.reason + ')'].filter(Boolean).join(' ')))];
    if (gone.length) fail('font-not-on-google-fonts', gone.slice(0, 5).join('; '));
    const swapped = [...new Set(Object.values(gf.fonts || {}).filter((f) => f.lookalike_for && !f.adobe).map((f) => f.lookalike_for))];
    if (swapped.length) notes.push({ limitation: null, text: `We used a lookalike for ${count(swapped.length, 'font')} we couldn’t get (${swapped.join(', ')}).`, detail: Object.values(gf.fonts).filter((f) => f.lookalike_for && !f.adobe).map((f) => `${f.lookalike_for} -> ${f.family} ${f.weight} ${f.style}`).join('; ') });
    fontRecord = gf.record || [];
    const lacking = Object.values(gf.fonts || {}).filter((f) => f.lacks && !f.lookalike_for);
    if (lacking.length) warnings.push(`Google Fonts versions lack characters Squarespace's had: ${lacking.map((f) => `${f.family} ${f.weight} ${f.subset} (${f.lacks})`).join(', ')}`);
  }
  if (exportReport?.misses?.length) warnings.push(`export: ${exportReport.misses.length} files the copy server didn't have, e.g. ${exportReport.misses.slice(0, 3).join(', ')}`);

  // Load each layout like a visitor, blocking anything outside the copy, and compare with the live page.
  const srv = await serve(path.dirname(copyDir));
  const base = `http://127.0.0.1:${srv.address().port}`;
  info.layouts = {};
  info.liveSelfDiff = await liveSelfDiff(url, siteDir);
  try {
    for (const prof of ['desktop', 'mobile']) {
      const c = await check(`${base}/${id}/${prof}`, prof, { refDir: siteDir, shotPrefix: path.join(siteDir, 'gate'), isCopy: true });
      info.layouts[prof] = c;
      layoutSpots = c.spots; layoutName = prof;
      const L = (s) => `${prof}: ${s}`;
      if (c.loadError) fail('copy-did-not-load', L(c.loadError));
      if (c.externalRequests.length) fail('outside-requests', L(c.externalRequests.join(', ')));
      if (c.brokenImages > LIMITS.brokenImages) fail('broken-images', L(`${c.brokenImages} images don't load`));
      if (c.stuckInvisible > LIMITS.stuckInvisible) fail('blocks-stay-invisible', L(`${c.stuckInvisible} blocks never appear when scrolled to`));
      if (c.overlaysVisible?.length) fail('overlay-left', L(c.overlaysVisible.join(', ')));
      if (c.mobileMenu === 'fail') fail('phone-menu-broken', L('burger menu does not open'));
      if (c.dropdown === 'fail') fail('dropdown-broken', L('folder dropdown does not open'));
      if (c.replicaNotice === 'fail') fail('replica-notice-missing', L('a link navigated away instead of showing the preview notice'));
      if (c.gallery === 'fail') fail('gallery-does-not-advance', L('gallery/slideshow "next" does nothing'), 9);
      if (c.pageErrors) warnings.push(L(`${c.pageErrors} script errors: ${c.errorSamples.join(' | ').slice(0, 200)}`));
      const d1 = c.diffFirstScreen, d2 = c.diffFullPage, self = info.liveSelfDiff[prof] || {};
      const allow1 = LIMITS.firstScreenDiffPct + (self.firstScreen?.pct || 0), allow2 = LIMITS.fullPageDiffPct + (self.fullPage?.pct || 0);
      if (!d1 || !d2) fail('no-reference', L('missing reference screenshot of the live page'));
      else {
        if (d1.pct > allow1) fail('first-screen-differs', L(`${d1.pct}% of first-screen pixels differ from the live page (allowed ${allow1}%, the live page varies ${self.firstScreen?.pct ?? '?'}% by itself)`));
        if (d2.pct > allow2) fail('page-differs', L(`${d2.pct}% of full-page pixels differ from the live page (allowed ${allow2}%, the live page varies ${self.fullPage?.pct ?? '?'}% by itself)`));
        if (d2.heightRatio < LIMITS.heightRatio[0] || d2.heightRatio > LIMITS.heightRatio[1]) fail('page-length-differs', L(`copy is ${Math.round(d2.heightRatio * 100)}% as long as the live page`));
      }
    }
  } finally { srv.close(); layoutSpots = null; }

  // Load time on desktop and phone 4G (loadtime.mjs). Over the 2-second target ships with a note, never a block: some
  // pages can't reach it faithfully. An owner's intro animation doesn't count; one that hides the page over a second,
  // and heavy files loading before the first screen is ready, are noted for us.
  if (process.env.PRESERVE_LOAD_CHECK !== '0') {
    try {
      info.loadTime = await timeCopy(path.dirname(copyDir), id, { runs: 3 });
      const slow = Object.entries(info.loadTime).filter(([, t]) => t.readyMs > TARGET_MS);
      if (slow.length) notes.push({ limitation: null, code: 'slow-first-screen', text: `This copy's first screen takes about ${(Math.max(...slow.map(([, t]) => t.readyMs)) / 1000).toFixed(1)} seconds to appear${slow.length === 1 ? (slow[0][0] === 'mobile' ? ' on phones' : ' on computers') : ''}, a little over our 2-second goal.`, detail: slow.map(([l, t]) => `${l} ${t.readyMs} ms (${t.kb} KB)`).join('; ') });
      for (const [l, t] of Object.entries(info.loadTime)) {
        if (t.introMs) warnings.push(`${l}: owner intro animation ${t.introMs} ms (not counted in the ${t.readyMs} ms)`);
        if (t.hiddenMs > 1000) warnings.push(`${l}: owner intro keeps the first screen hidden for ${t.hiddenMs} ms`);
        if (t.heavyEarly.length) warnings.push(`${l}: heavy files load before the first screen is ready: ${t.heavyEarly.map((h) => `${h.url} (${h.kb} KB)`).join(', ')}`);
      }
    } catch (e) { warnings.push(`load-time check failed: ${String(e.message).slice(0, 200)}`); }
  }

  // Sizes worked out once for one width (resize.mjs): the copy at another width against the live page at that width,
  // and the copy resized against itself opened at that width. Fixed-size elements are listed for us.
  if (process.env.PRESERVE_RESIZE_CHECK !== '0') {
    const srv2 = await serve(path.dirname(copyDir));
    try {
      info.resize = await resizeCheck(url, `http://127.0.0.1:${srv2.address().port}/${id}`, path.join(siteDir, 'resize'));
      const off = [], resized = [];
      for (const [prof, rs] of Object.entries(info.resize)) for (const r of rs) {
        if (r.error) { warnings.push(`size check ${prof} ${r.width}px: ${r.error}`); continue; }
        const n1 = r.liveNoise?.firstScreen?.pct || 0, n2 = r.liveNoise?.fullPage?.pct || 0;
        if (r.firstScreen && r.firstScreen.pct > LIMITS.firstScreenDiffPct + n1) off.push(`${prof} at ${r.width}px: ${r.firstScreen.pct}% of the first screen differs from the live page (allowed ${+(LIMITS.firstScreenDiffPct + n1).toFixed(1)}%)`);
        if (r.fullPage && r.fullPage.pct > LIMITS.fullPageDiffPct + n2) off.push(`${prof} at ${r.width}px: ${r.fullPage.pct}% of the page differs from the live page (allowed ${+(LIMITS.fullPageDiffPct + n2).toFixed(1)}%)`);
        if (r.resized && r.resized.pct > RESIZE_MAX_DIFF) resized.push(`${prof}: resized to ${r.width}px, ${r.resized.pct}% differs from opening at ${r.width}px`);
        if (r.fixedSize?.length) warnings.push(`${prof} at ${r.width}px: fixed sizes kept from the capture width: ${r.fixedSize.map((f) => `${f.what} ${f.widthPx}px in ${f.containerPx}px`).join(', ')}`);
      }
      if (off.length) fail('differs-at-other-widths', off.slice(0, 4).join('; '));
      if (resized.length) fail('breaks-on-resize', resized.slice(0, 4).join('; '));
    } catch (e) { warnings.push(`size check failed: ${String(e.message).slice(0, 200)}`); }
    finally { srv2.close(); }
  }

  // Fonts by who holds the license (google-fonts.py), each marked with the layouts that show it, for the review's Fonts
  // tab and the confirmation at Publish. Adobe fonts swapped for lookalikes get a note when a visitor would see them.
  if (fontRecord.length) {
    const w = (x) => String(x).replace('normal', '400').replace('bold', '700').split(' ')[0];
    const same = (r, u) => u.family.toLowerCase() === String(r.family).toLowerCase() && w(u.weight) === w(r.weight) && (u.style === 'normal') === (r.style === 'normal');
    info.fonts = fontRecord.map((r) => ({ ...r, shown: Object.entries(info.layouts).filter(([, c]) => (c.fontsUsed || []).some((u) => same(r, u))).map(([l]) => l) }));
    const name = (f) => f.split(/[-_ ]+/).filter(Boolean).map((x) => x[0].toUpperCase() + x.slice(1)).join(' ');
    const adobe = new Map();
    for (const r of info.fonts) if (r.holder === 'platform' && r.action === 'lookalike' && r.shown.length) adobe.set(name(r.family), r.served_as);
    // Wording from the sign-up plan (Jeremy, 2026-10-26). "Connect your own Adobe Fonts account" joins the choices once
    // that connection exists.
    if (adobe.size) notes.push({ limitation: null, text: `We found ${count(adobe.size, 'font')} in your Preserve that ${adobe.size === 1 ? 'needs' : 'need'} a license to be shown outside Squarespace (${[...adobe.keys()].join(', ')}), so for now we’re showing ${adobe.size === 1 ? 'a close free alternative' : 'close free alternatives'} (${[...new Set(adobe.values())].join(', ')}). When you review, you can upload font files you’ve licensed for the web, or keep the free ${adobe.size === 1 ? 'alternative' : 'alternatives'}.`, detail: 'adobe-fonts' });
  }

  // Known limitations present on the original page.
  info.detected = detect(siteDir, exportReport);
  for (const [n, what] of Object.entries(info.detected)) {
    if (NOTE[n]) notes.push({ limitation: +n, text: NOTE[n], detail: what });
    else warnings.push(`known limitation #${n} (ships): ${what}`);
  }

  const result = reasons.length ? 'fail' : notes.length ? 'ship-with-note' : 'pass';
  const verdict = { result, reasons, notes, warnings, info: { detected: info.detected, liveSelfDiff: info.liveSelfDiff, ...(info.loadTime ? { loadTime: info.loadTime } : {}), ...(info.resize ? { resize: info.resize } : {}), ...(info.ownCss ? { ownCss: info.ownCss } : {}), ...(info.fonts ? { fonts: info.fonts } : {}), layouts: Object.fromEntries(Object.entries(info.layouts).map(([k, c]) => [k, { diffFirstScreen: c.diffFirstScreen, diffFullPage: c.diffFullPage, stuckInvisible: c.stuckInvisible, stuckSamples: c.stuckSamples, replicaProbe: c.replicaProbe, brokenImages: c.brokenImages, mobileMenu: c.mobileMenu, dropdown: c.dropdown, gallery: c.gallery, replicaNotice: c.replicaNotice, pageErrors: c.pageErrors, externalRequests: c.externalRequests }])) } };
  fs.writeFileSync(path.join(siteDir, 'verdict.json'), JSON.stringify(verdict, null, 1));
  return verdict;
}

// Re-run the check on an existing job: node gate.mjs <work>/<id> <copyDir> <url>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [siteDir, copyDir, url] = process.argv.slice(2);
  const opt = (f) => { try { return fs.readFileSync(path.join(siteDir, f), 'utf8'); } catch { return null; } };
  const v = await runGate({ id: path.basename(copyDir), url, siteDir, copyDir, exportReport: JSON.parse(opt('export-report.json') || 'null'), scrubOutput: opt('scrub-output.txt') || '' });
  console.log(JSON.stringify(v, null, 1)); process.exit(0);
}
