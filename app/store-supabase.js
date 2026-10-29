// Real data store: Supabase sign-in and database, with the same API as store-local.js so the screens don't change.
// Reads go straight to tables (row-level rules limit them to the person's studio); every change goes through a
// database function (schema-actions.sql), which enforces plan limits, refinement rounds, and who may approve.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { PLANS } from './store-local.js';
import { SUPABASE_URL, SUPABASE_KEY, VIEW } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce' } });
const STEP_NAMES = { 'check-url': 'Checking the address', 'capture-and-build': 'Opening the page on phone and desktop', export: 'Saving images, fonts and video', fonts: 'Building the fast copy', scrub: 'Removing trackers and contact details', 'quality-check': 'Comparing it with the live site' };
const STEP_KEYS = Object.keys(STEP_NAMES);
const ERRORS = { 'plan-limit': null, 'bad-url': 'That doesn’t look like a web address.', 'name-taken': 'That name is taken in your studio.', 'bad-name': 'Use letters and numbers.', 'no-new-notes': 'Flag at least one new issue first.', 'refine-cap': 'This Preserve has had all 20 refinement rounds.' };

let me = null, studio = null, copies = [], notes = [], ready = false, timer = null;
const listeners = new Set();
const emit = () => listeners.forEach((f) => f());
const say = (e) => { const m = e?.message || String(e); return ERRORS[m] ?? (m === 'plan-limit' ? `Your ${planOf().name} plan’s Live Preserves are all in use. Archive a Live Preserve or upgrade your plan first.` : m); };
// The plan's name and price come from the plan list; the copy allowance is whatever the database says (it can be raised per studio).
const planOf = () => { const p = PLANS.find((x) => x.id === studio?.plan) || (studio?.plan === 'unlimited' ? { id: 'unlimited', name: 'Unlimited', price: 0, blurb: 'Set by the Preserve team.' } : PLANS[0]); return { ...p, copies: studio?.copy_limit ?? p.copies }; };

async function refresh() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { me = null; studio = null; copies = []; ready = true; emit(); return; }
  const uid = session.user.id;
  const [{ data: person }, { data: st }, { data: cs }, { data: nt }] = await Promise.all([
    sb.from('person').select('*').eq('id', uid).maybeSingle(),
    sb.from('studio').select('*').limit(1).maybeSingle(),
    sb.from('copy').select('*, copy_name(name,is_current,created_at), copy_version(version,verdict,findings,notes,created_at), copy_job(attempt,state,step,error,queued_at), copy_pin(*)').order('created_at', { ascending: false }),
    sb.from('notification').select('*').order('created_at', { ascending: false }).limit(30),
  ]);
  me = person ? { email: person.email, name: person.name } : { email: session.user.email };
  studio = st;
  notes = (nt || []).map((n) => ({ at: n.created_at, copy: n.copy_id, text: n.body, read: !!n.read_at, id: n.id }));
  copies = (cs || []).map(shape);
  ready = true;
  emit();
  clearTimeout(timer);
  if (copies.some((c) => c.status === 'processing')) timer = setTimeout(refresh, 5000);
}

function shape(r) {
  const names = (r.copy_name || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const versions = (r.copy_version || []).sort((a, b) => a.version - b.version);
  const jobs = (r.copy_job || []).sort((a, b) => a.attempt - b.attempt);
  const job = jobs.at(-1);
  const last = versions.at(-1);
  const host = new URL(r.source_url).hostname.replace(/^www\./, '');
  return {
    id: r.id, url: r.source_url, title: r.title || host, status: r.status, created: r.created_at, live: r.live_version,
    name: names.find((n) => n.is_current)?.name || r.id, oldNames: names.filter((n) => !n.is_current).map((n) => n.name),
    versions: versions.map((v) => ({ v: v.version, at: v.created_at })),
    findings: r.status === 'review' ? (last?.findings || []).map((f) => (typeof f === 'string' ? { text: f } : f)) : [],
    notes: (last?.notes || []).map((f) => f.text || f),
    pins: (r.copy_pin || []).filter((p) => !p.resolved_at && (p.kind !== 'finding' || r.status === 'review')).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)).map((p) => ({ id: p.id, kind: p.kind, body: p.body, blockId: p.block_id, x: p.x, y: p.y, layout: p.layout, label: p.meta?.label, meta: p.meta || {}, at: p.created_at })),
    stepNames: Object.values(STEP_NAMES), step: Math.max(0, STEP_KEYS.indexOf(job?.step)),
    rounds: Math.max(0, jobs.length - 1), lastRoundAt: jobs.length ? jobs.map((j) => j.queued_at).sort().at(-1) : null,
    message: r.status === 'failed' ? (job?.error || null) : null,
  };
}

