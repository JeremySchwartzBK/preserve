// Our own form for the math in a copy's stylesheet (Jeremy, 2026-10-20; scope: "Removing the last Squarespace-derived
// parts of copies"). The stylesheet own-css.mjs writes holds, for every element, the values the cascade picked, with
// Squarespace's variables filled in. Where a value is a formula (calc, min, max, clamp) that still leaves Squarespace's
// arithmetic as written, e.g. calc((1.2 - 1) * calc(.012 * min(100vh, 900px)) + 1rem) or
// repeat(24, minmax(calc(min(1920px, calc(100vw - 3vw * 2 - 0vw)) * 0.0215), auto)).
//
// mathForm() works each formula out and writes the result in one form of our own: a straight line in the units it
// depends on (so many vw plus so many px), capped by min/max only where the original is capped. Formulas that come
// out constant become plain values (calc(-1 * 0px) -> 0px, calc(1*0.55) -> 0.55); leftovers from unset variables
// (calc(90svh - unset)) were never valid in the browser either, and are dropped. The result is the same number at
// every screen size, not a fit; own-css.mjs checks the copy against the original at extra widths all the same.
//
// A formula this can't read (env(), attr(), an unknown unit) is kept as it is and counted in the report.

// Units in the order we write them: what changes with the screen first, fixed sizes last.
const ORDER = ['vw', 'vh', 'svh', 'lvh', 'dvh', 'svw', 'lvw', 'dvw', 'vmin', 'vmax', 'cqw', 'cqh', '%', 'em', 'rem', 'ch', 'ex', 'lh', 'px', 'deg', 'rad', 'turn', 's', 'ms', 'fr', ''];
const ABS = { in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 4 / 3, pc: 16 };
// Properties where a negative length is allowed as written. Elsewhere a negative result keeps calc(), which the
// browser clamps the same way the original was clamped.
const NEG_OK = /^(margin|top|right|bottom|left|inset|text-indent|letter-spacing|word-spacing|background-position|object-position|transform|translate|rotate|z-index|order|outline-offset|vertical-align|scroll-margin|text-underline-offset|animation-delay|transition-delay|offset)/;
const MATH = /(^|[^\w-])(-webkit-calc|calc|min|max|clamp)\(/gi;

class Broken extends Error {}
class Unreadable extends Error {}

// Tokens of a math expression: numbers with units, operators, parentheses, commas, function names.
function tokens(s) {
  const out = []; let i = 0;
  const signOk = () => !out.length || ['op', '(', ',', 'f'].includes(out[out.length - 1].k);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^([+-]?)(\d*\.\d+|\d+\.?)(e[+-]?\d+)?([a-z%]*)/i.exec(s.slice(i));
    if (num && (num[1] === '' || signOk())) {
      out.push({ k: 'n', v: parseFloat(num[1] + num[2] + (num[3] || '')), u: num[4].toLowerCase() }); i += num[0].length; continue;
    }
    if ('+-*/'.includes(ch)) { out.push({ k: 'op', v: ch }); i++; continue; }
    if (ch === '(' || ch === ')' || ch === ',') { out.push({ k: ch }); i++; continue; }
    const id = /^-?[a-z_][\w-]*/i.exec(s.slice(i));
    if (id) {
      const name = id[0].toLowerCase(); i += id[0].length;
      if (s[i] === '(') { out.push({ k: 'f', v: name }); i++; continue; }
      if (name === 'unset' || name === 'initial' || name === 'inherit') throw new Broken(name);
      if (name === 'infinity') { out.push({ k: 'n', v: Infinity, u: '' }); continue; }
      if (name === '-infinity') { out.push({ k: 'n', v: -Infinity, u: '' }); continue; }
      if (name === 'pi') { out.push({ k: 'n', v: Math.PI, u: '' }); continue; }
      throw new Unreadable(name);
    }
    throw new Unreadable(ch);
  }
  return out;
}

