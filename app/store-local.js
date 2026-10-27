// Demo data store: keeps everything in this browser (localStorage) so the screens can be clicked through before the
// real database is connected. Same shape as platform/schema.sql; store-supabase.js will replace it with no screen changes.
// New copies are simulated here: the real copy job runs on a server, which this demo doesn't have.
const KEY = 'preserve-demo-v4';
const VIEW = 'https://preserve-view.pages.dev';
const now = () => new Date().toISOString();
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();

const SEED_COPIES = [
  { id: 'q9398e5j', name: 'minaab', title: 'Minaa B.', url: 'https://www.minaab.com/', status: 'ready', created: ago(6), notes: [] },
  { id: 'znf7w3k9', name: 'breathpod', title: 'Breathpod', url: 'https://www.breathpod.com/', status: 'ready', created: ago(5), notes: [] },
  { id: '2h59u7sb', name: 'designforward', title: 'Design Forward', url: 'https://www.designforward.live/', status: 'ready', created: ago(4), notes: [] },
  { id: 'b4vhrecu', name: 'xanadu', title: 'Xanadu Roller Arts', url: 'https://www.xanadu.nyc/', status: 'ready', created: ago(3), notes: ['Embedded widgets (such as signup forms) are shown as pictures.'] },
  { id: '9x2arj4e', name: 'kosa', title: 'Kosa Artist Residency', url: 'https://hello-world-kosa.squarespace.com/', status: 'review', created: ago(0.1), notes: ['Videos play muted and on a loop.'],
    findings: [{ text: 'A slideshow or carousel doesn’t move.', pinned: true }, { text: 'The first screen looks noticeably different from the live site.', pinned: true }] },
];
// Where the quality check saw each problem on the kosa copy (from a real run, 2026-10-16), shown as lettered pins.
const f = (code, body, layout, blockId, x, y) => ({ kind: 'finding', code, body, layout, blockId, x, y, meta: { code } });
const SEED_FINDINGS = { '9x2arj4e': [
  f('gallery-does-not-advance', 'A slideshow or carousel doesn’t move.', 'desktop', 'block-yui_3_17_2_1_1784704282143_21527', 0.994, 0.02),
  f('first-screen-differs', 'The first screen looks noticeably different from the live site.', 'desktop', 'el:body', 0.506, 0.067),
  f('first-screen-differs', 'The first screen looks noticeably different from the live site.', 'mobile', 'el:body', 0.467, 0.047),
] };
export const PLANS = [
  { id: 'free', name: 'Starter', price: 0, copies: 1, blurb: 'One Live Preserve to try it out.' },
  { id: 'studio', name: 'Studio', price: 12, copies: 10, blurb: 'Ten Live Preserves, Tour and Credits on every one.' },
  { id: 'agency', name: 'Agency', price: 39, copies: 50, blurb: 'Fifty Live Preserves for a whole portfolio.' },
];

function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} }
let db = load();
const listeners = new Set();
const emit = () => { save(db); listeners.forEach((f) => f()); };

