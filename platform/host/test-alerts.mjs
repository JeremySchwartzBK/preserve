// Alerts say something only when something is wrong, and say what. Run: node test-alerts.mjs
import assert from 'node:assert/strict';
import { alertFor, alertsOn, sendAlert, QUEUE_MAX_MIN } from './src/alerts.js';

const calm = { failed: [], queued: 0, oldest_min: 0, working: 0 };
assert.equal(alertFor(calm), null, 'nothing wrong, nothing sent');
assert.equal(alertFor({ ...calm, queued: 4, oldest_min: QUEUE_MAX_MIN, working: 2 }), null, 'a short wait is normal');

const f = alertFor({ ...calm, failed: [{ copy: 'k7f2qx9m', url: 'https://example.com/', attempt: 1, why: 'job-error: own-css.mjs timed out', log: 'logs/k7f2qx9m/a1-t1.log' }] });
assert.match(f.subject, /failed jobs/);
assert.match(f.text, /1 copy job failed/);
assert.match(f.text, /k7f2qx9m.*https:\/\/example\.com\//);
assert.match(f.text, /timed out/);
assert.match(f.text, /logs\/k7f2qx9m\/a1-t1\.log/);

const q = alertFor({ ...calm, queued: 30, oldest_min: 95, working: 2 });
assert.match(q.subject, /queue backing up/);
assert.match(q.text, /30 jobs waiting, the oldest for 95 minutes; 2 being made now/);

const w = alertFor(calm, 'container failed to start');
assert.match(w.subject, /runner not starting/);
assert.match(w.text, /container failed to start/);

const all = alertFor({ failed: [{ copy: 'a', url: 'u', attempt: 2, why: '' }], queued: 9, oldest_min: 40, working: 0 }, 'boom');
assert.match(all.subject, /failed jobs, queue backing up, runner not starting/);
assert.match(all.text, /no cause recorded/);

assert.equal(alertsOn({}), false);
assert.equal(alertsOn({ RESEND_API_KEY: 'k', ALERT_TO: 'a@example.com' }), false, 'all three settings or none');
assert.equal(alertsOn({ RESEND_API_KEY: 'k', ALERT_TO: 'a@example.com', ALERT_FROM: 'b@example.com' }), true);

let sent;
await sendAlert({ RESEND_API_KEY: 'k', ALERT_TO: 'a@example.com, c@example.com', ALERT_FROM: 'Preserve <alerts@example.com>' }, f,
  async (url, init) => { sent = { url, init }; return { ok: true }; });
assert.equal(sent.url, 'https://api.resend.com/emails');
assert.equal(sent.init.headers.authorization, 'Bearer k');
assert.deepEqual(JSON.parse(sent.init.body).to, ['a@example.com', 'c@example.com']);
await assert.rejects(sendAlert({ RESEND_API_KEY: 'k', ALERT_TO: 'a@example.com', ALERT_FROM: 'b@example.com' }, f, async () => ({ ok: false, status: 403, text: async () => 'nope' })), /403 nope/);
console.log('alerts: all checks pass');
