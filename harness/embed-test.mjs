// Tests a copy two ways: opened as a link (full window) and embedded in a frame on a portfolio-style page from another
// origin. Times the first screen, checks motion/links/layout inside the frame, and screenshots both next to the live
// site at the same size.
// Usage: node embed-test.mjs <siteKey> [--runs 3] [--variant frozen-opt] [--out dir]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer } from './server.mjs';
import { serverVariants } from './build.mjs';
import { measure } from './measure.mjs';
import { PROFILES, OVERLAY_SELECTORS, launch, sleep } from './lib.mjs';

const SITES = { minaab: 'https://www.minaab.com/', breathpod: 'https://www.breathpod.com/', kosa: 'https://hello-world-kosa.squarespace.com/', designforward: 'https://www.designforward.live/', xanadu: 'https://www.xanadu.nyc/' };
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const site = process.argv[2];
const runs = +arg('--runs', 3), variant = arg('--variant', 'frozen-opt');
const OUT = arg('--out', '/mnt/project-files/prototype/results/embed');
const shots = path.join(OUT, 'screenshots', site);
fs.mkdirSync(shots, { recursive: true });
const siteDir = path.join('/root/work', site);

const copyPort = 8600 + Math.floor(Math.random() * 50), hostPort = copyPort + 100;
const srv = await startServer(siteDir, copyPort, serverVariants());
const copyUrl = `http://127.0.0.1:${copyPort}/${variant}/`;

// Portfolio-style host page on a different origin (localhost vs 127.0.0.1). This is the embed code a designer pastes.
const embedCode = (below) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:16px/1.5 Georgia,serif;color:#222;background:#f6f3ee}main{max-width:1180px;margin:0 auto;padding:24px 16px}
h1{font-size:28px;margin:0 0 8px}p{margin:0 0 16px}.spacer{height:${below ? '120vh' : '0'}}
.preserve-frame{width:100%;aspect-ratio:16/10;border:0;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.15);background:#fff;display:block}
@media (max-width:767px){.preserve-frame{aspect-ratio:auto;height:78vh}}</style></head><body><main>
<h1>Project: ${site}</h1><p>Website design and build, 2025. Scroll inside the preview to explore the live design.</p><div class="spacer"></div>
<iframe class="preserve-frame" src="${copyUrl}" title="Interactive preview of the ${site} website" loading="${below ? 'lazy' : 'eager'}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<p style="margin-top:16px">More about the project…</p></main></body></html>`;
const host = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(embedCode(req.url.includes('below'))); }).listen(hostPort);
const hostUrl = `http://localhost:${hostPort}/`;

const result = { site, variant, standalone: {}, embedded: {}, checks: {} };
// 1. Timing: standalone link (through the layout picker) vs embedded on the host page.
for (const prof of ['mobile-4g', 'desktop']) {
  result.standalone[prof] = (await measure(copyUrl, prof, { runs, blockExternal: true })).median;
  result.embedded[prof] = (await measure(hostUrl, prof, { runs, blockExternal: true })).median;
  console.log(site, prof, 'standalone', result.standalone[prof].vc95, 'embedded', result.embedded[prof].vc95);
}

