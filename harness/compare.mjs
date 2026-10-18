// Side-by-side full-page strips: reference (live page, overlays hidden) and each copy, per site and profile.
// Usage: node compare.mjs <workDir> <resultsDir>
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const [WORK, OUT] = process.argv.slice(2);
const cols = [['live page', (s, p) => path.join(WORK, s, `ref-full-${p}.png`)], ...['frozen', 'frozen-opt', 'opt-rendered', 'opt-server'].map((v) => [v, (s, p) => path.join(OUT, 'screenshots', s, `check-${v}-full-${p}.png`)])];
const W = 300, MAXH = 2400;
fs.mkdirSync(path.join(OUT, 'compare'), { recursive: true });
for (const site of fs.readdirSync(path.join(OUT, 'screenshots'))) for (const prof of ['desktop', 'mobile']) {
  const tiles = [];
  for (const [label, f] of cols) {
    const p = f(site, prof); if (!fs.existsSync(p)) continue;
    let img = sharp(p).resize({ width: W });
    let buf = await img.png().toBuffer();
    const m = await sharp(buf).metadata();
    if (m.height > MAXH) buf = await sharp(buf).extract({ left: 0, top: 0, width: W, height: MAXH }).png().toBuffer();
    const h = Math.min(m.height, MAXH);
    const lab = Buffer.from(`<svg width="${W}" height="28"><rect width="100%" height="100%" fill="#222"/><text x="8" y="19" font-family="sans-serif" font-size="15" fill="#fff">${label}</text></svg>`);
    tiles.push({ buf, h, lab });
  }
  if (!tiles.length) continue;
  const H = Math.max(...tiles.map((t) => t.h)) + 28, gap = 10;
  const comp = [];
  tiles.forEach((t, i) => { comp.push({ input: t.lab, left: i * (W + gap), top: 0 }, { input: t.buf, left: i * (W + gap), top: 28 }); });
  await sharp({ create: { width: tiles.length * (W + gap) - gap, height: H, channels: 3, background: '#ffffff' } }).composite(comp).jpeg({ quality: 70 }).toFile(path.join(OUT, 'compare', `${site}-${prof}.jpg`));
}
console.log('ok');
