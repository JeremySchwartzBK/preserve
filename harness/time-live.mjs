// Times hosted copies against the live sites over the real network (emulated devices). Usage: node time-live.mjs <outJson> <demoBase> [sites]
import fs from 'node:fs';
import { measure, measureOnce } from './measure.mjs';
const [out, demoBase, list] = process.argv.slice(2);
const SITES = { minaab: 'https://www.minaab.com/', breathpod: 'https://www.breathpod.com/', kosa: 'https://hello-world-kosa.squarespace.com/', designforward: 'https://www.designforward.live/', xanadu: 'https://www.xanadu.nyc/' };
const PUB = 'https://preserve-copies.pages.dev';
const res = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
for (const s of (list || Object.keys(SITES).join(',')).split(',')) {
  for (const prof of ['desktop', 'mobile-4g', 'mobile']) {
    const targets = { original: SITES[s], link: `${PUB}/${s}/`, embedded: `${demoBase}/${s}/embed-demo` };
    for (const [k, u] of Object.entries(targets)) {
      if (k === 'original' && res[s]?.[prof]?.original?.vc95 && process.env.KEEP_ORIGINALS) continue; // live sites already timed
      if (k !== 'original') await measureOnce(u, prof).catch(() => {}); // fill Cloudflare's edge cache, as the first viewer would
      const m = await measure(u, prof, { runs: 3, label: `${s}-${k}` }).catch((e) => ({ error: e.message }));
      (res[s] ||= {})[prof] ||= {}; res[s][prof][k] = m.median || m;
      console.log(new Date().toISOString().slice(11, 19), s, prof, k, JSON.stringify(m.median ? { vc95: m.median.vc95, lcp: m.median.lcp, fcp: m.median.fcp, kb: m.median.kb } : m));
      fs.writeFileSync(out, JSON.stringify(res, null, 1));
    }
  }
}
process.exit(0);
