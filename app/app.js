// Preserve app screens: sign in, dashboard, new Preserve, review (look and feel, Tour, Talent, accept), Preserve details, plan.
// (A "Preserve" is what the code calls a copy; the word copy stays out of what people read, where it reads as page text.)
// Plain JS, no build step. Routes: #/ dashboard, #/new, #/copy/<id>, #/plan.
import { store, PLANS } from './store.js';
import { GOOGLE } from './config.js';
import { spotMessage, pageMessage, groupMessage, HIDDEN } from './review-messages.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
// Confirmations. On the review screen they show at the top of the side panel, where the person is working, not at the
// bottom of the window under the Preserve (user testing, 2026-11-17). Elsewhere, and on narrow screens, bottom centre.
// undo: optional function; adds an Undo button and keeps the note up longer.
const toast = (t, undo) => {
  const el = $('#toast'), side = $('.side'), r = side?.getBoundingClientRect();
  const inSide = !!(r && r.width && innerWidth > 860 && r.bottom > 0);
  el.textContent = t; el.classList.toggle('in-side', inSide); el.classList.toggle('act', !!undo);
  if (undo) { const b = document.createElement('button'); b.className = 'undo'; b.textContent = 'Undo'; b.onclick = () => { el.classList.remove('show'); undo(); }; el.append(' ', b); }
  el.style.left = inSide ? `${r.left + r.width / 2}px` : ''; el.style.top = inSide ? `${Math.max(r.top, 0) + 14}px` : '';
  el.style.maxWidth = inSide ? `${r.width - 24}px` : '';
  el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), undo ? 6000 : 2600);
};
// A "Saved" tick next to the item just saved in the panel's lists (a pin, tour stop or answer). It fades by itself.
const markSaved = (m) => { view.saved = { ...m, until: Date.now() + 3200 }; };
const isSaved = (p) => !!(view.saved && Date.now() < view.saved.until
  && (view.saved.id ? String(view.saved.id) === String(p.id) : p.kind === view.saved.kind && p.body === view.saved.body));
// One line-icon set (Plum style, 2026-11-20): 16 px grid, 1.25 stroke, round ends.
const ICON_PATHS = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  copy: '<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5"/>',
  back: '<path d="M13 8H3M7 4L3 8l4 4"/>',
  next: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  more: '<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',
};
const ic = (name, size = 14) => `<svg class="ico" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
const COPY_ICON = ic('copy');
const CHECK_ICON = ic('check');
const SAVED_TICK = `<small class="saved" aria-live="polite">${ic('check', 12)} Saved</small>`;
const copyText = async (t, what) => { try { await navigator.clipboard.writeText(t); toast(`${what} copied`); } catch { prompt(`Copy the ${what.toLowerCase()}:`, t); } };
const when = (iso) => { const d = (Date.now() - Date.parse(iso)) / 1000; return d < 60 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`; };
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const STATUS = { processing: ['Pending', 'busy'], review: ['Ready to review', 'attn'], ready: ['Live', 'ok'], paused: ['Paused', 'muted'], archived: ['Archived', 'muted'], failed: ['Couldn’t preserve', 'bad'] };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
// House style (Jeremy, 2026-10-27): in sentences, numbers under 10 are spelled out; labels and counters keep digits.
// Status names (Live, Archived, Pending…) are capitalized wherever they appear in a sentence.
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const num = (n) => (n >= 0 && n < 10 ? NUM[n] : String(n));
const count = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const planFull = () => { const n = store.plan().copies; return n === 1 ? 'Your plan provides for one Live Preserve, which is currently in use.' : `Your plan provides for ${count(n, 'Live Preserve')}, which are all currently in use.`; };
// Dashboard thumbnails. The demo has pictures of its five test sites. A real Preserve shows its desktop still (made by
// the runner for each version, platform/runner.mjs): the version in review, or the accepted one. Only a Live one's
// still is public; any other needs the owner's signed link, fetched after the cards are drawn (fillThumbs).
const DEMO_THUMBS = ['minaab', 'breathpod', 'kosa', 'designforward', 'xanadu'];
const thumbV = (c) => (c.status === 'review' || c.status === 'processing' ? c.versions.at(-1)?.v : c.live);
const thumb = (c) => {
  if (!store.real) { const t = DEMO_THUMBS.find((s) => c.url.includes(s.replace('kosa', 'kosa.squarespace'))); return t ? { src: `thumbs/${t}.webp` } : null; }
  const v = thumbV(c);
  if (!v || c.status === 'failed') return null;
  const src = `${store.view}/c/${c.id}/desktop-still.webp?v=${v}`;
  return c.status === 'ready' ? { src } : { src, signed: true };
};
const thumbTokens = {};  // copy id -> { t, at }: signed links last 12 hours; one is asked for again after six
function fillThumbs(root) {
  root.querySelectorAll('img[data-still]').forEach((img) => {
    const id = img.dataset.still, have = thumbTokens[id];
    const show = (t) => { if (img.isConnected) img.src = `${img.dataset.src}&review=${encodeURIComponent(t || 1)}`; };
    if (have && Date.now() - have.at < 6 * 3600e3) return show(have.t);
    (store.reviewToken ? store.reviewToken(id).catch(() => null) : Promise.resolve(null)).then((t) => { thumbTokens[id] = { t, at: Date.now() }; show(t); });
  });
}
// A still that isn't made yet (a new Preserve, or one the runner hasn't reached) falls back to the name.
const noShot = (img) => { const d = document.createElement('div'); d.className = 'noshot'; d.textContent = img.alt; img.replaceWith(d); };
window.preserveNoShot = noShot;

function shell(body, { back } = {}) {
  app.innerHTML = `<header class="top"><a href="#/" class="brand">Preserve</a>
    <nav>${back ? `<a href="${back}" class="back">${ic('back')} Back</a>` : ''}<a href="#/plan">${esc(store.plan().name)}<span class="wide-only"> plan</span></a>
    <button class="link" id="out">Sign out</button></nav></header>
    <main>${body}</main>
    <dialog id="cdlg"></dialog>
    ${store.real ? '' : '<div class="demo-bar">Demo: everything here is stored only in this browser, and new Preserves are simulated. <button class="link" id="reset">Reset demo</button></div>'}`;
  $('#out').onclick = async () => { await store.signOut(); location.hash = '#/'; };
  if ($('#reset')) $('#reset').onclick = () => { store.reset(); location.hash = '#/'; };
  readyTitle();
}