// Values: { lin: Map(unit -> coefficient) } or { kind: 'min'|'max', args: [...] }.
const lin = (u, c) => ({ lin: new Map([[u, c]]) });
const isNum = (a) => a.lin && [...a.lin.keys()].every((u) => u === '');
const numOf = (a) => a.lin.get('') || 0;
function add(a, b, sign = 1) {
  if (a.lin && b.lin) { const m = new Map(a.lin); for (const [u, c] of b.lin) m.set(u, (m.get(u) || 0) + sign * c); return { lin: m }; }
  if (!a.lin) return mk(a.kind, a.args.map((x) => add(x, b, sign)));
  // a + min(x, y) = min(a + x, a + y); a - min(x, y) = max(a - x, a - y).
  return mk(sign > 0 ? b.kind : flip(b.kind), b.args.map((x) => add(a, x, sign)));
}
const flip = (k) => (k === 'min' ? 'max' : 'min');
function scale(a, k) {
  if (a.lin) return { lin: new Map([...a.lin].map(([u, c]) => [u, c * k])) };
  return mk(k >= 0 ? a.kind : flip(a.kind), a.args.map((x) => scale(x, k)));
}
const key = (a) => (a.lin ? [...a.lin].filter(([, c]) => Math.abs(c) > 1e-9).map(([u, c]) => u + ':' + +c.toFixed(6)).sort().join(',') : a.kind + '(' + a.args.map(key).join(';') + ')');
function mk(kind, args) {
  const flat = [];
  for (const a of args) { if (!a.lin && a.kind === kind) flat.push(...a.args); else flat.push(a); }
  // Drop repeats, and any argument another one always beats (they differ only by a fixed amount).
  const keep = [];
  for (const a of flat) {
    if (keep.some((b) => key(b) === key(a))) continue;
    let beaten = false;
    for (let j = 0; j < keep.length && !beaten; j++) {
      const b = keep[j]; if (!a.lin || !b.lin) continue;
      const d = add(a, b, -1);
      const fixed = [...d.lin].filter(([, c]) => Math.abs(c) > 1e-9);
      // Comparable when the difference is in one absolute unit only (or nothing).
      if (fixed.length > 1 || (fixed.length === 1 && fixed[0][0] !== 'px' && fixed[0][0] !== '')) continue;
      const diff = fixed.length ? fixed[0][1] : 0;
      if ((kind === 'min' && diff >= 0) || (kind === 'max' && diff <= 0)) beaten = true; // a never wins
      else keep[j] = a, beaten = true; // a always wins over b
    }
    if (!beaten) keep.push(a);
  }
  if (keep.length > 8) throw new Unreadable('too many cases');
  return keep.length === 1 ? keep[0] : { kind, args: keep };
}
function mul(a, b) {
  if (isNum(a)) return scale(b, numOf(a));
  if (isNum(b)) return scale(a, numOf(b));
  throw new Unreadable('length times length');
}

function parse(toks) {
  let i = 0;
  const peek = () => toks[i];
  const expect = (k) => { if (!toks[i] || toks[i].k !== k) throw new Unreadable('expected ' + k); i++; };
  function sum() {
    let v = product();
    while (peek() && peek().k === 'op' && (peek().v === '+' || peek().v === '-')) { const s = toks[i++].v === '+' ? 1 : -1; v = add(v, product(), s); }
    return v;
  }
  function product() {
    let v = unary();
    while (peek() && peek().k === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = toks[i++].v, w = unary();
      if (op === '*') v = mul(v, w);
      else { if (!isNum(w) || numOf(w) === 0) throw new Unreadable('division'); v = scale(v, 1 / numOf(w)); }
    }
    return v;
  }
  function unary() {
    const t = toks[i++];
    if (!t) throw new Unreadable('end');
    if (t.k === 'n') {
      if (ABS[t.u]) return lin('px', t.v * ABS[t.u]);
      if (!ORDER.includes(t.u)) throw new Unreadable(t.u);
      return lin(t.u, t.v);
    }
    if (t.k === '(') { const v = sum(); expect(')'); return v; }
    if (t.k === 'f') return fn(t.v);
    throw new Unreadable(t.k);
  }
  function fn(name) {
    const args = [sum()];
    while (peek() && peek().k === ',') { i++; args.push(sum()); }
    expect(')');
    if (name === 'calc' || name === '-webkit-calc') { if (args.length !== 1) throw new Unreadable('calc args'); return args[0]; }
    if (name === 'min' || name === 'max') return mk(name, args);
    if (name === 'clamp') { if (args.length !== 3) throw new Unreadable('clamp args'); return mk('max', [args[0], mk('min', [args[1], args[2]])]); }
    throw new Unreadable(name);
  }
  const v = sum();
  if (i !== toks.length) throw new Unreadable('trailing');
  return v;
}

