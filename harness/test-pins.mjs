// A pin applies on both layouts (Jeremy, 2026-11-13): comparePins judges the pinned block on desktop and phone, and only
// "looks fixed" when every layout that shows the block matches the live page.
// Usage: node test-pins.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { comparePins } from './pins.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-'));
const png = (name, colour) => sharp({ create: { width: 200, height: 120, channels: 3, background: colour } }).png().toFile(path.join(dir, name));
const pins = [
  { block_id: 'a', layout: 'desktop', from: 'person', at: 't' }, // fixed on desktop, still blank on phone
  { block_id: 'b', layout: 'desktop', from: 'person', at: 't' }, // fixed on both
  { block_id: 'c', layout: 'mobile', from: 'person', at: 't' },  // phone-only block: desktop has no picture
  { block_id: 'd', layout: 'desktop', from: 'person', at: 't' }, // not in the Preserve on the pinned layout
];
await png('live-pin0-desktop.png', '#336699'); await png('copy-pin0-desktop.png', '#336699');
await png('live-pin0-mobile.png', '#336699'); await png('copy-pin0-mobile.png', '#ffffff');
for (const l of ['desktop', 'mobile']) { await png(`live-pin1-${l}.png`, '#993333'); await png(`copy-pin1-${l}.png`, '#993333'); }
await png('live-pin2-mobile.png', '#339933'); await png('copy-pin2-mobile.png', '#339933');
await png('live-pin3-desktop.png', '#999999');

const out = await comparePins(dir, 8, {}, pins);
assert.equal(out[0].result, 'still-different', 'a block blank on phone is not fixed, though the pin was on desktop');
assert.equal(out[0].layouts.desktop.result, 'looks-fixed');
assert.equal(out[0].layouts.mobile.result, 'still-different');
assert.equal(out[0].layout, 'desktop', 'the pin keeps the layout it was placed on');
assert.equal(out[1].result, 'looks-fixed');
assert.equal(out[2].result, 'looks-fixed', 'a layout that does not show the block is skipped');
assert.equal(out[2].layouts.desktop.result, 'not-found');
assert.equal(out[3].result, 'not-found', 'the pinned layout still decides "not found"');
fs.rmSync(dir, { recursive: true, force: true });
console.log('pins: ok');
