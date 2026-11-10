// The desktop still: a picture of the top of a Preserve's desktop layout (1440 wide, about two screens), as WebP.
// The Desktop embed shows it on phones and tablets, which can't run a live 1440-wide page in a frame; tapping it opens
// the full-screen desktop view. The runner makes it from the served page when a Preserve goes live (fonts as chosen
// at review, no tour), so it shows what visitors see.
//   node desktop-still.mjs <url of the desktop page> <out.webp>
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';

const W = 1440, H = 900, SCREENS = 2;

export async function desktopStill(url, out) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const res = await page.goto(url, { waitUntil: 'load', timeout: 60e3 });
    const title = await page.title();
    if (!res?.ok() || /^(Preview paused|Not found|Preview removed)$/.test(title)) throw new Error(`not showing (${res?.status()} ${title})`);
    // Our own UI (tour, preview notice) isn't part of the site.
    await page.addStyleTag({ content: '.pt-layer,[role=status]{display:none!important}' });
    // Bring in anything that loads as it scrolls into view, then go back to the top.
    for (let y = H; y <= H * SCREENS; y += H) { await page.evaluate((yy) => scrollTo(0, yy), y); await page.waitForTimeout(400); }
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(2500);
    const height = Math.min(H * SCREENS, await page.evaluate(() => document.documentElement.scrollHeight));
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: W, height }, fullPage: true });
    const webp = await sharp(png).webp({ quality: 72 }).toBuffer();
    fs.writeFileSync(out, webp);
    return { bytes: webp.length, height };
  } finally { await browser.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, out] = process.argv.slice(2);
  console.log(JSON.stringify(await desktopStill(url, out)));
}
