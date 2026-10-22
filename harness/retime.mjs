// Weekly re-timing of the test corpus on the live copy host (run by .github/workflows/retime.yml, no Claude session).
// Times each published corpus copy (corpus.json) on desktop and phone 4G, same profiles and "ready" rule as the quality
// check (loadtime.mjs), and compares with the baseline: the first run's times from the same kind of machine, kept by
// the workflow from week to week (a copy missing from it gets today's time as its baseline). Writes retime-report.md
// and the baseline back; exits 1 when a copy got slower by more than 0.3 s or went over 2 s, so the workflow can open
// an issue.
// Usage: node retime.mjs [corpus.json] [baseline.json]
import fs from 'node:fs';
import { measure } from './measure.mjs';
import { summarize, TARGET_MS } from './loadtime.mjs';

const file = process.argv[2] || new URL('./corpus.json', import.meta.url).pathname;
const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
const baseFile = process.argv[3] || 'baseline.json';
let baseline = {};
try { baseline = JSON.parse(fs.readFileSync(baseFile, 'utf8')); } catch {}
const SLOWER_MS = 300;
const rows = [], bad = [];
for (const c of corpus.copies) {
  for (const [layout, prof] of [['desktop', 'desktop'], ['mobile', 'mobile-4g']]) {
    const url = `${corpus.host}/c/${c.copyId}/${layout}`;
    // One load first so the host's edge cache is warm, as it is for a copy people are visiting.
    await measure(url, prof, { runs: 1 }).catch(() => {});
    let now = null, err = '';
    try { now = summarize(await measure(url, prof, { runs: 3 })).readyMs; } catch (e) { err = String(e.message).slice(0, 60); }
    const key = `${c.copyId}/${layout}`, was = baseline[key] ?? null;
    if (was == null && now != null) baseline[key] = now;
    const flag = now == null ? `error ${err}` : now > TARGET_MS && (was == null || was <= TARGET_MS) ? 'over 2 s' : was != null && now - was > SLOWER_MS ? `+${now - was} ms` : '';
    rows.push(`| ${c.site} | ${layout} | ${was ?? '-'} | ${now ?? '-'} | ${flag} |`);
    if (flag) bad.push(`${c.site} ${layout}: ${flag}`);
    console.log(c.site, layout, was, now, flag);
  }
}
fs.writeFileSync('retime-report.md', `# Weekly re-timing of the test corpus\n\nFirst screen ready (ms, median of 3 loads) on ${corpus.host}, against the baseline.\n\n| Site | Layout | Baseline | Now | Flag |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n${bad.length ? `**Slower:** ${bad.join('; ')}` : 'Nothing got slower.'}\n`);
fs.writeFileSync(baseFile, JSON.stringify(baseline, null, 1));
process.exit(bad.length ? 1 : 0);