const fmt = (c) => String(+c.toFixed(4)).replace(/^(-?)0\./, '$10.');
function terms(a) {
  const ts = [...a.lin].filter(([, c]) => Math.abs(c) > 5e-5);
  ts.sort((x, y) => ORDER.indexOf(x[0]) - ORDER.indexOf(y[0]));
  return ts;
}
// One value as we write it. top: a whole expression in place of the original (calc() around sums); inside min/max
// arguments are written bare.
function write(a, zeroUnit, top) {
  if (!a.lin) return `${a.kind}(${a.args.map((x) => write(x, zeroUnit, false)).join(', ')})`;
  const ts = terms(a);
  if (!ts.length) return '0' + zeroUnit;
  if (ts.length === 1) return fmt(ts[0][1]) + ts[0][0];
  const s = ts.map(([u, c], k) => (k === 0 ? fmt(c) + u : (c < 0 ? ' - ' : ' + ') + fmt(Math.abs(c)) + u)).join('');
  return top ? `calc(${s})` : s;
}

// Where a formula ends: the parenthesis matching the one at `open`.
function closing(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) { if (s[i] === '(') depth++; else if (s[i] === ')' && --depth === 0) return i; }
  return -1;
}

// Rewrite every formula in one declaration value. Returns the new value, or null when the declaration should go (it
// was an invalid leftover). stats counts what happened: { rewritten, kept, dropped }.
export function mathForm(prop, value, stats = {}) {
  if (!/(calc|min|max|clamp)\(/i.test(value)) return value;
  let out = '', last = 0;
  MATH.lastIndex = 0;
  for (let m; (m = MATH.exec(value));) {
    const start = m.index + m[1].length, open = value.indexOf('(', start), end = closing(value, open);
    if (end < 0) break;
    const text = value.slice(start, end + 1);
    let w = text;
    try {
      const v = parse(tokens(text));
      // A zero keeps a unit where the original had one, so it stays a length where a length is needed.
      const units = [...text.matchAll(/\d([a-z%]+)/gi)].map((x) => x[1].toLowerCase());
      const zeroUnit = units.includes('px') ? 'px' : units.find((u) => ORDER.includes(u) && u !== '') || '';
      w = write(v, zeroUnit, true);
      if (v.lin) { const ts = terms(v); if (ts.length === 1 && ts[0][1] < 0 && !NEG_OK.test(prop)) w = `calc(${w})`; }
      stats.rewritten = (stats.rewritten || 0) + 1;
    } catch (e) {
      if (e instanceof Broken) { stats.dropped = (stats.dropped || 0) + 1; return null; }
      stats.kept = (stats.kept || 0) + 1;
      (stats.keptSamples ||= []).length < 5 && stats.keptSamples.push(`${prop}: ${text.slice(0, 100)}`);
    }
    out += value.slice(last, start) + w; last = end + 1; MATH.lastIndex = end + 1;
  }
  return out + value.slice(last);
}

// ---- Animations ----
// Our own animation definitions. Squarespace's @keyframes text (fade-ups, marquees, spinners) is replaced by one we
// write from measurements: each animation in use is played on two test boxes of different sizes in the copy page,
// paused at every keyframe and at points between them, and the browser's computed values are read back. From those
// we write the motion in our own terms (move by so many px or % of the box, turn by so many degrees, scale, fade),
// then play ours the same way and check it lands on the same values all along the run. One that doesn't, or that uses
// something we don't write yet, keeps the original renamed and is listed in the report.

const SIZES = [100, 200];
const STEPS = 8; // points measured between two keyframes

// In the page: measure the named animations. Returns { [name]: { stops: [{ o, easing, props }], samples: [...] } }.
export function sampleMotions({ names, sizes, steps, prefix }) {
  const found = {};
  const walk = (rules) => {
    for (const r of rules) {
      if (r.cssRules && r.constructor.name !== 'CSSKeyframesRule') {
        if (r.media && !matchMedia(r.media.mediaText).matches) continue;
        if (r.constructor.name === 'CSSSupportsRule' && !CSS.supports(r.conditionText)) continue;
        walk(r.cssRules); continue;
      }
      if (r.constructor.name === 'CSSKeyframesRule' && names.includes(r.name)) found[r.name] = r;
    }
  };
  for (const s of document.styleSheets) { try { walk(s.cssRules); } catch {} }
  const probes = sizes.map((z) => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:0;top:0;width:${z}px;height:${z}px;visibility:hidden;pointer-events:none;font-size:16px`;
    document.body.appendChild(d); return d;
  });
  const out = {};
  try {
    for (const name of names) {
      const r = found[name]; if (!r) continue;
      const stops = [];
      for (const kf of r.cssRules) {
        const props = [];
        for (let i = 0; i < kf.style.length; i++) { const p = kf.style[i]; if (p !== 'animation-timing-function' && p !== 'animation-composition') props.push(p); }
        const easing = kf.style.getPropertyValue('animation-timing-function') || null;
        for (const k of kf.keyText.split(',')) {
          const t = k.trim(); const o = t === 'from' ? 0 : t === 'to' ? 1 : parseFloat(t) / 100;
          let s = stops.find((x) => Math.abs(x.o - o) < 1e-9);
          if (!s) { s = { o, easing: null, props: [] }; stops.push(s); }
          for (const p of props) if (!s.props.includes(p)) s.props.push(p);
          if (easing) s.easing = easing;
        }
      }
      stops.sort((a, b) => a.o - b.o);
      const props = [...new Set(stops.flatMap((s) => s.props))];
      const times = new Set(stops.map((s) => s.o));
      for (let k = 0; k + 1 < stops.length; k++) for (let j = 1; j < steps; j++) times.add(stops[k].o + (stops[k + 1].o - stops[k].o) * j / steps);
      out[name] = { stops, props, samples: measure(prefix + name, props, [...times].sort((a, b) => a - b)) };
    }
  } finally { probes.forEach((p) => p.remove()); }
  return out;

  function measure(anim, props, times) {
    return times.map((t) => ({ t, at: probes.map((p) => {
      p.style.animation = 'none'; void p.offsetWidth;
      p.style.animation = `${anim} 1000s linear ${-t * 1000}s 1 normal both paused`;
      const cs = getComputedStyle(p); const o = {};
      for (const q of props) o[q] = cs.getPropertyValue(q);
      return o;
    }) }));
  }
}

// In the page: measure our own definitions (already added to the page under their new names).
export function sampleOwn({ jobs, sizes }) {
  const probes = sizes.map((z) => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:0;top:0;width:${z}px;height:${z}px;visibility:hidden;pointer-events:none;font-size:16px`;
    document.body.appendChild(d); return d;
  });
  try {
    const out = {};
    for (const { name, props, times } of jobs) out[name] = times.map((t) => ({ t, at: probes.map((p) => {
      p.style.animation = 'none'; void p.offsetWidth;
      p.style.animation = `${name} 1000s linear ${-t * 1000}s 1 normal both paused`;
      const cs = getComputedStyle(p); const o = {};
      for (const q of props) o[q] = cs.getPropertyValue(q);
      return o;
    }) }));
    return out;
  } finally { probes.forEach((p) => p.remove()); }
}

