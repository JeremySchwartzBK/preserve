// One job, URL in, finished copy out. No hand steps: capture -> build -> export -> shrink fonts -> scrub -> quality check
// -> (optionally) publish. Meant to be run by a queue worker; it writes its progress to <work>/<id>/job.json as it goes,
// which is what an app would poll to show "working" / "ready" / "can't process this site yet".
//
// Usage: node make-copy.mjs <url> [--id <copyId>] [--work <dir>] [--out <readyRoot>] [--publish <pagesProject>]
//   --id       folder name the copy is served under (default: derived from the URL)
//   --work     capture workspace (default ./work)
//   --out      where finished copies are written, one folder per copy (default ./ready)
//   --publish  after a pass or ship-with-note, deploy <out> to this Cloudflare Pages project
// Exit code: 0 copy ready (pass or ship-with-note), 2 ready but the check found problems (needs-review), 1 couldn't copy.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runGate } from './gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const url = args.find((a) => /^https?:\/\//.test(a));
if (!url) { console.error('usage: node make-copy.mjs <url> [--id x] [--work dir] [--out dir] [--publish project]'); process.exit(1); }
const id = opt('--id', new URL(url).hostname.replace(/^www\./, '').replace(/\.(squarespace\.com|com|net|org|co|io|nyc|live|studio|design|co\.uk)$/, '').replace(/[^a-z0-9]+/g, '-').slice(0, 40));
const WORK = path.resolve(opt('--work', 'work'));
const OUT = path.resolve(opt('--out', 'ready'));
const siteDir = path.join(WORK, id);
const stage = path.join(WORK, '_stage', id); // export goes here first; moved to OUT only if it passes
fs.mkdirSync(siteDir, { recursive: true });

const job = { id, url, state: 'working', step: null, steps: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(siteDir, 'job.json'), JSON.stringify(job, null, 1));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), id, ...a);

function run(cmd, argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(argv[0])} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`${path.basename(argv[0])} exited ${code}: ${(err || out).trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)); });
  });
}
async function step(name, fn) {
  job.step = name; save(); log(name);
  const t0 = Date.now();
  try { const r = await fn(); job.steps.push({ name, s: Math.round((Date.now() - t0) / 1000) }); return r; }
  catch (e) { job.steps.push({ name, s: Math.round((Date.now() - t0) / 1000), error: String(e.message).slice(0, 500) }); throw e; }
}

let verdict;
try {
  // 1. Is this a page we can copy at all? (v1: Squarespace only)
  const pre = await step('check-url', async () => {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' }, signal: AbortSignal.timeout(30000) });
    const html = await r.text();
    return { status: r.status, finalUrl: r.url, squarespace: /<!-- This is Squarespace\. -->|static1\.squarespace\.com|assets\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/i.test(html), passwordPage: /sqs-slide-container|squarespace-locked|lock-screen|password-page/i.test(html) && !/<main|<article/i.test(html) };
  });
  job.preflight = pre;
  if (pre.status >= 400 || !pre.squarespace || pre.passwordPage) {
    verdict = { result: 'fail', reasons: [{ code: pre.status >= 400 ? 'page-unreachable' : pre.passwordPage ? 'password-protected' : 'not-squarespace', limitation: pre.squarespace ? null : 13, detail: `HTTP ${pre.status} ${pre.finalUrl}` }], notes: [], warnings: [] };
  } else {
    // 2-3. Capture the live page at phone and desktop width, build the script-free fast copy.
    await step('capture-and-build', () => run('node', ['capbuild.mjs', id, url, WORK], 20 * 60e3));
    // 4. Folder of plain files for a static host.
    fs.rmSync(stage, { recursive: true, force: true });
    const exp = await step('export', async () => { const o = await run('node', ['export-static.mjs', siteDir, id, path.dirname(stage)], 15 * 60e3); const r = JSON.parse(o.slice(o.indexOf('{'))); fs.writeFileSync(path.join(siteDir, 'export-report.json'), JSON.stringify(r, null, 1)); return r; });
    // 5. Shrink fonts to the characters the copy uses; strip Squarespace leftovers, hide from search, replace contact details.
    await step('subset-fonts', () => run('python3', ['subset-fonts.py', stage], 10 * 60e3));
    const scrub = await step('scrub', () => run('python3', ['scrub.py', stage, url], 5 * 60e3));
    fs.writeFileSync(path.join(siteDir, 'scrub-output.txt'), scrub);
    // 6. Quality check: pass, ship with a note, or fail with the "can't process this site yet" message.
    verdict = await step('quality-check', () => runGate({ id, url, siteDir, copyDir: stage, exportReport: exp, scrubOutput: scrub }));
  }
} catch (e) {
  verdict = { result: 'fail', reasons: [{ code: 'job-error', detail: String(e.message).slice(0, 500) }], notes: [], warnings: [] };
}

job.verdict = verdict;
job.finishedAt = new Date().toISOString();
job.minutes = +((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 60e3).toFixed(1);
// Jeremy (2026-10-15): a copy that fails the check still goes to the user for review, with the check's findings shown
// as "we noticed" items, and they may keep it. Only a page we couldn't copy at all ends the job.
const HARD = ['not-squarespace', 'page-unreachable', 'password-protected', 'job-error', 'copy-did-not-load'];
const hard = verdict.result === 'fail' && verdict.reasons.some((r) => HARD.includes(r.code));
if (verdict.result === 'fail') fs.appendFileSync(path.join(WORK, 'gaps.jsonl'), JSON.stringify({ at: new Date().toISOString(), id, url, reasons: verdict.reasons }) + '\n');
if (hard) {
  job.state = 'failed';
  job.message = "This site contains elements our system can't process yet. We've logged the gap and will be in touch when we can handle this site.";
} else {
  fs.rmSync(path.join(OUT, id), { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(stage, path.join(OUT, id), { recursive: true });
  // Ready for the user's review; "needs-review" carries the check's findings for the review screen.
  job.state = verdict.result === 'fail' ? 'needs-review' : 'ready';
  job.findings = verdict.reasons;
  job.copyDir = path.join(OUT, id);
  if (verdict.notes.length) job.message = 'Your copy is ready. ' + verdict.notes.map((n) => n.text).join(' ');
  const project = opt('--publish');
  if (project) {
    try {
      await step('publish', () => run('node', ['publish.mjs', OUT, project], 15 * 60e3));
      job.links = { full: `https://${project}.pages.dev/${id}/`, embedDemo: `https://${project}.pages.dev/${id}/embed-demo` };
    } catch (e) { job.state = 'publish-failed'; job.publishError = String(e.message); }
  }
}
job.step = null;
save();
log(job.state, verdict.result, JSON.stringify(verdict.reasons || []).slice(0, 300));
process.exit(job.state === 'ready' ? 0 : job.state === 'needs-review' ? 2 : 1);
