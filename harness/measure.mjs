// Times how fast the first screen looks finished, using a cold browser and a throttled profile.
// Usage: node measure.mjs <url> <mobile|desktop> [--runs 3] [--block-external] [--out dir] [--label name]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PROFILES, OVERLAY_SELECTORS, launch, applyThrottle, sleep } from './lib.mjs';

const W = 160; // frames are downscaled to this width before comparing

async function toRaw(buf) {
  const { data, info } = await sharp(buf).resize({ width: W }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}

function similarity(a, b, mask) {
  const n = Math.min(a.data.length, b.data.length) / 3;
  let same = 0, total = 0;
  for (let i = 0; i < n; i++) {
    if (mask && mask[i]) continue;
    total++;
    const o = i * 3;
    if (Math.abs(a.data[o] - b.data[o]) <= 16 && Math.abs(a.data[o + 1] - b.data[o + 1]) <= 16 && Math.abs(a.data[o + 2] - b.data[o + 2]) <= 16) same++;
  }
  return total ? same / total : 1;
}

// Pixels that keep changing at the end of the recording (tickers, clocks, autoplay slideshows, looping video/GIFs)
// never settle, so they are left out of the comparison; otherwise "first screen ready" would be the end of the recording.
function volatileMask(tail, final) {
  const n = final.data.length / 3;
  const mask = new Uint8Array(n);
  for (const f of tail) {
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (Math.abs(f.data[o] - final.data[o]) > 16 || Math.abs(f.data[o + 1] - final.data[o + 1]) > 16 || Math.abs(f.data[o + 2] - final.data[o + 2]) > 16) mask[i] = 1;
    }
  }
  let c = 0; for (const m of mask) c += m;
  return { mask, share: c / n };
}

