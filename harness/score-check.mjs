// Scores the quality check against Jeremy's spot-check verdicts (check-cases.json), so a change to the check is
// measured instead of judged by eye. Plan: "A more robust Preserve quality check" (2026-11-10, Jeremy approved steps 1-2
// on 2026-11-11). Launch targets he set: no misses on the cases, under 25% of Preserves held.
//
//   node score-check.mjs                     what the check said when he reviewed (recorded), scored
//   node score-check.mjs --rerun [--only a,b] [--jobs 3] [--work dir]
//                                            the check as it is now, re-run on the exact copies he reviewed: each copy's
//                                            files and its stored capture come from R2 (needs the Cloudflare token, as the
//                                            runner has). Build-time findings (stylesheet swap, fonts) can't be re-run on a
//                                            stored copy, so they are kept from the record.
//   node score-check.mjs --rerun --add-behavior ...   only the behavior probes, added to the recorded findings
//   node score-check.mjs --report <dir>      score the verdicts a --rerun left in <dir> again (no browsers)
//
// Counts: a MISS is a case with a problem the check passed (or shipped with a note); a FALSE HOLD is a case Jeremy
// found fine that the check held. A hold on a problem case is NAMED when one of its findings is of the same kind as an
// issue he saw (behavior, content, layout, font, frame), VAGUE when it was held only by pixel or stylesheet findings, and
// WRONG when every finding points somewhere else.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(fs.readFileSync(path.join(HERE, 'check-cases.json'), 'utf8')).cases;

// The kind of problem each finding names. Pixel findings say something differs, not what: they count as vague.
export const KIND = {
  'widget-frozen': 'behavior', 'gallery-does-not-advance': 'behavior', 'gallery-does-not-autoplay': 'behavior', 'phone-menu-broken': 'behavior',
  'dropdown-broken': 'behavior', 'blocks-stay-invisible': 'behavior', 'replica-notice-missing': 'behavior',
  'motion-lost': 'behavior', 'video-hidden': 'behavior', 'animation-flattened': 'behavior', 'hover-effect-lost': 'behavior', 'drag-lost': 'behavior', 'scroll-effect-lost': 'behavior',
  'broken-images': 'content', 'blank-images': 'content', 'gallery-blank-slide': 'content', 'page-length-differs': 'content',
  'font-not-on-google-fonts': 'font',
  'first-screen-differs': 'vague', 'page-differs': 'vague', 'differs-at-other-widths': 'vague', 'breaks-on-resize': 'vague', 'own-stylesheet-mismatch': 'vague',
};
// Findings made while building the copy, not by loading it: a re-run on a stored copy keeps them from the record.
const BUILD_TIME = new Set(['own-stylesheet-mismatch', 'squarespace-styles-left', 'unhandled-address', 'font-not-on-google-fonts', 'capture-addresses-left', 'squarespace-addresses-left']);

export function score(cases, verdictOf) {
  const rows = [], t = { cases: 0, ok: 0, problem: 0, held: 0, miss: [], falseHold: [], named: [], vague: [], wrong: [] };
  for (const c of cases) {
    const v = verdictOf(c);
    if (!v) continue;
    const held = v.result === 'fail', codes = v.codes || [];
    const kinds = new Set(codes.map((k) => KIND[k] || 'other'));
    let outcome;
    if (c.truth === 'ok') outcome = held ? 'false-hold' : 'right';
    else if (!held) outcome = 'miss';
    else if (c.issues.some((i) => kinds.has(i.kind))) outcome = 'named';
    else if (kinds.has('vague')) outcome = 'vague';
    else outcome = 'wrong';
    t.cases++; t[c.truth]++; if (held) t.held++;
    ({ miss: t.miss, 'false-hold': t.falseHold, named: t.named, vague: t.vague, wrong: t.wrong })[outcome]?.push(c.case);
    rows.push({ case: c.case, truth: c.truth, result: v.result, codes, outcome });
  }
  return { rows, totals: t };
}

