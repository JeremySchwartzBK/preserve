// Runs the whole experiment: capture -> build copies -> measure -> check -> results.
// Usage: node run-all.mjs [--sites a,b] [--runs 3] [--out /mnt/project-files/prototype] [--work ./work] [--recapture]
import fs from 'node:fs';
import path from 'node:path';
import { capture } from './capture.mjs';
import { startServer } from './server.mjs';
import { VARIANTS, buildVariant, serverVariants } from './build.mjs';
import { optimizeFirstScreen } from './atf.mjs';
import { measure, measureOnce } from './measure.mjs';
import { check } from './check.mjs';
import { PROFILES } from './lib.mjs';

const SITES = {
  minaab: 'https://www.minaab.com/',
  breathpod: 'https://www.breathpod.com/',
  kosa: 'https://hello-world-kosa.squarespace.com/',
  designforward: 'https://www.designforward.live/',
  xanadu: 'https://www.xanadu.nyc/',
};
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
if (arg('--url')) { for (const k of Object.keys(SITES)) delete SITES[k]; SITES.test = arg('--url'); }
const runs = +arg('--runs', 3);
const OUT = arg('--out', '/mnt/project-files/prototype');
const WORK = arg('--work', path.resolve('work'));
const only = arg('--sites', Object.keys(SITES).join(',')).split(',').filter((s) => SITES[s]);
const variantsWanted = arg('--variants', Object.keys(VARIANTS).join(',')).split(',');
fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let port = 8700;
for (const site of only) {
  const url = SITES[site];
  const siteDir = path.join(WORK, site);
  const shots = path.join(OUT, 'screenshots', site);
  fs.mkdirSync(shots, { recursive: true });
  const result = { site, url, variants: {} };
  try {
    if (process.argv.includes('--recapture') || !fs.existsSync(path.join(siteDir, 'manifest.json'))) {
      log(site, 'capturing');
      await capture(url, siteDir);
    }
    const info = JSON.parse(fs.readFileSync(path.join(siteDir, 'capture-info.json'), 'utf8'));
    result.capture = { status: info.status, finalUrl: info.finalUrl, errors: info.errors, generator: info.generator, overlaysFound: info.overlaysFound };
    if (!info.finalUrl || info.status >= 400 || !fs.existsSync(path.join(siteDir, 'rendered-desktop.html'))) {
      result.skipped = `capture failed: status ${info.status} ${info.errors.join('; ')}`;
      throw new Error(result.skipped);
    }
    for (const f of ['orig-asis-mobile.png', 'orig-asis-desktop.png', 'ref-mobile.png', 'ref-desktop.png']) if (fs.existsSync(path.join(siteDir, f))) fs.copyFileSync(path.join(siteDir, f), path.join(shots, f));

    const sv = serverVariants();
    const myPort = port++;
    const srv = await startServer(siteDir, myPort, sv);
    const base = `http://127.0.0.1:${myPort}`;
    log(site, 'building variants on', base);
    for (const v of variantsWanted) {
      const rep = buildVariant(siteDir, v, srv);
      result.variants[v] = { scripts: { kept: rep.scripts.filter((s) => s.keep).length, dropped: rep.scripts.filter((s) => !s.keep).length } };
      if (VARIANTS[v].optimize) {
        const pages = VARIANTS[v].source === 'server' ? { 'index.html': ['mobile', 'desktop'] } : { 'desktop.html': ['desktop'], 'mobile.html': ['mobile'] };
        result.variants[v].firstScreen = await optimizeFirstScreen(base, siteDir, v, pages);
      }
      fs.writeFileSync(path.join(OUT, 'screenshots', site, `scripts-${v}.json`), JSON.stringify(rep.scripts, null, 1));
    }
    const pageUrl = (v, prof) => (VARIANTS[v].source === 'server' ? `${base}/${v}/` : `${base}/${v}/${PROFILES[prof].pages || prof}.html`);

    const profiles = arg('--profiles', 'mobile,mobile-4g,desktop').split(',');
    for (const prof of profiles) {
      const doCheck = !PROFILES[prof].pages; // timing-only profiles reuse another profile's pages and checks
      log(site, prof, 'measuring original');
      result.original ||= {};
      result.original[prof] = { timing: await measure(url, prof, { runs, outDir: shots, label: 'orig' }) };
      if (doCheck) result.original[prof].check = await check(url, prof, { refDir: siteDir, shotPrefix: path.join(shots, 'check-orig'), isCopy: false });
      for (const v of variantsWanted) {
        log(site, prof, 'measuring', v);
        await measureOnce(pageUrl(v, prof), prof, { blockExternal: true }); // warm the image cache
        const missesBefore = srv.misses.length;
        result.variants[v][prof] = { timing: await measure(pageUrl(v, prof), prof, { runs, blockExternal: true, outDir: shots, label: v }) };
        if (doCheck) result.variants[v][prof].check = await check(pageUrl(v, prof), prof, { refDir: siteDir, shotPrefix: path.join(shots, `check-${v}`), isCopy: true });
        result.variants[v][prof].misses = [...new Set(srv.misses.slice(missesBefore))].slice(0, 40);
      }
    }
    srv.server.close();
  } catch (e) {
    result.error = String(e.stack || e).slice(0, 600);
    log(site, 'ERROR', result.error);
  }
  fs.writeFileSync(path.join(OUT, `result-${site}.json`), JSON.stringify(result, null, 1));
  log(site, 'done');
}