export const store = {
  view: VIEW,
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  reset() { localStorage.removeItem(KEY); db = null; emit(); },
  me() { return db?.person || null; },
  signIn(email, name) {
    db = { person: { email, name: name || email.split('@')[0] }, studio: { slug: 'demo', name: (name || 'My') + ' Studio', plan: 'studio' },
      copies: SEED_COPIES.map((c) => ({ ...c, pins: (SEED_FINDINGS[c.id] || []).map((p, i) => ({ ...p, id: 'f' + i, at: c.created })), versions: [{ v: 1, at: c.created }], live: c.status === 'ready' ? 1 : null })), notifications: [] };
    emit();
  },
  signOut() { db = null; emit(); },
  studio() { return db.studio; },
  plan() { return PLANS.find((p) => p.id === db.studio.plan); },
  // Over the new plan's live-copy limit: archive (never delete) the copies published longest ago.
  setPlan(id) { db.studio.plan = id; const lim = this.plan().copies; db.copies.filter((c) => ['ready', 'paused'].includes(c.status)).slice(lim).forEach((c) => (c.status = 'archived')); emit(); },
  copies() { return db.copies.filter((c) => c.status !== 'deleted'); },
  copy(id) { return db.copies.find((c) => c.id === id); },
  // Live Preserves are what a plan limits. Starting a new one also needs room among the ones in use (live, pending or
  // in review), as request_copy does.
  liveCount() { return db.copies.filter((c) => ['ready', 'paused'].includes(c.status)).length; },
  inUse() { return db.copies.filter((c) => !['archived', 'deleted', 'failed'].includes(c.status)).length; },
  link(c) { return `${VIEW}/${db.studio.slug}/${c.name}/`; },
  embed(c) {
    return `<div style="position:relative;width:100%;aspect-ratio:16/10;max-height:90vh">\n<iframe title="Interactive preview of ${c.title}" style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:10px" loading="eager" referrerpolicy="no-referrer"></iframe>\n<script>(function(f){f.src='${VIEW}/c/${c.id}/'+(f.parentNode.offsetWidth<768?'mobile':'desktop')})(document.currentScript.previousElementSibling)</script>\n</div>`;
  },
  rename(id, name) {
    name = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!name) return 'Use letters and numbers.';
    if (db.copies.some((c) => c.id !== id && (c.name === name || (c.oldNames || []).includes(name)))) return 'That name is taken in your studio.';
    const c = this.copy(id); if (c.name !== name) { c.oldNames = [...(c.oldNames || []), c.name]; c.name = name; } emit(); return null;
  },
  setStatus(id, status) {
    const c = this.copy(id);
    if (status === 'ready' && c.status === 'archived' && this.liveCount() >= this.plan().copies) return 'Your plan’s Live Preserves are all in use. Archive a Live Preserve or upgrade your plan first.';
    c.status = status; emit(); return null;
  },
  remove(id) { this.copy(id).status = 'deleted'; emit(); },
  notifications() { return db.notifications; },
  markRead() { db.notifications.forEach((n) => (n.read = true)); emit(); },
  addPin(id, pin) { const c = this.copy(id); c.pins.push({ meta: {}, ...pin, at: now(), id: Math.random().toString(36).slice(2, 10), at: now() }); emit(); },
  updatePin(id, pid, fields) { const p = this.copy(id).pins.find((x) => String(x.id) === String(pid)); if (p) Object.assign(p, fields); emit(); },
  removePin(id, pid) { const c = this.copy(id); c.pins = c.pins.filter((x) => x.id !== pid); emit(); },
  // Accepting goes live if the plan has room, and otherwise starts archived (approve_copy in schema-review-flow.sql).
  approve(id) { const c = this.copy(id); c.status = this.liveCount() < this.plan().copies ? 'ready' : 'archived'; c.live = c.versions.at(-1).v; c.findings = []; c.pins = c.pins.filter((p) => (p.kind !== 'issue' || p.meta?.report) && p.kind !== 'finding'); emit(); },
  // Simulated copy job. The steps and timing mirror the real one (harness/make-copy.mjs, 2-4 minutes), sped up.
  create(url) {
    let u; try { u = new URL(/^https?:/.test(url) ? url : 'https://' + url); } catch { return { error: 'That doesn’t look like a web address.' }; }
    if (this.inUse() >= this.plan().copies) return { error: `Your ${this.plan().name} plan’s Preserves are all in use. Archive one or upgrade your plan to make another.` };
    const known = SEED_COPIES.find((s) => new URL(s.url).hostname === u.hostname);
    const id = known ? known.id : Math.random().toString(36).slice(2, 10);
    let name = (known?.name || u.hostname.replace(/^www\./, '').split('.')[0]).replace(/[^a-z0-9]+/g, '-');
    while (db.copies.some((c) => c.name === name && c.status !== 'deleted')) name += '-2';
    const c = { id, name, title: known?.title || u.hostname.replace(/^www\./, ''), url: u.href, status: 'processing', step: 0, created: now(), notes: [], pins: [], versions: [], live: null, simulated: !known };
    db.copies.unshift(c); emit();
    const steps = ['Checking the address', 'Opening the page on phone and desktop', 'Saving images, fonts and video', 'Building the fast copy', 'Removing trackers and contact details', 'Comparing it with the live site'];
    const tick = () => {
      if (c.status !== 'processing') return;
      c.step++;
      if (c.step < steps.length) { emit(); setTimeout(tick, 1600); return; }
      if (!known) { c.status = 'failed'; c.message = 'This demo can only preserve the five test sites. Real Preserves are made on our server, which the demo doesn’t use.'; }
      else { c.status = 'review'; c.versions.push({ v: 1, at: now() }); c.findings = known.findings || []; c.notes = known.notes; }
      db.notifications.unshift({ at: now(), copy: c.id, text: c.status === 'review' ? `Your Preserve of ${c.title} is ready to review.` : `We couldn’t preserve ${c.title}.`, read: false });
      emit();
    };
    c.stepNames = steps;
    setTimeout(tick, 1200);
    return { id };
  },
  // A refinement round, guided by the user's pinned notes (at least one new since the last round); up to 20 per copy.
  MAX_ROUNDS: 20,
  refine(id) {
    const c = this.copy(id); c.status = 'processing'; c.step = 0; c.rounds = (c.rounds || 0) + 1; c.lastRoundAt = now(); emit();
    const finish = () => { c.status = 'review'; c.pins = c.pins.filter((p) => p.kind !== 'finding'); c.findings = []; c.versions.push({ v: c.versions.length + 1, at: now(), from: 'refinement' }); db.notifications.unshift({ at: now(), copy: c.id, text: `Refinement ${c.rounds} of ${c.title} is ready to review.`, read: false }); emit(); };
    const tick = () => { if (c.status !== 'processing') return; c.step++; if (c.step < c.stepNames.length) { emit(); setTimeout(tick, 1400); } else finish(); };
    c.stepNames = c.stepNames || ['Re-reading your notes', 'Opening the page again', 'Adjusting the capture', 'Building the fast copy', 'Removing trackers and contact details', 'Comparing it with the live site'];
    setTimeout(tick, 1200);
  },
};
