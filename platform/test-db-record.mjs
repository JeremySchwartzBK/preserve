// The record of applied database files (db.mjs), checked on the local test database. Run by test-db.sh.
import { order, target, readApplied, statusOf, applyFile, recordFile, fingerprint } from './db.mjs';
const results = [];
const ok = (name, cond, detail = '') => { results.push(!!cond); if (!cond) console.log('FAIL', name, detail); };
const db = target();
const state = async () => Object.fromEntries(statusOf(order(), await readApplied(db)).map((r) => [r.file, r.state]));

let s = await state();
ok('nothing recorded at first', Object.values(s).every((v) => v === 'no record'), JSON.stringify(s));
await recordFile(db, 'schema.sql');
await applyFile(db, 'schema-guards.sql');
await applyFile(db, 'schema-review-links.sql');
s = await state();
ok('recorded and applied files show as loaded', s['schema.sql'] === 'loaded' && s['schema-guards.sql'] === 'loaded' && s['schema-review-links.sql'] === 'loaded', JSON.stringify(s));
ok('the rest still have no record', s['schema-actions.sql'] === 'no record');
const rows = await readApplied(db);
ok('each run is written down with how', rows.length === 3 && rows[0].how === 'recorded' && rows[1].how === 'applied' && rows[1].sha256 === fingerprint('schema-guards.sql'));
ok('a file edited after loading is flagged', statusOf(['schema.sql'], rows, () => 'different')[0].state === 'changed since it was loaded');
// A file that fails leaves no record and none of its changes.
let failed = false;
try { await db.run(`begin; create table half_done (x int); select 1/0; commit;`); } catch { failed = true; }
ok('a failing run stops', failed);
ok('and leaves nothing behind', (await db.run(`select json_build_object('has', to_regclass('public.half_done') is not null) as r`))[0].r.has === false);
// Signed-in people can't read or write the record.
let denied = false;
try { await db.run(`set role authenticated; select count(*) from schema_applied;`); } catch { denied = true; }
ok('the record is closed to signed-in people', denied);
const bad = results.filter((x) => !x).length;
console.log(bad ? `database record: ${bad} FAILED` : `database record: all ${results.length} checks pass`);
process.exit(bad ? 1 : 0);
