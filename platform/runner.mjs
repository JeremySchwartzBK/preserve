// Copy runner: takes queued copy jobs from the database, runs the copy job (harness/make-copy.mjs), uploads the result
// to R2 as a new version, and records it for review. It keeps the original capture of each page (capture-store.mjs)
// while the copy is being built or refined, and deletes it when the retention rules say so (sweepCaptures). It also keeps the edge lookup (KV) in step with the database, so
// approving, renaming, archiving or deleting in the app reaches visitors within a few seconds.
//
// Any number of runners can run at once, on one machine or several (schema-runner.sql): each job is claimed with a
// lease the runner renews while it works, so a runner that dies or is redeployed hands its job to another one. On
// SIGTERM a runner stops its jobs and gives them straight back to the queue.
//
// Usage: node runner.mjs [--once]
// Env: SUPABASE_PROJECT (ref), HARNESS (default ../harness in this checkout), RUN_DIR (default /root/runs),
//      RUNNER_SLOTS (jobs at a time, default 1), RUNNER_IDLE_EXIT (seconds with nothing to do before exiting; unset =
//      run forever). v1 hosting sleeps when idle to keep costs down (Jeremy, 2026-10-18): a new copy request starts a
//      runner, which exits once the queue has been empty this long; a once-a-minute check is the safety net.
// Database access goes through the Supabase management API with the access token (injected by the proxy here); a
// production runner would use a direct database connection instead.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cloudflareStore, uploadPages, setCopy, setNames, deleteCopyFiles } from './worker/copy-store.mjs';
import { storeCapture, deleteCapture, capturePrefix } from './capture-store.mjs';
import { refuseAddress, jobEnv } from './address-guard.mjs';
import { mintReviewToken } from './review-token.mjs';
import { spotMessage, pageMessage, groupMessage, MOVES, HIDDEN } from '../app/review-messages.js';
import { adobe, ensureKit, syncFamilies, checkConnection } from './adobe.mjs';
import { MOVE_FAMILY, codeOf } from '../harness/fix-menu.mjs';
import { oneItemPerIssue, carryAnswers, sameKind } from './finding-items.mjs';

// Our findings and the person's pins come back each round; a fix tried on one in an earlier round is never tried on it
// again (fix-menu.mjs). A finding is the same issue as an earlier one on the same part when its kind is the same, or of
// the same movement family (a drag found by two different tests).
const triedFor = (rows, code, blockId) => [...new Set(rows.filter((r) => r.block_id === blockId && sameKind(r.code, code)).flatMap((r) => r.tried || []))];

if (!process.env.NODE_USE_ENV_PROXY) {
  const r = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => r.kill(sig));
  r.on('close', (c) => process.exit(c));
} else {
  await main();
}

