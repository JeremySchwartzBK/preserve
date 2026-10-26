// Preserve app screens: sign in, dashboard, new Preserve, review (look and feel, tour, credits, accept), Preserve details, plan.
// (A "Preserve" is what the code calls a copy; the word copy stays out of what people read, where it reads as page text.)
// Plain JS, no build step. Routes: #/ dashboard, #/new, #/copy/<id>, #/plan.
import { store, PLANS } from './store.js';
import { GOOGLE } from './config.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const toast = (t) => { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2200); };
const copyText = async (t, what) => { try { await navigator.clipboard.writeText(t); toast(`${what} copied`); } catch { prompt(`Copy the ${what.toLowerCase()}:`, t); } };
const when = (iso) => { const d = (Date.now() - Date.parse(iso)) / 1000; return d < 60 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`; };
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const STATUS = { processing: ['Pending', 'busy'], review: ['Ready to review', 'attn'], ready: ['Live', 'ok'], paused: ['Paused', 'muted'], archived: ['Archived', 'muted'], failed: ['Couldn’t preserve', 'bad'] };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const thumb = (c) => ['minaab', 'breathpod', 'kosa', 'designforward', 'xanadu'].find((s) => c.url.includes(s.replace('kosa', 'kosa.squarespace'))) || null;

function shell(body, { back } = {}) {
  const unread = store.notifications().filter((n) => !n.read).length;
  app.innerHTML = `<header class="top"><a href="#/" class="brand">Preserve</a>
    <nav>${back ? `<a href="${back}" class="back">← Back</a>` : ''}<a href="#/plan">${esc(store.plan().name)} plan</a>
    <button class="bell" id="bell" aria-label="Notifications">🔔${unread ? `<span>${unread}</span>` : ''}</button>
    <button class="link" id="out">Sign out</button></nav></header>
    <div id="notes" class="pop" hidden>${store.notifications().length ? store.notifications().slice(0, 8).map((n) => `<a href="#/copy/${n.copy}" class="${n.read ? '' : 'unread'}">${esc(n.text)}<small>${when(n.at)}</small></a>`).join('') : '<p>No notifications yet.</p>'}</div>
    <main>${body}</main>
    <dialog id="cdlg"></dialog>
    ${store.real ? '' : '<div class="demo-bar">Demo: everything here is stored only in this browser, and new Preserves are simulated. <button class="link" id="reset">Reset demo</button></div>'}`;
  $('#out').onclick = async () => { await store.signOut(); location.hash = '#/'; };
  if ($('#reset')) $('#reset').onclick = () => { store.reset(); location.hash = '#/'; };
  $('#bell').onclick = () => { const p = $('#notes'); p.hidden = !p.hidden; if (!p.hidden) setTimeout(() => store.markRead(), 1500); };
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
const confirmDelete = () => confirmCard({ title: 'Delete this Preserve?', body: 'Deleting is permanent and can’t be undone. Its link and embed code will stop working.', ok: 'Delete', danger: true });

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
  shell(`<div class="head"><div><h1>Your Preserves</h1><p class="sub" id="cap"></p></div><a href="#/new" class="btn">+ New Preserve</a></div>
    <div class="dashbar"><input id="dashq" type="search" placeholder="Search by site name or address" value="${esc(dash.q)}" aria-label="Search your Preserves">
      <div class="seg" id="filt">${FILTERS.map(([k, l]) => `<button data-f="${k}" class="${dash.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <section class="grid" id="list"></section><nav class="pager" id="pager"></nav>`);
  $('#dashq').oninput = () => { dash.q = $('#dashq').value; dash.page = 0; drawList(); };
  app.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { dash.filter = b.dataset.f; dash.page = 0; app.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); drawList(); }));
  drawList();
}

