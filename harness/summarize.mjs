// Builds results.md and results.csv from result-*.json in the output folder.
// Usage: node summarize.mjs [/mnt/project-files/prototype]
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || '/mnt/project-files/prototype';
const files = fs.readdirSync(OUT).filter((f) => /^result-.+\.json$/.test(f)).sort();
const rows = [];
const s = (ms) => (ms == null ? '–' : (ms / 1000).toFixed(2) + 's');
const md = ['# Squarespace copy prototype: results', '',
  'Times are medians of cold loads. **First screen ready** = first moment the visible screen is 95% of the way to its final look (screen recording). LCP = browser Largest Contentful Paint. Pixels that never stop moving (tickers, clocks, slideshows, looping GIFs) are left out of that comparison; "moving" is their share of the screen. Mobile: 390x844, Slow 4G (150ms, 1.6 Mbps), 4x CPU slowdown. Mobile 4G: same phone on 9 Mbps, 85ms (timing only). Desktop: 1440x900, Cable (28ms, 5 Mbps). Copies are served from one local origin with every outside request blocked.', ''];
const checkCols = (c, prof) => [
  prof !== 'desktop' ? c.mobileMenu ?? '–' : c.dropdown ?? '–',
  c.gallery ?? '–', c.stuckInvisible ?? '–', (c.brokenImages ?? 0) + (c.blankImages ?? 0),
  (c.overlaysVisible || []).length ? 'yes' : 'no', c.pageErrors ?? '–',
  c.diffFirstScreen ? c.diffFirstScreen.pct + '%' : '–', c.diffFullPage ? `${c.diffFullPage.pct}% (h×${c.diffFullPage.heightRatio})` : '–',
  c.replicaNotice ?? '–', (c.externalRequests || []).length,
];
const all = files.map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')));
const vnames = ['original', 'frozen', 'frozen-opt', 'opt-rendered', 'opt-server'];
md.push('## Overview: first screen ready (median)', '', '| site | profile | ' + vnames.join(' | ') + ' |', '|' + '---|'.repeat(vnames.length + 2));
for (const r of all) for (const prof of ['mobile', 'mobile-4g', 'desktop']) {
  if (!r.original?.[prof]) continue;
  const v = (n) => (n === 'original' ? r.original[prof] : r.variants?.[n]?.[prof])?.timing?.median?.vc95;
  md.push(`| ${r.site} | ${prof} | ` + vnames.map((n) => { const x = v(n); return x == null ? '–' : (x < 2000 ? `**${s(x)}**` : s(x)); }).join(' | ') + ' |');
}
md.push('', 'Bold = under 2 seconds.', '');
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
  md.push(`## ${r.site} (${r.url})`, '');
  if (r.skipped || (r.error && !r.original)) { md.push(`Not measured: ${r.skipped || r.error.split('\n')[0]}`, ''); continue; }
  for (const prof of ['mobile', 'mobile-4g', 'desktop']) {
    if (!r.original?.[prof]) continue;
    md.push(`### ${prof}`, '', '| version | first screen ready | LCP | FCP | KB | requests | moving | menu | gallery next | stuck-invisible | broken imgs | overlays shown | JS errors | pixel diff first screen | pixel diff full page | replica notice | outside requests |', '|' + '---|'.repeat(17));
    const line = (name, x) => {
      if (!x) return;
      const m = x.timing.median, c = x.check || {};
      md.push(`| ${name} | ${s(m.vc95)} | ${s(m.lcp)} | ${s(m.fcp)} | ${m.kb} | ${m.requests} | ${m.volatilePct ?? '–'}% | ${checkCols(c, prof).join(' | ')} |`);
      rows.push([r.site, prof, name, m.vc95, m.vc99, m.lcp, m.fcp, m.kb, m.requests, m.volatilePct, ...checkCols(c, prof)].join(','));
    };
    line('original', r.original?.[prof]);
    for (const [v, x] of Object.entries(r.variants || {})) line(v, x[prof]);
    md.push('');
    for (const [v, x] of Object.entries(r.variants || {})) {
      const c = x[prof]?.check; if (!c) continue;
      const notes = [];
      if (c.errorSamples?.length) notes.push('errors: ' + c.errorSamples.join(' / '));
      if (x[prof].misses?.length) notes.push(`${x[prof].misses.length} missing files, e.g. ${x[prof].misses.slice(0, 3).join(' ; ')}`);
      if (c.externalRequests?.length) notes.push('tried to reach: ' + c.externalRequests.slice(0, 5).join(', '));
      if (notes.length) md.push(`- **${v}**: ${notes.join('. ')}`);
    }
    md.push('');
  }
  const sc = Object.entries(r.variants || {}).map(([v, x]) => `${v}: ${x.scripts?.kept} kept / ${x.scripts?.dropped} dropped`).join('; ');
  md.push(`Scripts: ${sc}. Overlays found on the live page: ${(r.capture?.overlaysFound || []).join(', ') || 'none'}.`, '');
}
fs.writeFileSync(path.join(OUT, 'results.md'), md.join('\n'));
fs.writeFileSync(path.join(OUT, 'results.csv'), ['site,profile,version,first_screen_ms,vc99_ms,lcp_ms,fcp_ms,kb,requests,moving_pct,menu,gallery_next,stuck_invisible,broken_images,overlays_shown,js_errors,diff_first_screen,diff_full_page,replica_notice,outside_requests', ...rows].join('\n'));
console.log('wrote', path.join(OUT, 'results.md'));
