// One-off: upload the five test copies to R2 under permanent IDs, studio "demo". Usage: node migrate.mjs <stageRoot> <outJson>
import fs from 'node:fs';
import { cloudflareStore, uploadVersion, setCopy, setNames } from './copy-store.mjs';
const [root, outJson] = process.argv.slice(2);
const store = cloudflareStore({ account: '1dcf2dbf05caa4963ed872ff035bc9db', bucket: 'preserve-copies', kvNamespace: 'c67307a470e44d529efa87933c42942f' });
const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
const prev = fs.existsSync(outJson) ? JSON.parse(fs.readFileSync(outJson, 'utf8')) : {};
const out = { ...prev };
for (const name of ['minaab', 'breathpod', 'kosa', 'designforward', 'xanadu']) {
  const id = prev[name]?.id || Array.from({ length: 8 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  const version = (prev[name]?.version || 0) + 1;
  const up = await uploadVersion(store, { dir: `${root}/${name}`, id, version });
  await setCopy(store, { id, version, studio: 'demo', name });
  await setNames(store, { studio: 'demo', id, current: name });
  out[name] = { id, version, ...up };
  console.log(name, id, version, up);
}
fs.writeFileSync(outJson, JSON.stringify(out, null, 1));
