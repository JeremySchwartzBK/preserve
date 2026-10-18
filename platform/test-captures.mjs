// Checks storing, restoring and deleting a capture against an in-memory store: node test-captures.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { storeCapture, restoreCapture, deleteCapture, capturePrefix } from './capture-store.mjs';

const objects = new Map();
const store = {
  put: async (k, body) => { objects.set(k, Buffer.from(body)); },
  get: async (k) => { if (!objects.has(k)) throw new Error(`GET ${k}: 404 not found`); return objects.get(k); },
  del: async (k) => { if (!objects.delete(k)) throw new Error(`DELETE ${k}: 404 not found`); },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-captures-'));
const work = path.join(tmp, 'work');
for (const [f, body] of Object.entries({
  'raw/index.html': '<html>live</html>', 'raw/img/a.jpg': crypto.randomBytes(300_000), 'stills/v1.jpg': crypto.randomBytes(1000),
  'manifest.json': '{}', 'capture-info.json': '{}', 'server.html': 's', 'rendered-desktop.html': 'd', 'rendered-mobile.html': 'm',
  'ref-desktop.png': 'p', 'ref-full-mobile.png': 'p', 'orig-asis-desktop.png': 'p',
  // Rebuilt from the capture, so never stored:
  'variants/x.webp': 'v', 'img-cache/y': 'c', 'gate-desktop.png': 'g', 'live2-desktop.png': 'l', 'verdict.json': '{}', 'job.json': '{}',
})) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), body); }

const prefix = capturePrefix({ copyId: 'abcd1234', pageId: 'p2x9', attempt: 1 });
assert.equal(prefix, 'captures/abcd1234/p2x9/a1/');
const index = await storeCapture(store, { dir: work, prefix, partSize: 100_000 });
assert.ok(index.parts >= 3, 'split into several parts');
assert.equal(index.files, 11);
assert.ok([...objects.keys()].every((k) => k.startsWith(prefix)));

const back = path.join(tmp, 'back');
await restoreCapture(store, { prefix, dir: back });
assert.deepEqual(fs.readFileSync(path.join(back, 'raw/img/a.jpg')), fs.readFileSync(path.join(work, 'raw/img/a.jpg')));
assert.ok(fs.existsSync(path.join(back, 'rendered-mobile.html')));
for (const f of ['variants', 'img-cache', 'gate-desktop.png', 'live2-desktop.png', 'verdict.json', 'job.json']) assert.ok(!fs.existsSync(path.join(back, f)), `${f} not stored`);

objects.set(`${prefix}part-001`, Buffer.from('damaged'));
await assert.rejects(restoreCapture(store, { prefix, dir: path.join(tmp, 'bad') }), /damaged/);

await deleteCapture(store, { prefix, parts: index.parts });
assert.equal(objects.size, 0);
await deleteCapture(store, { prefix, parts: index.parts });  // already gone: still fine

fs.rmSync(tmp, { recursive: true, force: true });
console.log('capture store: all checks passed');
