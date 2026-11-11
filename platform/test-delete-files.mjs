// Deleting a Preserve removes its files and nothing else. Run: node test-delete-files.mjs
import assert from 'node:assert/strict';
import { deleteCopyFiles, lookupKey } from './worker/copy-store.mjs';

function fakeStore(keys) {
  const have = new Set(keys);
  return {
    have,
    list: async (prefix) => [...have].filter((k) => k.startsWith(prefix)),
    del: async (k) => { if (!have.delete(k)) throw new Error(`DELETE ${k}: 404 not found`); },
    kvDel: async (k) => { have.delete(lookupKey(k)); },
  };
}
const mine = ['copies/k7f2qx9m/a/abc.webp', 'copies/k7f2qx9m/v1/p/ab12/desktop.html', 'copies/k7f2qx9m/v1/p/ab12/mobile.html', 'copies/k7f2qx9m/v2/manifest.json', 'logs/k7f2qx9m/a1-t1.log', 'lookup/tour/k7f2qx9m.json', 'lookup/fonts/k7f2qx9m.json'];
const others = ['copies/k7f2qx9n/a/abc.webp', 'copies/zzzzzzzz/v1/desktop.html', 'logs/zzzzzzzz/a1-t1.log', 'lookup/copy/k7f2qx9m.json', 'lookup/tour/zzzzzzzz.json', 'captures/k7f2qx9m/ab12/a1/index.json', 'platform/tour.js'];
const s = fakeStore([...mine, ...others]);
assert.equal(await deleteCopyFiles(s, 'k7f2qx9m'), 5);
assert.deepEqual([...s.have].sort(), [...others].sort(), 'only this Preserve\'s files went; the "deleted" record, captures and other Preserves stay');
assert.equal(await deleteCopyFiles(s, 'k7f2qx9m'), 0, 'running it again is harmless');
for (const bad of ['', 'k7f2', '../zzzzzzzz', 'K7F2QX9M', undefined, 'k7f2qx9m/']) await assert.rejects(deleteCopyFiles(s, bad), /not a copy id/);
assert.deepEqual([...s.have].sort(), [...others].sort());
console.log('delete files: all checks pass');
