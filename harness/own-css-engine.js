// Runs inside the copy page (own-css.mjs injects it). Works out, for every element marked data-pz, which declarations
// win the cascade from the page's stylesheets right now, with every var() replaced by its value on that element.
// Doing the cascade here, in one pass over the rules, takes about a second a page; asking DevTools element by element
// (the first probe) took two to three minutes.
//
// window.__oc.capture() -> { [pz]: { '': [[prop, value, important], ...], '::before': [...], ... } }
// window.__oc.hoverTargets(cap), captureHover(pz): the same for hover, one hovered element at a time.
// window.__oc.keyframes(names), fontFaces(), inlineVars(), breakpoints()
(() => {
  const PSEUDO_EL = /::?(before|after|first-line|first-letter|placeholder|marker|selection|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(?![\w-])/i;
  const DYNAMIC = /:(hover|active|focus|focus-visible|focus-within|visited|target)(?![\w-])/;
  const DYNAMIC_G = new RegExp(DYNAMIC.source, 'g');
  // At rest nothing is hovered, focused or active: those parts never match (so ":not(:hover)" always does).
  const atRest = (sel) => sel.replace(DYNAMIC_G, '[data-pzn]');
  const hovered = (sel) => atRest(sel.replace(/:hover(?![\w-])/g, '[data-pzh]'));

  // Split at top-level commas (not inside parentheses, brackets or quotes).
  function splitTop(s, sep) {
    const out = []; let depth = 0, q = null, cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { cur += ch; if (ch === '\\') { cur += s[++i] || ''; } else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  }

  // Selector specificity [ids, classes, types].
  function spec(sel) {
    let a = 0, b = 0, c = 0, s = sel;
    s = s.replace(/:(not|is|has|matches|-webkit-any)\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g, (_, fn, inner) => {
      let best = [0, 0, 0];
      for (const x of splitTop(inner, ',')) { const t = spec(x); if (t[0] > best[0] || (t[0] === best[0] && (t[1] > best[1] || (t[1] === best[1] && t[2] > best[2])))) best = t; }
      a += best[0]; b += best[1]; c += best[2]; return ' ';
    });
    s = s.replace(/:where\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g, ' ');
    s = s.replace(/\[[^\]]*\]/g, () => { b++; return ' '; });
    s = s.replace(/"[^"]*"|'[^']*'/g, ' ');
    s = s.replace(/#[\w-]+/g, () => { a++; return ' '; });
    s = s.replace(/::[\w-]+(\([^)]*\))?/g, () => { c++; return ' '; });
    s = s.replace(/:(before|after|first-line|first-letter)(?![\w-])/g, () => { c++; return ' '; });
    s = s.replace(/:[\w-]+(\([^)]*\))?/g, () => { b++; return ' '; });
    s = s.replace(/\.[\w-]+/g, () => { b++; return ' '; });
    s = s.replace(/(^|[\s>+~(])([a-zA-Z][\w-]*)/g, (_, p) => { c++; return p; });
    return [a, b, c];
  }
  const specNum = (t) => t[0] * 1e6 + t[1] * 1e3 + t[2];

  // Declarations as written in a rule (shorthands kept, so var() inside shorthands survives).
  function decls(style) {
    const out = [];
    for (const d of splitTop(style.cssText, ';')) {
      const i = d.indexOf(':'); if (i < 0) continue;
      const name = d.slice(0, i).trim().toLowerCase(); let v = d.slice(i + 1).trim();
      if (!name || name.startsWith('--')) continue;
      const imp = /!\s*important\s*$/i.test(v); if (imp) v = v.replace(/\s*!\s*important\s*$/i, '');
      out.push([name, v, imp]);
    }
    return out;
  }

  // url(...) relative to its stylesheet -> absolute.
  const absUrls = (v, base) => v.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => { if (/^(data:|#)/.test(u)) return m; try { return `url("${new URL(u, base).href}")`; } catch { return m; } });

  // Every style rule in order, with its conditions (media/supports), layer and parsed selectors.
  let RULES = null, KEYFRAMES = [], FONTFACES = [];
  function collect() {
    RULES = []; KEYFRAMES = []; FONTFACES = [];
    let order = 0; const layerRank = new Map();
    // parent: the enclosing style rule's selector, for CSS nesting (rules written inside a rule, as plugins do).
    const nest = (sel, parent) => {
      if (!parent) return sel;
      if (sel.includes('&')) return sel.replace(/&/g, `:is(${parent})`);
      return `:is(${parent}) ${sel}`;
    };
    const walk = (rules, base, conds, layer, parent = null) => {
      for (const r of rules) {
        const t = r.constructor.name;
        if (t === 'CSSImportRule') { if (r.styleSheet) { try { walk(r.styleSheet.cssRules, r.styleSheet.href || base, r.media && r.media.mediaText ? [...conds, ['media', r.media.mediaText]] : conds, layer); } catch {} } continue; }
        if (t === 'CSSMediaRule') { walk(r.cssRules, base, [...conds, ['media', r.media.mediaText]], layer, parent); continue; }
        if (t === 'CSSSupportsRule') { if (CSS.supports(r.conditionText)) walk(r.cssRules, base, conds, layer, parent); continue; }
        if (t === 'CSSLayerBlockRule') { const n = (layer ? layer + '.' : '') + (r.name || '#' + order); if (!layerRank.has(n)) layerRank.set(n, layerRank.size); walk(r.cssRules, base, conds, n, parent); continue; }
        if (t === 'CSSLayerStatementRule') { for (const n of r.nameList) if (!layerRank.has(n)) layerRank.set(n, layerRank.size); continue; }
        if (t === 'CSSKeyframesRule') { KEYFRAMES.push({ name: r.name, text: absUrls(r.cssText, base), conds }); continue; }
        if (t === 'CSSFontFaceRule') { FONTFACES.push(absUrls(r.cssText, base)); continue; }
        if (t === 'CSSContainerRule') { walk(r.cssRules, base, conds, layer, parent); continue; }
        if (t !== 'CSSStyleRule' && t !== 'CSSNestedDeclarations') continue;
        const ds = decls(r.style).map(([n, v, i]) => [n, absUrls(v, base), i]);
        const pos = order++;
        // Declarations after nested rules (or inside a nested @media) belong to the enclosing rule's selector.
        const own = t === 'CSSNestedDeclarations' ? (parent ? [parent] : []) : splitTop(r.selectorText, ',').map((x) => nest(x, parent));
        if (t === 'CSSStyleRule' && r.cssRules && r.cssRules.length) walk(r.cssRules, base, conds, layer, own.join(', '));
        if (!ds.length) continue;
        for (const sel of own) {
          const pm = sel.match(PSEUDO_EL);
          let pseudo = '', baseSel = sel;
          if (pm) { pseudo = '::' + pm[1].toLowerCase(); baseSel = sel.slice(0, pm.index) + sel.slice(pm.index + pm[0].length); }
          baseSel = baseSel.trim() || '*';
          if (/[>+~]\s*$/.test(baseSel)) baseSel += '*';
          const dynamic = DYNAMIC.test(baseSel);
          RULES.push({ sel: dynamic ? atRest(baseSel) : baseSel, raw: baseSel, pseudo, spec: specNum(spec(sel)), order: pos, layer, ds, conds, dynamic, hover: /:hover(?![\w-])/.test(baseSel) });
        }
      }
    };
    for (const s of document.styleSheets) { let rs; try { rs = s.cssRules; } catch { continue; } walk(rs, s.href || document.baseURI, s.media && s.media.mediaText ? [['media', s.media.mediaText]] : [], null); }
    for (const r of RULES) r.lrank = r.layer == null ? 1e9 : layerRank.get(r.layer);
    return { rules: RULES.length, keyframes: KEYFRAMES.length, fontFaces: FONTFACES.length };
  }
  const active = (conds) => conds.every(([k, v]) => k !== 'media' || matchMedia(v).matches);

  // Cascade one element's matched rules (already sorted) into its winning declarations, in cascade order.
  const SH_KEEP = { border: ['border-radius', 'border-collapse', 'border-spacing', 'border-image'] };
  function cascade(list) {
    const m = new Map(), imp = new Map();
    for (const r of list) for (const [name, v, important] of r.ds) {
      const tgt = important ? imp : m;
      for (const k of [...tgt.keys()]) if (k.startsWith(name + '-') && !(SH_KEEP[name] || []).some((x) => k.startsWith(x))) tgt.delete(k);
      tgt.delete(name); tgt.set(name, v);
    }
    for (const k of imp.keys()) m.delete(k);
    return [...m].map(([k, v]) => [k, v, false]).concat([...imp].map(([k, v]) => [k, v, true]));
  }
  const cmpNormal = (x, y) => x.lrank - y.lrank || x.spec - y.spec || x.order - y.order;

  function resolveVars(el, pseudo, v) {
    let cs = null;
    for (let g = 0; g < 500 && v.includes('var('); g++) {
      v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\((?:[^()]|\([^()]*\))*\))*))?\)/, (_, n, fb) => {
        cs = cs || getComputedStyle(el, pseudo || null);
        const x = cs.getPropertyValue(n).trim();
        return x || (fb || '').trim() || 'unset';
      });
    }
    return v;
  }

  function capture() {
    if (!RULES) collect();
    const els = [...document.querySelectorAll('[data-pz]')];
    const byEl = new Map(els.map((e) => [e, {}]));
    for (const r of RULES) {
      if (!active(r.conds)) continue;
      const sel = r.sel;
      let hits; try { hits = document.querySelectorAll(sel); } catch { continue; }
      for (const e of hits) { const o = byEl.get(e); if (!o) continue; (o[r.pseudo] ||= []).push(r); }
    }
    const out = {};
    for (const [e, o] of byEl) {
      const res = {};
      for (const ps in o) {
        const d = cascade(o[ps].sort(cmpNormal));
        if (d.length) res[ps] = d.map(([k, v, i]) => [k, v.includes('var(') ? resolveVars(e, ps, v) : v, i]);
      }
      out[e.getAttribute('data-pz')] = res;
    }
    return out;
  }

  // Where :hover can apply: for each :hover rule, the elements the hovered part of its selector picks out.
  function hoverTarget(sel) {
    sel = sel.replace(/:not\(\s*:hover\s*\)/g, '');
    const i = sel.search(/:hover(?![\w-])/); if (i < 0) return null;
    let depth = 0, end = sel.length;
    for (let k = i; k < sel.length; k++) { const ch = sel[k]; if (ch === '(' || ch === '[') depth++; else if (ch === ')' || ch === ']') depth--; else if (depth === 0 && /[\s>+~]/.test(ch)) { end = k; break; } }
    const t = sel.slice(0, end).replace(/:hover(?![\w-])/g, '').trim();
    if (!t || DYNAMIC.test(t)) return null;
    return /[>+~]\s*$/.test(t) ? t + '*' : t;
  }
  function hoverTargets(cap) {
    if (!RULES) collect();
    const set = new Set();
    for (const r of RULES) {
      if (!r.hover || !active(r.conds)) continue;
      const t = hoverTarget(r.raw); if (!t) continue;
      try { for (const e of document.querySelectorAll(t)) if (e.hasAttribute('data-pz')) set.add(e); } catch {}
    }
    const all = [...set];
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const list = all.filter(vis).concat(all.filter((e) => !vis(e))).slice(0, cap).map((e) => +e.getAttribute('data-pz'));
    return { list, total: all.length };
  }
  // Declarations of the elements a hover on element t changes, with t (and so its ancestors) hovered.
  function captureHover(t) {
    const el = document.querySelector(`[data-pz="${t}"]`);
    const marked = []; for (let x = el; x && x.nodeType === 1; x = x.parentElement) { x.setAttribute('data-pzh', ''); marked.push(x); }
    try {
      const all = RULES.filter((r) => active(r.conds)).map((r) => (r.hover ? { ...r, sel: hovered(r.raw) } : r));
      // Elements a hover can change: those a :hover rule now matches, or matched at rest (":not(:hover)").
      const affected = new Set();
      for (const r of RULES) if (r.hover && active(r.conds)) for (const sel of [hovered(r.raw), r.sel]) { try { for (const e of document.querySelectorAll(sel)) if (e.hasAttribute('data-pz')) affected.add(e); } catch {} }
      const out = {};
      for (const e of affected) {
        const o = {};
        for (const r of all) { let ok = false; try { ok = e.matches(r.sel); } catch {} if (ok) (o[r.pseudo] ||= []).push(r); }
        const res = {};
        for (const ps in o) { const d = cascade(o[ps].sort(cmpNormal)); if (d.length) res[ps] = d.map(([k, v, i]) => [k, v.includes('var(') ? resolveVars(e, ps, v) : v, i]); }
        out[e.getAttribute('data-pz')] = res;
      }
      return out;
    } finally { for (const x of marked) x.removeAttribute('data-pzh'); }
  }

  // Keyframes used by name (the last definition for a name wins, as in the browser), conditions honoured.
  function keyframes(names) {
    const out = {};
    for (const k of KEYFRAMES) if (names.includes(k.name) && active(k.conds)) out[k.name] = k.text;
    return out;
  }

  // Inline style attributes that use var(): the same attribute with values resolved on that element.
  function inlineVars() {
    const out = {};
    for (const e of document.querySelectorAll('[data-pz][style*="var("]')) {
      const ds = decls(e.style);
      out[e.getAttribute('data-pz')] = ds.map(([k, v, i]) => `${k}:${v.includes('var(') ? resolveVars(e, '', v) : v}${i ? '!important' : ''}`).join(';');
    }
    return out;
  }

  window.__oc = { collect, capture, keyframes, hoverTargets, captureHover, fontFaces: () => [...new Set(FONTFACES)], inlineVars,
    // Breakpoints (px) any width media condition in the page's stylesheets uses.
    breakpoints: () => { if (!RULES) collect(); const s = new Set(); const add = (t) => { for (const m of t.matchAll(/(min|max)-width:\s*([\d.]+)px/g)) s.add(m[1] === 'min' ? Math.ceil(+m[2]) : Math.floor(+m[2]) + 1); };
      for (const r of RULES) for (const [, v] of r.conds) add(v); for (const k of KEYFRAMES) for (const [, v] of k.conds) add(v); return [...s].sort((a, b) => a - b); } };
})();