export async function measureOnce(url, profileName, { blockExternal = false, screenshotPath, hideOverlays = true } = {}) {
  const profile = PROFILES[profileName];
  const browser = await launch();
  const context = await browser.newContext({ ...profile.context, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const external = new Set();
  if (blockExternal) {
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (['localhost', '127.0.0.1'].includes(u.hostname) || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      external.add(u.hostname + u.pathname.slice(0, 60));
      return route.abort();
    });
  }
  // Marketing overlays (popups, cookie banners, announcement bars) are hidden on originals too, so both sides are
  // timed on the same content; a popup that appears after 5s would otherwise count as the page finishing.
  if (hideOverlays) await page.addInitScript((css) => {
    const add = () => { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); };
    if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
  }, OVERLAY_SELECTORS.join(',') + '{display:none!important}');
  // Collect paint metrics from inside the page.
  await page.addInitScript(() => {
    window.__m = { lcp: 0, fcp: 0, lcpEl: '' };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__m.lcp = e.startTime;
        const el = e.element;
        window.__m.lcpEl = el ? (el.tagName + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')) : '';
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__m.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
    // How visible the middle of the first screen is (the element there, times its ancestors' opacity), sampled each
    // frame for 6 s: an owner's intro fade keeps the page hidden although everything has loaded.
    // Owner intros are caught while they run: any opacity animation or transition on something covering a quarter of
    // the first screen or more.
    window.__vis = []; window.__intros = new Map();
    const t0 = performance.now();
    const opacityAt = (x, y) => { const el = document.elementFromPoint(x, y); if (!el) return null; let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; };
    const tick = () => {
      if (document.body) {
        const os = [[0.5, 0.25], [0.5, 0.5], [0.5, 0.75]].map(([fx, fy]) => opacityAt(innerWidth * fx, innerHeight * fy)).filter((o) => o != null);
        if (os.length) window.__vis.push([Math.round(performance.now()), +Math.max(...os).toFixed(2)]);
        const vpA = innerWidth * innerHeight;
        for (const a of document.getAnimations()) {
          if (window.__intros.has(a)) continue;
          const el = a.effect && a.effect.target; if (!el || !el.getBoundingClientRect) continue;
          const r = el.getBoundingClientRect();
          const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
          const kf = a.effect.getKeyframes ? a.effect.getKeyframes() : [];
          const t = a.effect.getComputedTiming();
          if (area < vpA * 0.25 || !kf.length || kf[0].opacity === undefined || +kf[0].opacity >= 0.5 || !isFinite(t.endTime)) continue;
          window.__intros.set(a, { start: (a.startTime ?? performance.now()) + (t.delay || 0), end: (a.startTime ?? performance.now()) + t.endTime });
        }
      }
      if (performance.now() - t0 < 6000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const cdp = await applyThrottle(page, profile);
  let bytes = 0, requests = 0, inflight = 0, lastNet = Date.now();
  const reqs = new Map();
  cdp.on('Network.requestWillBeSent', (e) => { requests++; inflight++; lastNet = Date.now(); reqs.set(e.requestId, { url: e.request.url, type: e.type, start: e.wallTime * 1000 }); });
  cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; inflight = Math.max(0, inflight - 1); lastNet = Date.now(); const q = reqs.get(e.requestId); if (q) { q.bytes = e.encodedDataLength; q.done = Date.now(); } });
  cdp.on('Network.loadingFailed', () => { inflight = Math.max(0, inflight - 1); lastNet = Date.now(); });

  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ ts: f.metadata.timestamp * 1000, data: Buffer.from(f.data, 'base64') });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  const vp = profile.context.viewport;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });

  let error = null;
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: profile.timeout });
  } catch (e) { error = String(e.message).split('\n')[0]; }
  // Let it settle: network quiet for 2s, at least 3s after load, capped by the profile timeout.
  const loadAt = Date.now();
  while (Date.now() - t0 < profile.timeout) {
    if (Date.now() - loadAt > 3000 && Date.now() - lastNet > 2000) break;
    await sleep(200);
  }
  // Keep recording 3s after the page has settled: whatever still changes then is motion (tickers, slideshows, video),
  // not loading, and is left out of the visual-progress comparison.
  const settleAt = Date.now();
  await sleep(3000);
  await cdp.send('Page.stopScreencast').catch(() => {});
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    // First-screen images, and when the last of them finished loading.
    const fsImgs = [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0; }).map((i) => i.currentSrc).filter(Boolean);
    const res = performance.getEntriesByType('resource');
    const fsDone = Math.max(0, ...res.filter((e) => fsImgs.includes(e.name)).map((e) => e.responseEnd));
    const intros = [...(window.__intros || new Map()).values()];
    return { origin: performance.timeOrigin, ttfb: nav?.responseStart, dcl: nav?.domContentLoadedEventEnd, load: nav?.loadEventEnd, fsDone, fsImgs, intros, vis: window.__vis || [], ...window.__m };
  }).catch(() => ({}));
  if (screenshotPath) await page.screenshot({ path: screenshotPath }).catch(() => {});

  // Visual progress: compare each frame after navigation start to the final frame.
  let vc95 = null, vc99 = null;
  const fr = frames.filter((f) => f.ts >= (timing.origin || 0));
  let volatile = 0;
  if (fr.length) {
    const raws = [];
    for (const f of fr) raws.push(await toRaw(f.data));
    const final = raws[raws.length - 1];
    // Frames on screen after the page settled: the one showing at settle time plus any later ones.
    let firstTail = fr.findIndex((f) => f.ts >= settleAt);
    if (firstTail < 0) firstTail = fr.length - 1; else firstTail = Math.max(0, firstTail - 1);
    const tail = raws.slice(firstTail);
    const vm = volatileMask(tail, final);
    if (process.env.VC_DUMP) { fs.mkdirSync(process.env.VC_DUMP, { recursive: true }); fr.forEach((f, i) => { if (i >= firstTail) fs.writeFileSync(`${process.env.VC_DUMP}/${Math.round(f.ts - timing.origin)}.jpg`, f.data); }); }
    volatile = vm.share;
    const mask = vm.share < 0.9 ? vm.mask : null;
    const base = similarity(raws[0], final, mask);
    const prog = raws.map((r, i) => ({ t: fr[i].ts - timing.origin, p: base >= 0.999 ? 1 : Math.max(0, (similarity(r, final, mask) - base) / (1 - base)) }));
    // Earliest time after which progress stays at or above the threshold.
    const firstStable = (th) => { let t = null; for (const x of prog) { if (x.p >= th) { if (t === null) t = x.t; } else t = null; } return t; };
    if (process.env.VC_DEBUG) console.error(prog.filter((_, i) => i % 3 === 0).map((x) => `${Math.round(x.t)}:${x.p.toFixed(2)}`).join(" "));
    vc95 = firstStable(0.95);
    vc99 = firstStable(0.99);
    // A first frame identical to the final one means the page painted before our first frame.
    if (base >= 0.999) vc95 = vc99 = fr[0].ts - timing.origin;
  }
  await browser.close();
  const r = (x) => (x == null ? null : Math.round(x));
  // Intro: from the first fade's start to the last one's end. Hidden: how long after first paint the middle of the
  // first screen stayed nearly invisible (opacity under 0.1).
  const intro = timing.intros?.length ? { start: Math.min(...timing.intros.map((i) => i.start)), end: Math.max(...timing.intros.map((i) => i.end)) } : null;
  const shown = (timing.vis || []).find(([t, o]) => t >= (timing.fcp || 0) && o >= 0.1);
  const hiddenMs = timing.fcp && shown ? Math.max(0, shown[0] - timing.fcp) : 0;
  // Heavy files (over 150 KB) that finished before the first screen was ready but aren't first-screen images.
  const readyAt = (timing.origin || 0) + (vc95 || timing.load || 0);
  const heavyEarly = [...reqs.values()].filter((q) => q.bytes > 150e3 && q.done && q.done <= readyAt && q.type !== 'Document' && !(timing.fsImgs || []).includes(q.url)).map((q) => ({ url: q.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 100), type: q.type, kb: Math.round(q.bytes / 1024) }));
  return {
    url, profile: profileName, error,
    ttfb: r(timing.ttfb), fcp: r(timing.fcp), lcp: r(timing.lcp), lcpEl: timing.lcpEl, vc95: r(vc95), vc99: r(vc99),
    load: r(timing.load), requests, volatilePct: Math.round(volatile * 100), kb: Math.round(bytes / 1024), frames: fr.length,
    firstScreenDone: r(timing.fsDone), intro: intro && { start: r(intro.start), end: r(intro.end), ms: r(intro.end - intro.start) }, hiddenMs: r(hiddenMs), heavyEarly,
    externalBlocked: [...external],
  };
}

const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };

export async function measure(url, profileName, { runs = 3, blockExternal = false, outDir, label = 'run' } = {}) {
  const all = [];
  for (let i = 0; i < runs; i++) {
    const shot = outDir ? path.join(outDir, `${label}-${profileName}.png`) : undefined;
    all.push(await measureOnce(url, profileName, { blockExternal, screenshotPath: i === runs - 1 ? shot : undefined }));
  }
  const keys = ['ttfb', 'fcp', 'lcp', 'vc95', 'vc99', 'load', 'requests', 'kb', 'volatilePct'];
  const med = Object.fromEntries(keys.map((k) => [k, median(all.map((a) => a[k]))]));
  return { url, profile: profileName, label, median: med, runs: all };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, prof = 'mobile'] = process.argv.slice(2);
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const out = arg('--out');
  if (out) fs.mkdirSync(out, { recursive: true });
  const res = await measure(url, prof, { runs: +arg('--runs', 3), blockExternal: process.argv.includes('--block-external'), outDir: out, label: arg('--label', 'run') });
  console.log(JSON.stringify(res, null, 1));
}
