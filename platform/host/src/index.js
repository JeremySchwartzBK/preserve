// Starts and stops the copy runner container. v1 sleeps when idle to keep costs down (Jeremy, 2026-10-18):
//   - POST /wake (from the database when a copy job is queued or something visitors see changes) starts it at once;
//   - a once-a-minute check starts it if queued jobs or serving changes are waiting (in case a wake was missed);
//   - when it has been quiet for sleepAfter, the container is asked whether it's still busy (its /health page) and is
//     stopped only if it isn't. On stop (SIGTERM) the runner hands any running job back to the queue.
import { Container } from '@cloudflare/containers';
import postgres from 'postgres';
import { WINDOW_MIN, readState, alertFor, alertsOn, sendAlert } from './alerts.js';

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

const runner = (env) => env.RUNNER.getByName('runner-1');
const wake = async (env) => (await runner(env).fetch(new Request('http://runner/health'))).json();

async function workWaiting(env) {
  const db = postgres(env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const [r] = await db`select exists (select 1 from copy_job where state = 'queued' or (state = 'working' and lease_until < now())) as jobs,
      exists (select 1 from serving_outbox) or exists (select 1 from copy_tombstone where cleared_at is null) as serving`;
    return r.jobs || r.serving;
  } finally { await db.end(); }
}

async function checkAndAlert(env, waiting, dbError) {
  if (dbError) return sendAlert(env, { subject: 'Preserve alert: database not reachable', text: `The runner host could not read the queue: ${String(dbError).slice(0, 300)}\n` });
  let wakeError = null;
  if (waiting) { try { await wake(env); } catch (e) { wakeError = e.message || String(e); } }
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
    return new Response(null, { status: 404 });
  },
  async scheduled(event, env, ctx) {
    // If the database can't be reached, the alert check below says so (when alerts are on).
    let waiting = false, dbError = null;
    try { waiting = await workWaiting(env); } catch (e) { dbError = e.message || String(e); console.error('queue check failed:', dbError); }
    // Every 15 minutes: tell the team about failed jobs, a backed-up queue or a runner that won't start (alerts.js).
    if (alertsOn(env) && new Date(event.scheduledTime).getUTCMinutes() % WINDOW_MIN === 0) {
      ctx.waitUntil(checkAndAlert(env, waiting, dbError).catch((e) => console.error('alert check failed:', e.message)));
    } else if (waiting) ctx.waitUntil(wake(env));
  },
};