// A confirmation card (instead of the browser's confirm box). Resolves true when the main button is pressed.
// While it is open, background refreshes don't redraw the screen underneath it (see route()).
function confirmCard({ title, body, ok, cancel = 'Cancel', danger }) {
  return new Promise((done) => {
    const dlg = $('#cdlg');
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p class="sub">${esc(body)}</p>
      <div class="row end"><button class="btn secondary" value="cancel">${esc(cancel)}</button><button class="btn ${danger ? 'danger solid' : ''}" value="ok">${esc(ok)}</button></div></form>`;
    dlg.returnValue = '';
    dlg.onclose = () => { done(dlg.returnValue === 'ok'); if (routeWaiting) { routeWaiting = false; setTimeout(route); } };
    dlg.showModal();
  });
}
// "Copy embed code": three codes. Desktop and Phone always show that layout (a case-study page can show both); Auto
// picks by the frame's width.
function embedCard(c) {
  const dlg = $('#cdlg');
  // Auto (layout by frame width) was dropped 2026-11-18 (Jeremy: a Preserve shouldn't switch layout by device). Auto codes
  // already pasted on sites keep working: the code itself picks the layout, and the viewer serves both.
  const LABEL = { desktop: 'Desktop embed', phone: 'Phone embed' };
  dlg.innerHTML = `<form method="dialog"><h2>Copy embed code</h2><p class="sub">Paste it where you want the Preserve to appear. Desktop and Phone always show that layout, scaled to fit, whatever the visitor’s screen.</p>
    <div class="row" style="flex-wrap:wrap">${Object.entries(LABEL).map(([l, t]) => `<button type="button" class="btn small" data-emb="${l}">${COPY_ICON}<span>${t}</span></button>`).join('')}</div>
    <p class="fine copied" id="copied" aria-live="polite"></p>
    <div class="row end"><button class="btn secondary" value="">Done</button></div></form>`;
  // Copying keeps the card open: the button turns into a tick for a moment and the line below says what to do next.
  dlg.querySelectorAll('[data-emb]').forEach((b) => (b.onclick = async () => {
    const l = b.dataset.emb, code = store.embed(c, l);
    try { await navigator.clipboard.writeText(code); } catch { prompt(`Copy the ${LABEL[l].toLowerCase()} code:`, code); return; }
    dlg.querySelectorAll('[data-emb]').forEach((x) => { x.classList.remove('done'); x.innerHTML = `${COPY_ICON}<span>${LABEL[x.dataset.emb]}</span>`; });
    b.classList.add('done'); b.innerHTML = `${CHECK_ICON}<span>Copied</span>`;
    $('#copied', dlg).textContent = `${LABEL[l]} code copied. Paste it where your site lets you add HTML or embed code.`;
    clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('done'); b.innerHTML = `${COPY_ICON}<span>${LABEL[l]}</span>`; }, 2500);
  }));
  dlg.returnValue = '';
  dlg.onclose = () => { if (routeWaiting) { routeWaiting = false; setTimeout(route); } };
  dlg.showModal();
}
// Adobe Fonts connection (platform/schema-adobe.sql; Jeremy 2026-11-22). Once per studio the designer pastes their
// Adobe Fonts API token; Preserves then show Adobe's fonts, loaded from Adobe, with the lookalike behind each one.
const ADOBE_TOKENS = 'https://typekit.com/account/tokens';   // Adobe's API docs (fonts.adobe.com/docs/api/auth)
const adobeFaces = (f) => (f.faces?.length ? f.faces.map((x) => x.family) : [f.id]);
const adobeHas = (f) => { const a = store.adobe?.(); return f.holder === 'platform' && a?.state === 'ok' && adobeFaces(f).some((x) => a.families?.[x]?.css); };
// An Adobe font the person's Adobe plan doesn't include (Adobe refused to add it): its row says so (Jeremy, 2026-11-23).
const adobeNotInPlan = (f) => { const a = store.adobe?.(); return f.holder === 'platform' && a?.state === 'ok' && adobeFaces(f).some((x) => a.families?.[x]?.plan === false); };
const usesAdobe = (c) => (c.fonts || []).some((f) => f.holder === 'platform');
function adobeCard(c, { found = false } = {}) {
  const dlg = $('#cdlg');
  const names = [...new Set((c?.fonts || []).filter((f) => f.holder === 'platform').map((f) => f.name))];
  dlg.innerHTML = `<form method="dialog" class="adobe"><h2>Show your Adobe fonts</h2>
    <p class="sub">${names.length ? `Your site uses ${names.length === 1 ? 'an Adobe font' : 'Adobe fonts'}: ${esc(names.join(', '))}. ` : found ? 'This page uses Adobe fonts. ' : ''}If you have Adobe Creative Cloud, connect it once and your Preserves show your Adobe fonts instead of substitutes.</p>
    <ol class="steps"><li><a href="${ADOBE_TOKENS}" target="_blank" rel="noopener">Open your Adobe Fonts API token page</a> and sign in with your Adobe account.</li>
      <li>Click “Make me a new API token”.</li><li>Copy the token and paste it here.</li></ol>
    <input id="adkey" autocomplete="off" spellcheck="false" placeholder="Paste your token" aria-label="Adobe Fonts API token">
    <p class="fine bad" id="aderr" aria-live="polite"></p>
    <p class="fine">We use it only to add the fonts your Preserves use to a web project called Preserve in your Adobe account. Adobe serves the fonts. If your Adobe subscription ends, your Preserves switch to substitutes.</p>
    <div class="row end"><button class="btn secondary" value="later">Not now</button><button class="btn" type="button" id="adgo">Connect</button></div></form>`;
  dlg.returnValue = '';
  $('#adgo', dlg).onclick = async () => {
    const b = $('#adgo', dlg); b.disabled = true; b.textContent = 'Connecting…';
    const err = await store.connectAdobe($('#adkey', dlg).value);
    if (err) { $('#aderr', dlg).textContent = err; b.disabled = false; b.textContent = 'Connect'; return; }
    dlg.close('ok');
    // The one question (all or nothing, never per Preserve): accepted Preserves stay as they are unless the person says yes.
    const accepted = store.copies().filter((x) => ['ready', 'paused', 'archived'].includes(x.status) && usesAdobe(x)).length;
    if (accepted && store.adobe()?.acceptedToo == null) {
      const yes = await confirmCard({ title: 'Switch your accepted Preserves too?', body: `${cap(count(accepted, 'accepted Preserve'))} ${accepted === 1 ? 'uses' : 'use'} substitutes for Adobe fonts. Switch ${accepted === 1 ? 'it' : 'them all'} to your Adobe fonts? Nothing else about ${accepted === 1 ? 'it' : 'them'} changes.`, ok: accepted === 1 ? 'Switch it' : 'Switch them all', cancel: 'Leave them as they are' });
      store.setAdobeAcceptedToo(yes);
    }
    toast('Connected. Your Adobe fonts appear in a few minutes.');
  };
  dlg.onclose = () => { if (dlg.returnValue === 'later') adobeLater(true); if (routeWaiting) { routeWaiting = false; setTimeout(route); } };
  dlg.showModal();
  setTimeout(() => $('#adkey', dlg)?.focus(), 0);
}
// "Not now" is remembered on this device; the Fonts step keeps a Connect button, and the plan page has it too.
const adobeLater = (set) => { try { if (set) localStorage.setItem('preserve-adobe-later', '1'); return localStorage.getItem('preserve-adobe-later') === '1'; } catch { return !!set; } };
const confirmDelete = () => confirmCard({ title: 'Confirm Deletion', body: 'Once a Preserve is deleted it can’t be recovered and its links and embed codes will stop working.', ok: 'Delete', danger: true });

// 1. Sign in ---------------------------------------------------------------------------------------------------
function signIn() {
  app.innerHTML = `<div class="signin"><div class="card narrow">
    <h1>Preserve</h1><p class="lede">Preserve the sites you’ve designed as live, interactive pages for your portfolio. Fast, private, and they never break.</p>
    ${!store.real || GOOGLE ? '<button class="btn wide google" id="g"><span>G</span> Continue with Google</button><div class="or">or</div>' : ''}
    <form id="f"><label>Email<input type="email" id="email" required placeholder="you@studio.com"></label>
    <button class="btn wide secondary">Email me a sign-in link</button></form>
    <p class="fine">No password. New here? The same buttons create your account.</p></div></div>
    <p class="err" id="err" hidden></p>
    ${store.real ? '' : '<div class="demo-bar">Demo: sign-in is simulated and everything stays in this browser.</div>'}`;
  const fail = (m) => { $('#err').textContent = m; $('#err').hidden = false; };
  if ($('#g')) $('#g').onclick = async () => { if (!store.real) { store.signIn('designer@studio.com', 'Jordan'); location.hash = '#/'; return; } const err = await store.signInGoogle(); if (err) fail(err); };
  $('#f').onsubmit = async (e) => {
    e.preventDefault(); const em = $('#email').value;
    if (store.real) { const err = await store.signIn(em); if (err) return fail(err); }
    app.innerHTML = `<div class="signin"><div class="card narrow"><h1>Check your email</h1><p class="lede">We sent a sign-in link to <b>${esc(em)}</b>. Open it in this browser. It works once and expires in an hour.</p>${store.real ? '' : '<button class="btn wide" id="go">Open the link (demo)</button>'}</div></div>`;
    if (!store.real) $('#go').onclick = () => { store.signIn(em); location.hash = '#/'; };
  };
}

// 2. Dashboard -------------------------------------------------------------------------------------------------
// Newest first, 20 to a page, with a search (site title and address) and a filter by state. The list redraws on its
// own, so typing in the search box or a background refresh never loses the search box's focus.
const PAGE = 20;
const FILTERS = [['all', 'All'], ['live', 'Live'], ['review', 'Ready to review'], ['pending', 'Pending'], ['archived', 'Archived']];
const inFilter = (c, f) => f === 'all' || (f === 'live' ? ['ready', 'paused'].includes(c.status) : f === 'pending' ? c.status === 'processing' : c.status === f);
const hostOf = (c) => new URL(c.url).hostname.replace(/^www\./, '');
let dash = { q: '', filter: 'all', page: 0 };

function dashboard() {
  if ($('#dashq')) { refreshHeader(); drawList(); return; }
  shell(`<div class="head"><div><h1>Your Preserves</h1><p class="sub" id="cap"></p></div><a href="#/new" class="btn">${ic('plus')} New Preserve</a></div>
    <div class="dashbar"><input id="dashq" type="search" placeholder="Search by site name or address" value="${esc(dash.q)}" aria-label="Search your Preserves">
      <div class="seg" id="filt">${FILTERS.map(([k, l]) => `<button data-f="${k}" class="${dash.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <section class="grid" id="list"></section><nav class="pager" id="pager"></nav>`);
  $('#dashq').oninput = () => { dash.q = $('#dashq').value; dash.page = 0; drawList(); };
  app.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { dash.filter = b.dataset.f; dash.page = 0; app.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); drawList(); }));
  drawList();
}

function drawList() {
  const plan = store.plan();
  $('#cap').textContent = plan.copies >= 100000 ? `${plural(store.liveCount(), 'Live Preserve')} · ${plan.name} plan` : `${store.liveCount()} of ${plan.copies} Live on your ${plan.name} plan`;
  const q = dash.q.trim().toLowerCase();
  const all = store.copies().filter((c) => c.status !== 'deleted')
    .sort((a, b) => (b.status === 'review') - (a.status === 'review') || b.created.localeCompare(a.created));   // ready to review first
  const shown = all.filter((c) => inFilter(c, dash.filter) && (!q || c.title.toLowerCase().includes(q) || c.url.toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  dash.page = Math.min(dash.page, pages - 1);
  $('#list').innerHTML = shown.slice(dash.page * PAGE, (dash.page + 1) * PAGE).map(card).join('')
    || `<p class="sub">${all.length ? 'No Preserves match.' : 'No Preserves yet. Make your first one.'}</p>`;
  fillThumbs($('#list'));
  $('#pager').innerHTML = pages > 1 ? `<button class="btn small secondary" data-pg="-1" ${dash.page ? '' : 'disabled'}>${ic('back')} Newer</button><span class="sub">Page ${dash.page + 1} of ${pages}</span><button class="btn small secondary" data-pg="1" ${dash.page < pages - 1 ? '' : 'disabled'}>Older ${ic('next')}</button>` : '';
  app.querySelectorAll('[data-pg]').forEach((b) => (b.onclick = () => { dash.page += +b.dataset.pg; drawList(); scrollTo(0, 0); }));
  app.querySelectorAll('[data-link]').forEach((b) => (b.onclick = () => copyText(store.link(store.copy(b.dataset.link)), 'Link')));
  app.querySelectorAll('[data-embed]').forEach((b) => (b.onclick = () => embedCard(store.copy(b.dataset.embed))));
  app.querySelectorAll('[data-live]').forEach((b) => (b.onchange = async () => {
    const id = b.dataset.live, err = await store.setStatus(id, b.checked ? 'ready' : 'archived');
    if (err) { b.checked = !b.checked; toast(err); return; }
    if (b.checked) toast('Live again');
    else toast('Archived. Its link now shows “preview paused”.', async () => { const e2 = await store.setStatus(id, 'ready'); toast(e2 || 'Live again'); });
  }));
  app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDelete()) { await store.remove(b.dataset.del); toast('Deleted'); } }));
}