const num = (s) => (s.match(/-?[\d.]+(e[+-]?\d+)?/gi) || []).map(Number);
// A transform the browser reports as matrix(a, b, c, d, e, f) -> move, turn, scale. null when it skews or is 3D.
function parts(m) {
  if (m === 'none') return { x: 0, y: 0, r: 0, sx: 1, sy: 1 };
  if (!m.startsWith('matrix(')) return null;
  const [a, b, c, d, e, f] = num(m);
  const sx = Math.hypot(a, b); if (sx < 1e-9) return null;
  if (Math.abs(a * c + b * d) > 1e-6 * Math.max(1, sx * sx)) return null;
  return { x: e, y: f, r: Math.atan2(b, a) * 180 / Math.PI, sx, sy: (a * d - b * c) / sx };
}
const len = (pxv, pct) => {
  const p = Math.abs(pct) > 1e-4, x = Math.abs(pxv) > 1e-4;
  if (p && x) return `calc(${fmt(pct)}% ${pxv < 0 ? '-' : '+'} ${fmt(Math.abs(pxv))}px)`;
  return p ? `${fmt(pct)}%` : `${fmt(pxv)}px`;
};

// Write one animation in our own terms from its measurements. Returns { css, kind } or { error }.
function writeMotion(newName, m) {
  const [s0, s1] = SIZES;
  const at = (t) => m.samples.find((x) => Math.abs(x.t - t) < 1e-9).at;
  const decl = {};
  for (const p of m.props) {
    if (p === 'transform') {
      // Turns: the browser reports an angle between -180 and 180, so follow it along the run to count whole turns.
      let prev = null, add = 0; const turn = new Map();
      for (const s of m.samples) {
        const a = parts(s.at[0][p]); if (!a) return { error: `transform ${s.at[0][p].slice(0, 40)}` };
        let r = a.r + add;
        if (prev !== null) { while (r - prev > 180) { add -= 360; r -= 360; } while (r - prev < -180) { add += 360; r += 360; } }
        prev = r; turn.set(s.t, r);
      }
      const vals = m.stops.filter((s) => s.props.includes(p)).map((s) => {
        const A = parts(at(s.o)[0][p]), B = parts(at(s.o)[1][p]);
        if (!A || !B) return null;
        // Move: the part that grows with the box is a % of its size, the rest is px.
        const px = (a, b) => { const pct = (b - a) / (s1 - s0) * 100; return [a - pct * s0 / 100, pct]; };
        return { o: s.o, x: px(A.x, B.x), y: px(A.y, B.y), r: turn.get(s.o), sx: A.sx, sy: A.sy };
      });
      if (vals.includes(null)) return { error: 'transform' };
      const use = { t: vals.some((v) => [...v.x, ...v.y].some((z) => Math.abs(z) > 1e-4)), r: vals.some((v) => Math.abs(v.r) > 1e-4), s: vals.some((v) => Math.abs(v.sx - 1) > 1e-5 || Math.abs(v.sy - 1) > 1e-5) };
      for (const v of vals) {
        const f = [];
        if (use.t) f.push(`translate(${len(...v.x)}, ${len(...v.y)})`);
        if (use.r) f.push(`rotate(${fmt(v.r)}deg)`);
        if (use.s) f.push(Math.abs(v.sx - v.sy) < 1e-5 ? `scale(${fmt(v.sx)})` : `scale(${fmt(v.sx)}, ${fmt(v.sy)})`);
        (decl[v.o] ||= []).push(['transform', f.join(' ') || 'none']);
      }
      continue;
    }
    for (const s of m.stops) {
      if (!s.props.includes(p)) continue;
      const [a, b] = at(s.o).map((x) => x[p]);
      let v = a;
      if (a !== b) {
        // A turning point given as a share of the box (center, 50%): the numbers that grow with the box are %.
        const A = num(a), B = num(b);
        if (p !== 'transform-origin' || A.length !== B.length) return { error: `${p} depends on size` };
        let k = 0;
        v = a.replace(/-?[\d.]+(e[+-]?\d+)?px/gi, () => { const x = A[k], y = B[k++]; const pct = (y - x) / (s1 - s0) * 100; return len(x - pct * s0 / 100, pct); });
      }
      (decl[s.o] ||= []).push([p, mathForm(p, v)]);
    }
  }
  // Same declarations at several offsets share one block, as people write them.
  const blocks = new Map();
  for (const s of m.stops) {
    const d = (decl[s.o] || []).slice();
    if (s.easing) d.push(['animation-timing-function', s.easing]);
    if (!d.length) continue;
    const body = d.map(([k, v]) => `${k}:${v}`).join(';');
    (blocks.get(body) || blocks.set(body, []).get(body)).push(s.o);
  }
  const css = `@keyframes ${newName}{` + [...blocks].map(([body, os]) => `${os.map((o) => fmt(o * 100) + '%').join(',')}{${body}}`).join('') + '}';
  const changes = new Set(m.props.map((p) => (p === 'transform' ? 'move' : p)));
  const kind = [...changes].join('+');
  return { css, kind };
}

