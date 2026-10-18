// Publishes a folder of finished copies to a Cloudflare Pages project, then deletes the project's older deployments
// (each one keeps its own reachable address, and older ones may hold pre-scrub content).
// Usage: node publish.mjs <readyRoot> <pagesProject>
// Needs CLOUDFLARE_ACCOUNT_ID; the API token is injected by the environment (CLOUDFLARE_API_TOKEN may be a placeholder).
// Interim: one Pages project holding every copy. The account review recommends R2 + a Worker with permanent copy IDs
// before real customers; only this file changes when that lands.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Node's fetch only goes through the environment's proxy (which adds the Cloudflare token) when this is set at start.
if (!process.env.NODE_USE_ENV_PROXY) {
  const r = (await import('node:child_process')).spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(r.status ?? 1);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const [root, project] = process.argv.slice(2);
const account = process.env.CLOUDFLARE_ACCOUNT_ID || '1dcf2dbf05caa4963ed872ff035bc9db';
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || 'injected-by-proxy' };
const sites = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'desktop.html')));
const pub = `https://${project}.pages.dev`;
execFileSync('node', ['site-pages.mjs', path.resolve(root), pub, ...sites], { cwd: HERE, stdio: 'inherit' });

const api = async (p, init = {}) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects${p}`, { ...init, headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  return r.json();
};
const existing = await api(`/${project}`);
if (!existing.success) {
  const c = await api('', { method: 'POST', body: JSON.stringify({ name: project, production_branch: 'main' }) });
  if (!c.success) throw new Error('could not create Pages project: ' + JSON.stringify(c.errors));
}
execFileSync('npx', ['-y', 'wrangler@4', 'pages', 'deploy', path.resolve(root), '--project-name', project, '--branch', 'main', '--commit-dirty=true'], { cwd: HERE, env, stdio: 'inherit', timeout: 15 * 60e3 });

const list = await api(`/${project}/deployments?per_page=25`);
const deps = (list.result || []).sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
for (const d of deps.slice(1)) {
  const r = await api(`/${project}/deployments/${d.id}?force=true`, { method: 'DELETE' });
  console.log('deleted old deployment', d.id, r.success);
}
console.log(JSON.stringify({ project, url: pub, sites }));