function card(c) {
  const [label, tone] = STATUS[c.status] || ['', 'muted'];
  const t = thumb(c);
  const accepted = ['ready', 'paused', 'archived'].includes(c.status);
  const del = `<button class="link danger" data-del="${c.id}">Delete</button>`;
  return `<article class="copy">
    <a href="#/copy/${c.id}" class="shot">${t ? `<img ${t.signed ? `data-still="${c.id}" data-src="${esc(t.src)}"` : `src="${esc(t.src)}"`} alt="${esc(c.title)}" loading="lazy" onerror="preserveNoShot(this)">` : `<div class="noshot">${esc(c.title)}</div>`}${c.status === 'processing' ? `<div class="veil"><div class="spin"></div>${esc(c.stepNames?.[c.step] || 'Starting')}…</div>` : ''}</a>
    <div class="meta"><a href="#/copy/${c.id}" class="title">${c.status === 'review' ? '<i class="dot" aria-hidden="true"></i>' : ''}${esc(c.title)}</a><span class="pill ${tone}">${label}</span></div>
    <div class="sub">${esc(hostOf(c))} · ${day(c.created)}</div>
    ${accepted ? `<div class="actions"><button class="btn small" data-link="${c.id}">Copy link</button><button class="btn small secondary" data-embed="${c.id}">Copy embed code</button></div>
      <div class="actions minor"><label class="switch"><input type="checkbox" data-live="${c.id}" ${c.status === 'archived' ? '' : 'checked'}><span class="knob"></span><span class="on">Live</span><span class="off">Archived</span></label>
        <a class="link" href="#/copy/${c.id}">Open</a><span class="push"></span>${del}</div>`
      : c.status === 'review' ? `<div class="actions"><a class="btn small" href="#/copy/${c.id}">Review</a></div><div class="actions minor">${del}</div>`
      : c.status === 'failed' ? `<p class="sub">${esc(c.message || '')}</p><div class="actions minor">${del}</div>` : ''}
  </article>`;
}

// 3. New Preserve ----------------------------------------------------------------------------------------------
// The Preserve just made from this page: the page shows "We're on it" until the person goes elsewhere (kept here, not
// only drawn once, so a redraw from a store change doesn't put the empty form back).
let justMade = null;
function newCopy() {
  if (justMade) {
    shell(`<div class="card narrow center" id="onit"><div class="spin big"></div><h1>We’re on it</h1><p class="lede">Your Preserve is being made. It usually takes a few minutes, and you don’t need to keep this page open. When it’s ready to review, it moves to the top of your Preserves.</p><a class="btn" href="#/">Back to your Preserves</a></div>`, { back: '#/' });
    return;
  }
  shell(`<div class="card narrow"><h1>New Preserve</h1><p class="lede">Paste the address of a page you designed. We’ll preserve that page as it looks right now, on phone and desktop. We swap emails, phone numbers and addresses for placeholders.</p>
    <form id="f"><label>Page address<input id="u" placeholder="https://www.clientsite.com/" required autofocus></label>
    <p class="err" id="err" hidden></p><button class="btn wide">Create Preserve</button></form>
    <p class="fine">Takes a few minutes. You can leave this page; it moves to the top of your Preserves when it’s ready to review.${store.real ? '' : ' Try one of the test sites: minaab.com, breathpod.com, xanadu.nyc.'}</p></div>`, { back: '#/' });
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const r = await store.create($('#u').value.trim());
    if (r.error) { $('#err').textContent = r.error; $('#err').hidden = false; return; }
    justMade = r.id; newCopy();
    // Adobe Fonts first thing (Jeremy, 2026-11-22): a quick look at the page's own HTML says whether it loads Adobe
    // fonts, so the connect card opens now, before any lookalike choice. Anything it misses is asked at first review.
    if (store.adobeCheck && store.adobe && !store.adobe() && !adobeLater()) {
      const yes = await store.adobeCheck(r.id);
      if (yes && justMade === r.id && location.hash === '#/new' && !store.adobe() && !$('#cdlg').open) { view.adobeAsked = r.id; adobeCard(null, { found: true }); }
    }
  };
}

// 4. One Preserve: pending / review / live --------------------------------------------------------------------
// The preview frame is built once per copy and layout and then left alone, so saving a note, adding a tour stop or
// a background refresh never reloads it or scrolls it back to the top; only the side panel is redrawn.
// Desktop is shown at a real 1440px desktop width, scaled down to fit, so the copy lays out as it would on a monitor.
const DESKTOP_W = 1440, PHONE_W = 390;
let view = { id: null, layout: innerWidth < 700 ? 'mobile' : 'desktop', tab: null, pinFor: null, frameKey: null, flash: null, missing: [], fontShown: null };
const KIND_FOR = { check: 'issue', tour: 'tour' };
// Issues waiting for a refinement: the person's own pins since the last round, plus suspected issues marked "Fix issue".
// Fonts that need the person's look before accepting (shown only when some do). Every font that needs a license asks
// in the Fonts step (Jeremy, 2026-11-18): a font the owner added to their site is confirmed there ("I have the rights
// to use it here") or swapped for its lookalike, and Accept waits for that answer (unanswered, below).
// Fonts the Fonts step lists: only ones that need a decision (Jeremy, 2026-11-23: no non-questions). Not listed: a font
// Adobe serves once Adobe Fonts is connected (the lapse fallback is in the help guide and Terms), and a font already
// covered by a licensed file the studio uploaded earlier (the Preserve simply uses it).
const fontsShown = (c) => (c.fonts || []).filter((f) => !adobeHas(f) && !(f.covered && !f.decision));
const fontsToCheck = (c) => unanswered(c);
// Pins to fix: new since the last refinement, or still different from the live site after it (a pin is never needed twice).
const toFix = (c) => pinsFor(c, 'check').filter((p) => !c.lastRoundAt || p.at > c.lastRoundAt || p.meta?.round_result === 'still-different').length + c.pins.filter((p) => p.kind === 'finding' && p.meta.verdict === 'fix').length;

