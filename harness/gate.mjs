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

export async function runGate({ id, url, siteDir, copyDir, exportReport, scrubOutput = '' }) {
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
  // Contact details in a shape we can't rewrite (known limitation #17: hold the copy rather than publish them).
  const unhandled = [...scrubOutput.matchAll(/UNHANDLED address \(not rewritten\): (.*)/g)].map((m) => m[1]);
  if (unhandled.length) fail('unhandled-address', unhandled.slice(0, 3).join(' | '), 17);
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

  // Known limitations present on the original page.
  info.detected = detect(siteDir, exportReport);
  for (const [n, what] of Object.entries(info.detected)) {
    if (NOTE[n]) notes.push({ limitation: +n, text: NOTE[n], detail: what });
    else warnings.push(`known limitation #${n} (ships): ${what}`);
  }

  const result = reasons.length ? 'fail' : notes.length ? 'ship-with-note' : 'pass';
  const verdict = { result, reasons, notes, warnings, info: { detected: info.detected, liveSelfDiff: info.liveSelfDiff, layouts: Object.fromEntries(Object.entries(info.layouts).map(([k, c]) => [k, { diffFirstScreen: c.diffFirstScreen, diffFullPage: c.diffFullPage, stuckInvisible: c.stuckInvisible, stuckSamples: c.stuckSamples, replicaProbe: c.replicaProbe, brokenImages: c.brokenImages, mobileMenu: c.mobileMenu, dropdown: c.dropdown, gallery: c.gallery, replicaNotice: c.replicaNotice, pageErrors: c.pageErrors, externalRequests: c.externalRequests }])) } };
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
