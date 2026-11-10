// Real data store: Supabase sign-in and database, with the same API as store-local.js so the screens don't change.
// Reads go straight to tables (row-level rules limit them to the person's studio); every change goes through a
// database function (schema-actions.sql), which enforces plan limits, refinement rounds, and who may approve.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { PLANS } from './store-local.js';
import { SUPABASE_URL, SUPABASE_KEY, VIEW } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce' } });
const STEP_NAMES = { 'check-url': 'Checking the address', 'capture-and-build': 'Opening the page on phone and desktop', export: 'Saving images, fonts and video', fonts: 'Building the fast copy', scrub: 'Removing trackers and contact details', 'quality-check': 'Comparing it with the live site' };
const STEP_KEYS = Object.keys(STEP_NAMES);
const ERRORS = { 'not-a-font': 'That isn’t a font file. Upload a .woff2, .woff, .otf or .ttf file.', 'font-too-big': 'That file is too big for a web font. Upload one under 5 MB.', 'not-in-review': 'This Preserve has been accepted, so its fonts can’t change.', 'plan-limit': null, 'bad-url': 'That doesn’t look like a web address.', 'name-taken': 'That name is taken in your studio.', 'bad-name': 'Use letters and numbers.', 'no-new-notes': 'Flag at least one new issue first.', 'refine-cap': 'This Preserve has had all 20 refinement rounds.' };

let me = null, studio = null, copies = [], notes = [], studioFonts = [], ready = false, timer = null;
// Font files uploaded in this browser, kept as data: addresses so the preview shows them while the file is checked.
const justUploaded = {};
const listeners = new Set();
const emit = () => listeners.forEach((f) => f());
const say = (e) => { const m = e?.message || String(e); return ERRORS[m] ?? (m === 'plan-limit' ? `Your ${planOf().name} plan’s Live Preserves are all in use. Archive a Live Preserve or upgrade your plan first.` : m); };
// The plan's name and price come from the plan list; the copy allowance is whatever the database says (it can be raised per studio).
const planOf = () => { const p = PLANS.find((x) => x.id === studio?.plan) || (studio?.plan === 'unlimited' ? { id: 'unlimited', name: 'Unlimited', price: 0, blurb: 'Set by the Preserve team.' } : PLANS[0]); return { ...p, copies: studio?.copy_limit ?? p.copies }; };

async function refresh() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { me = null; studio = null; copies = []; ready = true; emit(); return; }
  const uid = session.user.id;
  const [{ data: person }, { data: st }, { data: cs }, { data: nt }, { data: sf }] = await Promise.all([
    sb.from('person').select('*').eq('id', uid).maybeSingle(),
    sb.from('studio').select('*').limit(1).maybeSingle(),
    sb.from('copy').select('*, copy_name(name,is_current,created_at), copy_version(version,verdict,findings,notes,fonts,created_at), copy_job(attempt,state,step,error,queued_at), copy_pin(*), copy_font(*)').order('created_at', { ascending: false }),
    sb.from('notification').select('*').order('created_at', { ascending: false }).limit(30),
    sb.from('studio_font').select('id,font_key,name,file_name,asset,state,problem,created_at').order('created_at', { ascending: false }),
  ]);
  studioFonts = sf || [];
  me = person ? { email: person.email, name: person.name } : { email: session.user.email };
  studio = st;
  notes = (nt || []).map((n) => ({ at: n.created_at, copy: n.copy_id, text: n.body, read: !!n.read_at, id: n.id }));
  copies = (cs || []).map(shape);
  ready = true;
  emit();
  clearTimeout(timer);
  // Keep looking while a Preserve is being made or an uploaded font is being checked.
  if (copies.some((c) => c.status === 'processing') || studioFonts.some((f) => f.state === 'checking')) timer = setTimeout(refresh, 5000);
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
    fonts: r.status === 'review' || last?.fonts?.length ? fontsOf(r, last) : null,
  };
}