function copyPage(id) {
  const c = store.copy(id);
  if (!c || c.status === 'deleted') { location.hash = '#/'; return; }
  if (view.id !== id) view = { ...view, id, tab: null, pinFor: null, frameKey: null, flash: null, missing: [], fontShown: null };
  if (c.status === 'processing') {
    view.frameKey = null;
    shell(`<div class="card narrow"><h1 class="name">${esc(c.title)}</h1><p class="sub">${esc(c.url)}</p>
      <ol class="steps">${(c.stepNames || []).map((s, i) => `<li class="${i < c.step ? 'done' : i === c.step ? 'now' : ''}">${esc(s)}</li>`).join('')}</ol>
      <p class="fine">You can leave this page. When it’s ready to review, it moves to the top of your Preserves.</p></div>`, { back: '#/' });
    return;
  }
  if (c.status === 'failed') {
    view.frameKey = null;
    shell(`<div class="card narrow"><h1>We couldn’t preserve this page yet</h1><p class="lede">${esc(c.message || 'This site contains elements our system can’t process yet. We’ve logged the gap and will be in touch when we can handle this site.')}</p><button class="btn secondary" id="del">Delete</button></div>`, { back: '#/' });
    $('#del').onclick = async () => { if (await confirmDelete()) { await store.remove(id); location.hash = '#/'; } };
    return;
  }
  const review = c.status === 'review';
  const steps = review ? [...(fontsShown(c).length ? [['fonts', 'Fonts']] : []), ['check', 'Look and Feel'], ['tour', 'Tour'], ['talent', 'Talent']] : [];
  const tabs = review ? steps.map(([k, l], i) => [k, `${i + 1}. ${l}`])
    // Accepted: the captured page can never change again (Jeremy, 2026-10-28), so there is no issue reporting here;
    // only the Tour, Talent, link name and Live/Archived stay editable.
    : [['share', 'Share'], ['tour', 'Tour'], ['talent', 'Talent']];
  if (!tabs.some((t) => t[0] === view.tab)) view.tab = tabs[0][0];
  const key = `${id}|${view.layout}`;
  // A Preserve in review opens only with a signed link from the database, good for 12 hours; ask again after six.
  if (review && store.reviewToken && !(view.reviewToken?.id === id && Date.now() - view.reviewToken.at < 6 * 3600e3)) {
    const rt = view.reviewToken = { id, at: Date.now(), t: view.reviewToken?.id === id ? view.reviewToken.t : null };
    store.reviewToken(id).catch(() => null).then((t) => { rt.t = t || rt.t; if (view.id === id) copyPage(id); });
    return;  // the frame is drawn once the link is here, so it never opens with a link the viewer would turn down
  }
  if (view.frameKey !== key || !$('#fr')) {
    view.frameKey = key;
    // Title, link and the preview controls share one row so the preview starts high and gets the height.
    shell(`<div class="head copyhead"><div class="ttlwrap"><div class="ttlrow"><h1 id="ttl"></h1><div class="morewrap"><button class="link more" id="morebtn" aria-label="More actions" aria-haspopup="true">${ic('more', 18)}</button><div class="pop menu" id="more" hidden><button class="link danger" id="del">Delete this Preserve</button></div></div></div><p class="sub"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></p></div>
          <div class="toolbar"><div class="seg"><button data-l="desktop" class="${view.layout === 'desktop' ? 'on' : ''}">Desktop</button><button data-l="mobile" class="${view.layout === 'mobile' ? 'on' : ''}">Phone</button></div>
            <button class="btn small secondary" id="expand"></button></div></div>
      <div class="split ${view.wide ? 'wide' : ''}">
        <div class="stage">
          <div class="frame ${view.layout}" id="fw"><div class="pinbar" id="hint" hidden></div><iframe id="fr" src="${store.view}/c/${c.id}/${view.layout}?review=${encodeURIComponent(view.reviewToken?.t || 1)}" title="Preserve preview"></iframe></div>
        </div>
        <aside class="side"><nav class="tabs" id="tabs"></nav><div id="panel"></div></aside>
      </div>
      <dialog id="dlg"><form method="dialog" id="dlgf"></form></dialog>`, { back: '#/' });
    app.querySelectorAll('[data-l]').forEach((b) => (b.onclick = () => { view.layout = b.dataset.l; view.pinFor = null; copyPage(id); }));
    $('main').classList.add('full');
    $('#expand').onclick = () => { view.wide = !view.wide; $('.split').classList.toggle('wide', view.wide); copyPage(id); fitFrame(); };
    fitFrame();
    window.onmessage = (m) => onFrameMessage(m, id);
    $('#morebtn').onclick = () => { $('#more').hidden = !$('#more').hidden; };
    $('#del').onclick = async () => { $('#more').hidden = true; if (await confirmDelete()) { await store.remove(id); location.hash = '#/'; } };
  } else {
    refreshHeader();
  }
  $('#ttl').innerHTML = `${esc(c.title)} <span class="pill ${STATUS[c.status][1]}">${STATUS[c.status][0]}</span>`;
  $('#expand').textContent = `${view.wide ? 'Show' : 'Hide'} ${review ? 'review panel' : 'panel'}`;
  const nf = fontsToCheck(c).length;
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button data-t="${k}" class="${view.tab === k ? 'on' : ''}">${l}${k === 'fonts' && nf ? ` <span class="count">${nf}</span>` : ''}</button>`).join('');
  app.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { view.tab = b.dataset.t; view.pinFor = null; sendMode(); copyPage(id); }));
  panel(c, review);
  // A site with Adobe fonts: offer the connection first thing in its review, before any lookalike choice, once per visit.
  if (review && usesAdobe(c) && store.adobe && !store.adobe() && !adobeLater() && view.adobeAsked !== id && !$('#cdlg').open) { view.adobeAsked = id; adobeCard(c); }
  $('#hint').textContent = !view.pinFor ? '' : view.pinFor === 'check' ? 'Click the spot that looks wrong. Esc to cancel.'
    : 'Click the spot on the page. Esc to cancel.';
  $('#hint').hidden = !view.pinFor;
  // The boxes around a font's words belong to the Fonts step only (Jeremy, 2026-11-16).
  if (view.fontShown && view.tab !== 'fonts') showFont(null);
  sendPins(c);
  sendFonts(c);
}

// With no bell (Jeremy, 2026-11-19), the browser tab says how many Preserves are ready to review: "(2) Preserve".
function readyTitle() {
  const n = store.copies().filter((c) => c.status === 'review').length;
  document.title = n ? `(${n}) Preserve` : 'Preserve';
}
function refreshHeader() { readyTitle(); }

function fitFrame() {
  const fw = $('#fw'), fr = $('#fr');
  if (!fw || !fr) return;
  if (view.layout === 'desktop') {
    const s = fw.clientWidth / DESKTOP_W;
    fr.style.width = DESKTOP_W + 'px'; fr.style.height = fw.clientHeight / s + 'px';
    fr.style.transform = `scale(${s})`; fr.style.transformOrigin = '0 0';
  } else {
    fr.style.width = PHONE_W + 'px'; fr.style.height = '100%'; fr.style.transform = '';
  }
}
addEventListener('resize', fitFrame);

const frameWin = () => $('#fr')?.contentWindow;
// Outline every place one font shows on the page, or (null) take the outlines away (worker: preserve-show-font).
function showFont(f) { view.fontShown = f ? f.id : null; frameWin()?.postMessage({ type: 'preserve-show-font', name: f ? f.name : '' }, '*'); }
function sendMode() { frameWin()?.postMessage({ type: 'preserve-pin-mode', on: !!view.pinFor }, '*'); }
// The person's font choices, drawn in the preview at once (the viewer adds the same for visitors).
let lastFonts = '';
function sendFonts(c, force) {
  const css = store.fontCss ? store.fontCss(c) : '';
  if (css === lastFonts && !force) return;
  lastFonts = css;
  frameWin()?.postMessage({ type: 'preserve-fonts', css }, '*');
}
let lastPins = '';
function sendPins(c, force) {
  const kind = KIND_FOR[view.tab];
  const list = kind ? pinsFor(c, view.tab) : [];
  const pins = list.filter((p) => kind === 'tour' || p.layout === view.layout || !p.layout).map((p) => ({ kind: p.kind, blockId: p.blockId, x: p.x, y: p.y, body: p.body, n: list.indexOf(p) + 1 }));
  // While checking, the quality check's findings show too, lettered A, B, C… (grey once marked).
  // Every suspected issue has its own letter (Jeremy, 2026-11-21); the page nudges markers on the same spot apart so
  // none hides another. One about the whole page (the first screen, or no one block) shows as a band, not a dot.
  if (view.tab === 'check') placedOf(c).forEach((p, i) => pins.push({ kind: p.meta.verdict ? 'finding-done' : 'finding', blockId: p.blockId, x: p.x, y: p.y, body: fText(p), n: letter(i),
    ...(pageWide(p) ? { wide: true, top: p.meta.code === 'first-screen-differs' ? 0 : p.meta.pageY ?? 0 } : {}) }));
  const key = JSON.stringify(pins);
  if (key === lastPins && !force) return;   // unchanged: don't touch the page
  lastPins = key;
  frameWin()?.postMessage({ type: 'preserve-pins', pins }, '*');
}
// Findings for the layout on screen, top to bottom (lettered in that order, on the page and in the list).
// A suspected issue the person called "Not an issue" in an earlier round stays answered in later refinements, on
// phone and desktop alike (runner.mjs carries the answer). It drops out of the list and off the page, into a collapsed
// list where the answer can still be changed (Jeremy, 2026-11-20).
const dismissedEarlier = (p) => !!p.meta.carried && verdictOf(p) === 'not-a-problem';
// Suspected issues the person can see and judge in review (Jeremy, 2026-11-20). Older Preserves still carry markers the
// check now keeps to itself: our own leftovers, and part-by-part findings seen only at a window size between the two
// layouts (their text names a width but no layout).
const reviewable = (p) => !HIDDEN.has(p.meta.code) && !(/pixels wide/.test(p.body || '') && !/on (computers|phones)/.test(p.body || ''));
// Shown in today's wording, by kind (review-messages.js); the stored text stays as it was.
// The AI's plain description of this very spot (ai-vet.mjs) when it looked; otherwise today's wording for the kind.
const fText = (p) => (!p.meta.code ? p.body : p.meta.codes ? groupMessage(p.meta.codes) : p.meta.say ? p.meta.say : p.blockId ? spotMessage(p.meta.code, p.meta.noun) : pageMessage(p.meta.code));
// A finding the check couldn't place on the page has no block and no layout (runner.mjs): it is listed in both views,
// after the lettered ones, and answered like any other.
const inView = (p, layout) => p.layout === layout || !p.layout;
const dismissedOf = (c, layout = view.layout) => c.pins.filter((p) => p.kind === 'finding' && inView(p, layout) && reviewable(p) && dismissedEarlier(p));
const findingsOf = (c, layout = view.layout) => c.pins.filter((p) => p.kind === 'finding' && inView(p, layout) && reviewable(p) && !dismissedEarlier(p)).sort((a, b) => !a.blockId - !b.blockId || (a.meta.pageY ?? 1e9) - (b.meta.pageY ?? 1e9) || a.sort - b.sort);
const placedOf = (c, layout = view.layout) => findingsOf(c, layout).filter((p) => p.blockId);
const letter = (i) => String.fromCharCode(65 + (i % 26));
const pageWide = (p) => p.meta.code === 'first-screen-differs' || p.blockId === 'el:body';
// The "Your site" and "Preserve" pictures the runner cut for a finding (finding-crops.mjs), from the viewer on the
// owner's signed link. A picture that can't load takes its pair away rather than leave a broken image.
function cropPair(c, p) {
  return '';   // Pictures taken out of the review (Jeremy, 2026-11-23): markers and short descriptions only.
  const src = p.meta.demoCrop ? (w) => `${p.meta.demoCrop}-${w}.webp`
    : p.meta.crop && store.view ? (w) => `${store.view}/c/${c.id}/findings/${p.meta.crop}-${w}.webp?review=${encodeURIComponent(view.reviewToken?.t || 1)}` : null;
  if (!src) return '';
  return `<button type="button" class="crops ${p.layout === 'mobile' ? 'phone' : ''}" title="See larger" onclick="showCrops(this)">${[['site', 'Your site'], ['preserve', 'Preserve']].map(([w, t]) =>
    `<figure><img src="${esc(src(w))}" alt="${t}" loading="lazy" onerror="this.closest('.crops').remove()"><figcaption>${t}</figcaption></figure>`).join('')}</button>`;
}
// The pair at full size, side by side over the page (the side panel is too narrow to judge a desktop picture).
window.showCrops = (btn) => {
  const d = document.createElement('dialog');
  d.className = 'cropview';
  d.innerHTML = `<div class="cropview-in ${btn.classList.contains('phone') ? 'phone' : ''}">${btn.innerHTML}</div><button class="btn secondary" autofocus>Close</button>`;
  d.onclick = (e) => { if (e.target === d || e.target.closest('button')) d.close(); };
  d.onclose = () => d.remove();
  document.body.appendChild(d); d.showModal();
};
// The person's answer for each suspected issue: two answers since user testing (Jeremy, 2026-11-12). Older answers
// stay as stored and show as "Not an issue": 'fine' (the first "Looks fine") and 'ignore' (the dropped "Ignore issue").
const VERDICTS = [['fix', 'Fix issue'], ['not-a-problem', 'Not an issue']];
const verdictOf = (p) => (['fine', 'ignore'].includes(p.meta.verdict) ? 'not-a-problem' : p.meta.verdict);
const pinsFor = (c, tab) => c.pins.filter((p) => tab === 'tour' ? p.kind === 'tour' : tab === 'talent' ? p.kind === 'credit'
  : p.kind === 'issue' && !p.meta?.report);

function onFrameMessage(m, id) {
  if (m.source !== frameWin()) return;
  const d = m.data || {};
  const c = store.copy(id);
  if (d.type === 'preserve-ready') { view.fontShown = null; sendPins(c, true); if (store.fontCss) sendFonts(c, true); sendMode(); if (view.gotoAfter) { frameWin()?.postMessage({ type: 'preserve-scroll-to', ...view.gotoAfter }, '*'); view.gotoAfter = null; } }
  // Pins the page couldn't place (their block isn't there, e.g. after a refinement): tour stops are marked to move.
  if (d.type === 'preserve-missing') { const k = (d.blockIds || []).join('|'); if (k !== view.missing.join('|')) { view.missing = d.blockIds || []; copyPage(id); } }
  if (d.type === 'preserve-pin' && view.pinFor?.startsWith('move:')) {
    const p = c.pins.find((x) => String(x.id) === view.pinFor.slice(5));
    view.pinFor = null; sendMode();
    if (p) { markSaved({ id: p.id }); store.updatePin(id, p.id, { body: p.body, meta: p.meta, blockId: d.blockId, x: d.x, y: d.y }).then(() => toast('Stop moved')); }
    copyPage(id); return;
  }
  if (d.type === 'preserve-pin' && view.pinFor) {
    const forWhat = view.pinFor;
    view.pinFor = null; sendMode(); $('#hint').textContent = ''; $('#hint').hidden = true;
    noteDialog(forWhat, null, async (vals) => {
      const pin = { blockId: d.blockId, x: d.x, y: d.y, layout: d.layout, label: d.label };
      markSaved({ kind: forWhat === 'tour' ? 'tour' : 'issue', body: vals.body });
      if (forWhat === 'tour') await store.addPin(id, { ...pin, kind: 'tour', body: vals.body, meta: { title: vals.title } });
      else await store.addPin(id, { ...pin, kind: 'issue', body: vals.body, meta: {} });
      toast(forWhat === 'tour' ? 'Tour stop saved' : 'Issue saved');
    });
    copyPage(id);
  }
}
// The "…" menu next to a Preserve's title closes on a click anywhere else, or Esc.
addEventListener('click', (e) => { const m = $('#more'); if (m && !m.hidden && !e.target.closest('#more,#morebtn')) m.hidden = true; });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#more') && !$('#more').hidden) $('#more').hidden = true; });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && view.fontShown && !view.pinFor) { showFont(null); if (view.id) copyPage(view.id); } });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && view.pinFor) { view.pinFor = null; sendMode(); if (view.id) copyPage(view.id); } });

// A small form in a dialog (instead of the browser's prompt box). kind: issue | tour.
function noteDialog(kind, current, save) {
  const dlg = $('#dlg'), f = $('#dlgf');
  const tour = kind === 'tour';
  const fnote = kind === 'finding';
  f.innerHTML = `<h2>${tour ? (current ? 'Edit tour stop' : 'New tour stop') : fnote ? 'Add a note' : 'What’s wrong here?'}</h2>
    ${tour ? `<label>Title<input name="title" value="${esc(current?.meta?.title || '')}" placeholder="Layered hero portrait" required></label>` : ''}
    <label>${tour ? 'Note' : fnote ? 'What do you see? Anything you add helps us fix it.' : 'Describe it in your own words'}<textarea name="body" rows="4" required placeholder="${tour ? 'What visitors should notice here, and why it matters.' : fnote ? 'For example: on my site you can drag the pictures sideways.' : 'For example: this slideshow doesn’t move, or the logo is the wrong color.'}">${esc(current?.body || '')}</textarea></label>
    <div class="row end"><button class="btn secondary" value="cancel" formnovalidate>Cancel</button><button class="btn" value="ok">Save</button></div>`;
  f.onsubmit = (e) => { if (e.submitter?.value !== 'ok') return; const v = Object.fromEntries(new FormData(f)); if (!v.body?.trim()) return; save({ title: (v.title || '').trim(), body: v.body.trim() }); };
  dlg.showModal();
  f.querySelector('input,textarea')?.focus();
}

function startPin(forWhat) { view.pinFor = view.pinFor === forWhat ? null : forWhat; sendMode(); copyPage(view.id); }
// While a pin is being placed its button turns green; the label stays the same (the hint above the preview says what to do).
const pinButton = (forWhat, label) => `<button class="btn small ${view.pinFor === forWhat ? '' : 'secondary'}" data-pin="${forWhat}" aria-pressed="${view.pinFor === forWhat}">${label}</button>`;
const pinList = (c, tab, opts = {}) => {
  const list = pinsFor(c, tab);
  if (!list.length) return opts.empty ? `<p class="sub">${opts.empty}</p>` : '';
  return `<ol class="pins ${tab === 'tour' ? 'tour' : ''}">${list.map((p) => `<li>${p.meta?.title ? `<b>${esc(p.meta.title)}</b>` : ''}<span class="pbody">${esc(p.body)}</span>
    <small>${esc([tab === 'tour' ? '' : p.layout, tab === 'check' && c.lastRoundAt && p.at <= c.lastRoundAt && !p.meta?.round_result ? 'earlier round' : '', p.label].filter(Boolean).join(' · '))}</small>
    ${tab === 'check' && p.meta?.round_result ? roundResult(p) + aiNote(p) : ''}
    ${tab === 'tour' && view.missing.includes(p.blockId) ? '<small class="warn">This stop no longer lands on the page. Move it to the right spot.</small>' : ''}
    <span class="row">${isSaved(p) ? SAVED_TICK : ''}<button class="link" data-goto="${esc(p.blockId)}" data-n="${list.indexOf(p) + 1}">Show</button>${opts.edit ? `<button class="link" data-edit="${p.id}">Edit</button><button class="link" data-pin="move:${p.id}">${view.pinFor === 'move:' + p.id ? 'Drop it on the page…' : 'Move'}</button>` : ''}${opts.remove !== false ? `<button class="link" data-rm="${p.id}">Remove</button>` : ''}</span></li>`).join('')}</ol>`;
};

// How a pin came out in the last refinement (the check compares the pinned spot with the live site).
const roundResult = (p) => p.meta.round_result === 'looks-fixed' ? '<small class="ok">Looks fixed in the latest refinement. Remove the pin if you agree.</small>'
  : p.meta.round_result === 'still-different' ? '<small class="warn">Still different from your site after the latest refinement. It will be included in the next one.</small>'
  : '<small class="warn">We couldn’t find this spot after the latest refinement. Check it, and pin it again if it’s still wrong.</small>';

// What the refinement made of the pin's note, when AI read it (harness/ai-pins.mjs). Fixed wording per pick; the
// model's own words are never shown.
const BY_DESIGN_TEXT = {
  'contact-details': 'Preserves replace email addresses, phone numbers and street addresses with placeholders, so a Preserve never stands in for your real site.',
  'pop-ups': 'Preserves leave out pop-ups, announcement bars, cookie banners and promo tabs.',
  'video-still': 'Preserves show a static frame for YouTube and Vimeo videos, except section backgrounds.',
  'looping-video': 'Preserves clip looping background video to a short loop.',
  'shopping-forms': 'In a Preserve, buttons that buy, book or send a form show a note that it’s a snapshot.',
};
const aiNote = (p) => {
  const m = p.meta || {};
  const t = m.ai_action === 'fonts' ? 'This looks like a font difference. You can choose the font in the Fonts step.'
    : m.ai_action === 'by-design' && BY_DESIGN_TEXT[m.ai_by_design] ? BY_DESIGN_TEXT[m.ai_by_design] + ' This stays as it is.'
    : m.ai_action === 'live-same' ? 'Your live site shows the same thing here, so a refinement can’t change it.'
    : m.ai_action === 'still' ? 'This part now shows a picture of your live site, so it looks right but doesn’t respond to clicks.'
    : '';
  return t ? `<small>${esc(t)}</small>` : '';
};

function panel(c, review) {
  const id = c.id, P = $('#panel');
  const flash = view.flash ? `<p class="note ok">${view.flash}</p>` : '';
  const fix = review ? toFix(c) : 0;
  // Talent is typed straight into the panel (stored as copy_pin kind 'credit'): once drawn, the rows are left alone (only new rows get their ids), so a
  // save when a field loses focus never redraws the panel under the next click.
  const key = `${id}|${view.tab}|${view.talentKind || 'person'}|${c.status}|${view.flash || ''}`;
  if (view.tab === 'talent' && P.dataset.k === key) {
    const shown = new Set([...P.querySelectorAll('.cred')].map((r) => r.dataset.cid));
    const added = pinsFor(c, 'talent').filter((p) => !shown.has(String(p.id)));
    P.querySelectorAll('.cred[data-cid="saving"]').forEach((r, i) => { if (added[i]) r.dataset.cid = added[i].id; });
    return;
  }
  P.dataset.k = view.tab === 'talent' ? key : '';
  if (view.tab === 'check') {
    const capped = (c.rounds || 0) >= store.MAX_ROUNDS;
    const found = findingsOf(c), gone = dismissedOf(c);
    const other = view.layout === 'desktop' ? 'mobile' : 'desktop', otherN = findingsOf(c, other).filter((p) => p.layout === other).length;
    // Preserves checked before unplaced findings became answerable (2026-11-21) keep them only as text: listed with the
    // rest, without buttons.
    const older = found.some((p) => !p.blockId) ? [] : (c.findings || []).map((f) => (typeof f === 'string' ? { text: f } : f))
      .filter((f) => !f.pinned && !HIDDEN.has(f.code) && !/pixels wide|browser window/.test(f.text || ''))
      .map((f) => ({ ...f, text: f.code ? pageMessage(f.code) : f.text }));
    P.innerHTML = `<h2>Look and Feel</h2>
      <p class="fgroup">You can flag components that don’t match the look and feel of the live site, and we’ll attempt to address by refining this Preserve.</p>
      <p class="fgroup"><b>Your review</b>: Flag and describe anything that doesn’t match the look and feel of the live site.</p>
      <p>${pinButton('check', `${ic('plus')} Issue`)}</p>
      ${pinsFor(c, 'check').length ? pinList(c, 'check', {}) : ''}
      ${capped ? `<p class="note">We’ve refined this Preserve as far as we can for now. What’s still off is logged, and we’ll let you know when we can do better. You can accept it as it is, or leave it here.</p>`
        : ''}
      ${found.length || older.length || gone.length || otherN ? '<p class="fgroup"><b>Our review</b>: Let us know whether issues we identified through an automated quality check should be fixed.</p>' : ''}
      ${found.length || older.length ? `
        <ol class="pins findings">${found.map((p, i) => `<li class="${p.blockId ? '' : 'nopin'}">${p.blockId ? `<b class="ltr">${letter(i)}</b>` : ''}<span class="pbody">${esc(fText(p))}</span>${cropPair(c, p)}${p.meta?.note ? `<small class="fnote">${esc(p.meta.note)}</small>` : ''}
          <span class="row wrap">${VERDICTS.map(([v, t]) => `<button class="chip ${verdictOf(p) === v ? 'on' : ''}" data-verdict="${v}" data-fid="${p.id}">${t}</button>`).join('')}${p.blockId ? `<button class="link" data-goto="${esc(p.blockId)}" data-n="${letter(i)}">Show</button>` : ''}${verdictOf(p) === 'fix' ? `<button class="link" data-fnote="${p.id}">${p.meta?.note ? 'Edit note' : 'Add note'}</button>` : ''}${isSaved(p) ? SAVED_TICK : ''}</span></li>`).join('')}${older.map((f) => `<li class="nopin"><span class="pbody">${esc(f.text)}</span></li>`).join('')}</ol>` : ''}
      ${gone.length ? `<details class="dismissed"><summary>${cap(count(gone.length, 'issue'))} you said ${gone.length === 1 ? 'is' : 'are'} fine</summary>
        <ul class="pins findings">${gone.map((p) => `<li><span class="pbody">${esc(fText(p))}</span>
          <span class="row wrap"><button class="chip on" data-verdict="not-a-problem" data-fid="${p.id}" title="Press to ask about it again">Not an issue</button></span></li>`).join('')}</ul></details>` : ''}
      ${otherN ? `<p class="fine"><button class="link" data-l2="${other}">${count(otherN, 'more issue')} on ${other === 'mobile' ? 'Phone' : 'Desktop'} view</button></p>` : ''}
      <div class="stack"><button class="btn wide" data-t2="tour">Next: Create Tour</button>
      ${fix && !capped ? `<button class="btn wide secondary" id="refine">Refine Preserve (${plural(fix, 'issue')} to fix)</button>
        <p class="fine">We’ll re-capture the page and focus on the spots you pinned. Check the rest once more before accepting.</p>` : ''}
</div>`;
  } else if (view.tab === 'fonts') {
    loadSubstitutes(c);
    P.innerHTML = `<h2>Fonts</h2>${fontGroups(c)}
      <div class="stack"><button class="btn wide" data-t2="check">Next: Look and Feel</button></div>`;
  } else if (view.tab === 'tour') {
    const lost = pinsFor(c, 'tour').filter((p) => view.missing.includes(p.blockId)).length;
    P.innerHTML = `${flash}<h2>Tour <span class="opt">optional</span></h2><p class="fgroup">Create a tour through your Preserve by directing visitors to components that reflect your strategic, creative, or technical work.</p>
      ${fix ? `<p class="note">${cap(count(fix, 'issue'))} ${fix === 1 ? 'is' : 'are'} waiting for refinement, but tour stops dropped on the current Preserve will carry over to refined Preserves.</p>` : ''}
      ${lost ? `<p class="note">${cap(count(lost, 'stop'))} no longer ${lost === 1 ? 'lands' : 'land'} on the page. Move ${lost === 1 ? 'it' : 'them'} below.</p>` : ''}
      <p>${pinButton('tour', `${ic('plus')} Add a stop`)}</p>
      ${pinList(c, 'tour', { edit: true })}
      ${review ? '<div class="stack"><button class="btn wide" data-t2="talent">Next: Create Talent</button></div>' : ''}`;
  } else if (view.tab === 'talent') {
    // Two kinds of Talent (Jeremy, 2026-11-18): people (individuals, agencies) and tools (Squarespace, Claude, ...).
    // The toggle picks which list is being edited; entries made before it have no type and count as people.
    const tk = view.talentKind || 'person';
    const cr = pinsFor(c, 'talent').filter((p) => talentKind(p) === tk);
    P.innerHTML = `${flash}<h2>Talent <span class="opt">optional</span></h2><p class="fgroup">Let visitors know the talent and tools that created this design.</p>
      <div class="seg tk">${TALENT_KINDS.map(([k, l]) => `<button data-tk="${k}" class="${k === tk ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="crl">${cr.map((p) => credRow(p, tk)).join('')}</div>
      <p><button class="btn small secondary" id="addcr">${ic('plus')} ${tk === 'tool' ? 'Tool' : 'Talent'}</button></p>
      ${review ? `<div class="stack">${unanswered(c).length ? `<p class="fine">Before you can accept this Preserve, you’ll need to complete the <button class="link" data-t2="fonts">Font</button> review.</p>` : ''}<button class="btn wide" id="acc" ${unanswered(c).length ? 'disabled' : ''}>Accept Preserve</button></div>` : ''}`;
  } else if (view.tab === 'share') {
    const base = store.link({ name: '' }).slice(0, -1);
    P.innerHTML = `${flash}<h2>Share</h2><label>Link <span class="fine">(click the name to change it)</span>
        <div class="linkedit"><span>${esc(base.replace(/^https?:\/\//, ''))}</span><input id="nm" value="${esc(c.name)}" spellcheck="false" aria-label="Name in the link"><span>/</span></div></label>
      <div class="row"><button class="btn small" id="cl">Copy link</button><button class="btn small secondary" id="ce">Copy embed code</button><a class="btn small secondary" href="${esc(store.link(c))}" target="_blank" rel="noopener">Open</a></div>
      <p class="fine">Old links keep working after a name change. Embed codes never change.</p>
`;
  }
  const on = (sel, f) => { const el = P.querySelector(sel); if (el) el.onclick = f; };
  P.querySelectorAll('[data-pin]').forEach((b) => (b.onclick = () => startPin(b.dataset.pin)));
  P.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => store.removePin(id, b.dataset.rm)));
  P.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => {
    // A pin placed on the other layout: switch to it, then scroll once the page is loaded.
    // Scroll to the marker itself (its letter or number), not the middle of the block it sits on: a finding about the
    // first screen sits on the whole page, whose middle is far from the marker (Jeremy, 2026-11-23).
    const go = { blockId: b.dataset.goto, n: b.dataset.n };
    if (b.dataset.layout && b.dataset.layout !== view.layout) { view.layout = b.dataset.layout; view.gotoAfter = go; copyPage(id); return; }
    frameWin()?.postMessage({ type: 'preserve-scroll-to', ...go }, '*');
  }));
  P.querySelectorAll('[data-l2]').forEach((b) => (b.onclick = () => { view.layout = b.dataset.l2; view.pinFor = null; copyPage(id); }));
  P.querySelectorAll('[data-verdict]').forEach((b) => (b.onclick = () => {
    const p = c.pins.find((x) => String(x.id) === b.dataset.fid);
    const v = verdictOf(p) === b.dataset.verdict ? null : b.dataset.verdict;   // clicking the chosen answer again clears it
    markSaved({ id: p.id });
    store.updatePin(id, p.id, { body: p.body, meta: { ...p.meta, verdict: v, marked_at: v ? new Date().toISOString() : null } });
  }));
  // A note on one of our findings (Jeremy, 2026-11-24): what the person sees, in their words. The refinement reads it
  // with our description when it picks a fix.
  P.querySelectorAll('[data-fnote]').forEach((b) => (b.onclick = () => { const p = c.pins.find((x) => String(x.id) === b.dataset.fnote); noteDialog('finding', { body: p.meta?.note || '' }, async (v) => { markSaved({ id: p.id }); await store.updatePin(id, p.id, { body: p.body, meta: { ...p.meta, note: v.body } }); }); }));
  P.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => { const p = c.pins.find((x) => String(x.id) === b.dataset.edit); noteDialog('tour', p, async (v) => { markSaved({ id: p.id }); await store.updatePin(id, p.id, { body: v.body, meta: { ...p.meta, title: v.title } }); toast('Tour stop saved'); }); }));
  P.querySelectorAll('[data-t2]').forEach((b) => (b.onclick = () => { view.tab = b.dataset.t2; view.pinFor = null; sendMode(); copyPage(id); }));
  on('#acc', () => accept(id));
  P.querySelectorAll('[data-font]').forEach((b) => (b.onclick = () => store.setFont(id, b.dataset.fid, b.dataset.font)));
  P.querySelectorAll('[data-showfont]').forEach((b) => (b.onclick = () => {
    const f = c.fonts.find((x) => x.id === b.dataset.showfont);
    if (view.fontShown === f.id) { showFont(null); copyPage(id); return; }
    frameWin()?.postMessage({ type: 'preserve-scroll-to', blockId: f.block }, '*');
    showFont(f); copyPage(id);
  }));
  P.querySelectorAll('[data-adobe]').forEach((b) => (b.onclick = () => adobeCard(c)));
  on('#refine', () => store.refine(id));
  on('#cl', () => copyText(store.link(c), 'Link'));
  on('#ce', () => embedCard(c));
  P.querySelectorAll('[data-tk]').forEach((b) => (b.onclick = () => { view.talentKind = b.dataset.tk; panel(c, review); }));
  on('#addcr', () => { $('#crl > p.fine')?.remove(); const row = document.createElement('div'); row.innerHTML = credRow(null, view.talentKind || 'person'); $('#crl').appendChild(row.firstElementChild); wireCred(id); row.remove(); $('#crl').lastElementChild.querySelector('input').focus(); });
  wireCred(id);
  const nm = $('#nm');
  if (nm) {
    const save = async () => { if (nm.value.trim() === c.name) return; const err = await store.rename(id, nm.value); toast(err || 'Link updated. The old one still works.'); if (err) nm.value = c.name; };
    nm.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nm.blur(); } if (e.key === 'Escape') { nm.value = c.name; nm.blur(); } };
    nm.onblur = save;
    nm.oninput = () => { nm.style.width = Math.max(4, nm.value.length + 1) + 'ch'; }; nm.oninput();
  }
}