// 2. Behaviour inside the frame, plus screenshots next to the live site at the frame's size.
const browser = await launch();
for (const prof of ['mobile', 'desktop']) {
  const ctx = await browser.newContext({ ...PROFILES[prof].context });
  await ctx.route((u) => !/^(localhost|127\.0\.0\.1)$/.test(new URL(u).hostname), (r) => r.abort());
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(hostUrl, { waitUntil: 'load' }); await sleep(2500);
  const frameEl = await page.$('iframe'); const box = await frameEl.boundingBox();
  const frame = await frameEl.contentFrame();
  const c = { frameSize: `${Math.round(box.width)}x${Math.round(box.height)}` };
  c.layout = (await frame.url()).match(/(mobile|desktop)\.html/)?.[1] || frame.url();
  c.firstScreenRevealed = await frame.evaluate(() => { const els = [...document.querySelectorAll('.preFade,.preSlide,.preScale,.preClip,.preFlex')].filter((e) => { const r = e.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.width > 0; }); return els.length ? `${els.filter((e) => +getComputedStyle(e).opacity > 0.95).length}/${els.length}` : 'none on site'; });
  c.marquee = await frame.evaluate(async () => { const t = document.querySelector('textPath.Marquee-svg-text'); if (!t) return 'none on site'; const a = t.getAttribute('startOffset'); await new Promise((r) => setTimeout(r, 600)); return a !== t.getAttribute('startOffset') ? 'moving' : 'still'; });
  c.brokenImages = await frame.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getBoundingClientRect().height > 20).length);
  c.horizontalScroll = await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  await page.screenshot({ path: path.join(shots, `embedded-${prof}.png`) });
  await frameEl.screenshot({ path: path.join(shots, `frame-${prof}.png`) });
  // Scroll inside the frame: content further down should reveal as it comes into view.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 300); await sleep(200); }
  await sleep(1500);
  c.scrollsInsideFrame = (await frame.evaluate(() => scrollY)) > 0;
  c.revealedAfterScroll = await frame.evaluate(() => { const els = [...document.querySelectorAll('.preFade,.preSlide,.preScale,.preClip,.preFlex')].filter((e) => { const r = e.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.width > 0; }); return els.length ? `${els.filter((e) => +getComputedStyle(e).opacity > 0.95).length}/${els.length}` : 'none on site'; });
  // A navigation link inside the frame shows the preview notice and leaves both the frame and the portfolio page alone.
  const before = [page.url(), frame.url()];
  const link = frame.locator('a[href]:not([href^="#"]):not([href=""])').filter({ visible: true }).first();
  if (await link.count()) {
    await link.click({ timeout: 3000 }).catch(() => {}); await sleep(600);
    c.linkClick = page.url() === before[0] && frame.url() === before[1] && (await frame.locator('text=preview copy of the site').count()) ? 'notice shown, stayed put' : `page ${page.url()} frame ${frame.url()}`;
  } else c.linkClick = 'no visible link';
  c.errors = [...new Set(errors)].slice(0, 3);
  await ctx.close();
  // Live site at the frame's size (overlays hidden), for comparison.
  const live = await browser.newContext({ viewport: { width: Math.round(box.width), height: Math.round(box.height) }, deviceScaleFactor: PROFILES[prof].context.deviceScaleFactor, isMobile: !!PROFILES[prof].context.isMobile, hasTouch: !!PROFILES[prof].context.hasTouch, userAgent: PROFILES[prof].context.userAgent });
  const lp = await live.newPage();
  await lp.addInitScript((css) => { const add = () => { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); }; if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add); }, OVERLAY_SELECTORS.join(',') + '{display:none!important}');
  await lp.goto(SITES[site], { waitUntil: 'load', timeout: 60000 }).catch(() => {}); await sleep(5000);
  await lp.screenshot({ path: path.join(shots, `live-at-frame-size-${prof}.png`) });
  await live.close();
  result.checks[prof] = c;
  console.log(site, prof, JSON.stringify(c));
}
// 3. Frame placed below the fold: nothing should load or animate until the visitor scrolls to it.
{
  const ctx = await browser.newContext({ ...PROFILES.desktop.context });
  await ctx.route((u) => !/^(localhost|127\.0\.0\.1)$/.test(new URL(u).hostname), (r) => r.abort());
  const page = await ctx.newPage(); let copyRequests = 0;
  page.on('request', (r) => { if (r.url().includes(`:${copyPort}/`)) copyRequests++; });
  await page.goto(hostUrl + 'below', { waitUntil: 'load' }); await sleep(2000);
  const early = copyRequests;
  await page.evaluate(() => document.querySelector('iframe').scrollIntoView({ block: 'center' })); await sleep(3000);
  const frame = await (await page.$('iframe')).contentFrame();
  const rev = frame ? await frame.evaluate(() => { const els = [...document.querySelectorAll('.preFade,.preSlide,.preScale,.preClip,.preFlex')].filter((e) => { const r = e.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.width > 0; }); return els.length ? `${els.filter((e) => +getComputedStyle(e).opacity > 0.95).length}/${els.length}` : 'none on site'; }).catch(() => '?') : 'no frame';
  result.checks.belowFold = { requestsBeforeScroll: early, requestsAfter: copyRequests, revealedWhenScrolledTo: rev };
  console.log(site, 'below fold', JSON.stringify(result.checks.belowFold));
  await ctx.close();
}
await browser.close();
fs.writeFileSync(path.join(OUT, `embed-${site}.json`), JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(OUT, 'embed-code-example.html'), embedCode(false).replace(copyUrl, 'https://previews.example.com/<copy-id>/'));
host.close(); srv.server.close();
process.exit(0);