function drawList() {
  const plan = store.plan();
  $('#cap').textContent = plan.copies >= 100000 ? `${plural(store.liveCount(), 'live Preserve')} · ${plan.name} plan` : `${store.liveCount()} of ${plan.copies} live on your ${plan.name} plan`;
  const q = dash.q.trim().toLowerCase();
  const all = store.copies().filter((c) => c.status !== 'deleted').sort((a, b) => b.created.localeCompare(a.created));
  const shown = all.filter((c) => inFilter(c, dash.filter) && (!q || c.title.toLowerCase().includes(q) || c.url.toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  dash.page = Math.min(dash.page, pages - 1);
  $('#list').innerHTML = shown.slice(dash.page * PAGE, (dash.page + 1) * PAGE).map(card).join('')
    || `<p class="sub">${all.length ? 'No Preserves match.' : 'No Preserves yet. Make your first one.'}</p>`;
  $('#pager').innerHTML = pages > 1 ? `<button class="btn small secondary" data-pg="-1" ${dash.page ? '' : 'disabled'}>← Newer</button><span class="sub">Page ${dash.page + 1} of ${pages}</span><button class="btn small secondary" data-pg="1" ${dash.page < pages - 1 ? '' : 'disabled'}>Older →</button>` : '';
  app.querySelectorAll('[data-pg]').forEach((b) => (b.onclick = () => { dash.page += +b.dataset.pg; drawList(); scrollTo(0, 0); }));
  app.querySelectorAll('[data-link]').forEach((b) => (b.onclick = () => copyText(store.link(store.copy(b.dataset.link)), 'Link')));
  app.querySelectorAll('[data-embed]').forEach((b) => (b.onclick = () => copyText(store.embed(store.copy(b.dataset.embed)), 'Embed code')));
  app.querySelectorAll('[data-live]').forEach((b) => (b.onchange = async () => {
    const err = await store.setStatus(b.dataset.live, b.checked ? 'ready' : 'archived');
    if (err) { b.checked = !b.checked; toast(err); } else toast(b.checked ? 'Live again' : 'Archived. Its link now shows “preview paused”.');
  }));
  app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDelete()) { await store.remove(b.dataset.del); toast('Deleted'); } }));
}

function card(c) {
  const [label, tone] = STATUS[c.status] || ['', 'muted'];
  const t = thumb(c);
  const accepted = ['ready', 'paused', 'archived'].includes(c.status);
  const del = `<button class="link danger" data-del="${c.id}">Delete</button>`;
  return `<article class="copy">
    <a href="#/copy/${c.id}" class="shot">${t ? `<img src="thumbs/${t}.webp" alt="" loading="lazy">` : `<div class="noshot">${esc(c.title)}</div>`}${c.status === 'processing' ? `<div class="veil"><div class="spin"></div>${esc(c.stepNames?.[c.step] || 'Starting')}…</div>` : ''}</a>
    <div class="meta"><a href="#/copy/${c.id}" class="title">${esc(c.title)}</a><span class="pill ${tone}">${label}</span></div>
    <div class="sub">${esc(hostOf(c))} · ${day(c.created)}</div>
    ${accepted ? `<div class="actions"><button class="btn small" data-link="${c.id}">Copy link</button><button class="btn small secondary" data-embed="${c.id}">Copy embed code</button></div>
      <div class="actions minor"><label class="switch"><input type="checkbox" data-live="${c.id}" ${c.status === 'archived' ? '' : 'checked'}><span class="knob"></span><span class="on">Live</span><span class="off">Archived</span></label>
        <a class="link" href="#/copy/${c.id}">Review</a>${del}</div>`
      : c.status === 'review' ? `<div class="actions"><a class="btn small" href="#/copy/${c.id}">Review</a></div><div class="actions minor">${del}</div>`
      : c.status === 'failed' ? `<p class="sub">${esc(c.message || '')}</p><div class="actions minor">${del}</div>` : ''}
  </article>`;
}

// 3. New Preserve ----------------------------------------------------------------------------------------------
function newCopy() {
  shell(`<div class="card narrow"><h1>New Preserve</h1><p class="lede">Paste the address of a Squarespace page you designed. We’ll preserve that page as it looks right now, on phone and desktop.</p>
    <form id="f"><label>Page address<input id="u" placeholder="https://www.clientsite.com/" required autofocus></label>
    <p class="err" id="err" hidden></p><button class="btn wide">Create Preserve</button></form>
    <p class="fine">Takes a few minutes. You can leave this page; we’ll let you know here (and soon by email) when it’s ready to review.${store.real ? '' : ' Try one of the test sites: minaab.com, breathpod.com, xanadu.nyc.'}</p></div>`, { back: '#/' });
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const r = await store.create($('#u').value.trim());
    if (r.error) { $('#err').textContent = r.error; $('#err').hidden = false; return; }
    app.querySelector('main').innerHTML = `<div class="card narrow center"><div class="spin big"></div><h1>We’re on it</h1><p class="lede">Your Preserve is being made. It usually takes a few minutes, and you don’t need to keep this page open. We’ll notify you when it’s ready to review.</p><a class="btn" href="#/">Back to your Preserves</a></div>`;
  };
}

