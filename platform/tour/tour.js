/* Preserve page tour, as served with copies (copied from product/tour/demo/tour.js with the editor switched off). Hotspots the designer pins to parts of the copy; viewers tap them to read notes.
   Data: <script id="preserve-tour-data" type="application/json">{"site":"..","spots":[{id,sel,x,y,title,body}]}</script>
   Each spot is pinned to a Squarespace block (shared by the desktop and phone layouts) plus a point inside it,
   given as fractions of the block's width and height, so one tour works in both layouts.
   ?edit opens the editor. Drafts live in this browser only (localStorage) until the designer copies them out. */
(function () {
  var dataEl = document.getElementById('preserve-tour-data');
  if (!dataEl) return;
  var base = JSON.parse(dataEl.textContent);
  var KEY = 'preserve-tour:' + base.site;
  var params = new URLSearchParams(location.search);
  var editing = false;  // served copies: visitor view only; editing happens in the app
  var store = null;
  try { store = window.localStorage; store.getItem(KEY); } catch (e) { store = null; }
  function loadDraft() { try { var d = store && store.getItem(KEY); return d ? JSON.parse(d) : null; } catch (e) { return null; } }
  var tour = base;
  var phone = function () { return innerWidth < 768; };
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  var css = document.createElement('style');
  css.textContent = [
    '.pt-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483600;font:400 15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.pt-dot{position:absolute;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;border:2px solid #fff;background:#111;color:#fff;font:600 12px/22px system-ui,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;box-shadow:0 2px 10px rgba(0,0,0,.35);padding:0;transition:opacity .2s}',
    '.pt-dot::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid #111;animation:pt-pulse 2s ease-out infinite;pointer-events:none}',
    '.pt-dot.pt-on{background:#fff;color:#111;border-color:#111}',
    '.pt-dot.pt-on::after,.pt-quiet .pt-dot::after{animation:none;opacity:0}',
    '@keyframes pt-pulse{0%{transform:scale(1);opacity:.7}80%,100%{transform:scale(2.2);opacity:0}}',
    '@media (prefers-reduced-motion:reduce){.pt-dot::after{animation:none;opacity:0}}',
    '.pt-hidden .pt-dot{opacity:0;pointer-events:none}',
    '.pt-small .pt-dot,.pt-small .pt-pill,.pt-small .pt-card{display:none!important}',
    '.pt-menu .pt-dot,.pt-menu .pt-pill,.pt-menu .pt-card,.pt-menu .pt-panel{visibility:hidden!important}',
    '.pt-card{position:absolute;left:0;top:0;width:290px;max-width:calc(100vw - 24px);box-sizing:border-box;background:#fff;color:#111;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:16px 16px 12px;pointer-events:auto;opacity:0;transform:translateY(6px);transition:opacity .18s,transform .18s}',
    '.pt-card.pt-show{opacity:1;transform:none}',
    '.pt-card.pt-sheet{left:8px!important;right:8px;top:auto!important;bottom:8px;width:auto;max-width:none;position:fixed}',
    '.pt-step{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#666;margin:0 0 4px}',
    '.pt-title{font-weight:650;font-size:16px;margin:0 0 6px}',
    '.pt-body{margin:0 0 12px;white-space:pre-wrap}',
    '.pt-row{display:flex;gap:8px;align-items:center}',
    '.pt-row .pt-grow{flex:1}',
    '.pt-btn{font:500 14px system-ui,sans-serif;border:1px solid #ccc;background:#fff;color:#111;border-radius:999px;padding:6px 14px;cursor:pointer}',
    '.pt-btn.pt-primary{background:#111;border-color:#111;color:#fff}',
    '.pt-x{position:absolute;top:8px;right:8px;border:0;background:none;font-size:20px;line-height:1;color:#666;cursor:pointer;padding:4px 8px}',
    '.pt-pill{position:fixed;left:12px;bottom:12px;pointer-events:auto;display:flex;align-items:center;gap:8px;background:#111;color:#fff;border:0;border-radius:999px;padding:9px 16px 9px 12px;font:500 14px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);cursor:pointer}',
    '.pt-pill i{width:10px;height:10px;border-radius:50%;background:#fff;display:inline-block;box-shadow:0 0 0 3px rgba(255,255,255,.3)}',
    '.pt-pill-off{opacity:.75}',
    '.pt-pill b{font-weight:500;opacity:.55}',
    '.pt-panel{position:fixed;left:12px;bottom:62px;width:320px;max-width:calc(100vw - 24px);max-height:calc(100vh - 86px);overflow:auto;box-sizing:border-box;background:#fff;color:#111;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:6px 16px 14px;pointer-events:auto;opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}',
    '.pt-panel.pt-show{opacity:1;transform:none}',
    '.pt-panel.pt-sheet{left:8px;right:8px;bottom:8px;width:auto;max-width:none;max-height:70vh;border-radius:18px}',
    '.pt-small .pt-panel{display:none!important}',
    '.pt-tabs{display:flex;gap:4px;border-bottom:1px solid #eee;margin:0 -16px 10px;padding:0 44px 0 12px}',
    '.pt-tab{flex:0 0 auto;border:0;background:none;font:500 14px system-ui,sans-serif;color:#777;padding:12px 8px 10px;border-bottom:2px solid transparent;cursor:pointer;margin-bottom:-1px}',
    '.pt-tab[aria-selected=true]{color:#111;border-bottom-color:#111}',
    '.pt-stops{list-style:none;margin:0 0 12px;padding:0}',
    '.pt-stops button{display:flex;gap:10px;align-items:center;width:100%;text-align:left;border:0;background:none;font:inherit;color:#111;padding:8px 4px;border-radius:8px;cursor:pointer}',
    '.pt-stops button:hover{background:#f4f4f4}',
    '.pt-num{flex:0 0 22px;height:22px;border-radius:50%;background:#111;color:#fff;font:600 12px/22px system-ui,sans-serif;text-align:center}',
    '.pt-lead{margin:2px 0 12px;color:#444}',
    '.pt-credits{margin:0;padding:0}',
    '.pt-credits div{padding:9px 0;border-top:1px solid #f0f0f0}',
    '.pt-credits div:first-child{border-top:0}',
    '.pt-credits dt{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#777;margin:0 0 2px}',
    '.pt-credits dd{margin:0;font-weight:600}',
    '.pt-credits a{color:#111;text-decoration:underline;text-underline-offset:3px}',
    '.pt-crow{display:grid;grid-template-columns:1fr 1fr 1fr 28px;gap:6px;margin:0 0 6px}',
    '.pt-crow input{margin:0!important;padding:6px!important;font-size:13px!important}',
    '.pt-crow button{border:0;background:none;font-size:18px;color:#999;cursor:pointer}',
    '.pt-card input,.pt-card textarea{width:100%;box-sizing:border-box;font:inherit;border:1px solid #ccc;border-radius:8px;padding:8px;margin:0 0 8px}',
    '.pt-card textarea{min-height:90px;resize:vertical}',
    '.pt-bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);pointer-events:auto;display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:#111;color:#fff;border-radius:14px;padding:8px 10px;box-shadow:0 6px 24px rgba(0,0,0,.3);max-width:calc(100vw - 24px)}',
    '.pt-bar b{font-weight:600;margin:0 6px}',
    '.pt-bar .pt-btn{background:#222;color:#fff;border-color:#444;padding:5px 12px}',
    '.pt-bar .pt-btn.pt-act{background:#fff;color:#111}',
    '.pt-hint{position:fixed;top:64px;left:50%;transform:translateX(-50%);background:rgba(17,17,17,.85);color:#fff;border-radius:999px;padding:6px 14px;font-size:13px;pointer-events:none}',
    '.pt-adding,.pt-adding *{cursor:crosshair!important}',
    '.pt-phone{position:fixed;right:12px;bottom:12px;width:390px;height:min(760px,calc(100vh - 90px));border:10px solid #111;border-radius:34px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.35);pointer-events:auto;overflow:hidden}',
    '.pt-phone iframe{width:100%;height:100%;border:0}',
    '.pt-missing{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);background:#b3261e;color:#fff;border-radius:10px;padding:6px 12px;font-size:13px;pointer-events:none}'
  ].join('\n');
  document.head.appendChild(css);

  var layer = document.createElement('div');
  layer.className = 'pt-layer';
  document.body.appendChild(layer);
  var dots = [], card = null, openIdx = -1, hidden = false;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(text, cls, fn) { var b = el('button', 'pt-btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; b.onclick = function (e) { e.stopPropagation(); fn(e); }; return b; }

  // Our clicks must never reach the copy's own handlers (or the replica notice).
  layer.addEventListener('click', function (e) { e.stopPropagation(); });

  function target(s) { try { return document.querySelector(s.sel); } catch (e) { return null; } }
  function point(s) {
    var t = target(s); if (!t) return null;
    var r = t.getBoundingClientRect(); if (!r.width && !r.height) return null;
    return { x: r.left + s.x * r.width, y: r.top + s.y * r.height };
  }

  function render() {
    dots.forEach(function (d) { d.remove(); }); dots = [];
    tour.spots.forEach(function (s, i) {
      var d = el('button', 'pt-dot', String(i + 1)); d.type = 'button';
      d.setAttribute('aria-label', 'Tour stop ' + (i + 1) + ': ' + s.title);
      d.onclick = function (e) { e.stopPropagation(); if (d._dragged) return; editing ? editSpot(i) : open(i); };
      if (editing) dragable(d, i);
      layer.appendChild(d); dots.push(d);
    });
    if (pill) pill.update();
    place();
  }

  var missing = null;
  // A dot hides when something fixed on the page (an open menu, a sticky header) sits on top of its spot.
  function covered(s, p) {
    var t = target(s); if (!t || p.x < 0 || p.x > innerWidth || p.y < 0 || p.y > innerHeight) return false;
    var stack = document.elementsFromPoint(p.x, p.y);
    for (var i = 0; i < stack.length; i++) {
      var e = stack[i];
      if (layer.contains(e)) continue;
      if (t.contains(e) || e.contains(t)) return false;
      for (var a = e; a && a !== document.body; a = a.parentElement) {
        var pos = getComputedStyle(a).position;
        if (pos === 'fixed' || pos === 'sticky') return !a.contains(t);
      }
      return false;
    }
    return false;
  }
  function place() {
    var gone = 0;
    tour.spots.forEach(function (s, i) {
      var d = dots[i]; if (!d) return;
      var p = point(s);
      if (!p) { d.style.display = 'none'; gone++; return; }
      d.style.display = '';
      d.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
      d.style.visibility = (p.y < -20 || p.y > innerHeight + 20 || covered(s, p)) ? 'hidden' : '';
    });
    // The site's own menu is open: step out of the way entirely.
    layer.classList.toggle('pt-menu', document.body.classList.contains('header--menu-open'));
    if (editing) {
      if (gone && !missing) { missing = el('div', 'pt-missing'); layer.appendChild(missing); }
      if (missing) { missing.style.display = gone ? '' : 'none'; missing.textContent = gone + ' hotspot' + (gone > 1 ? 's are' : ' is') + ' on a part of the page hidden in this layout'; }
    }
    if (card && openIdx >= 0) placeCard();
  }
  var raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; place(); }); }
  addEventListener('scroll', schedule, { passive: true });
  // Too small a window (a tiny embed) to read a card comfortably: hide the tour rather than crowd the site.
  function fit() { if (editing) return; var small = innerWidth < 300 || innerHeight < 420; layer.classList.toggle('pt-small', small); if (small) close(); }
  addEventListener('resize', function () { fit(); schedule(); });
  if (window.ResizeObserver) new ResizeObserver(schedule).observe(document.body);
  setInterval(schedule, 400); // follows reveal animations and late images

  function placeCard() {
    if (phone()) { card.classList.add('pt-sheet'); return; }
    card.classList.remove('pt-sheet');
    if (openIdx < 0) { card.style.left = Math.max(12, (innerWidth - card.offsetWidth) / 2) + 'px'; card.style.top = '110px'; return; }
    var p = point(tour.spots[openIdx]); if (!p) return;
    var w = card.offsetWidth, h = card.offsetHeight, m = 12;
    var x = p.x + 22, y = p.y - 20;
    if (x + w > innerWidth - m) x = p.x - 22 - w;
    if (x < m) x = Math.min(Math.max(m, p.x - w / 2), innerWidth - w - m);
    if (y + h > innerHeight - m) y = innerHeight - h - m;
    if (y < m) y = m;
    card.style.transform = ''; card.style.left = x + 'px'; card.style.top = y + 'px';
  }

  var panel = null;
  function closePanel() { if (panel) { panel.remove(); panel = null; } }
  function close() {
    closePanel();
    if (card) { card.remove(); card = null; }
    if (openIdx >= 0 && dots[openIdx]) dots[openIdx].classList.remove('pt-on');
    openIdx = -1;
  }
  function showCard(i, build) {
    close(); openIdx = i; if (pill) pill.update();
    if (dots[i]) dots[i].classList.add('pt-on');
    card = el('div', 'pt-card'); card.setAttribute('role', 'dialog');
    build(card);
    card.appendChild(btn('×', 'pt-x', close)).setAttribute('aria-label', 'Close');
    card.querySelector('.pt-x').className = 'pt-x';
    layer.appendChild(card);
    placeCard();
    requestAnimationFrame(function () { card && card.classList.add('pt-show'); });
  }
  function bringIntoView(i, then) {
    var p = point(tour.spots[i]);
    if (!p) return then();
    var top = phone() ? innerHeight * 0.3 : innerHeight * 0.4;
    if (p.y > 80 && p.y < innerHeight - (phone() ? 260 : 120)) return then();
    scrollTo({ top: scrollY + p.y - top, behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(then, reduce ? 50 : 550);
  }
  function open(i) {
    layer.classList.add('pt-quiet'); // stop pulsing once someone has found the notes
    bringIntoView(i, function () {
      var s = tour.spots[i], n = tour.spots.length;
      showCard(i, function (c) {
        c.appendChild(el('p', 'pt-step', 'Tour stop ' + (i + 1) + ' of ' + n));
        c.appendChild(el('p', 'pt-title', s.title));
        if (s.body) c.appendChild(el('p', 'pt-body', s.body));
        var row = el('div', 'pt-row');
        row.appendChild(el('span', 'pt-grow'));
        if (i > 0) row.appendChild(btn('Back', '', function () { open(i - 1); }));
        row.appendChild(i < n - 1 ? btn('Next', 'pt-primary', function () { open(i + 1); }) : btn('Done', 'pt-primary', close));
        c.appendChild(row);
      });
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
    if (!editing && openIdx >= 0 && e.key === 'ArrowRight' && openIdx < tour.spots.length - 1) open(openIdx + 1);
    if (!editing && openIdx >= 0 && e.key === 'ArrowLeft' && openIdx > 0) open(openIdx - 1);
  });

  // Launcher pill for viewers.
  var pill = null;
  if (!editing) {
    pill = el('button', 'pt-pill'); pill.type = 'button';
    pill.update = function () {
      var n = tour.spots.length, c = (tour.credits || []).length;
      pill.style.display = n || c ? '' : 'none';
      pill.innerHTML = '';
      pill.appendChild(el('i'));
      if (hidden) pill.appendChild(document.createTextNode('Show tour'));
      else {
        if (n) pill.appendChild(document.createTextNode('Tour'));
        if (n && c) pill.appendChild(el('b', '', '·'));
        if (c) pill.appendChild(document.createTextNode('Credits'));
      }
      pill.setAttribute('aria-expanded', panel ? 'true' : 'false');
      pill.classList.toggle('pt-pill-off', hidden);
    };
    pill.onclick = function (e) {
      e.stopPropagation();
      if (hidden) { hidden = false; layer.classList.remove('pt-hidden'); pill.update(); return; }
      if (panel) { closePanel(); pill.update(); return; }
      openPanel(tour.spots.length ? 'tour' : 'credits');
    };
    pill.oncontextmenu = function (e) { e.preventDefault(); hidden = true; close(); layer.classList.add('pt-hidden'); pill.update(); };
    layer.appendChild(pill);

    // One pill, two tabs: the tour's stop list, and the people who made the site.
    var openPanel = function (tab) {
      close();
      panel = el('div', 'pt-panel' + (phone() ? ' pt-sheet' : '')); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Tour and credits');
      var tabs = el('div', 'pt-tabs'); tabs.setAttribute('role', 'tablist');
      var body = el('div');
      var names = [];
      if (tour.spots.length) names.push(['tour', 'Tour']);
      if ((tour.credits || []).length) names.push(['credits', 'Credits']);
      names.forEach(function (t) {
        var b = btn(t[1], '', function () { show(t[0]); }); b.className = 'pt-tab'; b.setAttribute('role', 'tab'); b.dataset.tab = t[0]; tabs.appendChild(b);
      });
      function show(which) {
        [].forEach.call(tabs.children, function (b) { b.setAttribute('aria-selected', b.dataset.tab === which ? 'true' : 'false'); });
        body.innerHTML = '';
        if (which === 'tour') {
          body.appendChild(el('p', 'pt-lead', tour.spots.length + ' things the designer wants you to notice.'));
          var ol = el('ol', 'pt-stops');
          tour.spots.forEach(function (s, i) {
            var li = el('li'), b = btn('', '', function () { open(i); });
            b.className = ''; b.appendChild(el('span', 'pt-num', String(i + 1))); b.appendChild(el('span', '', s.title));
            li.appendChild(b); ol.appendChild(li);
          });
          body.appendChild(ol);
          var row = el('div', 'pt-row'); row.appendChild(el('span', 'pt-grow'));
          row.appendChild(btn('Start tour', 'pt-primary', function () { open(0); }));
          body.appendChild(row);
        } else {
          body.appendChild(el('p', 'pt-lead', 'The people behind this site.'));
          var dl = el('dl', 'pt-credits');
          tour.credits.forEach(function (c) {
            var d = el('div'); d.appendChild(el('dt', '', c.role));
            var dd = el('dd');
            if (c.url) { var a = el('a', '', c.name + ' ↗'); a.href = c.url; a.target = '_blank'; a.rel = 'noopener'; dd.appendChild(a); }
            else dd.textContent = c.name;
            d.appendChild(dd); dl.appendChild(d);
          });
          body.appendChild(dl);
        }
      }
      panel.appendChild(tabs); panel.appendChild(body);
      var x = btn('×', '', closePanel); x.className = 'pt-x'; x.setAttribute('aria-label', 'Close'); x.onclick = function (e) { e.stopPropagation(); closePanel(); pill.update(); };
      panel.appendChild(x);
      layer.appendChild(panel);
      show(names.some(function (t) { return t[0] === tab; }) ? tab : names[0][0]);
      pill.update();
      requestAnimationFrame(function () { panel && panel.classList.add('pt-show'); });
    };
    // Credit links are real links out. Keep the copy's "this is a preview" guard from swallowing them.
    window.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.pt-layer a[href]');
      if (a) e.stopImmediatePropagation();
    }, true);

  }

  render(); fit();
  if (!editing) return;

  // ---------- Editor ----------
  function save() { try { store && store.setItem(KEY, JSON.stringify(tour)); } catch (e) {} }
  function anchorAt(x, y) {
    layer.style.display = 'none';
    var hit = document.elementFromPoint(x, y);
    layer.style.display = '';
    if (!hit) return null;
    var a = hit.closest('[id^="block-"]') || hit.closest('[data-section-id]') || hit.closest('[id]');
    if (!a) return null;
    var sel = a.id ? '#' + CSS.escape(a.id) : '[data-section-id="' + a.getAttribute('data-section-id') + '"]';
    var r = a.getBoundingClientRect();
    return { sel: sel, x: +((x - r.left) / r.width).toFixed(4), y: +((y - r.top) / r.height).toFixed(4) };
  }
  function dragable(d, i) {
    d.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var sx = e.clientX, sy = e.clientY; d._dragged = false; d.setPointerCapture(e.pointerId);
      function mv(ev) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) d._dragged = true;
        if (d._dragged) d.style.transform = 'translate(' + ev.clientX + 'px,' + ev.clientY + 'px)';
      }
      function up(ev) {
        d.removeEventListener('pointermove', mv); d.removeEventListener('pointerup', up);
        if (d._dragged) {
          var a = anchorAt(ev.clientX, ev.clientY);
          if (a) { Object.assign(tour.spots[i], a); save(); }
          place(); setTimeout(function () { d._dragged = false; }, 0);
        }
      }
      d.addEventListener('pointermove', mv); d.addEventListener('pointerup', up);
    });
  }
  function editSpot(i, isNew) {
    var s = tour.spots[i];
    showCard(i, function (c) {
      c.appendChild(el('p', 'pt-step', isNew ? 'New hotspot' : 'Hotspot ' + (i + 1)));
      var t = el('input'); t.placeholder = 'Title, e.g. "Layered hero"'; t.value = s.title || '';
      var b = el('textarea'); b.placeholder = 'What should a visitor notice here?'; b.value = s.body || '';
      c.appendChild(t); c.appendChild(b);
      var row = el('div', 'pt-row');
      row.appendChild(btn('Delete', '', function () { tour.spots.splice(i, 1); save(); close(); render(); }));
      if (i > 0) row.appendChild(btn('↑', '', function () { tour.spots.splice(i - 1, 0, tour.spots.splice(i, 1)[0]); save(); close(); render(); }));
      row.appendChild(el('span', 'pt-grow'));
      row.appendChild(btn('Save', 'pt-primary', function () { s.title = t.value.trim() || 'Untitled'; s.body = b.value.trim(); save(); close(); render(); }));
      c.appendChild(row);
      setTimeout(function () { t.focus(); }, 30);
    });
  }

  function editCredits() {
    showCard(-1, function (c) {
      c.appendChild(el('p', 'pt-step', 'Credits'));
      c.appendChild(el('p', 'pt-body', 'Who else worked on this site? Visitors see these under Credits.'));
      var list = el('div'); c.appendChild(list);
      function addRow(v) {
        v = v || {};
        var r = el('div', 'pt-crow');
        [['role', 'Role'], ['name', 'Name'], ['url', 'Link (optional)']].forEach(function (f) { var i = el('input'); i.placeholder = f[1]; i.value = v[f[0]] || ''; i.dataset.f = f[0]; r.appendChild(i); });
        var x = el('button', '', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove'); x.onclick = function (e) { e.stopPropagation(); r.remove(); };
        r.appendChild(x); list.appendChild(r);
      }
      (tour.credits || []).forEach(addRow);
      if (!(tour.credits || []).length) addRow();
      var row = el('div', 'pt-row');
      row.appendChild(btn('+ Add person', '', function () { addRow(); }));
      row.appendChild(el('span', 'pt-grow'));
      row.appendChild(btn('Save', 'pt-primary', function () {
        tour.credits = [].map.call(list.children, function (r) {
          var o = {}; [].forEach.call(r.querySelectorAll('input'), function (i) { o[i.dataset.f] = i.value.trim(); });
          if (o.url && !/^https?:\/\//i.test(o.url)) o.url = 'https://' + o.url;
          if (!o.url) delete o.url;
          return o;
        }).filter(function (o) { return o.name; });
        save(); close(); flash('Credits saved');
      }));
      c.appendChild(row);
      c.style.width = '440px';
    });
  }

  var adding = false, hint = null;
  var bar = el('div', 'pt-bar');
  bar.appendChild(el('b', '', 'Tour editor'));
  var addBtn = btn('+ Add hotspot', '', function () { setAdding(!adding); });
  bar.appendChild(addBtn);
  var phoneBtn = btn('Phone preview', '', togglePhone);
  if (innerWidth >= 900) bar.appendChild(phoneBtn);
  bar.appendChild(btn('Preview as visitor', '', function () { location.href = location.pathname; }));
  bar.appendChild(btn('Credits', '', editCredits));
  bar.appendChild(btn('Copy tour data', '', function () {
    var json = JSON.stringify(tour, null, 2);
    (navigator.clipboard ? navigator.clipboard.writeText(json) : Promise.reject()).then(function () { flash('Copied'); }, function () { prompt('Tour data', json); });
  }));
  bar.appendChild(btn('Reset to sample', '', function () { if (confirm('Discard your edits and restore the sample tour?')) { try { store.removeItem(KEY); } catch (e) {} tour = JSON.parse(dataEl.textContent); close(); render(); } }));
  layer.appendChild(bar);
  function flash(text) { var h = el('div', 'pt-hint', text); layer.appendChild(h); setTimeout(function () { h.remove(); }, 1400); }
  function setAdding(on) {
    adding = on; addBtn.classList.toggle('pt-act', on);
    document.documentElement.classList.toggle('pt-adding', on);
    if (on && !hint) { hint = el('div', 'pt-hint', 'Click anywhere on the page to drop a hotspot'); layer.appendChild(hint); }
    if (!on && hint) { hint.remove(); hint = null; }
  }
  // Runs before the copy's own capture listeners, so placing a hotspot never follows a link.
  window.addEventListener('click', function (e) {
    if (layer.contains(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!adding) { close(); return; }
    var a = anchorAt(e.clientX, e.clientY); if (!a) return;
    a.id = 's' + Date.now().toString(36); a.title = ''; a.body = '';
    tour.spots.push(a); setAdding(false); save(); render(); editSpot(tour.spots.length - 1, true);
  }, true);

  var phoneFrame = null;
  function togglePhone() {
    if (phoneFrame) { phoneFrame.remove(); phoneFrame = null; phoneBtn.classList.remove('pt-act'); return; }
    phoneFrame = el('div', 'pt-phone');
    var f = document.createElement('iframe'); f.src = location.pathname.replace(/[^/]*$/, 'mobile'); f.title = 'Phone layout preview';
    phoneFrame.appendChild(f); layer.appendChild(phoneFrame); phoneBtn.classList.add('pt-act');
  }
})();
