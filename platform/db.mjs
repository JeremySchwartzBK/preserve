// Database changes with a record (production-readiness review, item A3). Every schema file that is run against a
// database is written down in that database (table schema_applied: file, fingerprint of its contents, when), so
// "what is loaded where" is a question the database answers instead of a note in a README.
//
//   node db.mjs status             which files are loaded, which changed since, which never were
//   node db.mjs apply <file>...    run the files (each in one transaction with its record; all or nothing per file)
//   node db.mjs record <file>...   write the record without running (only for files loaded before this tool existed)
//
// Which database: SUPABASE_PROJECT_REF=<ref> (through Supabase's management API; SUPABASE_ACCESS_TOKEN when not behind
// the proxy), or PGHOST/PGUSER/PGDATABASE for a local Postgres (psql). apply and record need --yes, and print the
// target first. Files are listed in schema-order.txt. The early ones can't be run twice; files from schema-guards.sql on can.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const order = () => fs.readFileSync(path.join(HERE, 'schema-order.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
export const fingerprint = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, file))).digest('hex');
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const RECORD_TABLE = `create table if not exists schema_applied (
  id bigint generated always as identity primary key, file text not null, sha256 text not null,
  applied_at timestamptz not null default now(), how text not null default 'applied');
alter table schema_applied enable row level security;
revoke all on schema_applied from anon, authenticated;`;
const READ = `select coalesce(json_agg(json_build_object('file', file, 'sha256', sha256, 'at', applied_at, 'how', how) order by id), '[]'::json) as r from schema_applied`;

// What to tell the person about each file. applied: schema_applied's rows, oldest first.
export function statusOf(files, applied, hash = fingerprint) {
  return files.map((file) => {
    const last = applied.filter((a) => a.file === file).at(-1);
    return { file, state: !last ? 'no record' : last.sha256 === hash(file) ? 'loaded' : 'changed since it was loaded', at: last?.at || null };
  });
}

export function target(env = process.env) {
  if (env.SUPABASE_PROJECT_REF) return { name: `Supabase project ${env.SUPABASE_PROJECT_REF}`, run: async (sql) => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST',
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN || 'placeholder'}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: sql }) });
    const text = await r.text();
    if (!r.ok) throw new Error(`database said ${r.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text || '[]');
  } };
  if (env.PGHOST) return { name: `local Postgres at ${env.PGHOST}`, run: async (sql) => {
    const out = execFileSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, env, encoding: 'utf8', maxBuffer: 64e6, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const last = out.split('\n').at(-1);
    try { return [{ r: JSON.parse(last) }]; } catch { return []; }
  } };
  throw new Error('Say which database: SUPABASE_PROJECT_REF=<ref>, or PGHOST=... for a local one.');
}

export async function readApplied(db) {
  const has = await db.run(`select json_build_object('has', to_regclass('public.schema_applied') is not null) as r`);
  if (!has[0]?.r?.has) return [];
  return (await db.run(READ))[0].r;
}
const recordSql = (file, how) => `insert into schema_applied (file, sha256, how) values (${lit(file)}, ${lit(fingerprint(file))}, ${lit(how)});`;
export const applyFile = (db, file) => db.run(`begin;\n${RECORD_TABLE}\n${fs.readFileSync(path.join(HERE, file), 'utf8')}\n;\n${recordSql(file, 'applied')}\ncommit;`);
export const recordFile = (db, file) => db.run(`begin;\n${RECORD_TABLE}\n${recordSql(file, 'recorded')}\ncommit;`);

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const files = rest.filter((a) => !a.startsWith('--'));
  const db = target();
  if (cmd === 'status') {
    const rows = statusOf(order(), await readApplied(db));
    console.log(db.name);
    for (const r of rows) console.log(`  ${r.file.padEnd(28)} ${r.state}${r.at ? `  (${String(r.at).slice(0, 16).replace('T', ' ')})` : ''}`);
    process.exit(rows.every((r) => r.state === 'loaded') ? 0 : 2);
  } else if ((cmd === 'apply' || cmd === 'record') && files.length) {
    const unknown = files.filter((f) => !order().includes(f));
    if (unknown.length) { console.error(`Not in schema-order.txt: ${unknown.join(', ')}`); process.exit(1); }
    console.log(`${cmd} on ${db.name}: ${files.join(', ')}`);
    if (!rest.includes('--yes')) { console.error('Nothing done. Add --yes to go ahead.'); process.exit(1); }
    for (const f of order().filter((x) => files.includes(x))) { await (cmd === 'apply' ? applyFile : recordFile)(db, f); console.log(`  ${f} ${cmd === 'apply' ? 'applied' : 'recorded'}`); }
  } else { console.error('Usage: node db.mjs status | apply <file>... --yes | record <file>... --yes'); process.exit(1); }
}