// 4. One Preserve: pending / review / live --------------------------------------------------------------------
// The preview frame is built once per copy and layout and then left alone, so saving a note, adding a tour stop or
// a background refresh never reloads it or scrolls it back to the top; only the side panel is redrawn.
// Desktop is shown at a real 1440px desktop width, scaled down to fit, so the copy lays out as it would on a monitor.
const DESKTOP_W = 1440, PHONE_W = 390;
let view = { id: null, layout: innerWidth < 700 ? 'mobile' : 'desktop', tab: null, pinFor: null, frameKey: null, flash: null, missing: [] };
const KIND_FOR = { check: 'issue', report: 'issue', tour: 'tour' };
// Issues waiting for a refinement: the person's own pins since the last round, plus suspected issues marked "Fix issue".
const toFix = (c) => pinsFor(c, 'check').filter((p) => !c.lastRoundAt || p.at > c.lastRoundAt).length + c.pins.filter((p) => p.kind === 'finding' && p.meta.verdict === 'fix').length;

function copyPage(id) {
  const c = store.copy(id);
  if (!c || c.status === 'deleted') { location.hash = '#/'; return; }
  if (view.id !== id) view = { ...view, id, tab: null, pinFor: null, frameKey: null, flash: null, missing: [] };
  if (c.status === 'processing') {
    view.frameKey = null;
    shell(`<div class="card narrow"><h1>${esc(c.title)}</h1><p class="sub">${esc(c.url)}</p>
      <ol class="steps">${(c.stepNames || []).map((s, i) => `<li class="${i < c.step ? 'done' : i === c.step ? 'now' : ''}">${esc(s)}</li>`).join('')}</ol>
      <p class="fine">You can leave this page. We’ll notify you when it’s ready.</p></div>`, { back: '#/' });
    return;
  }
  if (c.status === 'failed') {
    view.frameKey = null;
    shell(`<div class="card narrow"><h1>We couldn’t preserve this page yet</h1><p class="lede">${esc(c.message || 'This site contains elements our system can’t process yet. We’ve logged the gap and will be in touch when we can handle this site.')}</p><button class="btn secondary" id="del">Delete</button></div>`, { back: '#/' });
    $('#del').onclick = async () => { if (await confirmDelete()) { await store.remove(id); location.hash = '#/'; } };
    return;
  }
  const review = c.status === 'review';
  const tabs = review ? [['check', '1. Look and Feel'], ['tour', '2. Tour'], ['credits', '3. Credits']]
    : [['share', 'Share'], ['tour', 'Tour'], ['credits', 'Credits'], ['report', 'Report'], ['manage', 'Manage']];
  if (!tabs.some((t) => t[0] === view.tab)) view.tab = tabs[0][0];
  const key = `${id}|${view.layout}`;
  if (view.frameKey !== key || !$('#fr')) {
    view.frameKey = key;
    // Title, link and the preview controls share one row so the preview starts high and gets the height.
    shell(`<div class="head copyhead"><div class="ttlwrap"><h1 id="ttl"></h1><p class="sub"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></p></div>
          <div class="toolbar"><span class="hint" id="hint"></span><div class="seg"><button data-l="desktop" class="${view.layout === 'desktop' ? 'on' : ''}">Desktop</button><button data-l="mobile" class="${view.layout === 'mobile' ? 'on' : ''}">Phone</button></div>
            <button class="btn small secondary" id="expand"></button></div></div>
      <div class="split ${view.wide ? 'wide' : ''}">
        <div class="stage">
          <div class="frame ${view.layout}" id="fw"><iframe id="fr" src="${store.view}/c/${c.id}/${view.layout}?review=1" title="Preserve preview"></iframe></div>
        </div>
        <aside class="side"><nav class="tabs" id="tabs"></nav><div id="panel"></div></aside>
      </div>
      <dialog id="dlg"><form method="dialog" id="dlgf"></form></dialog>`, { back: '#/' });
    app.querySelectorAll('[data-l]').forEach((b) => (b.onclick = () => { view.layout = b.dataset.l; view.pinFor = null; copyPage(id); }));
    $('main').classList.add('full');
    $('#expand').onclick = () => { view.wide = !view.wide; $('.split').classList.toggle('wide', view.wide); copyPage(id); fitFrame(); };
    fitFrame();
    window.onmessage = (m) => onFrameMessage(m, id);
  } else {
    refreshHeader();
  }
  $('#ttl').innerHTML = `${esc(c.title)} <span class="pill ${STATUS[c.status][1]}">${STATUS[c.status][0]}</span>`;
  $('#expand').textContent = `${view.wide ? 'Show' : 'Hide'} ${review ? 'review panel' : 'panel'}`;
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button data-t="${k}" class="${view.tab === k ? 'on' : ''}">${l}</button>`).join('');
  app.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { view.tab = b.dataset.t; view.pinFor = null; sendMode(); copyPage(id); }));
  panel(c, review);
  $('#hint').textContent = !view.pinFor ? '' : view.pinFor === 'check' || view.pinFor === 'report' ? 'To report an issue, drop a pin and describe the issue. Press Esc to cancel.'
    : 'Click the spot on the page. Press Esc to cancel.';
  sendPins(c);
}

// Re-render only the header bits that shell() would otherwise redraw (notifications, plan).
function refreshHeader() {
  const unread = store.notifications().filter((n) => !n.read).length;
  const bell = $('#bell'); if (bell) bell.innerHTML = `🔔${unread ? `<span>${unread}</span>` : ''}`;
}

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
function sendMode() { frameWin()?.postMessage({ type: 'preserve-pin-mode', on: !!view.pinFor }, '*'); }
let lastPins = '';
function sendPins(c, force) {
  const kind = KIND_FOR[view.tab];
  const list = kind ? pinsFor(c, view.tab) : [];
  const pins = list.filter((p) => kind === 'tour' || p.layout === view.layout || !p.layout).map((p) => ({ kind: p.kind, blockId: p.blockId, x: p.x, y: p.y, body: p.body, n: list.indexOf(p) + 1 }));
  // While checking, the quality check's findings show too, lettered A, B, C… (grey once marked).
  if (view.tab === 'check') findingsOf(c).forEach((p, i) => { if (true) pins.push({ kind: p.meta.verdict ? 'finding-done' : 'finding', blockId: p.blockId, x: p.x, y: p.y, body: p.body, n: letter(i) }); });
  const key = JSON.stringify(pins);
  if (key === lastPins && !force) return;   // unchanged: don't touch the page
  lastPins = key;
  frameWin()?.postMessage({ type: 'preserve-pins', pins }, '*');
}
// Findings for the layout on screen, top to bottom (lettered in that order, on the page and in the list).
const findingsOf = (c, layout = view.layout) => c.pins.filter((p) => p.kind === 'finding' && p.layout === layout).sort((a, b) => (a.meta.pageY ?? 1e9) - (b.meta.pageY ?? 1e9) || a.sort - b.sort);
const letter = (i) => String.fromCharCode(65 + (i % 26));
// The person's answer for each suspected issue (Jeremy, 2026-10-26). 'fine' is the older "Looks fine" answer.
const VERDICTS = [['ignore', 'Ignore issue'], ['fix', 'Fix issue'], ['not-a-problem', 'Not an issue']];
const verdictOf = (p) => (p.meta.verdict === 'fine' ? 'not-a-problem' : p.meta.verdict);
const pinsFor = (c, tab) => c.pins.filter((p) => tab === 'tour' ? p.kind === 'tour' : tab === 'credits' ? p.kind === 'credit'
  : p.kind === 'issue' && (tab === 'report' ? !!p.meta?.report : !p.meta?.report));

function onFrameMessage(m, id) {
  if (m.source !== frameWin()) return;
  const d = m.data || {};
  const c = store.copy(id);
  if (d.type === 'preserve-ready') { sendPins(c, true); sendMode(); if (view.gotoAfter) { frameWin()?.postMessage({ type: 'preserve-scroll-to', blockId: view.gotoAfter }, '*'); view.gotoAfter = null; } }
  // Pins the page couldn't place (their block isn't there, e.g. after a refinement): tour stops are marked to move.
  if (d.type === 'preserve-missing') { const k = (d.blockIds || []).join('|'); if (k !== view.missing.join('|')) { view.missing = d.blockIds || []; copyPage(id); } }
  if (d.type === 'preserve-pin' && view.pinFor?.startsWith('move:')) {
    const p = c.pins.find((x) => String(x.id) === view.pinFor.slice(5));
    view.pinFor = null; sendMode();
    if (p) store.updatePin(id, p.id, { body: p.body, meta: p.meta, blockId: d.blockId, x: d.x, y: d.y });
    copyPage(id); return;
  }
  if (d.type === 'preserve-pin' && view.pinFor) {
    const forWhat = view.pinFor;
    view.pinFor = null; sendMode(); $('#hint').textContent = '';
    noteDialog(forWhat, null, async (vals) => {
      const pin = { blockId: d.blockId, x: d.x, y: d.y, layout: d.layout, label: d.label };
      if (forWhat === 'tour') await store.addPin(id, { ...pin, kind: 'tour', body: vals.body, meta: { title: vals.title } });
      else await store.addPin(id, { ...pin, kind: 'issue', body: vals.body, meta: forWhat === 'report' ? { report: true } : {} });
      if (forWhat === 'report') toast('Thanks. We’ve logged it and will look into it.');
    });
    copyPage(id);
  }
}
addEventListener('keydown', (e) => { if (e.key === 'Escape' && view.pinFor) { view.pinFor = null; sendMode(); if (view.id) copyPage(view.id); } });

// A small form in a dialog (instead of the browser's prompt box). kind: issue | report | tour.
function noteDialog(kind, current, save) {
  const dlg = $('#dlg'), f = $('#dlgf');
  const tour = kind === 'tour';
  f.innerHTML = `<h2>${tour ? (current ? 'Edit tour stop' : 'New tour stop') : 'What’s wrong here?'}</h2>
    ${tour ? `<label>Title<input name="title" value="${esc(current?.meta?.title || '')}" placeholder="Layered hero portrait" required></label>` : ''}
    <label>${tour ? 'Note' : 'Describe it in your own words'}<textarea name="body" rows="4" required placeholder="${tour ? 'What visitors should notice here, and why it matters.' : 'For example: this slideshow doesn’t move, or the logo is the wrong color.'}">${esc(current?.body || '')}</textarea></label>
    <div class="row end"><button class="btn secondary" value="cancel" formnovalidate>Cancel</button><button class="btn" value="ok">Save</button></div>`;
  f.onsubmit = (e) => { if (e.submitter?.value !== 'ok') return; const v = Object.fromEntries(new FormData(f)); if (!v.body?.trim()) return; save({ title: (v.title || '').trim(), body: v.body.trim() }); };
  dlg.showModal();
  f.querySelector('input,textarea')?.focus();
}

function startPin(forWhat) { view.pinFor = view.pinFor === forWhat ? null : forWhat; sendMode(); copyPage(view.id); }
const pinButton = (forWhat, label) => `<button class="btn small ${view.pinFor === forWhat ? '' : 'secondary'}" data-pin="${forWhat}">${view.pinFor === forWhat ? 'Drop a pin on the page…' : label}</button>`;
const pinList = (c, tab, opts = {}) => {
  const list = pinsFor(c, tab);
  if (!list.length) return `<p class="sub">${opts.empty}</p>`;
  return `<ol class="pins ${tab === 'tour' ? 'tour' : ''}">${list.map((p) => `<li>${p.meta?.title ? `<b>${esc(p.meta.title)}</b>` : ''}<span class="pbody">${esc(p.body)}</span>
    <small>${esc([tab === 'tour' ? '' : p.layout, tab === 'check' && c.lastRoundAt && p.at <= c.lastRoundAt ? 'earlier round' : '', p.label].filter(Boolean).join(' · '))}</small>
    ${tab === 'tour' && view.missing.includes(p.blockId) ? '<small class="warn">This stop no longer lands on the page. Move it to the right spot.</small>' : ''}
    <span class="row"><button class="link" data-goto="${esc(p.blockId)}">Show</button>${opts.edit ? `<button class="link" data-edit="${p.id}">Edit</button><button class="link" data-pin="move:${p.id}">${view.pinFor === 'move:' + p.id ? 'Drop it on the page…' : 'Move'}</button>` : ''}${opts.remove !== false ? `<button class="link" data-rm="${p.id}">Remove</button>` : ''}</span></li>`).join('')}</ol>`;
};

function panel(c, review) {
  const id = c.id, P = $('#panel');
  const flash = view.flash ? `<p class="note ok">${view.flash}</p>` : '';
  const fix = review ? toFix(c) : 0;
  // Credits are typed straight into the panel: once drawn, the rows are left alone (only new rows get their ids), so a
  // save when a field loses focus never redraws the panel under the next click.
  const key = `${id}|${view.tab}|${c.status}|${view.flash || ''}`;
  if (view.tab === 'credits' && P.dataset.k === key) {
    const shown = new Set([...P.querySelectorAll('.cred')].map((r) => r.dataset.cid));
    const added = pinsFor(c, 'credits').filter((p) => !shown.has(String(p.id)));
    P.querySelectorAll('.cred[data-cid="saving"]').forEach((r, i) => { if (added[i]) r.dataset.cid = added[i].id; });
    return;
  }
  P.dataset.k = view.tab === 'credits' ? key : '';
  if (view.tab === 'check') {
    const capped = (c.rounds || 0) >= store.MAX_ROUNDS;
    const found = findingsOf(c);
    const other = view.layout === 'desktop' ? 'mobile' : 'desktop', otherN = findingsOf(c, other).length;
    const listed = (c.findings || []).map((f) => (typeof f === 'string' ? { text: f } : f)).filter((f) => !f.pinned);
    P.innerHTML = `<h2>Look and Feel</h2>
      <p class="sub">Your Preserve should look and feel like the page you submitted, but won’t contain any other functionality (for example, form submissions, e-commerce checkout, or dynamically generated content).</p>
      <p class="sub">To report an issue, click <b>Flag an issue</b>, drop a pin, and describe the issue.</p>
      <p>${pinButton('check', '+ Flag an issue')}</p>
      ${capped ? `<p class="note">We’ve refined this Preserve as far as we can for now. What’s still off is logged, and we’ll let you know when we can do better. You can accept it as it is, or leave it here.</p>`
        : c.rounds ? `<p class="note ok">Refinement ${c.rounds} is ready. Compare it with your live site again. Your earlier pins are kept below; flag anything still off.</p>` : ''}
      ${found.length ? `<h3 class="semi">For review: Suspected issues</h3><p class="fine">Our automated check identified potential issues with your Preserve for you to review. The letters correspond to pins on the Preserve.</p>
        <ol class="pins findings">${found.map((p, i) => `<li><b class="ltr">${letter(i)}</b><span class="pbody">${esc(p.body)}</span>
          <span class="row wrap">${VERDICTS.map(([v, t]) => `<button class="chip ${verdictOf(p) === v ? 'on' : ''}" data-verdict="${v}" data-fid="${p.id}">${t}</button>`).join('')}<button class="link" data-goto="${esc(p.blockId)}">Show</button></span></li>`).join('')}</ol>` : ''}
      ${otherN ? `<p class="fine"><button class="link" data-l2="${other}">${plural(otherN, 'more issue')} on ${other === 'mobile' ? 'Phone' : 'Desktop'} view</button></p>` : ''}
      ${listed.length ? `<h3 class="semi">${found.length ? 'Also noticed' : 'We noticed'}</h3><ul class="found">${listed.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>` : ''}
      <h3 class="semi">Your pins and notes</h3>${pinList(c, 'check', { empty: 'None yet.' })}
      <div class="stack"><button class="btn wide" data-t2="tour">Next: Create Tour</button>
      ${fix && !capped ? `<button class="btn wide secondary" id="refine">Refine Preserve (${plural(fix, 'issue')} to fix)</button>` : ''}
      <button class="link" id="del">Delete this Preserve</button></div>`;
  } else if (view.tab === 'tour') {
    const lost = pinsFor(c, 'tour').filter((p) => view.missing.includes(p.blockId)).length;
    P.innerHTML = `${flash}<h2>Tour <span class="opt">optional</span></h2><p class="sub">Point out design decisions. Visitors see numbered dots they can open, under a “Tour” button.</p>
      ${fix ? `<p class="note">${plural(fix, 'issue')} ${fix === 1 ? 'is' : 'are'} waiting for a refinement. Tour stops carry over when the Preserve is refined.</p>` : ''}
      ${lost ? `<p class="note">${plural(lost, 'stop')} no longer ${lost === 1 ? 'lands' : 'land'} on the page. Move ${lost === 1 ? 'it' : 'them'} below.</p>` : ''}
      <p>${pinButton('tour', '+ Add a stop')}</p>
      ${pinList(c, 'tour', { empty: 'No stops yet.', edit: true })}
      ${review ? '<div class="stack"><button class="btn wide" data-t2="credits">Next: Create Credits</button></div>' : ''}`;
  } else if (view.tab === 'credits') {
    const cr = pinsFor(c, 'credits');
    P.innerHTML = `${flash}<h2>Credits <span class="opt">optional</span></h2><p class="sub">The people behind the site. Visitors see them under “Credits”.</p>
      <div id="crl">${cr.map((p) => credRow(p)).join('')}</div>
      <p><button class="btn small secondary" id="addcr">+ Add a credit</button></p>
      ${review ? '<div class="stack"><button class="btn wide" id="acc">Accept Preserve</button></div>' : ''}`;
  } else if (view.tab === 'share') {
    const base = store.link({ name: '' }).slice(0, -1);
    P.innerHTML = `${flash}<h2>Share</h2><label>Link <span class="fine">(click the name to change it)</span>
        <div class="linkedit"><span>${esc(base.replace(/^https?:\/\//, ''))}</span><input id="nm" value="${esc(c.name)}" spellcheck="false" aria-label="Name in the link"><span>/</span></div></label>
      <div class="row"><button class="btn small" id="cl">Copy link</button><button class="btn small secondary" id="ce">Copy embed code</button><a class="btn small secondary" href="${esc(store.link(c))}" target="_blank" rel="noopener">Open</a></div>
      <p class="fine">Old links keep working after a name change. Embed codes never change.</p>
`;
  } else if (view.tab === 'report') {
    P.innerHTML = `<h2>Report a problem</h2><p class="sub">To report an issue, click <b>Flag an issue</b>, drop a pin, and tell us what’s wrong.</p>
      <p>${pinButton('report', '+ Flag an issue')}</p>
      <h3 class="semi">Reported</h3>${pinList(c, 'report', { empty: 'Nothing reported yet.', remove: false })}`;
  } else {
    P.innerHTML = `<h2>Manage</h2><div class="row wrap"><button class="btn small secondary" id="arch">${c.status === 'archived' ? 'Make live' : 'Archive'}</button><button class="btn small danger" id="del">Delete</button></div>
      <p class="fine">Archived Preserves stop showing to visitors and don’t count toward your plan. Deleting is permanent.</p>`;
  }
  const on = (sel, f) => { const el = P.querySelector(sel); if (el) el.onclick = f; };
  P.querySelectorAll('[data-pin]').forEach((b) => (b.onclick = () => startPin(b.dataset.pin)));
  P.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => store.removePin(id, b.dataset.rm)));
  P.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => {
    // A pin placed on the other layout: switch to it, then scroll once the page is loaded.
    if (b.dataset.layout && b.dataset.layout !== view.layout) { view.layout = b.dataset.layout; view.gotoAfter = b.dataset.goto; copyPage(id); return; }
    frameWin()?.postMessage({ type: 'preserve-scroll-to', blockId: b.dataset.goto }, '*');
  }));
  P.querySelectorAll('[data-l2]').forEach((b) => (b.onclick = () => { view.layout = b.dataset.l2; view.pinFor = null; copyPage(id); }));
  P.querySelectorAll('[data-verdict]').forEach((b) => (b.onclick = () => {
    const p = c.pins.find((x) => String(x.id) === b.dataset.fid);
    const v = verdictOf(p) === b.dataset.verdict ? null : b.dataset.verdict;   // clicking the chosen answer again clears it
    store.updatePin(id, p.id, { body: p.body, meta: { ...p.meta, verdict: v, marked_at: v ? new Date().toISOString() : null } });
  }));
  P.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => { const p = c.pins.find((x) => String(x.id) === b.dataset.edit); noteDialog('tour', p, (v) => store.updatePin(id, p.id, { body: v.body, meta: { ...p.meta, title: v.title } })); }));
  P.querySelectorAll('[data-t2]').forEach((b) => (b.onclick = () => { view.tab = b.dataset.t2; view.pinFor = null; sendMode(); copyPage(id); }));
  on('#acc', () => accept(id));
  on('#refine', () => store.refine(id));
  on('#del', async () => { if (await confirmDelete()) { await store.remove(id); location.hash = '#/'; } });
  on('#cl', () => copyText(store.link(c), 'Link'));
  on('#ce', () => copyText(store.embed(c), 'Embed code'));
  on('#arch', async () => { const err = await store.setStatus(id, c.status === 'archived' ? 'ready' : 'archived'); if (err) toast(err); });
  on('#addcr', () => { const row = document.createElement('div'); row.innerHTML = credRow(null); $('#crl').appendChild(row.firstElementChild); wireCred(id); row.remove(); $('#crl').lastElementChild.querySelector('input').focus(); });
  wireCred(id);
  const nm = $('#nm');
  if (nm) {
    const save = async () => { if (nm.value.trim() === c.name) return; const err = await store.rename(id, nm.value); toast(err || 'Link updated. The old one still works.'); if (err) nm.value = c.name; };
    nm.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nm.blur(); } if (e.key === 'Escape') { nm.value = c.name; nm.blur(); } };
    nm.onblur = save;
    nm.oninput = () => { nm.style.width = Math.max(4, nm.value.length + 1) + 'ch'; }; nm.oninput();
  }
}

// Accept: the last step of review. Accepted Preserves can't be refined. It goes live if the plan has room for another
// live Preserve, and otherwise starts in Archived (the database decides, so two tabs can't both take the last spot).
async function accept(id) {
  const fix = toFix(store.copy(id));
  const yes = await confirmCard({ title: 'Accept this Preserve?',
    body: `Once a Preserve has been accepted, it cannot be refined.${fix ? ` You still have ${plural(fix, 'issue')} marked to fix that ${fix === 1 ? 'hasn’t' : 'haven’t'} been refined.` : ''}`,
    ok: 'Accept Preserve', cancel: 'Review Preserve' });
  if (!yes) { view.tab = 'check'; copyPage(id); return; }
  await store.approve(id);
  const c = store.copy(id);
  if (!c || c.status === 'review') return;   // the database said no (the reason was shown)
  view.tab = 'share';
  view.flash = c.status === 'archived'
    ? `Accepted. Your plan’s ${plural(store.plan().copies, 'live Preserve')} ${store.plan().copies === 1 ? 'is' : 'are'} already in use, so this one starts in Archived. Archive another one or upgrade to make it live.`
    : 'Accepted and live. Your link and embed code are below. You can change the tour and credits any time.';
  copyPage(id);
}

const credRow = (p) => `<div class="cred" data-cid="${p?.id ?? ''}"><input placeholder="Role, e.g. Photography" value="${esc(p?.meta?.role || '')}" data-f="role"><input placeholder="Name" value="${esc(p?.body || '')}" data-f="name"><input placeholder="Link (optional)" value="${esc(p?.meta?.url || '')}" data-f="url"><button class="link" data-crm>Remove</button></div>`;
function wireCred(id) {
  app.querySelectorAll('.cred').forEach((row) => {
    const get = (f) => row.querySelector(`[data-f="${f}"]`).value.trim();
    const save = async () => {
      const name = get('name'), role = get('role'), url = get('url').replace(/^(?!https?:\/\/)(?=\S)/, 'https://');
      const pid = row.dataset.cid;
      if (!name) return;
      if (pid) await store.updatePin(id, pid, { body: name, meta: { role, url: url || null } });
      else { row.dataset.cid = 'saving'; await store.addPin(id, { kind: 'credit', body: name, meta: { role, url: url || null } }); }
      toast('Credit saved');
    };
    row.querySelectorAll('input').forEach((i) => { i.onchange = save; });
    row.querySelector('[data-crm]').onclick = () => { const pid = row.dataset.cid; row.remove(); if (pid && pid !== 'saving') store.removePin(id, pid); };
  });
}

// 5. Plan ------------------------------------------------------------------------------------------------------
function planPage() {
  const cur = store.plan();
  shell(`<div class="head"><div><h1>Your plan</h1><p class="sub">You have ${plural(store.liveCount(), 'live Preserve')}.</p></div></div>
    <section class="plans">${PLANS.map((p) => `<div class="plan ${p.id === cur.id ? 'cur' : ''}"><h2>${p.name}</h2><div class="price">${p.price ? `$${p.price}<small>/month</small>` : 'Free'}</div><p>${p.blurb}</p>
      ${p.id === cur.id ? '<span class="pill ok">Current plan</span>' : `<button class="btn ${p.price > cur.price ? '' : 'secondary'}" data-p="${p.id}">${p.price > cur.price ? 'Upgrade' : 'Downgrade'}</button>`}</div>`).join('')}</section>
    <p class="fine">Payment, receipts and card changes are handled by Stripe. <button class="link" id="portal">Manage billing</button> · Prices are placeholders.</p>`, { back: '#/' });
  app.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => {
    const p = PLANS.find((x) => x.id === b.dataset.p);
    const over = store.liveCount() - p.copies;
    const msg = p.price > cur.price ? `Upgrade to ${p.name} for $${p.price}/month? (In the real app this opens Stripe checkout.)`
      : `Switch to ${p.name}? It takes effect at the end of this billing period.` + (over > 0 ? `\n\n${p.name} includes ${plural(p.copies, 'live Preserve')}, so ${over} of yours will be archived then: their links will show “preview paused”. Nothing is deleted, and you can choose which Preserves stay live or restore them by upgrading again.` : '');
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
addEventListener('hashchange', () => { view.pinFor = null; view.flash = null; route(); });
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
