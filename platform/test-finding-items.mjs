// One issue is one item across layouts and rounds (Jeremy, 2026-11-24).
import assert from 'node:assert/strict';
import { oneItemPerIssue, carryAnswers } from './finding-items.mjs';

const pins = oneItemPerIssue([
  { blockId: 's1', layout: 'desktop', code: 'drag-lost', x: 0.5, y: 0.5, pageY: 900 },
  { blockId: 's2', layout: 'desktop', code: 'part-size-differs', x: 0.1, y: 0.1, pageY: 100 },
  { blockId: 's1', layout: 'mobile', code: 'gallery-drag-broken', x: 0.4, y: 0.6, pageY: 700 },   // same drag issue
  { blockId: 's2', layout: 'mobile', code: 'blank-images', x: 0.2, y: 0.2, pageY: 50 },             // a different issue
]);
assert.equal(pins.length, 3);
assert.deepEqual(pins[0].spots, { mobile: { x: 0.4, y: 0.6, pageY: 700 } });
assert.equal(pins[2].layout, 'mobile');

// Answers, newest first.
carryAnswers(pins, [
  { block_id: 's2', code: 'blank-images', verdict: '', carried: true },          // cleared: ask again
  { block_id: 's2', code: 'blank-images', verdict: 'fix', carried: false },
  { block_id: 's1', code: 'gallery-drag-broken', verdict: 'fix', carried: false }, // confirmed on phone, earlier round
  { block_id: 's2', code: 'part-size-differs', verdict: 'not-a-problem', carried: false },
]);
assert.deepEqual(pins.map((p) => p.verdict), ['fix', 'not-a-problem', undefined]);
console.log('finding items: ok');
