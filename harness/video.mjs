// Squarespace native video (video blocks and section background videos), saved as plain files.
// Squarespace streams these as encrypted HLS pieces and its player only starts when the browser plays H.264,
// so the capture browser never loads them. Instead, read each video's address from the page, turn the stream
// into one file with ffmpeg, and make small web versions: H.264 MP4 (every browser) + VP9 WebM (smaller,
// and the only one open-source Chromium plays), at desktop (1280 wide) and phone (640 wide) sizes, plus a poster.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
export const MAX_SECONDS = 60; // longer clips are cut; background loops are normally 10-30 s
export const SIZES = { desktop: 1280, mobile: 640 };

// Every Squarespace video base URL (".../{variant}" with {variant} removed) referenced in the captured HTML.
export function findVideos(html) {
  const out = new Set();
  const t = html.replace(/&quot;/g, '"').replace(/\\\//g, '/');
  for (const m of t.matchAll(/"alexandriaUrl"\s*:\s*"(https:\/\/video\.squarespace-cdn\.com\/[^"]+?\/)\{variant\}"/g)) out.add(m[1]);
  return [...out];
}

// Address of each saved file, under the video's own CDN path so the usual URL rewriting serves it from the copy.
export const videoUrl = (base, size, ext) => `${base}preserve-${size}.${ext}`;

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600000 });

export async function captureVideos(outDir, manifest, request) {
  const htmls = ['rendered-desktop.html', 'rendered-mobile.html', 'server.html'].map((f) => path.join(outDir, f)).filter(fs.existsSync).map((p) => fs.readFileSync(p, 'utf8'));
  const bases = [...new Set(htmls.flatMap(findVideos))];
  const report = [];
  const tmp = path.join(outDir, 'video-tmp');
  for (const base of bases) {
    const r = { base, ok: false };
    report.push(r);
    try {
      const t0 = Date.now();
      const master = await (await request.get(base + 'playlist.m3u8', { timeout: 30000 })).text();
      // Highest-resolution variant playlist.
      const variants = [...master.matchAll(/RESOLUTION=(\d+)x(\d+)[^\n]*\n(\S+)/g)].map((m) => ({ w: +m[1], h: +m[2], url: new URL(m[3], base + 'playlist.m3u8').href })).sort((a, b) => b.w - a.w);
      if (!variants.length) throw new Error('no variants in playlist');
      fs.mkdirSync(tmp, { recursive: true });
      const src = path.join(tmp, hash(base) + '.mp4');
      ff(['-i', variants[0].url, '-t', String(MAX_SECONDS), '-c', 'copy', src]);
      r.source = `${variants[0].w}x${variants[0].h}`;
      const files = [];
      for (const [, w] of Object.entries(SIZES)) {
        const scale = `scale='min(${w},iw)':-2`;
        const mp4 = path.join(tmp, `${hash(base)}-${w}.mp4`);
        const webm = path.join(tmp, `${hash(base)}-${w}.webm`);
        const jpg = path.join(tmp, `${hash(base)}-${w}.jpg`);
        // Background video is muted on the site, so audio is dropped. Bitrates are capped (~1 Mbps desktop, ~0.5 Mbps
        // phone): a background loop is texture, and the files stream in after the first screen anyway.
        ff(['-i', src, '-an', '-vf', scale, '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '28', '-maxrate', w > 700 ? '1000k' : '500k', '-bufsize', w > 700 ? '2000k' : '1000k', '-preset', 'medium', '-movflags', '+faststart', mp4]);
        ff(['-i', src, '-an', '-vf', scale, '-c:v', 'libvpx-vp9', '-b:v', w > 700 ? '800k' : '400k', '-crf', '40', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '5', webm]);
        ff(['-i', src, '-vf', scale, '-frames:v', '1', '-q:v', '4', jpg]);
        files.push([videoUrl(base, w, 'mp4'), mp4, 'video/mp4'], [videoUrl(base, w, 'webm'), webm, 'video/webm'], [videoUrl(base, w, 'jpg'), jpg, 'image/jpeg']);
      }
      for (const [u, p, ct] of files) {
        const body = fs.readFileSync(p);
        const file = hash(u);
        fs.writeFileSync(path.join(outDir, 'raw', file), body);
        manifest[u] = { status: 200, ct, file, size: body.length, type: 'video-file' };
      }
      r.sizes = Object.fromEntries(files.map(([u, , ]) => [u.slice(base.length), manifest[u].size]));
      r.seconds = (Date.now() - t0) / 1000;
      r.ok = true;
    } catch (e) {
      r.error = String(e.stderr || e.message || e).slice(0, 300);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return report;
}