// One row per font (font licensing decisions, 2026-10-26): the original's name, a before/after sample, where it shows,
// and the choices that fit who holds the license.
const FOX = 'The quick brown fox';   // capture.mjs FOX_TEXT
// The weight and capitals the lookalike is drawn in for the face the comparison shows (runner.mjs fontRows faces[].look).
// Preserves made before 2026-11-17 have neither: the original's weight, as written.
const lookOf = (f) => {
  const face = (f.faces || []).find((x) => x.look && x.weight === f.fox?.weight && x.style === f.fox?.style) || (f.faces || []).find((x) => x.look);
  return { weight: face?.look.weight || f.fox?.weight || '400', caps: !!(f.fox?.caps || face?.look.caps) };
};
const fontDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
// The Fonts step in groups, each with one line saying what it needs (Jeremy, 2026-11-23); no overview paragraph.
//   Licensed fonts: ones the owner added to their site; the person confirms their rights or picks the substitute.
//   Adobe fonts: shown with their lookalike; what the line says depends on the Adobe connection.
function fontGroups(c) {
  const shown = fontsShown(c), adobe = store.adobe?.();
  const lic = shown.filter((f) => f.holder !== 'platform'), ado = shown.filter((f) => f.holder === 'platform');
  const steps = '<button class="link" data-adobe="1">these steps</button>';
  const adoLine = !adobe ? `The following fonts require you to connect an Adobe Creative Cloud subscription or will be replaced by a substitute. To connect your account, follow ${steps}.`
    : adobe.state === 'checking' ? 'Connecting to your Adobe account. Until it’s connected, these fonts show their substitute.'
    : adobe.state === 'ok' ? 'Your Adobe account can’t show these fonts, so they will be replaced by a substitute.'
    : `We can’t reach your Adobe account, so these fonts will be replaced by a substitute. Connect again with a new token by following ${steps}.`;
  return (lic.length ? `<p class="fgroup"><b>Licensed fonts</b>: Confirm you have the right to use these fonts or select the substitute.</p>${lic.map((f) => fontRow(c, f)).join('')}` : '')
    + (ado.length ? `<p class="fgroup"><b>Adobe fonts</b>: ${adoLine}</p>${ado.map((f) => fontRow(c, f)).join('')}` : '');
}
function fontRow(c, f) {
  const adobeFont = f.holder === 'platform';
  const look = adobeFont || f.decision === 'lookalike';
  const chip = (v, t) => `<button class="chip ${f.decision === v ? 'on' : ''}" data-font="${v}" data-fid="${f.id}">${t}</button>`;
  // Fonts whose file was uploaded on this Preserve before uploads were dropped (2026-11-23) keep using it.
  const actions = adobeFont ? ''
    : f.decision === 'upload' ? `<span class="fine">Using your file ${esc(f.file)}.</span>${chip('lookalike', 'Use substitute')}`
    : `${chip('keep', 'I have the rights')}${chip('lookalike', 'Use substitute')}`;
  // "The quick brown fox" in both fonts (Jeremy, 2026-11-16): a picture of it drawn by the live site in the original
  // (capture.mjs foxPicture; Adobe files can't be shipped, pictures can), and the same words set here in the lookalike,
  // same size, weight and style. Preserves captured before that have a picture of the page's own words instead.
  const fam = (n) => `font-family:'${esc(n || '')}',sans-serif`;
  let site, alt = null;
  if (f.fox) {
    site = `<img class="fox" src="${esc(f.fox.file)}" alt="${FOX} in ${esc(f.name)}">`;
    // As the Preserve would draw it: in the weight that looks as heavy as the original (not the same number), and in
    // capitals when the site shows these words in capitals or the lookalike stands in for a capitals-only face.
    const lk = lookOf(f);
    if (f.look) alt = `<span class="fsample fox" style="${fam(f.look)};font-weight:${esc(lk.weight)};font-style:${esc(f.fox.style)}${lk.caps ? ';text-transform:uppercase' : ''}">${FOX}</span>`;
  } else {
    // A font we couldn't photograph on the live site shows its name in place of the picture.
    const words = f.text || f.name;
    site = f.sample ? `<img src="${esc(f.sample)}" alt="${esc(words)} in ${esc(f.name)}">` : `<span class="fsample">${esc(words)}</span>`;
    if (f.look) alt = `<span class="fsample" style="${fam(f.look)}">${esc(words)}</span>`;
  }
  // The second row is always the lookalike, so there's something to compare (Jeremy, 2026-11-16).
  const second = f.decision === 'upload' || !alt ? '' : `<span class="fl">${look ? `In your Preserve: ${esc(f.look)}` : `Substitute: ${esc(f.look)}`}</span>${alt}`;
  return `<div class="font ${!adobeFont && !f.decision ? 'todo' : ''}"><div class="row spread"><b>${esc(f.name)}</b><button class="link" data-showfont="${f.id}">${view.fontShown === f.id ? 'Hide on page' : 'Show on page'}</button></div>
    <div class="fsamples ${f.fox ? 'fox' : ''}"><span class="fl">${look ? 'On your site' : 'On your site and in your Preserve'}</span>${site}
      ${second}</div>
    ${actions ? `<div class="row wrap">${actions}</div>` : ''}
    ${view.fontErr?.fid === f.id ? `<p class="fine bad">${esc(view.fontErr.text)}</p>` : f.problem ? `<p class="fine bad">${esc(f.problem)}</p>` : ''}</div>`;
}
// No checkbox above Accept (Jeremy, 2026-11-23): each right is confirmed where it's given, one font at a time, and
// recorded with who and when ("I have the rights"). Accept waits only for licensed fonts that haven't been answered.
const unanswered = (c) => (c.fonts || []).filter((f) => f.holder === 'user' && !f.decision && !f.covered);
let lookLoaded = '';
function loadSubstitutes(c) {
  const fams = [...new Set(c.fonts.map((f) => f.look).filter(Boolean))].sort();
  if (!fams.length) return;
  const href = `https://fonts.googleapis.com/css2?${fams.map((f) => 'family=' + f.replace(/ /g, '+')).join('&')}&display=swap`;
  if (lookLoaded === href) return;
  lookLoaded = href;
  document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${href}">`);
  // The weight and style each comparison sets the lookalike in, one family per request: Google refuses a whole request
  // that names a weight one family lacks, and the plain request above stays as the fallback.
  for (const fm of fams) {
    const faces = [...new Set(c.fonts.filter((f) => f.look === fm && f.fox).map((f) => `${f.fox.style === 'normal' ? 0 : 1},${parseInt(lookOf(f).weight, 10) || 400}`))].sort();
    if (!faces.length || faces.join() === '0,400') continue;
    document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${fm.replace(/ /g, '+')}:ital,wght@${faces.join(';')}&display=swap">`);
  }
}

