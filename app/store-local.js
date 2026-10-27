// Demo data store: keeps everything in this browser (localStorage) so the screens can be clicked through before the
// real database is connected. Same shape as platform/schema.sql; store-supabase.js will replace it with no screen changes.
// New copies are simulated here: the real copy job runs on a server, which this demo doesn't have.
const KEY = 'preserve-demo-v5';
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
// Fonts on the kosa copy that need the person's look (font licensing, Jeremy 2026-10-19/26): who holds each license
// decides what the Preserve uses. The three uploaded to kosa's site are real (trial builds); Omnes Pro (an Adobe font
// from Squarespace's menu) and the saved GT Standard upload are staged so the demo shows every kind of row.
// sample: a picture of the font in the page's own words, taken at capture (Adobe files can't be shipped, pictures can).
// block: where it shows on the page. look: the open-license lookalike from Google Fonts.
const SEED_FONTS = { '9x2arj4e': [
  { id: 'omnes', name: 'Omnes Pro', holder: 'platform', sample: 'demo/font-omnes.png', text: 'KOSA RESIDENCE', look: 'Nunito', block: 'block-yui_3_17_2_1_1784647111340_5833', staged: true },
  { id: 'malamocco', name: 'Malamocco', holder: 'user', sample: 'demo/font-malamocco.png', text: '[ LIVE ]  [ EXPLORE ]  [ CREATE ]', look: 'Work Sans', block: 'block-yui_3_17_2_1_1784651790444_8028' },
  { id: 'pixel', name: 'That That New Pixel', holder: 'user', sample: 'demo/font-pixel.png', text: 'Kosa', look: 'Pixelify Sans', block: 'block-e21d97e9c46d6622a3aa' },
  { id: 'gt', name: 'GT Standard', holder: 'user', sample: 'demo/font-gt-standard.png', text: 'HOME  RESIDENCY  STORIES', look: 'Inter', block: 'el:header', covered: 'gt-standard' },
] };
// The studio's saved font files ("Your fonts"): a later Preserve using the same font is covered by the upload.
const SEED_STUDIO_FONTS = [{ id: 'gt-standard', name: 'GT Standard', file: 'GTStandard-M-Regular.woff2', at: ago(15) }];
const FONT_FILE = /\.(woff2|woff|otf|ttf)$/i;
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

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
    db = { person: { email, name: name || email.split('@')[0] }, studio: { slug: 'demo', name: (name || 'My') + ' Studio', plan: 'studio', fonts: SEED_STUDIO_FONTS },
      copies: SEED_COPIES.map((c) => ({ ...c, fonts: SEED_FONTS[c.id] ? SEED_FONTS[c.id].map((x) => ({ ...x })) : null, pins: (SEED_FINDINGS[c.id] || []).map((p, i) => ({ ...p, id: 'f' + i, at: c.created })), versions: [{ v: 1, at: c.created }], live: c.status === 'ready' ? 1 : null })), notifications: [] };
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
  // Font choices during review. decision: keep | lookalike | upload (null until the person has looked). Each change is
  // recorded with who and when; changing a font rebuilds only the fonts (seconds), not a refinement.
  studioFonts() { return db.studio.fonts || []; },
  setFont(id, fid, decision) {
    const c = this.copy(id), f = c.fonts.find((x) => x.id === fid);
    f.decision = decision; if (decision === 'lookalike') f.covered = null;
    (c.fontLog ||= []).push({ font: f.name, decision, by: db.person.email, at: now() }); emit();
  },
  // The real check reads the file's name table and compares letter widths with the original; the demo goes by the file
  // name, so a file named after a different font is turned down the same way.
  uploadFont(id, fid, file) {
    const c = this.copy(id), f = c.fonts.find((x) => x.id === fid);
    if (!FONT_FILE.test(file.name)) return 'That isn’t a font file. Upload a .woff2, .woff, .otf or .ttf file.';
    if (!squash(file.name).includes(squash(f.name.split(' ').sort((a, b) => b.length - a.length)[0]))) return `That file looks like a different font, so we kept what’s there. Upload a file of ${f.name}.`;
    const saved = { id: squash(f.name), name: f.name, file: file.name, at: now() };
    db.studio.fonts = [...this.studioFonts().filter((x) => x.id !== saved.id), saved];
    Object.assign(f, { decision: 'upload', file: file.name, uploadedAt: saved.at, covered: null });
    (c.fontLog ||= []).push({ font: f.name, decision: 'upload', file: file.name, by: db.person.email, at: now() }); emit(); return null;
  },
  // Accepting goes live if the plan has room, and otherwise starts archived (approve_copy in schema-review-flow.sql).
  approve(id, fontCert) { const c = this.copy(id); if (fontCert) (c.fontLog ||= []).push({ ...fontCert, by: db.person.email, at: now() }); c.status = this.liveCount() < this.plan().copies ? 'ready' : 'archived'; c.live = c.versions.at(-1).v; c.findings = []; c.pins = c.pins.filter((p) => (p.kind !== 'issue' || p.meta?.report) && p.kind !== 'finding'); emit(); },
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
    // The demo can't compare with the live site: the oldest open pin stays "still different", the rest "look fixed".
    const judge = () => c.pins.filter((p) => p.kind === 'issue' && !p.meta?.report).forEach((p, i) => { p.meta = { ...p.meta, round_result: i === 0 ? 'still-different' : 'looks-fixed', round_version: c.versions.length + 1 }; });
    const finish = () => { judge(); c.status = 'review'; c.pins = c.pins.filter((p) => p.kind !== 'finding'); c.findings = []; c.versions.push({ v: c.versions.length + 1, at: now(), from: 'refinement' }); db.notifications.unshift({ at: now(), copy: c.id, text: `Refinement ${c.rounds} of ${c.title} is ready to review.`, read: false }); emit(); };
    const tick = () => { if (c.status !== 'processing') return; c.step++; if (c.step < c.stepNames.length) { emit(); setTimeout(tick, 1400); } else finish(); };
    c.stepNames = c.stepNames || ['Re-reading your notes', 'Opening the page again', 'Adjusting the capture', 'Building the fast copy', 'Removing trackers and contact details', 'Comparing it with the live site'];
    setTimeout(tick, 1200);
  },
};
