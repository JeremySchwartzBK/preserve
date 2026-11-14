// Which pictures of each gallery can be seen (effective opacity, in view) at rest and after each "next": live vs Preserve.
// usage: node vis.mjs <liveUrl> <copyUrl with {L}> <width> [steps]
import { launch, sleep, PROFILES, NEXT_SEL } from './lib.mjs';
const [liveUrl, copyUrl, width = '1440', steps = '3'] = process.argv.slice(2);
const SEL = '.gallery-fullscreen-slideshow, .gallery-slideshow, .sqs-gallery-block-slideshow, .user-items-list-banner-slideshow, .user-items-list-carousel, .gallery-reel, .summary-block-wrapper';
const b = await launch(); const w = +width, mobile = w < 768;
async function run(url, copy) {
  const ctx = await b.newContext(mobile ? { ...PROFILES.mobile.context, viewport: { width: w, height: 844 } } : { viewport: { width: w, height: 900 } });
  if (copy) await ctx.addInitScript(() => { window.__pvStill = true; });
  const page = await ctx.newPage();
  await page.goto(copy ? url.replace('{L}', mobile ? 'mobile' : 'desktop') : url, { waitUntil: 'load', timeout: 90000 }); await sleep(copy ? 1500 : 5000);
  const sel = copy ? SEL.replace(/\.sqs-/g, '.ps-') : SEL;
  const n = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const out = [];
  for (let g = 0; g < n; g++) {
    const seen = () => page.evaluate(([s, g]) => {
      const G = document.querySelectorAll(s)[g]; const r0 = G.getBoundingClientRect();
      const vis = [];
      [...G.querySelectorAll('img')].forEach((im, k) => {
        let o = 1, v = true; for (let x = im; x && x !== G.parentElement; x = x.parentElement) { const c = getComputedStyle(x); o *= +c.opacity; if (c.visibility === 'hidden' || c.display === 'none') v = false; }
        const r = im.getBoundingClientRect(); const inside = r.right > r0.left + 2 && r.left < r0.right - 2 && r.width > 2 && r.left < innerWidth && r.right > 0;
        if (v && o > 0.5 && inside) vis.push(k + ':' + ((im.currentSrc || im.src || '').split('/').pop().split('?')[0].slice(-14)) + '@' + Math.round(r.left - r0.left) + (c2(im)));
      });
      function c2(im) { return ''; }
      return vis.join(' ');
    }, [sel, g]);
    await page.evaluate(([s, g]) => document.querySelectorAll(s)[g].scrollIntoView({ block: 'center', behavior: 'instant' }), [sel, g]); await sleep(600);
    const row = [await seen()];
    for (let i = 0; i < +steps; i++) {
      const ok = await page.evaluate(([s, g, NEXT, copy]) => {
        const G = document.querySelectorAll(s)[g];
        let btn = null;
        if (copy) { const host = G.closest('[data-pv-gal]') || G.querySelector('[data-pv-gal]'); const id = host && JSON.parse(host.getAttribute('data-pv-gal')).id; btn = id != null && document.querySelector('[data-pv-gal-next="' + id + '"]'); }
        else { const sec = G.closest('section') || G.parentElement; btn = [...sec.querySelectorAll(NEXT)].find((x) => x.getBoundingClientRect().width > 0) || sec.querySelector(NEXT); }
        if (!btn) return false; btn.click(); return true;
      }, [sel, g, NEXT_SEL, copy]);
      if (!ok) { row.push('(no arrow)'); break; }
      await sleep(1600); row.push(await seen());
    }
    out.push(row);
  }
  await ctx.close(); return out;
}
const live = await run(liveUrl, false), copy = await run(copyUrl, true);
const strip = (t) => t.replace(/:[^@ ]*@/g, '@');
live.forEach((row, g) => row.forEach((t, i) => { const c = (copy[g] || [])[i]; console.log(`g${g} step${i} ${strip(t) === strip(c || '') ? 'SAME' : 'DIFF'}\n   live: ${t}\n   copy: ${c}`); }));
await b.close();