async function main() {
  const REF = process.env.SUPABASE_PROJECT || 'uzgprpbhhrctklzumikn';
  const HARNESS = process.env.HARNESS || new URL('../harness', import.meta.url).pathname;
  const RUN = process.env.RUN_DIR || '/root/runs';
  // Where review pages are served; AI for refinements (harness/ai-pins.mjs) looks at the version under review there.
  const VIEW_BASE = process.env.PRESERVE_VIEW_URL || 'https://view.preserve.studio';
  const once = process.argv.includes('--once');
  const store = cloudflareStore({ account: '1dcf2dbf05caa4963ed872ff035bc9db', bucket: 'preserve-copies', kvNamespace: 'c67307a470e44d529efa87933c42942f' });
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  // The code that makes each version is recorded with it, so a copy can be traced to the commit that built it.
  const git = (...a) => { try { return execFileSync('git', ['-C', HARNESS, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const PIPELINE = process.env.PIPELINE_VERSION || (git('rev-parse', '--short=12', 'HEAD') || 'unknown') + (git('status', '--porcelain', '--untracked-files=no') ? '+dirty' : '');

  const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
  // With DATABASE_URL (a dedicated database role; how the hosted runner connects) queries go straight to Postgres.
  // Without it they go through the Supabase management API with the access token the proxy injects (this workspace).
  const db = { ok: null, error: null, errorAt: null };  // the last database success and failure, shown on /health
  // Timeouts so a connection that never answers (a network block, a pooler problem) shows up as an error the slots retry
  // and /health reports, instead of every slot waiting on it silently forever.
  const pool = process.env.DATABASE_URL ? new (await import('pg')).default.Pool({ connectionString: process.env.DATABASE_URL, max: 4, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20e3, query_timeout: 10 * 60e3, keepAlive: true }) : null;  // Supabase's certificate isn't from a public CA; still encrypted
  pool?.on('error', (e) => { db.error = e.message; db.errorAt = new Date().toISOString(); log('database connection error', e.message); });
  async function sql(query) {
    if (pool) {
      try {
        const r = await pool.query(query);
        db.ok = new Date().toISOString();
        return (Array.isArray(r) ? r.at(-1) : r).rows || [];
      } catch (e) { db.error = e.message; db.errorAt = new Date().toISOString(); throw e; }
    }
    for (let i = 0; ; i++) {
      const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer injected-by-proxy' }, body: JSON.stringify({ query }) });
      if (r.ok) return r.json();
      const t = await r.text();
      if (i < 3 && (r.status === 429 || r.status >= 500)) { await new Promise((s) => setTimeout(s, 2000 * (i + 1))); continue; }
      throw new Error(`database ${r.status}: ${t.slice(0, 300)}`);
    }
  }

  // What the review screen says for each suspected issue: app/review-messages.js, shared with the app.
  // What a finding is on, from the block's Squarespace class in the built page (the block id is the same in both
  // layouts). One place for every kind of finding, whichever part of the check placed it.
  const NOUNS = [[/\b(?:(?:sqs|ps)-block-image|image-block)\b/, 'Image'], [/\b(?:(?:sqs|ps)-block-(?:html|markdown|code)|html-block|markdown-block)\b/, 'Text'],
    [/\b(?:(?:sqs|ps)-block-button|button-block)\b/, 'Button'], [/\b(?:(?:sqs|ps)-block-(?:gallery|slideshow)|gallery-block|sqs-gallery)\b/, 'Gallery'],
    [/\b(?:(?:sqs|ps)-block-video|video-block)\b/, 'Video'], [/\b(?:(?:sqs|ps)-block-(?:form|newsletter)|form-block|newsletter-block)\b/, 'Form']];
  const nounOf = (html, blockId) => {
    if (!blockId || blockId === 'el:body') return 'Content';
    if (blockId === 'el:header') return 'Header';
    if (blockId === 'el:footer') return 'Footer';
    if (blockId.startsWith('section:')) return 'Section';
    const id = blockId.replace(/^el:/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`<[a-z]+[^>]*\\b(?:id|data-block-id)="${id}"[^>]*>`, 'i').exec(html || '');
    if (!m) return 'Content';
    // The block's own classes (the build renames sqs-block to ps-block), else those of the next two tags inside it (a
    // Fluid Engine cell wraps the Squarespace block). Never further, so a neighbouring block can't lend its kind.
    const inner = (html.slice(m.index + m[0].length, m.index + m[0].length + 2000).match(/<[a-z][^>]*>/gi) || []).slice(0, 2).join('');
    for (const tags of [m[0], inner]) for (const [re, n] of NOUNS) if (re.test(tags)) return n;
    return /<section\b/i.test(m[0]) ? 'Section' : 'Content';
  };
  const FAILED = {
    'not-squarespace': 'This page isn’t on Squarespace. For now we can only preserve Squarespace sites.',
    'page-unreachable': 'We couldn’t open this page. Check the address and that the site is public.',
    'password-protected': 'This page is password protected, so we couldn’t copy it.',
  };
  const GENERIC = 'This site contains elements our system can’t process yet. We’ve logged the gap and will be in touch when we can handle this site.';
  const STEP = { 'check-url': 'check-url', 'capture-and-build': 'capture-and-build', export: 'export', 'own-stylesheet': 'export', 'subset-fonts': 'fonts', scrub: 'scrub', steady: 'scrub', 'quality-check': 'quality-check', 'vet-findings': 'quality-check' };

  // The review's Fonts step (schema-fonts.sql): one row per font family that needs the person's look, from the quality
  // check's font record (google-fonts.py, gate.mjs). Open fonts never do, nor fonts no layout shows.
  const fontKey = (fam) => String(fam).toLowerCase().replace(/[^a-z0-9]/g, '');
  // The font's own name when it has one (an uploaded "malamocco-unlicensed-trial-bl0cl3" says "Malamocco"), without
  // trial wording or the random ending Squarespace adds to uploads.
  const fontName = (r) => {
    const raw = r.font_name || (/[A-Z ]/.test(r.family) ? String(r.family) : String(r.family).replace(/-[a-z0-9]{6}$/, '').split(/[-_]+/).filter(Boolean).map((x) => x[0].toUpperCase() + x.slice(1)).join(' '));
    return raw.replace(/\b(unlicen[sc]ed|trial|test|demo|personal use( only)?|for personal use)\b/gi, '').replace(/\s+/g, ' ').trim() || raw;
  };
  function fontRows(fonts) {
    const rows = new Map();
    for (const r of fonts || []) {
      if (r.holder === 'anyone' || r.action === 'open-equivalent' || !r.shown?.length) continue;
      const id = fontKey(fontName(r));
      const row = rows.get(id) || { id, name: fontName(r), holder: r.holder === 'platform' ? 'platform' : 'user', source: r.source, look: null, sample: null, text: null, block: null, fox: null, shown: [], faces: [], trial: false };
      row.look ||= (r.holder === 'platform' ? r.served_as : r.alt?.family) || null;
      if (r.sample && !row.sample) Object.assign(row, { sample: 'a/' + r.sample.file, text: r.sample.text, block: r.sample.block,
        fox: r.sample.fox ? { file: 'a/' + r.sample.fox, weight: String(r.sample.weight || r.weight), style: r.sample.style || r.style || 'normal', caps: !!r.sample.caps } : null });
      row.shown = [...new Set([...row.shown, ...r.shown])];
      // look: the weight the lookalike is drawn in for this face, chosen by how heavy it looks (google-fonts.py by_look),
      // and whether it draws capitals only, so the review shows the lookalike as the Preserve would.
      const lw = r.holder === 'platform' ? r.served_weight : r.alt?.weight;
      row.faces.push({ family: r.family, weight: String(r.weight), style: r.style || 'normal', alt: r.alt?.file || null,
        ...(lw ? { look: { weight: String(lw), caps: !!(r.holder === 'platform' ? r.caps_only : r.alt?.caps_only) } } : {}) });
      if (r.trial_hint) row.trial = true;
      rows.set(id, row);
    }
    return [...rows.values()];
  }
  // What the viewer draws in place of the fonts on the page (worker: fonts:<id>), from the person's choices: the
  // lookalike for a font they have no rights to, their checked upload for one they licensed (or one an earlier upload
  // in their studio covers). A same-named @font-face added after the page's own wins, so nothing is rebuilt.
  function fontSwaps(rows, choices, studioFonts) {
    const out = [];
    for (const row of rows || []) {
      const ch = (choices || []).find((x) => x.font_id === row.id);
      const ok = (sf) => sf && sf.state === 'ok' && sf.asset;
      const upload = ch?.decision === 'upload' ? (studioFonts || []).find((x) => x.id === ch.studio_font_id)
        : !ch ? (studioFonts || []).filter((x) => x.font_key === row.id && ok(x)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : null;
      if (ok(upload)) for (const f of row.faces) out.push({ family: f.family, weight: f.weight, style: f.style, src: upload.asset, studioFont: upload.id });
      else if (ch?.decision === 'lookalike' && row.holder === 'user') for (const f of row.faces) if (f.alt) out.push({ family: f.family, weight: f.weight, style: f.style, src: f.alt });
    }
    return out;
  }

  async function notify(copyId, kind, body) {
    await sql(`insert into notification (person_id, kind, copy_id, body) select sm.person_id, ${lit(kind)}, c.id, ${lit(body)} from copy c join studio_member sm on sm.studio_id = c.studio_id where c.id = ${lit(copyId)}`);
  }

  // Unique per runner even when several containers share a hostname and process number: a lease belongs to one runner.
  const WORKER = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 6)}`;
  const SLOTS = Math.max(1, +process.env.RUNNER_SLOTS || 1);
  const LEASE = 120;  // seconds; renewed every 30
  const running = new Map();  // job id -> { child }
  let stopping = false;
  const IDLE_EXIT = +process.env.RUNNER_IDLE_EXIT || 0;
  let lastBusy = Date.now();

  const jobLogFile = (work, j) => path.join(work, `${j.copy_id}.a${j.attempt}.log`);
  // logs/<copy>/a<attempt>-t<try>.log: what the job printed (the last 2 MB if it ran long), then its steps and result.
  async function saveJobLog(j, work, job, code) {
    const MAX = 2 * 1024 * 1024;
    let text = '';
    try {
      const f = jobLogFile(work, j), size = fs.statSync(f).size, fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(Math.min(size, MAX));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length); fs.closeSync(fd);
      text = (size > MAX ? `[first ${size - MAX} bytes left out]\n` : '') + buf.toString('utf8');
    } catch {}
    const tail = { copy: j.copy_id, job: j.id, attempt: j.attempt, try: j.tries, url: j.url, worker: WORKER, pipeline: PIPELINE, exit: code, state: job.state, minutes: job.minutes ?? null, steps: job.steps || [], result: job.verdict?.result ?? null, reasons: (job.verdict?.reasons || []).map((r) => ({ code: r.code, detail: r.detail })) };
    const key = `logs/${j.copy_id}/a${j.attempt}-t${j.tries}.log`;
    await store.put(key, `${text}\n--- job ---\n${JSON.stringify(tail, null, 1)}\n`, 'text/plain; charset=utf-8');
    return key;
  }

  async function runJob(j) {
    log('job', j.copy_id, 'attempt', j.attempt, j.url);
    const ctl = running.get(j.id);
    const work = path.join(RUN, 'work'), out = path.join(RUN, 'ready');
    fs.mkdirSync(work, { recursive: true });
    const notesFile = path.join(work, `${j.copy_id}.user-notes.json`);
    fs.rmSync(notesFile, { force: true });
    if (j.user_context?.length) {
      // What was already tried on each pin in earlier rounds, so this round tries something else.
      const rows = await sql(`select kind, block_id, meta->>'code' as code, created_at, coalesce(meta->'tried', '[]'::jsonb) as tried from copy_pin
        where copy_id = ${lit(j.copy_id)} and kind in ('finding', 'issue')`).catch(() => []);
      const pins = j.user_context.map((p) => {
        const code = codeOf(p);
        const tried = code ? triedFor(rows.filter((r) => r.kind === 'finding'), code, p.block_id)
          : [...new Set(rows.filter((r) => r.kind === 'issue' && r.block_id === p.block_id && +new Date(r.created_at) === +new Date(p.at)).flatMap((r) => r.tried || []))];
        return tried.length ? { ...p, tried } : p;
      });
      fs.writeFileSync(notesFile, JSON.stringify(pins, null, 1));
    }
    const jobFile = path.join(work, j.copy_id, 'job.json');
    fs.rmSync(jobFile, { force: true });
    let lastStep = null;
    const watch = setInterval(async () => {
      try {
        const st = JSON.parse(fs.readFileSync(jobFile, 'utf8')).step;
        if (st && st !== lastStep) { lastStep = st; await sql(`update copy_job set step = ${lit(STEP[st] || st)} where id = ${lit(j.id)}`); }
      } catch {}
    }, 3000);
    // Keep the lease. If another runner has taken the job over (this one was unreachable too long), stop here.
    const beat = setInterval(async () => {
      try {
        const [r] = await sql(`select renew_copy_job(${lit(j.id)}, ${lit(WORKER)}, ${LEASE}) as ok`);
        if (!r?.ok) { ctl.lost = true; stopChild(ctl); }
      } catch (e) { log('lease renewal failed', j.copy_id, e.message); }
    }, 30e3);
    // An address that points back at this machine or its private network is never opened (address-guard.mjs).
    const refused = await refuseAddress(j.url);
    if (refused) {
      fs.mkdirSync(path.dirname(jobFile), { recursive: true });
      fs.writeFileSync(jobFile, JSON.stringify({ state: 'failed', steps: [], verdict: { result: 'fail', reasons: [{ code: 'page-unreachable', detail: `refused: ${refused}` }] } }));
      log('refused', j.copy_id, refused);
    }
    const code = refused ? 1 : await new Promise((res) => {
      // Own process group, so stopping the job also stops the browsers and servers it started.
      const p = spawn('node', ['make-copy.mjs', j.url, '--id', j.copy_id, '--work', work, '--out', out, ...(fs.existsSync(notesFile) ? ['--notes', notesFile] : [])], { cwd: HARNESS, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...jobEnv(), PRESERVE_VIEW_BASE: `${VIEW_BASE}/c/${j.copy_id}`, ...(process.env.REVIEW_SECRET ? { PRESERVE_REVIEW_TOKEN: mintReviewToken(process.env.REVIEW_SECRET, j.copy_id, 6 * 3600) } : {}) } });  // the job gets none of the runner's keys
      ctl.child = p;
      const jl = fs.createWriteStream(jobLogFile(work, j), { flags: 'a' });
      p.stdout.on('data', (d) => { process.stdout.write(d); jl.write(d); }); p.stderr.on('data', (d) => { process.stderr.write(d); jl.write(d); });
      p.on('exit', (c) => jl.end(() => res(c)));  // not 'close': a leftover browser holding the output pipe must not stall the runner
    });
    clearInterval(watch); clearInterval(beat);
    let job;
    try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch { job = { state: 'failed', verdict: { result: 'fail', reasons: [{ code: 'job-error', detail: `make-copy exited ${code} without a job file` }] } }; }
    // The job's own log is kept in storage (logs/, never served): the container's disk is wiped whenever the runner
    // sleeps, and the log is how a failure gets explained afterwards. Losing it doesn't stop the copy.
    const logKey = await saveJobLog(j, work, job, code).catch((e) => { log('job log not saved', j.copy_id, e.message); return null; });
    if (ctl.lost || stopping) throw Object.assign(new Error(ctl.lost ? 'lease lost to another runner' : 'runner stopping'), { quiet: true });
    // How long each step took and where the log is go with the verdict, so slow steps and failures can be looked up later.
    const v = { ...(job.verdict || { result: 'fail', reasons: [] }), steps: job.steps || [], minutes: job.minutes ?? null, log: logKey };

    if (job.state === 'failed') {
      const r0 = (v.reasons || [])[0] || {};
      const msg = FAILED[r0.code] || GENERIC;
      const why = ((v.reasons || []).map((r) => `${r.code}: ${r.detail || ''}`).join('; ') + ' | steps: ' + JSON.stringify(job.steps || [])).slice(0, 1000);
      // A failure on our side (a crash or a time limit, not the address) gets one more try before the person hears about
      // it: every such failure up to 2026-11-24 copied fine on another run (thread "Replace progress screen with dashboard
      // progress"). The claim counts tries; the second failure is reported.
      if (!FAILED[r0.code] && j.tries < 2) {
        await sql(`update copy_job set state = 'queued', step = null, worker_id = null, lease_until = null, internal_error = ${lit('tried again after: ' + why)} where id = ${lit(j.id)} and worker_id = ${lit(WORKER)}`);
        log('trying again', j.copy_id, r0.code);
        return;
      }
      await sql(`update copy_job set state = 'failed', step = null, finished_at = now(), verdict = ${lit(JSON.stringify(v))}::jsonb, error = ${lit(msg)}, internal_error = ${lit(why)} where id = ${lit(j.id)};
        update copy set status = case when live_version is null and not exists (select 1 from copy_version where copy_id = ${lit(j.copy_id)}) then 'failed' else 'review' end, updated_at = now() where id = ${lit(j.copy_id)};`);
      await notify(j.copy_id, 'copy-failed', `We couldn’t copy ${new URL(j.url).hostname.replace(/^www\./, '')}.`);
      log('failed', j.copy_id, r0.code);
      return;
    }

    const dir = path.join(out, j.copy_id);
    // The version number was reserved when the job was queued (schema-pages-captures.sql).
    const next = j.version ?? (await sql(`select coalesce(max(version), 0) + 1 as next from copy_version where copy_id = ${lit(j.copy_id)}`))[0].next;
    // Page layout (storage format 2): shared files are uploaded once per copy, so a refinement only adds what changed.
    const up = await uploadPages(store, { id: j.copy_id, version: next, pages: [{ page_id: j.page_id, path: '', dir }] });
    const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(fs.readFileSync(path.join(dir, 'desktop.html'), 'utf8'))?.[1] || '').trim().replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/\s*·\s*Preview copy$/i, '').split(/\s+[|–—-]\s+/)[0].replace(/\s*®\s*$/, '').slice(0, 120) || null;
    // What the person can't see or judge in review (other window sizes, our own leftovers) stays in the verdict for our
    // triage and is left out here (Jeremy, 2026-11-20).
    const shown = (v.reasons || []).filter((r) => !HIDDEN.has(r.code) && !r.quiet);
    const findings = shown.map((r) => ({ code: r.code, text: r.spots?.length ? spotMessage(r.code) : pageMessage(r.code), pinned: !!r.spots?.length }))
      .filter((f, i, a) => a.findIndex((x) => x.text === f.text) === i);
    // Findings become pins the person can mark (schema-findings.sql), placed on the page where the check could tell.
    // They replace the previous version's findings.
    // Lettered top to bottom within each layout (the app lists one layout at a time).
    const pageHtml = Object.fromEntries(['desktop', 'mobile'].map((l) => { try { return [l, fs.readFileSync(path.join(dir, `${l}.html`), 'utf8')]; } catch { return [l, '']; } }));
    let findingPins = shown.flatMap((r) => (r.spots || []).map((p) => { const noun = nounOf(pageHtml[p.layout] || pageHtml.desktop, p.blockId); return { ...p, code: r.code, noun, text: p.vet?.say || spotMessage(r.code, noun), ...(p.vet?.say ? { say: p.vet.say } : {}) }; }));
    // Everything about how one slideshow moves is one issue with one marker, placed on the part of it that shows
    // (Jeremy, 2026-11-23). Other kinds of finding on it (sizes, images) stay their own.
    { const groups = new Map(), rest = [];
      for (const p of findingPins) { const k = p.comp?.key && MOVES[p.code] ? p.layout + '|' + p.comp.key : null; if (!k) { rest.push(p); continue; } if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
      for (const list of groups.values()) {
        const codes = [...new Set(list.map((p) => p.code))], at = list.find((p) => p.comp.at)?.comp.at || list[0];
        rest.push({ ...list[0], blockId: at.blockId, x: at.x, y: at.y, pageY: at.pageY ?? list[0].pageY, code: codes[0], codes, noun: 'slideshow', text: groupMessage(codes) });
      }
      findingPins = rest.sort((a, b) => (a.layout || '').localeCompare(b.layout || '') || (a.pageY ?? 0) - (b.pageY ?? 0)); }
    // One issue is one item on both layouts (finding-items.mjs).
    findingPins = oneItemPerIssue(findingPins);
    // What the check couldn't place on the page is answered like any other suspected issue (Jeremy, 2026-11-21: all
    // issues under Suspected issues): a pin with no block and no layout, which the app lists in both views, unlettered.
    for (const r of shown) if (!r.spots?.length) findingPins.push({ blockId: null, layout: null, code: r.code, text: pageMessage(r.code) });
    // The person's answers to last round's findings carry over to the same finding at the same spot, so a refinement
    // never asks again about something already answered (Jeremy, 2026-10-27). "Not an issue" is remembered from any
    // earlier round, and on phone and desktop alike: the same kind of finding on the same block (block ids are the same
    // in both layouts) stays dismissed (Jeremy, 2026-11-20). The app tucks those into a collapsed list.
    // Newest first. A carried pin whose answer was cleared means the person asked to see it again, so it ends the search.
    const answered = await sql(`select meta->>'code' as code, block_id, layout, coalesce(meta->>'verdict', '') as verdict, resolved_at is null as current,
        coalesce((meta->>'carried')::boolean, false) as carried from copy_pin
      where copy_id = ${lit(j.copy_id)} and page_id = ${lit(j.page_id)} and kind = 'finding' order by created_at desc, id desc`);
    // Answers carry to the same issue in later rounds (finding-items.mjs).
    carryAnswers(findingPins, answered);
    // No "Your site" / "Preserve" pictures any more: the review relies on the markers and a short description
    // (Jeremy, 2026-11-23). finding-crops.mjs stays in the harness, unused.
    // How each of the person's pins came out this round (pins.mjs): shown on the pin in review. With AI on, also the fix
    // it picked and the kind of problem (ai-pins.mjs), kept on the pin so we can count which kinds come up.
    const aiMeta = (a) => (!a ? {} : a.error ? { ai_error: a.error } : { ai_kind: a.kind, ai_action: a.action, ai_by_design: a.by_design === 'none' ? null : a.by_design, ai_confidence: a.confidence, ai_reason: a.reason, ai_model: a.model, ai_tokens: a.tokens, ...(a.moves ? { ai_moves: true } : {}), ...(a.look_error ? { ai_look_error: a.look_error } : {}) });
    const pinResults = (v.info?.pins || []).filter((r) => r.from === 'person' && r.at);
    // The fixes tried so far on each finding, carried to this round's row for the same issue (with this round's own).
    { const rows = await sql(`select block_id, meta->>'code' as code, coalesce(meta->'tried', '[]'::jsonb) as tried from copy_pin
        where copy_id = ${lit(j.copy_id)} and kind = 'finding'`).catch(() => []);
      const now = (v.info?.pins || []).filter((r) => codeOf(r) && r.ai?.action && r.ai.action !== 'none').map((r) => ({ block_id: r.block_id, code: codeOf(r), tried: [r.ai.action] }));
      for (const p of findingPins) { const t = triedFor([...rows, ...now], p.code, p.blockId); if (t.length) p.tried = t; } }
    const notes = (v.notes || []).map((n) => ({ limitation: n.limitation, text: n.text }));
    const pages = [{ page_id: j.page_id, path: '', verdict: v.result, findings: findings.length, files: up.files }];
    const fonts = fontRows(v.info?.fonts || v.pages?.[0]?.info?.fonts);
    // In the pin updates below, the list of tried actions is built under the alias t(action): copy_pin has its own column
    // x, so a bare x would name the pin's column and Postgres refuses the update ("aggregate functions are not allowed in
    // UPDATE"). Comments go here, never inside the SQL text: Postgres reads // as an error.
    await sql(`insert into copy_version (copy_id, version, job_id, verdict, findings, notes, file_count, bytes, pages, pipeline_version, storage_format, fonts)
        values (${lit(j.copy_id)}, ${next}, ${lit(j.id)}, ${lit(v.result)}, ${lit(JSON.stringify(findings))}::jsonb, ${lit(JSON.stringify(notes))}::jsonb, ${up.files}, ${up.bytes}, ${lit(JSON.stringify(pages))}::jsonb, ${lit(PIPELINE)}, 2, ${lit(JSON.stringify(fonts))}::jsonb);
      update copy_job set state = ${lit(job.state)}, step = null, finished_at = now(), version = ${next}, verdict = ${lit(JSON.stringify(v))}::jsonb where id = ${lit(j.id)};
      update copy set status = 'review', title = coalesce(title, ${lit(title)}), updated_at = now() where id = ${lit(j.copy_id)};
      update copy_page set title = coalesce(title, ${lit(title)}) where copy_id = ${lit(j.copy_id)} and page_id = ${lit(j.page_id)};
      update copy_pin set resolved_at = now() where copy_id = ${lit(j.copy_id)} and kind = 'finding' and resolved_at is null;
      ${findingPins.map((p, i) => `insert into copy_pin (copy_id, page_id, kind, block_id, x, y, layout, body, meta, version, sort)
        values (${lit(j.copy_id)}, ${lit(j.page_id)}, 'finding', ${lit(p.blockId)}, ${+p.x || 0}, ${+p.y || 0}, ${lit(p.layout)}, ${lit(p.text)}, ${lit(JSON.stringify({ code: p.code, ...(p.codes?.length > 1 ? { codes: p.codes } : {}), pageY: p.pageY ?? null, noun: p.noun, ...(p.crop ? { crop: p.crop } : {}), ...(p.verdict ? { verdict: p.verdict, carried: true } : {}), ...(p.tried ? { tried: p.tried } : {}), ...(p.spots ? { spots: p.spots } : {}), ...(p.say && !p.codes ? { say: p.say } : {}) }))}::jsonb, ${next}, ${i});`).join('\n')}
      ${pinResults.map((r) => `update copy_pin set meta = coalesce(meta, '{}'::jsonb) || ${lit(JSON.stringify({ round_result: r.result, round_diff: r.diff ?? null, round_version: next, ...aiMeta(r.ai) }))}::jsonb
          || jsonb_build_object('tried', (select coalesce(jsonb_agg(distinct t.action), '[]'::jsonb) from jsonb_array_elements_text(coalesce(meta->'tried', '[]'::jsonb) || ${lit(JSON.stringify(r.ai?.action && !['none', 'fonts', 'by-design', 'live-same'].includes(r.ai.action) ? [r.ai.action] : []))}::jsonb) as t(action)))
        where copy_id = ${lit(j.copy_id)} and kind = 'issue' and block_id = ${lit(r.block_id)} and created_at = ${lit(r.at)}::timestamptz;`).join('\n')}`);
    await notify(j.copy_id, 'copy-needs-review', j.attempt >= 2 ? `Refinement ${j.attempt - 1} of ${title || 'your copy'} is ready to review.` : `Your copy of ${title || new URL(j.url).hostname} is ready to review.`);
    log('ready for review', j.copy_id, 'v' + next, v.result, up.files, 'files');
    // Keep the original capture for refinements. Losing it doesn't stop the copy, so a failure here is only logged.
    const prefix = capturePrefix({ copyId: j.copy_id, pageId: j.page_id, attempt: j.attempt });
    try {
      const k = await storeCapture(store, { dir: path.join(work, j.copy_id), prefix });
      await sql(`insert into copy_capture (copy_id, page_id, job_id, attempt, prefix, parts, bytes, files)
        values (${lit(j.copy_id)}, ${lit(j.page_id)}, ${lit(j.id)}, ${j.attempt}, ${lit(prefix)}, ${k.parts}, ${k.bytes}, ${k.files})
        on conflict (prefix) do update set parts = excluded.parts, bytes = excluded.bytes, files = excluded.files, job_id = excluded.job_id, created_at = now(), deleted_at = null, deleted_why = null`);
      log('capture stored', prefix, (k.bytes / 1e6).toFixed(1) + ' MB', k.parts, 'parts');
    } catch (e) { log('capture not stored', prefix, e.message); }
  }

  // Retention for stored captures (Jeremy, 2026-10-18): gone once the copy is accepted or deleted, or after 30 days
  // with no activity if it never is. The capture_due view decides; this only deletes and records it.
  async function sweepCaptures() {
    for (const k of await sql(`select id, prefix, parts, why from capture_due limit 50`)) {
      await deleteCapture(store, k);
      await sql(`update copy_capture set deleted_at = now(), deleted_why = ${lit(k.why)} where id = ${lit(k.id)}`);
      log('capture deleted', k.prefix, k.why);
    }
  }

  // Keep KV in step: one record per copy, plus friendly names once a copy has been approved.
  // Adobe Fonts connection (schema-adobe.sql, adobe.mjs): the studio's kit is loaded on top of this Preserve when the
  // connection is working, the version uses an Adobe font the kit has, and the Preserve is in review, was accepted
  // after connecting, or the person said yes to switching earlier ones too. Otherwise its lookalikes show.
  const adobeFamilies = (fonts) => [...new Set((fonts || []).filter((f) => f.holder === 'platform').flatMap((f) => (f.faces || []).map((x) => x.family)).filter(Boolean))];
  // Returns { kit, names: { page font name: its name in the kit's stylesheet } }, or null.
  function adobeKit(r, status, fonts) {
    const a = r.adobe;
    if (!a || a.state !== 'ok' || !a.kit) return null;
    const names = Object.fromEntries(adobeFamilies(fonts).map((f) => [f, a.families?.[f]?.css]).filter(([, c]) => c));
    if (!Object.keys(names).length) return null;
    if (status === 'review' || a.accepted_too || a.accepted_after) return { kit: a.kit, names };
    return null;
  }

  // Each pass: a new or changed key is tried and the studio's kit made or found; fonts the studio's Preserves use are
  // added to it. Once a day per studio: the key and the kit's fonts are checked (a lapse shows as a refused key or
  // fonts that stop loading). A network problem on our side changes nothing; the next pass tries again.
  async function adobeUpkeep() {
    const rows = await sql(`select a.studio_id, a.kit_id, a.state, a.families, a.checked_at,
        a.state = 'checking' or a.checked_at is null or a.checked_at < now() - interval '1 day' as due,
        coalesce((select jsonb_agg(v.fonts) from copy c join copy_version v on v.copy_id = c.id where c.studio_id = a.studio_id and c.status <> 'failed' and v.fonts is not null), '[]') as fonts
      from studio_adobe a where a.secret_id is not null`);
    for (const a of rows) {
      const wanted = adobeFamilies(a.fonts.flat());
      const missing = wanted.filter((f) => !(f in (a.families || {})));
      if (!a.due && !missing.length) continue;
      try {
        const [{ k }] = await sql(`select adobe_key(${lit(a.studio_id)}) as k`);
        if (!k) continue;
        const api = adobe(k);
        let kit, families = a.families || {}, check;
        try {
          kit = await ensureKit(api, a.kit_id);
          ({ families } = await syncFamilies(api, kit, wanted, families));
          check = a.due ? await checkConnection(api, kit) : { state: a.state, problem: null };
        } catch (e) { if (!e.refused) throw e; check = { state: 'key-refused', problem: e.message }; }
        await sql(`update studio_adobe set kit_id = coalesce(${lit(kit)}, kit_id), families = ${lit(JSON.stringify(families))}::jsonb, state = ${lit(check.state)}, problem = ${lit(check.problem)}${a.due ? ', checked_at = now()' : ''} where studio_id = ${lit(a.studio_id)} and secret_id is not null`);
        log('adobe', a.studio_id, check.state, kit || '', `${Object.values(families).filter(Boolean).length} families`);
      } catch (e) { log('adobe check failed', a.studio_id, e.message); }
    }
  }

  async function syncServing(ids = null) {
    const rows = ids?.length === 0 ? [] : await sql(`select c.id, c.status, c.live_version, c.served, s.slug,
        (select max(version) from copy_version v where v.copy_id = c.id) as latest,
        (select jsonb_object_agg(version, jsonb_build_object('fmt', storage_format, 'pages', pages, 'fonts', fonts)) from copy_version v where v.copy_id = c.id) as stored,
        coalesce((select jsonb_agg(jsonb_build_object('font_id', f.font_id, 'decision', f.decision, 'studio_font_id', f.studio_font_id)) from copy_font f where f.copy_id = c.id), '[]') as font_choices,
        coalesce((select jsonb_agg(jsonb_build_object('id', sf.id, 'font_key', sf.font_key, 'state', sf.state, 'asset', sf.asset, 'created_at', sf.created_at)) from studio_font sf where sf.studio_id = c.studio_id), '[]') as studio_fonts,
        (select name from copy_name n where n.copy_id = c.id and n.is_current) as name,
        (select jsonb_build_object('state', a.state, 'kit', a.kit_id, 'families', a.families, 'accepted_too', a.accepted_too,
            'accepted_after', exists (select 1 from copy_version v where v.copy_id = c.id and v.version = c.live_version and v.approved_at >= a.connected_at))
          from studio_adobe a where a.studio_id = c.studio_id and a.secret_id is not null) as adobe,
        coalesce((select array_agg(name) from copy_name n where n.copy_id = c.id and not n.is_current), '{}') as old,
        coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'page', p.page_id, 'block', p.block_id, 'x', p.x, 'y', p.y, 'title', coalesce(p.meta->>'title', ''), 'body', p.body) order by p.sort, p.created_at)
          from copy_pin p where p.copy_id = c.id and p.kind = 'tour' and p.block_id is not null), '[]') as spots,
        coalesce((select jsonb_agg(jsonb_build_object('role', coalesce(p.meta->>'role', ''), 'name', p.body, 'url', p.meta->>'url', 'type', p.meta->>'type') order by p.sort, p.created_at)
          from copy_pin p where p.copy_id = c.id and p.kind = 'credit'), '[]') as credits
      from copy c join studio s on s.id = c.studio_id ${ids ? `where c.id in (${ids.map(lit).join(',')})` : ''}`);
    let stills = 0;
    for (const r of rows) {
      if (!r.latest) continue;
      const status = r.status === 'ready' ? 'live' : ['paused', 'archived'].includes(r.status) && r.live_version ? 'paused' : 'review';
      // Tour stops are pinned by block; the tour script finds the block by its id or Squarespace block id.
      const sel = (id) => (id.startsWith('el:') ? id.slice(3) : id.startsWith('section:') ? `section[data-section-id="${id.slice(8)}"]` : `[id="${id}"],[data-block-id="${id}"]`);
      const tour = { site: r.id, spots: r.spots.map((p) => ({ id: p.id, page: p.page, sel: sel(p.block), x: p.x, y: p.y, title: p.title, body: p.body })), credits: r.credits.map((c) => ({ role: c.role, name: c.name, ...(c.url ? { url: c.url } : {}), ...(c.type === 'tool' ? { type: 'tool' } : {}) })) };
      const v = status === 'review' ? r.latest : r.live_version || r.latest;
      // A version in the page layout tells the viewer where its pages are.
      const sv = r.stored?.[v] || {};
      const layout = sv.fmt === 2 ? { fmt: 2, pages: Object.fromEntries((sv.pages || []).map((p) => [p.path, p.page_id])) } : {};
      const swaps = fontSwaps(sv.fonts, r.font_choices, r.studio_fonts);
      const kit = adobeKit(r, status, sv.fonts);
      const want = { v, status, studio: r.slug, name: r.name, old: r.old, ...layout, tour: tour.spots.length + tour.credits.length ? tour : null, fonts: swaps.length ? swaps : null, still: r.served?.still, ...(kit ? { adobe: kit } : {}) };
      const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((m, kk) => ((m[kk] = v[kk]), m), {}) : v));  // key order differs once stored as jsonb
      // A Preserve needs its desktop still: what the Desktop embed shows on phones, and the dashboard's thumbnail. Made
      // once per version in review (so a refinement gets a new one) and again when it goes live (fonts as chosen), a few
      // per pass, so the hourly sweep also fills in Preserves made before stills existed. Live keeps the bare version
      // number, as stills made before review thumbnails existed recorded it.
      const stillKey = status === 'live' ? v : status === 'review' ? `review-${v}` : null;
      // Not while shutting down: an idle runner that has decided to exit must not hold on for minutes of stills, since
      // jobs queued meanwhile wait for the next start.
      const needStill = stillKey !== null && want.still !== stillKey && stills < 10 && !stopping;
      if (canon(want) === canon(r.served) && !needStill) continue;
      await setCopy(store, { id: r.id, version: want.v, status, studio: r.slug, name: r.name, ...layout });
      if (r.live_version && r.name) await setNames(store, { studio: r.slug, id: r.id, current: r.name, old: r.old });
      if (JSON.stringify(want.adobe ?? null) !== JSON.stringify(r.served?.adobe ?? null)) await (want.adobe ? store.kvPut(`adobe:${r.id}`, want.adobe) : store.kvDel(`adobe:${r.id}`).catch(() => {}));
      if (canon(want.tour) !== canon(r.served?.tour ?? null)) await (want.tour ? store.kvPut(`tour:${r.id}`, want.tour) : store.kvDel(`tour:${r.id}`).catch(() => {}));
      if (canon(want.fonts) !== canon(r.served?.fonts ?? null)) {
        // An uploaded font goes beside the Preserve first (shared files never change, so it is written once).
        const have = new Set(await store.list(`copies/${r.id}/a/`));
        for (const f of new Set((want.fonts || []).filter((x) => x.studioFont && !have.has(`copies/${r.id}/a/${x.src}`)).map((x) => x.studioFont))) {
          const [row] = await sql(`select asset, encode(web, 'base64') as b64 from studio_font where id = ${lit(f)}`);
          if (row?.b64) await store.put(`copies/${r.id}/a/${row.asset}`, Buffer.from(row.b64, 'base64'), 'font/woff2');
        }
        await (want.fonts ? store.kvPut(`fonts:${r.id}`, want.fonts.map(({ studioFont, ...x }) => x)) : store.kvDel(`fonts:${r.id}`).catch(() => {}));
      }
      if (needStill) {
        stills++;
        try {
          const tmp = path.join(os.tmpdir(), `still-${r.id}.webp`);
          if (layout.fmt === 2 && !layout.pages['']) throw new Error('no entry page');
          const review = status === 'review' ? `?review=${process.env.REVIEW_SECRET ? mintReviewToken(process.env.REVIEW_SECRET, r.id, 600) : 1}` : '';
          await promisify(execFile)('node', ['desktop-still.mjs', `${VIEW_BASE}/c/${r.id}/desktop${review}`, tmp], { cwd: HARNESS, timeout: 120e3, env: jobEnv() });
          await store.put(layout.fmt === 2 ? `copies/${r.id}/v${v}/p/${layout.pages['']}/desktop-still.webp` : `copies/${r.id}/v${v}/desktop-still.webp`, fs.readFileSync(tmp), 'image/webp');
          fs.rmSync(tmp, { force: true });
          want.still = stillKey;
        } catch (e) { log('still-failed', r.id, String(e.message).slice(0, 200)); }
        lastBusy = Date.now();  // making stills is work: don't count it as idle time and exit in the middle of a pass
      }
      await sql(`update copy set served = ${lit(JSON.stringify(want))}::jsonb where id = ${lit(r.id)}`);
      log('served', r.id, status, 'v' + want.v, r.name || '');
    }
    const gone = await sql(`select copy_id, studio_slug, names from copy_tombstone where cleared_at is null`);
    for (const t of gone) {
      await store.kvPut(`copy:${t.copy_id}`, { status: 'deleted' });
      for (const n of t.names || []) await store.kvDel(`name:${t.studio_slug}/${n}`).catch(() => {});
      // Deleting is permanent: the link is off (above) and the files go too. If this is cut off, the tombstone stays
      // uncleared and the next pass finishes the job.
      const removed = await deleteCopyFiles(store, t.copy_id);
      await sql(`update copy_tombstone set cleared_at = now() where copy_id = ${lit(t.copy_id)}`);
      log('deleted', t.copy_id, removed, 'files removed');
    }
  }

  // Font files people uploaded at review (schema-fonts.sql): check each is the font it replaces and make its web file.
  // A checked file is served from beside each Preserve that uses it (syncServing); a wrong one is turned down with why.
  async function checkStudioFonts() {
    for (const f of await sql(`select id, name, file_name, encode(data, 'base64') as b64 from studio_font where state = 'checking' order by created_at limit 5`)) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'font-'));
      try {
        const src = path.join(dir, 'upload' + path.extname(f.file_name).toLowerCase()), out = path.join(dir, 'web.woff2');
        fs.writeFileSync(src, Buffer.from(f.b64, 'base64'));
        const r = JSON.parse(execFileSync('python3', [path.join(HARNESS, 'check-font.py'), src, f.name, out], { timeout: 60e3 }).toString());
        if (r.ok) {
          const web = fs.readFileSync(out);
          const asset = 'uf-' + (await import('node:crypto')).createHash('sha1').update(web).digest('hex').slice(0, 12) + '.woff2';
          await sql(`update studio_font set state = 'ok', web = decode(${lit(web.toString('base64'))}, 'base64'), asset = ${lit(asset)}, problem = null where id = ${lit(f.id)}`);
        } else await sql(`update studio_font set state = 'rejected', problem = ${lit(r.problem)} where id = ${lit(f.id)}`);
        log('font checked', f.name, f.file_name, r.ok ? 'ok' : 'rejected');
      } catch (e) {
        log('font check failed', f.file_name, e.message);
        await sql(`update studio_font set state = 'rejected', problem = ${lit('We couldn’t read that file. Upload a .woff2, .woff, .otf or .ttf file.')} where id = ${lit(f.id)}`).catch(() => {});
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }

  function stopChild(ctl) {
    try { process.kill(-ctl.child.pid, 'SIGKILL'); } catch {}
  }

  // One slot: claim a job, run it, repeat. A job that fails on our side (storage, database, a crash) goes back in the
  // queue; the claim counts tries, and the third failure is reported to the person with the real cause kept for triage.
  async function slot() {
    while (!stopping) {
      let j;
      try { [j] = await sql(`select * from claim_copy_job(${lit(WORKER)}, ${LEASE})`); } catch (e) { log('claim failed', e.message); }
      if (!j) {
        if (once) return;
        if (IDLE_EXIT && !running.size && Date.now() - lastBusy > IDLE_EXIT * 1000) { stopping = true; log('idle, exiting'); return; }
        await new Promise((s) => setTimeout(s, 4000)); continue;
      }
      running.set(j.id, {}); lastBusy = Date.now();
      try { await runJob(j); } catch (e) {
        if (e.quiet) { if (!stopping) log('job dropped', j.copy_id, e.message); }
        else {
          log('runner error', j.copy_id, e.message);
          const msg = lit(String(e.message).slice(0, 1000));
          await (j.tries < 3
            ? sql(`update copy_job set state = 'queued', step = null, worker_id = null, lease_until = null, internal_error = ${msg} where id = ${lit(j.id)} and worker_id = ${lit(WORKER)}`)
            : sql(`update copy_job set state = 'failed', step = null, finished_at = now(), worker_id = null, lease_until = null, error = ${lit('Something went wrong on our side while making this copy. We’ve logged it and will try again.')}, internal_error = ${msg} where id = ${lit(j.id)};
                update copy set status = case when exists (select 1 from copy_version where copy_id = ${lit(j.copy_id)}) then 'review' else 'failed' end, updated_at = now() where id = ${lit(j.copy_id)};`)).catch(() => {});
        }
      } finally { running.delete(j.id); lastBusy = Date.now(); }
      if (once) return;
    }
  }

  // Visitors' view: copies whose records changed (serving_outbox, filled by triggers) every few seconds, plus a full
  // pass every hour as a safety net. Capture retention every 15 minutes.
  // With several hosted runners, only the first does the upkeep; the host tells the others (lead=0 on /health, right
  // as they start), so each waits a moment to hear before beginning.
  let upkeepOff = false;
  async function upkeep() {
    let full = 0, swept = 0, adobeAt = 0;
    if (process.env.PORT && !once) await new Promise((s) => setTimeout(s, 5000));
    while (!stopping) {
      if (upkeepOff) { await new Promise((s) => setTimeout(s, 3000)); continue; }
      try {
        // The full pass reads every Preserve once, then can spend minutes making stills; anything queued after that read
        // (an accept, a rename) was not seen by it, so only entries queued before the pass started are cleared.
        if (Date.now() - full > 60 * 60e3) {
          full = Date.now();
          const [{ t }] = await sql(`select now()::text as t`);
          await syncServing();
          await sql(`delete from serving_outbox where queued_at < ${lit(t)}::timestamptz`);
        }
        await checkStudioFonts().catch((e) => log('font checks failed', e.message));
        const ids = (await sql(`delete from serving_outbox where copy_id in (select copy_id from serving_outbox order by queued_at limit 50 for update skip locked) returning copy_id`)).map((r) => r.copy_id);
        if (ids.length) lastBusy = Date.now();
        await syncServing(ids);
        if (Date.now() - swept > 15 * 60e3) { swept = Date.now(); await sweepCaptures().catch((e) => log('capture sweep failed', e.message)); }
        if (Date.now() - adobeAt > 60e3) { adobeAt = Date.now(); await adobeUpkeep().catch((e) => log('adobe upkeep failed', e.message)); }
      } catch (e) { log('upkeep error', e.message); }
      if (once) return;
      await new Promise((s) => setTimeout(s, 3000));
    }
  }

  // Shutting down (a deploy, a scale-down): stop the jobs and hand them straight back to the queue.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log('stopping;', running.size, 'job(s) back to the queue');
    for (const [id, ctl] of running) { if (ctl.child) stopChild(ctl); await sql(`select release_copy_job(${lit(id)}, ${lit(WORKER)})`).catch((e) => log('release failed', e.message)); }
    process.exit(0);
  });

  // Hosted (PORT set): a small status page the host polls to decide whether this runner may be put to sleep.
  if (process.env.PORT) {
    const http = await import('node:http');
    http.createServer((req, res) => {
      if (/[?&]lead=0\b/.test(req.url || '')) { if (!upkeepOff) log('upkeep left to the first runner'); upkeepOff = true; }
      else if (/[?&]lead=1\b/.test(req.url || '')) upkeepOff = false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ worker: WORKER, pipeline: PIPELINE, jobs: running.size, upkeep: !upkeepOff, idleSeconds: running.size ? 0 : Math.round((Date.now() - lastBusy) / 1000), stopping, db }));
    }).listen(+process.env.PORT);
  }

  log('runner', WORKER, 'slots', SLOTS, 'pipeline', PIPELINE);
  await Promise.all([upkeep(), ...Array.from({ length: SLOTS }, slot)]);
  if (once) await syncServing();
}
