// Starts and stops the copy runner container. v1 sleeps when idle to keep costs down (Jeremy, 2026-10-18):
//   - POST /wake (from the database when a copy job is queued or something visitors see changes) starts it at once;
//   - a once-a-minute check starts it if queued jobs or serving changes are waiting (in case a wake was missed);
//   - when more jobs are waiting than one runner takes at a time, the minute check starts more runners (scale.js), up to
//     RUNNERS_MAX; each goes back to sleep by itself when the queue is empty;
//   - GET /adobe-check?copy=<id> (from the app right after "Create Preserve") says whether the page loads Adobe fonts,
//     so the app can offer the Adobe Fonts connection at once (adobe-sniff.js);
//   - GET /page-check?url=<address> (from the app on "Create Preserve", signed in) says at once whether the address
//     will work: the page is there, public and on Squarespace (page-check.js);
//   - when it has been quiet for sleepAfter, the container is asked whether it's still busy (its /health page) and is
//     stopped only if it isn't. On stop (SIGTERM) the runner hands any running job back to the queue.
import { Container } from '@cloudflare/containers';
import postgres from 'postgres';
import { WINDOW_MIN, readState, alertFor, alertsOn, sendAlert } from './alerts.js';
import { runnersMax, runnersNeeded } from './scale.js';
import { adobeCheck } from './adobe-sniff.js';
import { pageCheck, supabaseSignedIn } from './page-check.js';

export class Runner extends Container {
  defaultPort = 8080;
  sleepAfter = '3m';
  enableInternet = true;  // it copies live websites and talks to the database and storage

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = { DATABASE_URL: env.DATABASE_URL, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN };
    // AI for refinements (harness/ai-pins.mjs): off until both are set; PRESERVE_AI=on is the switch.
    if (env.ANTHROPIC_API_KEY && env.PRESERVE_AI) Object.assign(this.envVars, { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, PRESERVE_AI: env.PRESERVE_AI });
  }

  async onActivityExpired() {
    let h = null;
    try { h = await (await this.containerFetch('http://runner/health')).json(); } catch {}
    if (h && (h.jobs > 0 || h.idleSeconds < 120)) { await this.renewActivityTimeout(); return; }
    await this.stop('SIGTERM');
  }
}

// Runner 1 is the first to start and the one that also keeps what visitors see in step (the runner's upkeep); the
// others are told to make Preserves only (lead=0), so that work is never done twice.
const runner = (env, n) => env.RUNNER.getByName(`runner-${n}`);
const wakeOne = async (env, n) => (await runner(env, n).fetch(new Request(`http://runner/health?lead=${n === 1 ? 1 : 0}`))).json();
// Starts runners 1..count. The first one's answer (or error) is what callers report; the others are best effort.
async function wake(env, count = 1) {
  const all = await Promise.allSettled(Array.from({ length: count }, (_, i) => wakeOne(env, i + 1)));
  all.slice(1).forEach((r, i) => { if (r.status === 'rejected') console.error(`runner-${i + 2} did not start:`, r.reason?.message || r.reason); });
  if (all[0].status === 'rejected') throw all[0].reason;
  return all[0].value;
}

async function workWaiting(env) {
  const db = postgres(env.DATABASE_URL, { max: 1, prepare: false });
  try {
    // jobs: waiting to be made (queued, or dropped by a runner that stopped). busy: being made right now.
    const [r] = await db`select (select count(*)::int from copy_job where state = 'queued' or (state = 'working' and lease_until < now())) as jobs,
      (select count(*)::int from copy_job where state = 'working' and lease_until >= now()) as busy,
      exists (select 1 from serving_outbox) or exists (select 1 from copy_tombstone where cleared_at is null) as serving`;
    return { ...r, count: runnersNeeded(r, runnersMax(env)) };
  } finally { await db.end(); }
}

async function checkAndAlert(env, waiting, dbError, count = 1) {
  if (dbError) return sendAlert(env, { subject: 'Preserve alert: database not reachable', text: `The runner host could not read the queue: ${String(dbError).slice(0, 300)}\n` });
  let wakeError = null;
  if (waiting) { try { await wake(env, count); } catch (e) { wakeError = e.message || String(e); } }
  const db = postgres(env.DATABASE_URL, { max: 1, prepare: false });
  let state;
  try { state = await readState(db); } finally { await db.end(); }
  const alert = alertFor(state, wakeError);
  if (alert) { console.log('alert:', alert.subject); await sendAlert(env, alert); }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/wake' && req.method === 'POST') {
      if (!env.WAKE_SECRET || req.headers.get('authorization') !== `Bearer ${env.WAKE_SECRET}`) return new Response(null, { status: 401 });
      return Response.json(await wake(env));
    }
    // Stops runner 1 so the next wake starts a fresh one on the deployed image (a stuck runner that keeps being woken
    // never goes idle, so it would otherwise never be replaced). Running jobs go back to the queue (SIGTERM).
    if (url.pathname === '/restart' && req.method === 'POST') {
      if (!env.WAKE_SECRET || req.headers.get('authorization') !== `Bearer ${env.WAKE_SECRET}`) return new Response(null, { status: 401 });
      await runner(env, 1).stop('SIGTERM');
      return Response.json({ stopped: 'runner-1' });
    }
    if (url.pathname === '/adobe-check' && (req.method === 'GET' || req.method === 'OPTIONS')) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
      return adobeCheck(req, { lookup: async (id) => {
        const db = postgres(env.DATABASE_URL, { max: 1, prepare: false });
        try { const [r] = await db`select source_url from copy where id = ${id} and created_at > now() - interval '15 minutes'`; return r?.source_url || null; }
        finally { await db.end(); }
      } });
    }
    if (url.pathname === '/page-check' && (req.method === 'GET' || req.method === 'OPTIONS')) {
      // A site we don't cover yet goes on the list (schema-unsupported.sql), once per person and site.
      const record = async (personId, page, seen) => {
        const db = postgres(env.DATABASE_URL, { max: 1, prepare: false });
        try {
          await db`insert into unsupported_site (person_id, studio_id, url, host, seen, source)
            values (${personId}, (select studio_id from studio_member where person_id = ${personId} limit 1), ${page}, ${new URL(page).hostname.replace(/^www\./, '')}, ${seen}, 'start')
            on conflict (person_id, host) do nothing`;
        } finally { await db.end(); }
      };
      return pageCheck(req, { signedIn: supabaseSignedIn(env), record });
    }
    return new Response(null, { status: 404 });
  },
  async scheduled(event, env, ctx) {
    // If the database can't be reached, the alert check below says so (when alerts are on).
    let waiting = false, dbError = null, count = 1;
    try { const w = await workWaiting(env); waiting = w.jobs > 0 || w.serving; count = w.count; if (count > 1) console.log(`runners wanted: ${count} (waiting ${w.jobs}, being made ${w.busy})`); } catch (e) { dbError = e.message || String(e); console.error('queue check failed:', dbError); }
    // Every 15 minutes: tell the team about failed jobs, a backed-up queue or a runner that won't start (alerts.js).
    if (alertsOn(env) && new Date(event.scheduledTime).getUTCMinutes() % WINDOW_MIN === 0) {
      ctx.waitUntil(checkAndAlert(env, waiting, dbError, count).catch((e) => console.error('alert check failed:', e.message)));
    } else if (waiting) ctx.waitUntil(wake(env, count).catch((e) => console.error('wake failed:', e.message)));
  },
};
