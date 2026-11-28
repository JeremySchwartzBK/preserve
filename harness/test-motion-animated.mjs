// The motion check counts an animated picture as moving (check.mjs probeMotion, lib.mjs ANIMATED_IMAGE_BLOCKS), and the
// parts laid over one too, however long the picture holds a frame. A GIF that held a frame between photos read as
// still in the copy on one look and moving on the next, so copies were held with "static here, but moves on your
// site" (Ken Edits, and Jamesy World's sticker over its moving hero, Nov 28 showcase re-run). The copy is served with
// its real page rules, which forbid fetching. Usage: node test-motion-animated.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { launch } from './lib.mjs';
import { probeMotion } from './check.mjs';
import { serve } from './gate.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-motion-')), dir = path.join(root, 'site');
fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
// Two frames, each held for six seconds: photos two seconds apart never see it change in both pairs.
const w = 400, h = 300, raw = Buffer.alloc(w * h * 2 * 3);
for (let i = 0; i < raw.length; i += 3) { const second = i >= w * h * 3; raw[i] = second ? 30 : 220; raw[i + 1] = 40; raw[i + 2] = second ? 220 : 30; }
fs.writeFileSync(path.join(dir, 'a', 'hold.gif'), await sharp(raw, { raw: { width: w, height: h * 2, channels: 3, pageHeight: h } }).gif({ delay: [6000, 6000], loop: 0 }).toBuffer());
fs.writeFileSync(path.join(dir, 'a', 'still.png'), await sharp({ create: { width: w, height: h, channels: 3, background: '#3a7' } }).png().toBuffer());
fs.writeFileSync(path.join(dir, 'desktop.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0}.b{position:absolute;width:400px;height:300px}img{display:block;width:400px;height:300px}</style>
<div class="b" id="block-anim" style="left:40px;top:40px"><img src="a/hold.gif"></div>
<div class="b" id="block-over" style="left:140px;top:120px;width:160px;height:120px;font:20px sans-serif">sticker</div>
<div class="b" id="block-still" style="left:600px;top:40px"><img src="a/still.png"></div>`);

const srv = await serve(root), browser = await launch();
try {
  const m = await probeMotion(browser, `http://127.0.0.1:${srv.address().port}/site/desktop`, 'desktop', { isCopy: true });
  assert.equal(m['block-anim']?.moving, true, 'the animated picture moves');
  assert.equal(m['block-over']?.moving, true, 'the part laid over it moves with it');
  assert.equal(m['block-still']?.moving, false, 'a still picture stays still');
} finally { await browser.close(); srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
console.log('ok: animated pictures, and parts over them, count as moving');
