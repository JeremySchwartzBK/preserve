// Whole-page pictures stay as wide as the window (lib.mjs fullPageShot): a part sticking out past the right edge of
// a phone page (State of Sage's spaced-out header title, 2026-11-27) must not widen the picture, or the live page
// looks a quarter as long as the copy once both are shrunk to the comparison width. Usage: node test-full-width.mjs
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PROFILES, launch, fullPageShot } from './lib.mjs';

const browser = await launch();
const ctx = await browser.newContext({ ...PROFILES.mobile.context });
const page = await ctx.newPage();
await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}.wide{position:absolute;top:0;left:0;width:1500px;height:40px;background:#c33}.tall{height:3000px;background:linear-gradient(#eee,#333)}</style><div class="wide"></div><div class="tall"></div>');
const plain = await sharp(await page.screenshot({ fullPage: true })).metadata();
assert.ok(plain.width > 390 * 3, `the test page should stick out past the window (got ${plain.width})`);
const shot = await sharp(await fullPageShot(page)).metadata();
assert.equal(shot.width, 390 * 3, 'as wide as the phone window');
assert.equal(shot.height, plain.height, 'the whole page, top to bottom');
await browser.close();
console.log('ok: whole-page picture is as wide as the window');
