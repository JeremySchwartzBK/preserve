// A refinement never repeats a fix (Jeremy, 2026-11-24): each confirmed finding gets the next untried action on its
// kind's list, nothing when the list is used up, and the person's own pins pass through when AI is off.
import assert from 'node:assert/strict';
import { triagePins } from './ai-pins.mjs';
import { optionsFor, codeOf, FIXES, ACTION_IDS } from './fix-menu.mjs';

for (const [code, list] of Object.entries(FIXES)) for (const a of list) assert.ok(ACTION_IDS.includes(a), `${code}: unknown action ${a}`);
assert.equal(codeOf({ from: 'quality-check:drag-lost' }), 'drag-lost');
assert.equal(codeOf({ from: 'person' }), null);
assert.deepEqual(optionsFor({ from: 'quality-check:widget-frozen', tried: ['record-longer'] }), ['play-on-timer', 'still']);

delete process.env.PRESERVE_AI;
const pins = [
  { block_id: 'a', from: 'quality-check:gallery-drag-broken' },                          // first try: add drag
  { block_id: 'b', from: 'quality-check:gallery-drag-broken', tried: ['add-drag'] },     // nothing left
  { block_id: 'c', from: 'quality-check:gallery-does-not-autoplay', tried: ['record-longer'] }, // the next one
  { block_id: 'd', from: 'quality-check:phone-menu-broken' },                             // no fix for this kind
  { block_id: 'e', from: 'person', body: 'logo is blue' },                                // AI off: unchanged
];
const out = await triagePins(pins, { liveUrl: 'x', preserveBase: '', dir: '/tmp' });
assert.deepEqual(out.map((p) => p.ai?.action ?? null), ['add-drag', 'none', 'play-on-timer', 'none', null]);
console.log('fixes: ok');
