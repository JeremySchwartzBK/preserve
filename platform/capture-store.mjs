// Stored captures: the original capture of a page (what the site looked like when we copied it), kept privately in R2
// so a refinement or a later fix can rebuild the copy from it instead of from today's live site.
//
// A capture is the part of a page's work folder that came from the live site (see CAPTURE_FILES). It is packed as one
// .tar.gz, split into parts so each upload stays well under the API's request size limit, and written under
// captures/<copy>/<page>/a<attempt>/ with an index.json. The serving Worker only reads copies/, lookup/ and platform/,
// so nothing here is ever reachable by visitors. These files hold the site's real contact details: retention rules
// (deleted on acceptance, or after 30 days idle) are in schema-pages-captures.sql and runner.mjs.
//
// CLI (for checking a stored capture by hand): node capture-store.mjs restore <prefix> <dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Files in a work folder that came from the live site. Everything else there (variants/, img-cache/, gate-*, live2-*,
// verdict.json, job.json, export-report.json, scrub-output.txt) is rebuilt from these.
export const CAPTURE_FILES = [/^raw$/, /^stills$/, /^manifest\.json$/, /^capture-info\.json$/, /^server\.html$/, /^rendered-[a-z]+\.html$/, /^ref-.+\.png$/, /^orig-asis-.+\.png$/];
const PART = 40 * 1024 * 1024;

export async function storeCapture(store, { dir, prefix, partSize = PART }) {
  const names = fs.readdirSync(dir).filter((f) => CAPTURE_FILES.some((re) => re.test(f))).sort();
  if (!names.includes('raw')) throw new Error(`no capture in ${dir}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-'));
  try {
    const tgz = path.join(tmp, 'capture.tar.gz');
    execFileSync('tar', ['-czf', tgz, '-C', dir, ...names]);
    const files = +execFileSync('sh', ['-c', 'tar -tzf "$1" | grep -vc "/$"', 'sh', tgz]).toString().trim();
    const body = fs.readFileSync(tgz);
    const parts = Math.ceil(body.length / partSize);
    for (let i = 0; i < parts; i++) await store.put(`${prefix}part-${String(i).padStart(3, '0')}`, body.subarray(i * partSize, (i + 1) * partSize), 'application/octet-stream');
    const index = { format: 'tar.gz', parts, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), files, entries: names, stored_at: new Date().toISOString() };
    await store.put(`${prefix}index.json`, JSON.stringify(index), 'application/json');
    return index;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Unpack a stored capture into dir (which then looks like the capture part of a work folder).
export async function restoreCapture(store, { prefix, dir }) {
  const index = JSON.parse(await store.get(`${prefix}index.json`).then((b) => b.toString()));
  const chunks = [];
  for (let i = 0; i < index.parts; i++) chunks.push(await store.get(`${prefix}part-${String(i).padStart(3, '0')}`));
  const body = Buffer.concat(chunks);
  if (crypto.createHash('sha256').update(body).digest('hex') !== index.sha256) throw new Error(`capture ${prefix} is damaged (checksum differs)`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', '-', '-C', dir], { input: body, maxBuffer: 1 << 30 });
  return index;
}

// Deleting a file that is already gone counts as done, so a sweep cut off halfway can simply run again.
export async function deleteCapture(store, { prefix, parts }) {
  const del = (k) => store.del(k).catch((e) => { if (!/: 404 /.test(e.message)) throw e; });
  for (let i = 0; i < parts; i++) await del(`${prefix}part-${String(i).padStart(3, '0')}`);
  await del(`${prefix}index.json`);
}

export const capturePrefix = ({ copyId, pageId, attempt }) => `captures/${copyId}/${pageId}/a${attempt}/`;

if (import.meta.url === pathToFileURL(process.argv[1] || '').href && process.argv[2] === 'restore') {
  const { cloudflareStore } = await import('./worker/copy-store.mjs');
  const store = cloudflareStore({ account: '1dcf2dbf05caa4963ed872ff035bc9db', bucket: 'preserve-copies' });
  const index = await restoreCapture(store, { prefix: process.argv[3], dir: process.argv[4] });
  console.log(`restored ${index.files} files (${(index.bytes / 1e6).toFixed(1)} MB packed) into ${process.argv[4]}`);
}
