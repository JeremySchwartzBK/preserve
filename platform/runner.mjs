// Copy runner: takes queued copy jobs from the database, runs the copy job (harness/make-copy.mjs), uploads the result
// to R2 as a new version, and records it for review. It keeps the original capture of each page (capture-store.mjs)
// while the copy is being built or refined, and deletes it when the retention rules say so (sweepCaptures). It also keeps the edge lookup (KV) in step with the database, so
// approving, renaming, archiving or deleting in the app reaches visitors within a few seconds.
//
// Usage: node runner.mjs [--once]
// Env: SUPABASE_PROJECT (ref), HARNESS (default ../harness in this checkout), RUN_DIR (default /root/runs).
// Database access goes through the Supabase management API with the access token (injected by the proxy here); a
// production runner would use a direct database connection instead.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { cloudflareStore, uploadPages, setCopy, setNames } from './worker/copy-store.mjs';
import { storeCapture, deleteCapture, capturePrefix } from './capture-store.mjs';

if (!process.env.NODE_USE_ENV_PROXY) {
  const r = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  r.on('close', (c) => process.exit(c));
} else {
  await main();
}

async function main() {
  const REF = process.env.SUPABASE_PROJECT || 'uzgprpbhhrctklzumikn';
  const HARNESS = process.env.HARNESS || new URL('../harness', import.meta.url).pathname;
  const RUN = process.env.RUN_DIR || '/root/runs';
  const once = process.argv.includes('--once');
  const store = cloudflareStore({ account: '1dcf2dbf05caa4963ed872ff035bc9db', bucket: 'preserve-copies', kvNamespace: 'c67307a470e44d529efa87933c42942f' });
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  // The code that makes each version is recorded with it, so a copy can be traced to the commit that built it.
  const git = (...a) => { try { return execFileSync('git', ['-C', HARNESS, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const PIPELINE = (git('rev-parse', '--short=12', 'HEAD') || 'unknown') + (git('status', '--porcelain', '--untracked-files=no') ? '+dirty' : '');

  const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
  async function sql(query) {
    for (let i = 0; ; i++) {
      const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer injected-by-proxy' }, body: JSON.stringify({ query }) });
      if (r.ok) return r.json();
      const t = await r.text();
      if (i < 3 && (r.status === 429 || r.status >= 500)) { await new Promise((s) => setTimeout(s, 2000 * (i + 1))); continue; }
      throw new Error(`database ${r.status}: ${t.slice(0, 300)}`);
    }
  }

  // What the review screen says for each thing the quality check can find.
  const PLAIN = {
    'blocks-stay-invisible': 'Some parts of the page stay hidden that show on the live site.',
    'broken-images': 'Some images didn’t load.',
    'dropdown-broken': 'A dropdown menu doesn’t open.',
    'first-screen-differs': 'The first screen looks noticeably different from the live site.',
    'gallery-does-not-advance': 'A slideshow or carousel doesn’t move.',
    'outside-requests': 'The copy still reaches out to other websites.',
    'overlay-left': 'A popup or banner may still cover part of the page.',
    'page-differs': 'Parts of the page look different from the live site.',
    'page-length-differs': 'The page is a different length from the live site, so something may be missing or extra.',
    'phone-menu-broken': 'The phone menu doesn’t open.',
    'replica-notice-missing': 'Shopping or form buttons don’t show the “this is a preview” note.',
    'squarespace-addresses-left': 'Some parts still load from Squarespace.',
    'unhandled-address': 'There may be contact details we couldn’t replace.',
    'no-reference': 'We couldn’t compare it with the live site.',
  };
  const FAILED = {
    'not-squarespace': 'This page isn’t on Squarespace. For now we can only copy Squarespace sites.',
    'page-unreachable': 'We couldn’t open this page. Check the address and that the site is public.',
    'password-protected': 'This page is password protected, so we couldn’t copy it.',
  };
  const GENERIC = 'This site contains elements our system can’t process yet. We’ve logged the gap and will be in touch when we can handle this site.';
  const STEP = { 'check-url': 'check-url', 'capture-and-build': 'capture-and-build', export: 'export', 'subset-fonts': 'fonts', scrub: 'scrub', 'quality-check': 'quality-check' };

  async function notify(copyId, kind, body) {
    await sql(`insert into notification (person_id, kind, copy_id, body) select sm.person_id, ${lit(kind)}, c.id, ${lit(body)} from copy c join studio_member sm on sm.studio_id = c.studio_id where c.id = ${lit(copyId)}`);
  }

  async function runJob(j) {
    log('job', j.copy_id, 'attempt', j.attempt, j.url);
    const work = path.join(RUN, 'work'), out = path.join(RUN, 'ready');
    fs.mkdirSync(work, { recursive: true });
    if (j.user_context) fs.writeFileSync(path.join(work, `${j.copy_id}.user-notes.json`), JSON.stringify(j.user_context, null, 1));
    const jobFile = path.join(work, j.copy_id, 'job.json');
    fs.rmSync(jobFile, { force: true });
    let lastStep = null;
    const watch = setInterval(async () => {
      try {
        const st = JSON.parse(fs.readFileSync(jobFile, 'utf8')).step;
        if (st && st !== lastStep) { lastStep = st; await sql(`update copy_job set step = ${lit(STEP[st] || st)} where id = ${lit(j.id)}`); }
      } catch {}
    }, 3000);
    const code = await new Promise((res) => {
      const p = spawn('node', ['make-copy.mjs', j.url, '--id', j.copy_id, '--work', work, '--out', out], { cwd: HARNESS, stdio: ['ignore', 'pipe', 'pipe'] });
      const jl = fs.createWriteStream(path.join(work, `${j.copy_id}.a${j.attempt}.log`), { flags: 'a' });
      p.stdout.on('data', (d) => { process.stdout.write(d); jl.write(d); }); p.stderr.on('data', (d) => { process.stderr.write(d); jl.write(d); });
      p.on('exit', res);  // not 'close': a leftover browser holding the output pipe must not stall the runner
    });
    clearInterval(watch);
    let job;
    try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch { job = { state: 'failed', verdict: { result: 'fail', reasons: [{ code: 'job-error', detail: `make-copy exited ${code} without a job file` }] } }; }
    const v = job.verdict || { result: 'fail', reasons: [] };

    if (job.state === 'failed') {
      const r0 = (v.reasons || [])[0] || {};
      const msg = FAILED[r0.code] || GENERIC;
      await sql(`update copy_job set state = 'failed', step = null, finished_at = now(), verdict = ${lit(JSON.stringify(v))}::jsonb, error = ${lit(msg)}, internal_error = ${lit(((v.reasons || []).map((r) => `${r.code}: ${r.detail || ''}`).join('; ') + ' | steps: ' + JSON.stringify(job.steps || [])).slice(0, 1000))} where id = ${lit(j.id)};
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
    const findings = (v.reasons || []).map((r) => ({ code: r.code, text: PLAIN[r.code] || 'Something looks different from the live site.', pinned: !!r.spots?.length }))
      .filter((f, i, a) => a.findIndex((x) => x.text === f.text) === i);
    // Findings the check could place on the page become pins the person can mark (schema-findings.sql); the rest stay
    // a list. They replace the previous version's findings.
    // Lettered top to bottom within each layout (the app lists one layout at a time).
    const findingPins = (v.reasons || []).flatMap((r) => (r.spots || []).map((p) => ({ ...p, code: r.code, text: PLAIN[r.code] || 'Something looks different from the live site.' })))
      .sort((a, b) => (a.layout || '').localeCompare(b.layout || '') || (a.pageY ?? 0) - (b.pageY ?? 0));
    const notes = (v.notes || []).map((n) => ({ limitation: n.limitation, text: n.text }));
    const pages = [{ page_id: j.page_id, path: '', verdict: v.result, findings: findings.length, files: up.files }];
    await sql(`insert into copy_version (copy_id, version, job_id, verdict, findings, notes, file_count, bytes, pages, pipeline_version, storage_format)
        values (${lit(j.copy_id)}, ${next}, ${lit(j.id)}, ${lit(v.result)}, ${lit(JSON.stringify(findings))}::jsonb, ${lit(JSON.stringify(notes))}::jsonb, ${up.files}, ${up.bytes}, ${lit(JSON.stringify(pages))}::jsonb, ${lit(PIPELINE)}, 2);
      update copy_job set state = ${lit(job.state)}, step = null, finished_at = now(), version = ${next}, verdict = ${lit(JSON.stringify(v))}::jsonb where id = ${lit(j.id)};
      update copy set status = 'review', title = coalesce(title, ${lit(title)}), updated_at = now() where id = ${lit(j.copy_id)};
      update copy_page set title = coalesce(title, ${lit(title)}) where copy_id = ${lit(j.copy_id)} and page_id = ${lit(j.page_id)};
      update copy_pin set resolved_at = now() where copy_id = ${lit(j.copy_id)} and kind = 'finding' and resolved_at is null;
      ${findingPins.map((p, i) => `insert into copy_pin (copy_id, page_id, kind, block_id, x, y, layout, body, meta, version, sort)
        values (${lit(j.copy_id)}, ${lit(j.page_id)}, 'finding', ${lit(p.blockId)}, ${+p.x || 0}, ${+p.y || 0}, ${lit(p.layout)}, ${lit(p.text)}, ${lit(JSON.stringify({ code: p.code, pageY: p.pageY ?? null }))}::jsonb, ${next}, ${i});`).join('\n')}`);
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
  async function syncServing() {
    const rows = await sql(`select c.id, c.status, c.live_version, c.served, s.slug,
        (select max(version) from copy_version v where v.copy_id = c.id) as latest,
        (select jsonb_object_agg(version, jsonb_build_object('fmt', storage_format, 'pages', pages)) from copy_version v where v.copy_id = c.id) as stored,
        (select name from copy_name n where n.copy_id = c.id and n.is_current) as name,
        coalesce((select array_agg(name) from copy_name n where n.copy_id = c.id and not n.is_current), '{}') as old,
        coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'page', p.page_id, 'block', p.block_id, 'x', p.x, 'y', p.y, 'title', coalesce(p.meta->>'title', ''), 'body', p.body) order by p.sort, p.created_at)
          from copy_pin p where p.copy_id = c.id and p.kind = 'tour' and p.block_id is not null), '[]') as spots,
        coalesce((select jsonb_agg(jsonb_build_object('role', coalesce(p.meta->>'role', ''), 'name', p.body, 'url', p.meta->>'url') order by p.sort, p.created_at)
          from copy_pin p where p.copy_id = c.id and p.kind = 'credit'), '[]') as credits
      from copy c join studio s on s.id = c.studio_id`);
    for (const r of rows) {
      if (!r.latest) continue;
      const status = r.status === 'ready' ? 'live' : ['paused', 'archived'].includes(r.status) && r.live_version ? 'paused' : 'review';
      // Tour stops are pinned by block; the tour script finds the block by its id or Squarespace block id.
      const sel = (id) => (id.startsWith('el:') ? id.slice(3) : id.startsWith('section:') ? `section[data-section-id="${id.slice(8)}"]` : `[id="${id}"],[data-block-id="${id}"]`);
      const tour = { site: r.id, spots: r.spots.map((p) => ({ id: p.id, page: p.page, sel: sel(p.block), x: p.x, y: p.y, title: p.title, body: p.body })), credits: r.credits.map((c) => (c.url ? c : { role: c.role, name: c.name })) };
      const v = status === 'review' ? r.latest : r.live_version || r.latest;
      // A version in the page layout tells the viewer where its pages are.
      const sv = r.stored?.[v] || {};
      const layout = sv.fmt === 2 ? { fmt: 2, pages: Object.fromEntries((sv.pages || []).map((p) => [p.path, p.page_id])) } : {};
      const want = { v, status, studio: r.slug, name: r.name, old: r.old, ...layout, tour: tour.spots.length + tour.credits.length ? tour : null };
      const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((m, kk) => ((m[kk] = v[kk]), m), {}) : v));  // key order differs once stored as jsonb
      if (canon(want) === canon(r.served)) continue;
      await setCopy(store, { id: r.id, version: want.v, status, studio: r.slug, name: r.name, ...layout });
      if (r.live_version && r.name) await setNames(store, { studio: r.slug, id: r.id, current: r.name, old: r.old });
      if (canon(want.tour) !== canon(r.served?.tour ?? null)) await (want.tour ? store.kvPut(`tour:${r.id}`, want.tour) : store.kvDel(`tour:${r.id}`).catch(() => {}));
      await sql(`update copy set served = ${lit(JSON.stringify(want))}::jsonb where id = ${lit(r.id)}`);
      log('served', r.id, status, 'v' + want.v, r.name || '');
    }
    const gone = await sql(`select copy_id, studio_slug, names from copy_tombstone where cleared_at is null`);
    for (const t of gone) {
      await store.kvPut(`copy:${t.copy_id}`, { status: 'deleted' });
      for (const n of t.names || []) await store.kvDel(`name:${t.studio_slug}/${n}`).catch(() => {});
      await sql(`update copy_tombstone set cleared_at = now() where copy_id = ${lit(t.copy_id)}`);
      log('deleted', t.copy_id);
    }
  }

  // Only one runner runs at a time, so a job still marked working when it starts was cut off (stopped or restarted
  // mid-job): put it back in the queue.
  await sql(`update copy_job set state = 'queued', step = null, started_at = null where state = 'working'`).catch((e) => log('requeue failed', e.message));
  let swept = 0;
  for (;;) {
    try {
      await syncServing();
      if (Date.now() - swept > 15 * 60e3) { swept = Date.now(); await sweepCaptures().catch((e) => log('capture sweep failed', e.message)); }
      const [j] = await sql(`update copy_job set state = 'working', started_at = now(), step = 'check-url'
        where id = (select id from copy_job where state = 'queued' order by queued_at limit 1 for update skip locked)
        returning id, copy_id, attempt, url, user_context, tries, version,
          (select page_id from copy_page p where p.copy_id = copy_job.copy_id and p.path = '') as page_id`);
      if (j) { await runJob(j).catch(async (e) => {
        // Our own trouble (storage, database, a crash), not the site's: try the job again a couple of times before
        // telling anyone, and keep the real cause for triage.
        log('runner error', j.copy_id, e.message);
        const tries = (j.tries || 0) + 1;
        if (tries < 3) {
          await sql(`update copy_job set state = 'queued', step = null, tries = ${tries}, internal_error = ${lit(String(e.message).slice(0, 1000))} where id = ${lit(j.id)}`).catch(() => {});
          return;
        }
        await sql(`update copy_job set state = 'failed', step = null, finished_at = now(), tries = ${tries}, error = ${lit('Something went wrong on our side while making this copy. We’ve logged it and will try again.')}, internal_error = ${lit(String(e.message).slice(0, 1000))} where id = ${lit(j.id)};
          update copy set status = case when exists (select 1 from copy_version where copy_id = ${lit(j.copy_id)}) then 'review' else 'failed' end, updated_at = now() where id = ${lit(j.copy_id)};`).catch(() => {});
      }); await syncServing(); continue; }
    } catch (e) { log('loop error', e.message); }
    if (once) break;
    await new Promise((s) => setTimeout(s, 4000));
  }
}
