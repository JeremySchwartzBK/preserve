// Preserve app screens: sign in, dashboard, new copy, review (pinned notes, tour, credits), copy details, plan.
// Plain JS, no build step. Routes: #/ dashboard, #/new, #/copy/<id>, #/plan.
import { store, PLANS } from './store.js';
import { GOOGLE } from './config.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const toast = (t) => { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2200); };
const copyText = async (t, what) => { try { await navigator.clipboard.writeText(t); toast(`${what} copied`); } catch { prompt(`Copy the ${what.toLowerCase()}:`, t); } };
const when = (iso) => { const d = (Date.now() - Date.parse(iso)) / 1000; return d < 60 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`; };
const STATUS = { processing: ['Copying…', 'busy'], review: ['Ready to review', 'attn'], ready: ['Live', 'ok'], paused: ['Paused', 'muted'], archived: ['Archived', 'muted'], failed: ['Couldn’t copy', 'bad'] };
const thumb = (c) => ['minaab', 'breathpod', 'kosa', 'designforward', 'xanadu'].find((s) => c.url.includes(s.replace('kosa', 'kosa.squarespace'))) || null;

function shell(body, { back } = {}) {
  const unread = store.notifications().filter((n) => !n.read).length;
  app.innerHTML = `<header class="top"><a href="#/" class="brand">Preserve</a>
    <nav>${back ? `<a href="${back}" class="back">← Back</a>` : ''}<a href="#/plan">${esc(store.plan().name)} plan</a>
    <button class="bell" id="bell" aria-label="Notifications">🔔${unread ? `<span>${unread}</span>` : ''}</button>
    <button class="link" id="out">Sign out</button></nav></header>
    <div id="notes" class="pop" hidden>${store.notifications().length ? store.notifications().slice(0, 8).map((n) => `<a href="#/copy/${n.copy}" class="${n.read ? '' : 'unread'}">${esc(n.text)}<small>${when(n.at)}</small></a>`).join('') : '<p>No notifications yet.</p>'}</div>
    <main>${body}</main>
    ${store.real ? '' : '<div class="demo-bar">Demo: everything here is stored only in this browser, and new copies are simulated. <button class="link" id="reset">Reset demo</button></div>'}`;
  $('#out').onclick = async () => { await store.signOut(); location.hash = '#/'; };
  if ($('#reset')) $('#reset').onclick = () => { store.reset(); location.hash = '#/'; };
  $('#bell').onclick = () => { const p = $('#notes'); p.hidden = !p.hidden; if (!p.hidden) setTimeout(() => store.markRead(), 1500); };
}

// 1. Sign in ---------------------------------------------------------------------------------------------------
function signIn() {
  app.innerHTML = `<div class="signin"><div class="card narrow">
    <h1>Preserve</h1><p class="lede">Live, interactive copies of the sites you’ve designed, for your portfolio. Fast, private, and they never break.</p>
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
function dashboard() {
  const cs = store.copies().filter((c) => c.status !== 'archived');
  const archived = store.copies().filter((c) => c.status === 'archived');
  const plan = store.plan();
  const card = (c) => {
    const [label, tone] = STATUS[c.status];
    const t = thumb(c);
    return `<article class="copy">
      <a href="#/copy/${c.id}" class="shot">${t ? `<img src="thumbs/${t}.webp" alt="" loading="lazy">` : `<div class="noshot">${esc(c.title)}</div>`}${c.status === 'processing' ? `<div class="veil"><div class="spin"></div>${esc(c.stepNames?.[c.step] || 'Starting')}…</div>` : ''}</a>
      <div class="meta"><a href="#/copy/${c.id}" class="title">${esc(c.title)}</a><span class="pill ${tone}">${label}</span></div>
      <div class="sub">${esc(new URL(c.url).hostname.replace(/^www\./, ''))} · ${when(c.created)}</div>
      ${c.status === 'ready' ? `<div class="actions"><button class="btn small" data-link="${c.id}">Copy link</button><button class="btn small secondary" data-embed="${c.id}">Copy embed code</button></div>`
        : c.status === 'review' ? `<div class="actions"><a class="btn small" href="#/copy/${c.id}">Review copy</a></div>`
        : c.status === 'failed' ? `<p class="sub">${esc(c.message || '')}</p>` : ''}
    </article>`;
  };
  shell(`<div class="head"><div><h1>Your copies</h1><p class="sub">${plan.copies >= 100000 ? `${store.liveCount()} copies · ${esc(plan.name)} plan` : `${store.liveCount()} of ${plan.copies} on your ${esc(plan.name)} plan`}</p></div><a href="#/new" class="btn">+ New copy</a></div>
    <section class="grid">${cs.map(card).join('') || '<p>No copies yet. Make your first one.</p>'}</section>
    ${archived.length ? `<details class="arch"><summary>Archived (${archived.length})</summary><section class="grid">${archived.map(card).join('')}</section></details>` : ''}`);
  app.querySelectorAll('[data-link]').forEach((b) => (b.onclick = () => copyText(store.link(store.copy(b.dataset.link)), 'Link')));
  app.querySelectorAll('[data-embed]').forEach((b) => (b.onclick = () => copyText(store.embed(store.copy(b.dataset.embed)), 'Embed code')));
}

// 3. New copy --------------------------------------------------------------------------------------------------
function newCopy() {
  shell(`<div class="card narrow"><h1>New copy</h1><p class="lede">Paste the address of a Squarespace page you designed. We’ll copy that page as it looks right now, on phone and desktop.</p>
    <form id="f"><label>Page address<input id="u" placeholder="https://www.clientsite.com/" required autofocus></label>
    <p class="err" id="err" hidden></p><button class="btn wide">Make the copy</button></form>
    <p class="fine">Takes a few minutes. You can leave this page; we’ll let you know here (and soon by email) when it’s ready to review.${store.real ? '' : ' Try one of the test sites: minaab.com, breathpod.com, xanadu.nyc.'}</p></div>`, { back: '#/' });
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const r = await store.create($('#u').value.trim());
    if (r.error) { $('#err').textContent = r.error; $('#err').hidden = false; return; }
    app.querySelector('main').innerHTML = `<div class="card narrow center"><div class="spin big"></div><h1>We’re on it</h1><p class="lede">Your copy is being made. It usually takes a few minutes, and you don’t need to keep this page open. We’ll notify you when it’s ready to review.</p><a class="btn" href="#/">Back to your copies</a></div>`;
  };
}

