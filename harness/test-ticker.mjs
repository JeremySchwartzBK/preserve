// Things that move on their own on a timer (2026-11-17, Chelsey Arce's logo strip): motionKind keeps steady motion one
// way, allowing one jump back where it starts over, and leaves anything else frozen.
// Usage: node test-ticker.mjs
import assert from 'node:assert/strict';
import { motionKind } from './capture.mjs';

const at = (f) => Array.from({ length: 12 }, (_, j) => { const t = j * 150; return { t, m: f(t / 1000) }; });
const mx = (x, y = 0) => [1, 0, 0, 1, x, y];
const rot = (deg) => { const r = deg * Math.PI / 180; return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]; };

// Sideways at 90px a second, starting over once at 3304px.
const strip = motionKind(at((s) => mx(-((3200 + 90 * s) % 3304))));
assert.equal(strip.k, 'x'); assert.ok(Math.abs(strip.v + 90) < 1, String(strip.v));
// Upwards, and turning.
assert.equal(motionKind(at((s) => mx(0, -40 * s))).k, 'y');
const spin = motionKind(at((s) => rot(170 + 60 * s)));
assert.equal(spin.k, 'r'); assert.ok(Math.abs(spin.v - 60) < 1, String(spin.v));
// Left frozen: still, easing to a stop, back and forth, moving two ways, growing.
assert.equal(motionKind(at(() => mx(-10))), null);
assert.equal(motionKind(at((s) => mx(-300 * (1 - Math.exp(-3 * s))))), null);
assert.equal(motionKind(at((s) => mx(80 * Math.sin(4 * s)))), null);
assert.equal(motionKind(at((s) => mx(-50 * s, -50 * s))), null);
assert.equal(motionKind(at((s) => [1 + s, 0, 0, 1 + s, 0, 0])), null);
console.log('ticker: ok');