// The review's Fonts rows (schema-fonts.sql) in the shape the screens use (store-local.js SEED_FONTS): the version's
// fonts, the person's choice for each, and their studio's uploads. A font with no choice yet is covered by an upload
// of the same font that passed its check.
function fontsOf(r, last) {
  const rows = last?.fonts || [];
  if (!rows.length) return null;
  return rows.map((f) => {
    const ch = (r.copy_font || []).find((x) => x.font_id === f.id);
    const up = ch?.decision === 'upload' ? studioFonts.find((x) => x.id === ch.studio_font_id) : null;
    const cover = !ch ? studioFonts.find((x) => x.font_key === f.id && x.state === 'ok') : null;
    return {
      ...f, sample: f.sample ? `${VIEW}/c/${r.id}/${f.sample}` : null,
      decision: up && up.state === 'rejected' ? null : ch?.decision || null,
      file: up?.file_name, uploadedAt: up?.created_at, checking: up?.state === 'checking', problem: up?.state === 'rejected' ? up.problem : null,
      covered: cover?.id || null, studioFont: (up && up.state !== 'rejected' ? up : cover) || null,
    };
  });
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
  // Fills the block it's pasted into on Squarespace (Fluid Engine rows grow but never shrink, so a box sized from its
  // width left empty space); anywhere else, full width and 600 px tall. The layout is scaled to fit, never reflowed:
  // desktop (1440 px) when the box is 1024 px or wider, phone (390 px) below that; a layout change loads a fresh frame.
  // Tested on Jeremy's Squarespace page 2026-11-03 (thread "Fix embed height on Squarespace", v5). layout: 'auto' picks by
  // the frame's width (v5); 'desktop' always shows the 1440 layout scaled to fit, 'phone' always the 390 one (v6, so a
  // case-study page can show both whatever the visitor's device).
  embed(c, layout = 'auto') {
    const pick = layout === 'desktop' ? "'desktop'" : layout === 'phone' ? "'mobile'" : "w>=1024?'desktop':'mobile'", kind = layout === 'auto' ? '' : `${layout} `;
    // Desktop on a phone or tablet: a live 1440-wide page in a frame runs them out of memory (Jeremy's iPhone, 2026-11-10),
    // so it shows the desktop still and opens the full-screen desktop view when tapped.
    const still = layout !== 'desktop' ? '' : "if(matchMedia('(pointer:coarse)').matches&&Math.min(screen.width,screen.height)<1024){var a=document.createElement('a'),i=new Image(),t=document.createElement('span');a.href=u+'desktop?full=1';a.target='_blank';a.rel='noopener';a.setAttribute('aria-label',f.title);a.style.cssText='position:absolute;inset:0;display:block';i.src=u+'desktop-still.webp';i.alt='';i.style.cssText='width:100%;height:100%;object-fit:cover;object-position:top;display:block';t.textContent='Tap to explore';t.style.cssText='position:absolute;left:50%;bottom:16px;transform:translateX(-50%);background:#111;color:#fff;font:500 14px/1 system-ui,sans-serif;padding:10px 16px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.25);white-space:nowrap';a.appendChild(i);a.appendChild(t);d.replaceChild(a,f);return}";
    return `<style>.fe-block .sqs-block:has(.preserve-embed){position:relative}.fe-block .sqs-block:has(.preserve-embed) :has(.preserve-embed){position:static!important;padding:0!important;height:auto!important}.fe-block .preserve-embed{position:absolute!important;inset:0;height:auto!important;max-height:none!important}.preserve-embed-min{display:none}@media (max-width:767px){.fe-block .preserve-embed-min{display:block;height:70svh}.preserve-embed,.fe-block .preserve-embed{max-height:85svh!important}}</style>\n<div class="preserve-embed-min"></div>\n<div class="preserve-embed" style="position:relative;width:100%;height:600px;max-height:90vh;overflow:hidden;border-radius:10px">\n<iframe title="Interactive ${kind}preview of ${c.title}" style="position:absolute;top:0;left:0;border:0;transform-origin:0 0" loading="eager" referrerpolicy="no-referrer"></iframe>\n<script>(function(f){var d=f.parentNode,u='${VIEW}/c/${c.id}/',l,s=1;function post(){try{f.contentWindow.postMessage({type:'preserve-scale',scale:s},'*')}catch(e){}}${still}function fit(){var w=d.clientWidth,h=d.clientHeight;if(!w||!h)return;var m=${pick},v=m=='desktop'?1440:390;s=Math.min(1,w/v);if(m!=l){var n=f.cloneNode(false);n.removeAttribute('src');n.style.width=v+'px';n.onload=post;d.replaceChild(n,f);f=n;l=m;f.src=u+m}f.style.width=v+'px';f.style.height=Math.ceil(h/s)+'px';f.style.left=Math.max(0,(w-v*s)/2)+'px';f.style.transform='scale('+s+')';post()}fit();window.ResizeObserver?new ResizeObserver(fit).observe(d):addEventListener('resize',fit)})(document.currentScript.previousElementSibling)</script>\n</div>`;
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
  // Fonts during review: each choice is recorded with who and when, and the viewer swaps the font in (no refinement).
  studioFonts: () => studioFonts.filter((f) => f.state === 'ok').map((f) => ({ id: f.id, name: f.name, file: f.file_name, at: f.created_at })),
  setFont: (id, fid, decision) => act('set_font_choice', { cid: id, fid, choice: decision }),
  async uploadFont(id, fid, file) {
    if (!/\.(woff2|woff|otf|ttf)$/i.test(file.name)) return 'That isn’t a font file. Upload a .woff2, .woff, .otf or .ttf file.';
    if (file.size > 5 * 1024 * 1024) return 'That file is too big for a web font. Upload one under 5 MB.';
    const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
    try { await rpc('upload_font', { cid: id, fid, fname: file.name, b64: url.split(',')[1] }); } catch (e) { return say(e); }
    justUploaded[fid] = url;
    return null;
  },
  // The font swaps for the review frame, the same as the viewer's (runner.mjs fontSwaps), so a choice shows at once.
  fontCss(c) {
    const face = (f, src) => `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:${f.style};font-display:swap;src:url(${src})}`;
    return (c.fonts || []).flatMap((f) => {
      const sf = f.studioFont;
      if (sf && (sf.state === 'ok' || justUploaded[f.id])) return (f.faces || []).map((x) => face(x, justUploaded[f.id] && sf.state !== 'ok' ? justUploaded[f.id] : `a/${sf.asset}`));
      if (f.decision === 'lookalike' && f.holder === 'user') return (f.faces || []).filter((x) => x.alt).map((x) => face(x, `a/${x.alt}`));
      return [];
    }).join('');
  },
  async approve(id, fontCert) {
    if (fontCert) { try { await rpc('certify_fonts', { cid: id, cert: fontCert }); } catch (e) { alert(say(e)); return; } }
    return act('approve_copy', { cid: id, ver: copies.find((c) => c.id === id).versions.at(-1).v });
  },
  async create(url) {
    let u; try { u = new URL(/^https?:/.test(url) ? url : 'https://' + url); } catch { return { error: 'That doesn’t look like a web address.' }; }
    try { return { id: await rpc('request_copy', { page_url: u.href }) }; } catch (e) { return { error: say(e) }; }
  },
  refine: (id) => act('refine_copy', { cid: id }),
  MAX_ROUNDS: 20,
};
refresh();