// 4. One copy: processing / review / live --------------------------------------------------------------------
// The preview frame is built once per copy and layout and then left alone, so saving a note, adding a tour stop or
// a background refresh never reloads it or scrolls it back to the top; only the side panel is redrawn.
// Desktop is shown at a real 1440px desktop width, scaled down to fit, so the copy lays out as it would on a monitor.
const DESKTOP_W = 1440, PHONE_W = 390;
let view = { id: null, layout: innerWidth < 700 ? 'mobile' : 'desktop', tab: null, pinFor: null, frameKey: null, flash: null };
const KIND_FOR = { check: 'issue', report: 'issue', tour: 'tour' };

function copyPage(id) {
  const c = store.copy(id);
  if (!c || c.status === 'deleted') { location.hash = '#/'; return; }
  if (view.id !== id) view = { ...view, id, tab: null, pinFor: null, frameKey: null, flash: null };
  if (c.status === 'processing') {
    view.frameKey = null;
    shell(`<div class="card narrow"><h1>${esc(c.title)}</h1><p class="sub">${esc(c.url)}</p>
      <ol class="steps">${(c.stepNames || []).map((s, i) => `<li class="${i < c.step ? 'done' : i === c.step ? 'now' : ''}">${esc(s)}</li>`).join('')}</ol>
      <p class="fine">You can leave this page. We’ll notify you when it’s ready.</p></div>`, { back: '#/' });
    return;
  }
  if (c.status === 'failed') {
    view.frameKey = null;
    shell(`<div class="card narrow"><h1>We couldn’t copy this page yet</h1><p class="lede">${esc(c.message || 'This site contains elements our system can’t process yet. We’ve logged the gap and will be in touch when we can handle this site.')}</p><button class="btn secondary" id="del">Remove</button></div>`, { back: '#/' });
    $('#del').onclick = async () => { await store.remove(id); location.hash = '#/'; };
    return;
  }
  const review = c.status === 'review';
  const tabs = review ? [['check', '1. Check the copy'], ['tour', '2. Tour'], ['credits', '3. Credits']]
    : [['share', 'Share'], ['tour', 'Tour'], ['credits', 'Credits'], ['report', 'Report'], ['manage', 'Manage']];
  if (!tabs.some((t) => t[0] === view.tab)) view.tab = tabs[0][0];
  const key = `${id}|${view.layout}`;
  if (view.frameKey !== key || !$('#fr')) {
    view.frameKey = key;
    // Title, link and the preview controls share one row so the preview starts high and gets the height.
    shell(`<div class="head copyhead"><div class="ttlwrap"><h1 id="ttl"></h1><p class="sub"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></p></div>
          <div class="toolbar"><span class="hint" id="hint"></span><div class="seg"><button data-l="desktop" class="${view.layout === 'desktop' ? 'on' : ''}">Desktop</button><button data-l="mobile" class="${view.layout === 'mobile' ? 'on' : ''}">Phone</button></div>
            <button class="btn small secondary" id="expand">${view.wide ? 'Show panel' : 'Hide panel'}</button></div></div>
      <div class="split ${view.wide ? 'wide' : ''}">
        <div class="stage">
          <div class="frame ${view.layout}" id="fw"><iframe id="fr" src="${store.view}/c/${c.id}/${view.layout}?review=1" title="Copy preview"></iframe></div>
        </div>
        <aside class="side"><nav class="tabs" id="tabs"></nav><div id="panel"></div></aside>
      </div>
      <dialog id="dlg"><form method="dialog" id="dlgf"></form></dialog>`, { back: '#/' });
    app.querySelectorAll('[data-l]').forEach((b) => (b.onclick = () => { view.layout = b.dataset.l; view.pinFor = null; copyPage(id); }));
    $('main').classList.add('full');
    $('#expand').onclick = () => { view.wide = !view.wide; $('.split').classList.toggle('wide', view.wide); $('#expand').textContent = view.wide ? 'Show panel' : 'Hide panel'; fitFrame(); };
    fitFrame();
    window.onmessage = (m) => onFrameMessage(m, id);
  } else {
    refreshHeader();
  }
  $('#ttl').innerHTML = `${esc(c.title)} <span class="pill ${STATUS[c.status][1]}">${STATUS[c.status][0]}</span>`;
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button data-t="${k}" class="${view.tab === k ? 'on' : ''}">${l}</button>`).join('');
  app.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { view.tab = b.dataset.t; view.pinFor = null; sendMode(); copyPage(id); }));
  panel(c, review);
  $('#hint').textContent = view.pinFor ? 'Click the spot on the page. Press Esc to cancel.' : '';
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
const VERDICTS = [['fine', 'Looks fine'], ['fix', 'Needs fixing'], ['not-a-problem', 'Not a problem']];
const pinsFor = (c, tab) => c.pins.filter((p) => tab === 'tour' ? p.kind === 'tour' : tab === 'credits' ? p.kind === 'credit'
  : p.kind === 'issue' && (tab === 'report' ? !!p.meta?.report : !p.meta?.report));

function onFrameMessage(m, id) {
  if (m.source !== frameWin()) return;
  const d = m.data || {};
  const c = store.copy(id);
  if (d.type === 'preserve-ready') { sendPins(c, true); sendMode(); if (view.gotoAfter) { frameWin()?.postMessage({ type: 'preserve-scroll-to', blockId: view.gotoAfter }, '*'); view.gotoAfter = null; } }
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
const pinButton = (forWhat, label) => `<button class="btn small ${view.pinFor === forWhat ? '' : 'secondary'}" data-pin="${forWhat}">${view.pinFor === forWhat ? 'Click the spot on the page…' : label}</button>`;
const pinList = (c, tab, opts = {}) => {
  const list = pinsFor(c, tab);
  if (!list.length) return `<p class="sub">${opts.empty}</p>`;
  return `<ol class="pins ${tab === 'tour' ? 'tour' : ''}">${list.map((p) => `<li>${p.meta?.title ? `<b>${esc(p.meta.title)}</b>` : ''}<span class="pbody">${esc(p.body)}</span>
    <small>${esc([tab === 'tour' ? '' : p.layout, tab === 'check' && c.lastRoundAt && p.at <= c.lastRoundAt ? 'earlier round' : '', p.label].filter(Boolean).join(' · '))}</small>
    <span class="row"><button class="link" data-goto="${esc(p.blockId)}">Show</button>${opts.edit ? `<button class="link" data-edit="${p.id}">Edit</button>` : ''}${opts.remove !== false ? `<button class="link" data-rm="${p.id}">Remove</button>` : ''}</span></li>`).join('')}</ol>`;
};

function panel(c, review) {
  const id = c.id, P = $('#panel');
  const flash = view.flash ? `<p class="note ok">${view.flash}</p>` : '';
  if (view.tab === 'check') {
    const capped = (c.rounds || 0) >= store.MAX_ROUNDS;
    const found = findingsOf(c);
    const fresh = pinsFor(c, 'check').filter((p) => !c.lastRoundAt || p.at > c.lastRoundAt).length + c.pins.filter((p) => p.kind === 'finding' && p.meta.verdict === 'fix').length;
    const other = view.layout === 'desktop' ? 'mobile' : 'desktop', otherN = findingsOf(c, other).length;
    const listed = (c.findings || []).map((f) => (typeof f === 'string' ? { text: f } : f)).filter((f) => !f.pinned);
    P.innerHTML = `<h2>Does this look right?</h2>
      ${capped ? `<p class="note">We’ve refined this copy as far as we can for now. What’s still off is logged, and we’ll let you know when we can do better. You can publish it as it is, or leave it here.</p>`
        : c.rounds ? `<p class="note ok">Refinement ${c.rounds} is ready. Compare it with your live site again. Your earlier notes are kept below; add new ones for anything still off.</p>`
        : `<p class="sub">Compare it with your live site. If something’s off, point at it and say what’s wrong, then ask for a refinement. You can do this as many times as you need.</p>`}
      ${found.length ? `<h3>Our check flagged these</h3><p class="fine">Lettered on the ${view.layout === 'mobile' ? 'phone' : 'desktop'} page. Tell us what you think of each; you can publish without answering.</p>
        <ol class="pins findings">${found.map((p, i) => `<li><b class="ltr">${letter(i)}</b><span class="pbody">${esc(p.body)}</span>
          <span class="row wrap">${VERDICTS.map(([v, t]) => `<button class="chip ${p.meta.verdict === v ? 'on' : ''}" data-verdict="${v}" data-fid="${p.id}">${t}</button>`).join('')}<button class="link" data-goto="${esc(p.blockId)}">Show</button></span></li>`).join('')}</ol>` : ''}
      ${otherN ? `<p class="fine"><button class="link" data-l2="${other}">${otherN} more on the ${other === 'mobile' ? 'phone' : 'desktop'} view</button></p>` : ''}
      ${listed.length ? `<h3>${found.length ? 'Also noticed' : 'We noticed'}</h3><ul class="found">${listed.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>` : ''}
      <h3>Your notes</h3>${pinList(c, 'check', { empty: 'None yet.' })}
      <p>${pinButton('check', '📍 Point out a problem')}</p>
      <div class="stack"><button class="btn wide" id="ok">Looks good, publish it</button>
      ${capped ? '' : `<button class="btn wide secondary" id="refine" ${fresh ? '' : 'disabled'}>Refine with my ${fresh > 1 ? `${fresh} new notes` : fresh ? 'new note' : 'notes'}</button>
        ${fresh ? '' : `<p class="fine center">${c.rounds ? 'Add a new note, or mark a flagged item “Needs fixing”, to refine again.' : 'Point out a problem, or mark a flagged item “Needs fixing”, to refine.'}</p>`}`}
      <button class="link" id="del">Discard this copy</button></div>`;
  } else if (view.tab === 'tour') {
    P.innerHTML = `${flash}<h2>Tour <span class="opt">optional</span></h2><p class="sub">Point out design decisions. Visitors see numbered dots they can open, under a “Tour” button.</p>
      ${pinList(c, 'tour', { empty: 'No stops yet.', edit: true })}
      <p>${pinButton('tour', '+ Add a stop')}</p>
      ${review ? '<div class="stack"><button class="btn wide secondary" data-t2="credits">Next: credits</button></div>' : flash ? '<div class="stack"><button class="btn wide secondary" data-t2="credits">Next: credits</button></div>' : ''}`;
  } else if (view.tab === 'credits') {
    const cr = pinsFor(c, 'credits');
    P.innerHTML = `${flash}<h2>Credits <span class="opt">optional</span></h2><p class="sub">The people behind the site. Visitors see them under “Credits”.</p>
      <div id="crl">${cr.map((p) => credRow(p)).join('')}</div>
      <p><button class="btn small secondary" id="addcr">+ Add a credit</button></p>
      ${review ? '<div class="stack"><button class="btn wide" data-t2="check">Back to checking, then publish</button></div>'
        : flash ? '<div class="stack"><a class="btn wide" href="#/" id="done">Done</a></div>' : ''}`;
  } else if (view.tab === 'share') {
    const base = store.link({ name: '' }).slice(0, -1);
    P.innerHTML = `<h2>Share</h2><label>Link <span class="fine">(click the name to change it)</span>
        <div class="linkedit"><span>${esc(base.replace(/^https?:\/\//, ''))}</span><input id="nm" value="${esc(c.name)}" spellcheck="false" aria-label="Name in the link"><span>/</span></div></label>
      <div class="row"><button class="btn small" id="cl">Copy link</button><button class="btn small secondary" id="ce">Copy embed code</button><a class="btn small secondary" href="${esc(store.link(c))}" target="_blank" rel="noopener">Open</a></div>
      <p class="fine">Old links keep working after a name change. Embed codes never change.</p>
`;
  } else if (view.tab === 'report') {
    P.innerHTML = `<h2>Report a problem</h2><p class="sub">Point at the spot that isn’t working and tell us what’s wrong.</p>
      <p>${pinButton('report', '📍 Point out a problem')}</p>
      <h3>Reported</h3>${pinList(c, 'report', { empty: 'Nothing reported yet.', remove: false })}`;
  } else {
    P.innerHTML = `<h2>Manage</h2><div class="row wrap"><button class="btn small secondary" id="arch">${c.status === 'archived' ? 'Restore' : 'Archive'}</button><button class="btn small danger" id="del">Delete</button></div>
      <p class="fine">Archived copies stop showing to visitors and don’t count toward your plan. Deleting removes the copy and its links for good.</p>`;
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
    const v = p.meta.verdict === b.dataset.verdict ? null : b.dataset.verdict;   // clicking the chosen answer again clears it
    store.updatePin(id, p.id, { body: p.body, meta: { ...p.meta, verdict: v, marked_at: v ? new Date().toISOString() : null } });
  }));
  P.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => { const p = c.pins.find((x) => String(x.id) === b.dataset.edit); noteDialog('tour', p, (v) => store.updatePin(id, p.id, { body: v.body, meta: { ...p.meta, title: v.title } })); }));
  P.querySelectorAll('[data-t2]').forEach((b) => (b.onclick = () => { view.tab = b.dataset.t2; copyPage(id); }));
  on('#ok', async () => { await store.approve(id); view.tab = 'tour'; view.flash = 'Published. Your link and embed code are ready under Share. You can add a tour and credits now, or any time later.'; copyPage(id); });
  on('#refine', () => store.refine(id));
  on('#del', async () => { if (confirm(review ? 'Discard this copy?' : 'Delete this copy? Its link and embeds will stop working.')) { await store.remove(id); location.hash = '#/'; } });
  on('#cl', () => copyText(store.link(c), 'Link'));
  on('#ce', () => copyText(store.embed(c), 'Embed code'));
  on('#arch', () => store.setStatus(id, c.status === 'archived' ? 'ready' : 'archived'));
  on('#done', () => { view.flash = null; });
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
    row.querySelector('[data-crm]').onclick = () => (row.dataset.cid && row.dataset.cid !== 'saving' ? store.removePin(id, row.dataset.cid) : row.remove());
  });
}

// 5. Plan ------------------------------------------------------------------------------------------------------
function planPage() {
  const cur = store.plan();
  shell(`<div class="head"><div><h1>Your plan</h1><p class="sub">You have ${store.liveCount()} live ${store.liveCount() === 1 ? 'copy' : 'copies'}.</p></div></div>
    <section class="plans">${PLANS.map((p) => `<div class="plan ${p.id === cur.id ? 'cur' : ''}"><h2>${p.name}</h2><div class="price">${p.price ? `$${p.price}<small>/month</small>` : 'Free'}</div><p>${p.blurb}</p>
      ${p.id === cur.id ? '<span class="pill ok">Current plan</span>' : `<button class="btn ${p.price > cur.price ? '' : 'secondary'}" data-p="${p.id}">${p.price > cur.price ? 'Upgrade' : 'Downgrade'}</button>`}</div>`).join('')}</section>
    <p class="fine">Payment, receipts and card changes are handled by Stripe. <button class="link" id="portal">Manage billing</button> · Prices are placeholders.</p>`, { back: '#/' });
  app.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => {
    const p = PLANS.find((x) => x.id === b.dataset.p);
    const over = store.liveCount() - p.copies;
    const msg = p.price > cur.price ? `Upgrade to ${p.name} for $${p.price}/month? (In the real app this opens Stripe checkout.)`
      : `Switch to ${p.name}? It takes effect at the end of this billing period.` + (over > 0 ? `\n\n${p.name} includes ${p.copies} live ${p.copies === 1 ? 'copy' : 'copies'}, so ${over} of yours will be archived then: their links will show “preview paused”. Nothing is deleted, and you can choose which copies stay live or restore them by upgrading again.` : '');
    if (confirm(msg)) { store.setPlan(p.id); toast(`You’re on ${p.name}.`); }
  }));
  $('#portal').onclick = () => alert('In the real app this opens Stripe’s billing page for your card, invoices and cancelling.');
}

function route() {
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