const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw error; await refresh(); return data; };
const act = (fn, args) => rpc(fn, args).catch((e) => alert(say(e)));

sb.auth.onAuthStateChange((ev) => { if (ev !== 'TOKEN_REFRESHED') refresh(); });

export const store = {
  real: true,
  view: VIEW,
  ready: () => ready,
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  reset() { refresh(); },
  me: () => me,
  // Sign-in: email link or Google. Both send the person back here; the first sign-in creates their studio.
  async signIn(email) { const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + '/' } }); return error ? say(error) : null; },
  async signInGoogle() { const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/' } }); return error ? say(error) : null; },
  async signOut() { await sb.auth.signOut(); },
  studio: () => studio,
  plan: planOf,
  setPlan() { alert('Plan changes go through Stripe checkout, which isn’t connected yet.'); },
  copies: () => copies,
  copy: (id) => copies.find((c) => c.id === id),
  liveCount: () => copies.filter((c) => ['ready', 'paused'].includes(c.status)).length,
  link: (c) => `${VIEW}/${studio.slug}/${c.name}/`,
  embed(c) {
    return `<div style="position:relative;width:100%;aspect-ratio:16/10;max-height:90vh">\n<iframe title="Interactive preview of ${c.title}" style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:10px" loading="eager" referrerpolicy="no-referrer"></iframe>\n<script>(function(f){f.src='${VIEW}/c/${c.id}/'+(f.parentNode.offsetWidth<768?'mobile':'desktop')})(document.currentScript.previousElementSibling)</script>\n</div>`;
  },
  rename(id, name) { return rpc('rename_copy', { cid: id, new_name: name }).then(() => null, say); },
  setStatus: (id, status) => rpc('set_copy_status', { cid: id, new_status: status }).then(() => null, say),
  remove: (id) => act('delete_copy', { cid: id }),
  notifications: () => notes,
  async markRead() { await sb.from('notification').update({ read_at: new Date().toISOString() }).is('read_at', null); refresh(); },
  async addPin(id, p) {
    const c = copies.find((x) => x.id === id);
    const { error } = await sb.from('copy_pin').insert({ copy_id: id, kind: p.kind, body: p.body, block_id: p.blockId ?? null, x: p.x ?? null, y: p.y ?? null, layout: p.kind === 'issue' ? p.layout : null, version: c?.versions.at(-1)?.v, meta: { ...(p.meta || {}), label: p.label }, created_by: (await sb.auth.getUser()).data.user?.id });
    if (error) alert(say(error)); await refresh();
  },
  // f.blockId/x/y move a pin (a tour stop moved to a new spot).
  async updatePin(id, pid, f) {
    const row = { body: f.body, meta: f.meta, ...(f.blockId ? { block_id: f.blockId, x: f.x, y: f.y } : {}) };
    const { error } = await sb.from('copy_pin').update(row).eq('id', pid); if (error) alert(say(error)); await refresh();
  },
  async removePin(id, pid) { await sb.from('copy_pin').delete().eq('id', pid); await refresh(); },
  approve: (id) => act('approve_copy', { cid: id, ver: copies.find((c) => c.id === id).versions.at(-1).v }),
  async create(url) {
    let u; try { u = new URL(/^https?:/.test(url) ? url : 'https://' + url); } catch { return { error: 'That doesn’t look like a web address.' }; }
    try { return { id: await rpc('request_copy', { page_url: u.href }) }; } catch (e) { return { error: say(e) }; }
  },
  refine: (id) => act('refine_copy', { cid: id }),
  MAX_ROUNDS: 20,
};
refresh();
