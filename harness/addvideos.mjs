// Adds video files to an existing capture without re-capturing the page. Usage: node addvideos.mjs <siteDir>
import fs from 'node:fs'; import path from 'node:path';
import { request } from 'playwright';
import { captureVideos } from './video.mjs';
const dir = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const info = JSON.parse(fs.readFileSync(path.join(dir, 'capture-info.json'), 'utf8'));
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const req = await request.newContext({ ignoreHTTPSErrors: true, proxy });
info.videos = await captureVideos(dir, manifest, req);
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(dir, 'capture-info.json'), JSON.stringify(info, null, 1));
console.log(JSON.stringify(info.videos, null, 1));
process.exit(0);