export function report({ rows, totals: t }, title) {
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const out = [`${title}`, '',
    `${t.cases} cases: ${t.ok} fine, ${t.problem} with problems. Held ${t.held} (${pct(t.held, t.cases)}%; target under 25%).`,
    `Misses (problem passed): ${t.miss.length}${t.miss.length ? ' - ' + t.miss.join(', ') : ''}  (target 0)`,
    `False holds (fine but held): ${t.falseHold.length}${t.falseHold.length ? ' - ' + t.falseHold.join(', ') : ''}`,
    `Problem holds that named the right kind: ${t.named.length}; only pixel/stylesheet: ${t.vague.length}; named something else: ${t.wrong.length}${t.wrong.length ? ' - ' + t.wrong.join(', ') : ''}`,
    '', 'case\ttruth\tresult\toutcome\tfindings', ...rows.map((r) => `${r.case}\t${r.truth}\t${r.result}\t${r.outcome}\t${r.codes.join(', ')}`)];
  return out.join('\n');
}

// --- re-run on stored copies ---------------------------------------------------------------------------------------
async function r2() {
  const { cloudflareStore } = await import('../platform/worker/copy-store.mjs');
  return cloudflareStore({ account: '1dcf2dbf05caa4963ed872ff035bc9db', bucket: 'preserve-copies' });
}