// Accept: the last step of review. Accepted Preserves can't be refined. It goes live if the plan has room for another
// live Preserve, and otherwise starts in Archived (the database decides, so two tabs can't both take the last spot).
async function accept(id) {
  const fix = toFix(store.copy(id));
  const yes = await confirmCard({ title: 'Accept this Preserve?',
    body: `After you accept, you won’t be able to change the content or structure of this Preserve, but you will still be able to edit its Tour, Talent, and custom link.${fix ? ` This Preserve has ${count(fix, 'issue')} that ${fix === 1 ? 'has' : 'have'} not been refined.` : ''}`,
    ok: 'Accept Preserve', cancel: 'Review Preserve' });
  if (!yes) { view.tab = 'check'; copyPage(id); return; }
  await store.approve(id, null);
  const c = store.copy(id);
  if (!c || c.status === 'review') return;   // the database said no (the reason was shown)
  view.tab = 'share';
  view.flash = c.status === 'archived'
    ? `Accepted. ${planFull()} This Preserve is currently Archived but can be made Live by Archiving a Live Preserve or by upgrading your plan.`
    : 'Accepted and Live. Your link and embed code are below. You can change the Tour and Talent any time.';
  copyPage(id);
}

const TALENT_KINDS = [['person', 'Talent'], ['tool', 'Tools']];  // toggle labels (Jeremy, 2026-11-23: "Talent", not "People")
const talentKind = (p) => (p.meta?.type === 'tool' ? 'tool' : 'person');
const credRow = (p, kind) => `<div class="cred" data-cid="${p?.id ?? ''}" data-kind="${kind}"><input placeholder="${kind === 'tool' ? 'Used for, e.g. Website platform' : 'Role, e.g. Photography'}" value="${esc(p?.meta?.role || '')}" data-f="role"><input placeholder="${kind === 'tool' ? 'Name, e.g. Squarespace' : 'Name'}" value="${esc(p?.body || '')}" data-f="name"><input placeholder="Link (optional)" value="${esc(p?.meta?.url || '')}" data-f="url"><button class="link" data-crm>Remove</button></div>`;
function wireCred(id) {
  app.querySelectorAll('.cred').forEach((row) => {
    const get = (f) => row.querySelector(`[data-f="${f}"]`).value.trim();
    const save = async () => {
      const name = get('name'), role = get('role'), url = get('url').replace(/^(?!https?:\/\/)(?=\S)/, 'https://');
      const pid = row.dataset.cid;
      if (!name) return;
      const meta = { role, url: url || null, type: row.dataset.kind === 'tool' ? 'tool' : 'person' };
      if (pid) await store.updatePin(id, pid, { body: name, meta });
      else { row.dataset.cid = 'saving'; await store.addPin(id, { kind: 'credit', body: name, meta }); }
      toast('Talent saved');
      row.querySelector('.saved')?.remove(); row.insertAdjacentHTML('beforeend', SAVED_TICK);
    };
    row.querySelectorAll('input').forEach((i) => { i.onchange = save; });
    row.querySelector('[data-crm]').onclick = () => { const pid = row.dataset.cid; row.remove(); if (pid && pid !== 'saving') store.removePin(id, pid); };
  });
}