// Same within what a person could see: a hundredth of opacity or of a scale, half a pixel, half a degree.
function close(a, b, prop) {
  if (a === b) return true;
  if (prop === 'transform') {
    const A = a === 'none' ? [1, 0, 0, 1, 0, 0] : num(a), B = b === 'none' ? [1, 0, 0, 1, 0, 0] : num(b);
    if (A.length !== B.length) return false;
    return A.every((x, i) => Math.abs(x - B[i]) <= (i >= 4 ? 0.5 : 0.01));
  }
  const A = num(a), B = num(b);
  if (A.length !== B.length || a.replace(/-?[\d.]+(e[+-]?\d+)?/gi, '#') !== b.replace(/-?[\d.]+(e[+-]?\d+)?/gi, '#')) return false;
  return A.every((x, i) => Math.abs(x - B[i]) <= 0.5 * Math.max(0.02, Math.min(1, Math.abs(x) / 50)));
}

// Replace the page's keyframes for `names` with our own. kf: { name: original text } (as own-css.mjs collected them).
// Returns { css: keyframes text, rename: { old: new }, report }.
export async function ownMotions(page, kf, nextName) {
  const names = Object.keys(kf);
  const report = { ours: [], kept: [] };
  const rename = {}; let css = '';
  if (!names.length) return { css, rename, report };
  const measured = await page.evaluate(sampleMotions, { names, sizes: SIZES, steps: STEPS, prefix: '' });
  const ours = {};
  for (const name of names) {
    const nn = nextName();
    rename[name] = nn;
    const m = measured[name];
    const w = m ? writeMotion(nn, m) : { error: 'not found' };
    if (w.error) { report.kept.push(`${name}: ${w.error}`); css += kf[name].replace(/^@(-webkit-)?keyframes\s+\S+/, `@keyframes ${nn}`) + '\n'; continue; }
    ours[name] = { nn, w, m };
  }
  // Play ours the same way and compare.
  if (Object.keys(ours).length) {
    await page.addStyleTag({ content: Object.values(ours).map((o) => o.w.css).join('\n') });
    const got = await page.evaluate(sampleOwn, { jobs: Object.values(ours).map((o) => ({ name: o.nn, props: o.m.props, times: o.m.samples.map((s) => s.t) })), sizes: SIZES });
    for (const [name, o] of Object.entries(ours)) {
      const bad = o.m.samples.findIndex((s, i) => s.at.some((v, k) => o.m.props.some((p) => !close(v[p], got[o.nn][i].at[k][p], p))));
      if (bad >= 0) {
        const s = o.m.samples[bad], g = got[o.nn][bad];
        const p = o.m.props.find((q) => s.at.some((v, k) => !close(v[q], g.at[k][q], q)));
        report.kept.push(`${name}: differs at ${fmt(s.t * 100)}% (${p}: ${s.at[0][p]} vs ${g.at[0][p]})`);
        css += kf[name].replace(/^@(-webkit-)?keyframes\s+\S+/, `@keyframes ${o.nn}`) + '\n';
      } else { report.ours.push(`${name} -> ${o.w.kind}`); css += o.w.css + '\n'; }
    }
  }
  return { css, rename, report };
}
