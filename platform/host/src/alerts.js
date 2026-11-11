// Alerts for the team (Jeremy, 2026-11-11: by email). Every 15 minutes the host looks for three things nobody would
// otherwise notice: a copy job that failed on our side, a queue that is backing up, and a runner that won't start.
// One email covers whatever it finds; nothing found, nothing sent. Off until the secrets RESEND_API_KEY, ALERT_TO and
// ALERT_FROM are set on the host (the mail service needs a sending domain first).

// Failures that are the page's doing, not ours: the person is told why in the app, and there is nothing for us to fix.
export const NOT_OURS = ['not-squarespace', 'page-unreachable', 'password-protected'];
export const WINDOW_MIN = 15;      // how often the check runs, and how far back it looks for failures
export const QUEUE_MAX_MIN = 15;   // a job waiting longer than this means the queue is backing up

// One read-only query. The numbers and names in it are the constants above, never anything a person typed.
export const STATE_SQL = `select
  (select coalesce(jsonb_agg(jsonb_build_object('copy', copy_id, 'url', url, 'attempt', attempt,
      'why', left(coalesce(internal_error, error, ''), 300), 'log', verdict->>'log') order by finished_at), '[]'::jsonb)
    from copy_job where state = 'failed' and finished_at > now() - interval '${WINDOW_MIN} minutes'
      and coalesce(verdict->'reasons'->0->>'code', '') not in (${NOT_OURS.map((c) => `'${c}'`).join(', ')})) as failed,
  (select count(*)::int from copy_job where state = 'queued') as queued,
  (select coalesce(extract(epoch from now() - min(queued_at)) / 60, 0)::int from copy_job where state = 'queued') as oldest_min,
  (select count(*)::int from copy_job where state = 'working' and lease_until >= now()) as working`;
export const readState = async (db) => (await db.unsafe(STATE_SQL))[0];

// What to say, or null when all is well. state: readState's row; wakeError: why the runner didn't answer, if it didn't.
export function alertFor(state, wakeError = null) {
  const parts = [];
  const failed = state.failed || [];
  if (failed.length) {
    parts.push(`${failed.length} copy job${failed.length === 1 ? '' : 's'} failed on our side in the last ${WINDOW_MIN} minutes:\n` +
      failed.map((f) => `- ${f.copy} (round ${f.attempt}) ${f.url}\n  ${f.why || 'no cause recorded'}${f.log ? `\n  log: ${f.log}` : ''}`).join('\n'));
  }
  if (state.oldest_min > QUEUE_MAX_MIN) {
    parts.push(`The queue is backing up: ${state.queued} job${state.queued === 1 ? '' : 's'} waiting, the oldest for ${state.oldest_min} minutes; ${state.working} being made now.`);
  }
  if (wakeError) parts.push(`The runner did not start when asked: ${String(wakeError).slice(0, 300)}`);
  if (!parts.length) return null;
  const what = [failed.length && 'failed jobs', state.oldest_min > QUEUE_MAX_MIN && 'queue backing up', wakeError && 'runner not starting'].filter(Boolean).join(', ');
  return { subject: `Preserve alert: ${what}`, text: parts.join('\n\n') + '\n' };
}

export const alertsOn = (env) => !!(env.RESEND_API_KEY && env.ALERT_TO && env.ALERT_FROM);

export async function sendAlert(env, { subject, text }, fetcher = fetch) {
  const r = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.ALERT_FROM, to: String(env.ALERT_TO).split(',').map((x) => x.trim()).filter(Boolean), subject, text }),
  });
  if (!r.ok) throw new Error(`alert email not sent: ${r.status} ${(await r.text()).slice(0, 200)}`);
}