// Adobe Fonts on the plan page: connected or not, and the way to disconnect (it applies to every Preserve).
function adobeSection() {
  if (!store.adobe) return '';
  const a = store.adobe();
  const state = !a ? 'Not connected. Preserves use substitutes for Adobe fonts.'
    : a.state === 'checking' ? 'Connecting…'
    : a.state === 'ok' ? 'Connected. Your Preserves show your Adobe fonts.'
    : 'We can’t reach your Adobe Fonts account, so your Preserves use substitutes for now. Check your Adobe subscription, or connect again with a new token.';
  return `<section class="card adobebox"><h2>Adobe Fonts</h2><p class="sub">${state}</p>
    <div class="row">${!a || a.state !== 'ok' ? `<button class="btn small" id="adconnect">${a ? 'Connect again' : 'Connect Adobe Fonts'}</button>` : ''}${a ? '<button class="btn small secondary" id="addisc">Disconnect</button>' : ''}</div></section>`;
}

// 5. Plan ------------------------------------------------------------------------------------------------------
function planPage() {
  const cur = store.plan();
  shell(`<div class="head"><div><h1>Your plan</h1><p class="sub">You have ${count(store.liveCount(), 'Live Preserve')}.</p></div></div>
    <section class="plans">${PLANS.map((p) => `<div class="plan ${p.id === cur.id ? 'cur' : ''}"><h2>${p.name}</h2><div class="price">${p.price ? `$${p.price}<small>/month</small>` : 'Free'}</div><p>${p.blurb}</p>
      ${p.id === cur.id ? '<span class="pill ok">Current plan</span>' : `<button class="btn ${p.price > cur.price ? '' : 'secondary'}" data-p="${p.id}">${p.price > cur.price ? 'Upgrade' : 'Downgrade'}</button>`}</div>`).join('')}</section>
    <p class="fine">Payment, receipts and card changes are handled by Stripe. <button class="link" id="portal">Manage billing</button> · Prices are placeholders.</p>
    ${adobeSection()}`, { back: '#/' });
  if ($('#adconnect')) $('#adconnect').onclick = () => adobeCard(null);
  if ($('#addisc')) $('#addisc').onclick = async () => {
    if (await confirmCard({ title: 'Disconnect Adobe Fonts?', body: 'All your Preserves switch to substitutes for Adobe fonts. Connect again any time to bring your Adobe fonts back.', ok: 'Disconnect', danger: true })) { store.disconnectAdobe(); toast('Disconnected. Your Preserves use substitutes now.'); }
  };
  app.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => {
    const p = PLANS.find((x) => x.id === b.dataset.p);
    const over = store.liveCount() - p.copies;
    const msg = p.price > cur.price ? `Upgrade to ${p.name} for $${p.price}/month? (In the real app this opens Stripe checkout.)`
      : `Switch to ${p.name}? It takes effect at the end of this billing period.` + (over > 0 ? `\n\n${p.name} provides for ${count(p.copies, 'Live Preserve')}, so ${num(over)} of yours will be Archived then: their links will show “preview paused”. Nothing is deleted, and you can choose which Preserves stay Live or make them Live again by upgrading.` : '');
    if (confirm(msg)) { store.setPlan(p.id); toast(`You’re on ${p.name}.`); }
  }));
  $('#portal').onclick = () => alert('In the real app this opens Stripe’s billing page for your card, invoices and cancelling.');
}