// Lays the copy out as the check serves it (<root>/<id>/desktop.html, mobile.html, a/) and restores its capture.
export async function fetchCase(c, work) {
  const store = await r2();
  const root = path.join(work, c.case, 'copy'), copyDir = path.join(root, c.copy), siteDir = path.join(work, c.case, 'site');
  if (!fs.existsSync(path.join(copyDir, 'desktop.html'))) {
    const keys = await store.list(`copies/${c.copy}/`);
    const versions = [...new Set(keys.map((k) => k.match(/^copies\/[^/]+\/v(\d+)\//)?.[1]).filter(Boolean))].map(Number);
    const v = c.version || Math.max(...versions);
    const page = keys.find((k) => k.startsWith(`copies/${c.copy}/v${v}/p/`) && k.endsWith('/desktop.html'))?.split('/')[4];
    if (!page) throw new Error(`no stored copy for ${c.copy}`);
    fs.mkdirSync(path.join(copyDir, 'a'), { recursive: true });
    for (const l of ['desktop', 'mobile']) fs.writeFileSync(path.join(copyDir, `${l}.html`), await store.get(`copies/${c.copy}/v${v}/p/${page}/${l}.html`));
    const assets = keys.filter((k) => k.startsWith(`copies/${c.copy}/a/`));
    for (let i = 0; i < assets.length; i += 8) await Promise.all(assets.slice(i, i + 8).map(async (k) => fs.writeFileSync(path.join(copyDir, 'a', k.split('/').pop()), await store.get(k))));
  }
  if (!fs.existsSync(path.join(siteDir, 'raw'))) {
    const { restoreCapture } = await import('../platform/capture-store.mjs');
    const idx = (await store.list(`captures/${c.copy}/`)).filter((k) => k.endsWith('/index.json')).sort().pop();
    if (!idx) throw new Error(`no stored capture for ${c.copy} (deleted after 30 idle days?)`);
    await restoreCapture(store, { prefix: idx.replace(/index\.json$/, ''), dir: siteDir });
  }
  return { copyDir, siteDir };
}

// --add-behavior: only the behavior probes (behavior.mjs) run; their findings are added to what the check recorded.
// A quick way (about five minutes a case) to see what the behavior check alone changes.
async function addBehavior(c, copyDir) {
  const { serve } = await import('./gate.mjs');
  const { probeBehavior, compareBehavior } = await import('./behavior.mjs');
  const { launch } = await import('./lib.mjs');
  const srv = await serve(path.dirname(copyDir)), b = await launch();
  const found = [], detail = {};
  try {
    for (const l of ['desktop', 'mobile']) {
      const live = await probeBehavior(b, c.url, l);
      const copy = await probeBehavior(b, `http://127.0.0.1:${srv.address().port}/${c.copy}/${l}`, l, { isCopy: true });
      detail[l] = { live, copy };
      for (const [code, list] of Object.entries(compareBehavior(live, copy, l))) if (list.length) found.push({ code, detail: `${l}: ` + list.map((x) => x.detail).join('; ') });
    }
  } finally { await b.close(); srv.close(); }
  fs.writeFileSync(path.join(path.dirname(path.dirname(copyDir)), 'behavior.json'), JSON.stringify(detail, null, 1));
  const codes = [...new Set([...(c.recorded?.codes || []), ...found.map((f) => f.code)])];
  return { result: codes.length ? 'fail' : c.recorded.result, codes, reasons: found };
}

export async function runOne(c, work) {
  const { copyDir, siteDir } = await fetchCase(c, work);
  if (process.env.SCORE_ADD_BEHAVIOR === '1') {
    const out = { case: c.case, copy: c.copy, ...(await addBehavior(c, copyDir)), at: new Date().toISOString() };
    fs.writeFileSync(path.join(work, c.case, 'rescore.json'), JSON.stringify(out, null, 1));
    return out;
  }
  const { runGate } = await import('./gate.mjs');
  const v = await runGate({ id: c.copy, url: c.url, siteDir, copyDir, exportReport: null });
  const codes = [...new Set([...v.reasons.map((r) => r.code), ...(c.recorded?.codes || []).filter((k) => BUILD_TIME.has(k))])];
  const result = codes.length ? 'fail' : v.result === 'fail' ? 'pass' : v.result;
  const out = { case: c.case, copy: c.copy, result, codes, reasons: v.reasons, at: new Date().toISOString() };
  fs.writeFileSync(path.join(work, c.case, 'rescore.json'), JSON.stringify(out, null, 1));
  return out;
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
if (import.meta.url === `file://${process.argv[1]}`) {
  if (args[0] === '--one') {
    // Child of --rerun: one case, its verdict written to <work>/<case>/rescore.json.
    const c = CASES.find((x) => x.case === args[1]);
    try { await runOne(c, path.resolve(opt('--work'))); process.exit(0); }
    catch (e) { fs.mkdirSync(path.join(opt('--work'), c.case), { recursive: true }); fs.writeFileSync(path.join(opt('--work'), c.case, 'rescore.json'), JSON.stringify({ case: c.case, error: String(e.stack || e) })); console.error(c.case, e.message); process.exit(1); }
  }
  const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
  const cases = CASES.filter((c) => !only || only.has(c.case));
  if (args.includes('--rerun') || opt('--report')) {
    const work = path.resolve(opt('--report') || opt('--work', path.join(os.tmpdir(), 'score-check')));
    fs.mkdirSync(work, { recursive: true });
    if (args.includes('--rerun')) {
      // Load time is not a fidelity check, and it is the slowest part: left out here.
      const env = { ...process.env, PRESERVE_LOAD_CHECK: '0', ...(args.includes('--add-behavior') ? { SCORE_ADD_BEHAVIOR: '1' } : {}) };
      const queue = [...cases]; const jobs = +opt('--jobs', 3);
      await Promise.all(Array.from({ length: jobs }, async () => {
        for (let c; (c = queue.shift());) {
          const t0 = Date.now();
          const code = await new Promise((res) => { const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--one', c.case, '--work', work], { env, stdio: ['ignore', 'ignore', 'inherit'] }); p.on('exit', res); });
          console.error(`${c.case}: ${code ? 'error' : 'done'} in ${Math.round((Date.now() - t0) / 1000)} s`);
        }
      }));
    }
    const got = (c) => { try { const r = JSON.parse(fs.readFileSync(path.join(work, c.case, 'rescore.json'), 'utf8')); return r.error ? null : r; } catch { return null; } };
    const errors = cases.filter((c) => !got(c)).map((c) => c.case);
    const s = score(cases, got);
    const text = report(s, `Quality check re-run on the reviewed copies (${new Date().toISOString().slice(0, 16)}Z)`) + (errors.length ? `\n\nNot scored (error or not run): ${errors.join(', ')}` : '');
    fs.writeFileSync(path.join(work, 'score.txt'), text); fs.writeFileSync(path.join(work, 'score.json'), JSON.stringify(s, null, 1));
    console.log(text);
  } else {
    console.log(report(score(cases, (c) => c.recorded), 'Quality check as recorded when Jeremy reviewed'));
  }
}