let routeWaiting = false;
function route() {
  if ($('#cdlg')?.open) { routeWaiting = true; return; }   // redrawn when the confirmation card closes
  if (store.ready && !store.ready()) { app.innerHTML = '<div class="signin"><div class="spin big"></div></div>'; return; }
  if (!store.me()) return signIn();
  const h = location.hash.slice(1) || '/';
  if (h === '/new') return newCopy();
  if (h === '/plan') return planPage();
  if (h.startsWith('/copy/')) return copyPage(h.split('/')[2]);
  if (h !== '/') location.hash = '#/';
  dashboard();
}
addEventListener('hashchange', () => { justMade = null; view.pinFor = null; view.flash = null; route(); });
store.onChange(route);
route();

// A browser tab left open keeps running the version it first loaded. When the person comes back to the tab and a newer
// version has been published, reload it (unless a note is being written).
const FILES = ['app.js', 'app.css', 'store-supabase.js'];
const versionTag = async () => { try { return (await Promise.all(FILES.map((f) => fetch(f, { method: 'HEAD', cache: 'no-store' }).then((r) => r.headers.get('etag') || '')))).join('|'); } catch { return ''; } };
let loadedTag = '';
versionTag().then((t) => (loadedTag = t));
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !loadedTag.replace(/\|/g, '')) return;
  const t = await versionTag();
  if (t && t !== loadedTag && !$('#dlg')?.open) location.reload();
});
