// Writes copies to R2 and the edge lookup to KV. Used by the app (and the copy job) whenever something visitors see
// changes: publishing a version, renaming, pausing, deleting. The database (schema.sql) stays the source of truth;
// these records are what the serving Worker reads.
//
// Two backends: the Cloudflare REST API (real account) and Miniflare bindings (local tests).
import fs from 'node:fs';
import path from 'node:path';

// copy:<id> -> lookup/copy/<id>.json, name:<studio>/<name> -> lookup/name/<studio>/<name>.json, tour:<id> -> lookup/tour/<id>.json
export const lookupKey = (key) => `lookup/${key.replace(':', '/')}.json`;

export function cloudflareStore({ account, bucket, kvNamespace, token = process.env.CLOUDFLARE_API_TOKEN || 'injected-by-proxy' }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  // Cloudflare's API sometimes answers 5xx or 429 for a moment; those are retried, anything else fails at once.
  const call = async (p, init) => {
    for (let i = 0; ; i++) {
      let r, err;
      try { r = await fetch(base + p, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } }); } catch (e) { err = e; }
      if (r?.ok) return r;
      const transient = err || r.status === 429 || r.status >= 500;
      const msg = err ? String(err.message) : `${r.status} ${(await r.text()).slice(0, 200)}`;
      if (!transient || i >= 5) throw new Error(`${init.method} ${p}: ${msg}`);
      await new Promise((s) => setTimeout(s, 1000 * 2 ** i));
    }
  };
  return {
    put: (key, body, type) => call(`/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, { method: 'PUT', body, headers: { 'content-type': type } }),
    get: async (key) => Buffer.from(await (await call(`/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, { method: 'GET' })).arrayBuffer()),
    // Every key under a prefix.
    list: async (prefix) => {
      const keys = [];
      for (let cursor = ''; ;) {
        const r = await (await call(`/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { method: 'GET' })).json();
        keys.push(...(r.result || []).map((o) => o.key));
        cursor = r.result_info?.is_truncated ? r.result_info.cursor : '';
        if (!cursor) return keys;
      }
    },
    del: (key) => call(`/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    // Lookup records live in R2 (lookup/<key>.json): KV's free tier allows only 1,000 writes a day.
    kvPut: (key, value) => call(`/r2/buckets/${bucket}/objects/${encodeURIComponent(lookupKey(key))}`, { method: 'PUT', body: JSON.stringify(value), headers: { 'content-type': 'application/json' } }),
    kvDel: (key) => call(`/r2/buckets/${bucket}/objects/${encodeURIComponent(lookupKey(key))}`, { method: 'DELETE' }),
  };
}

export function bindingStore({ bucket, kv }) {
  return {
    put: (key, body, type) => bucket.put(key, body, { httpMetadata: { contentType: type } }),
    get: async (key) => Buffer.from(await (await bucket.get(key)).arrayBuffer()),
    list: async (prefix) => {
      const keys = [];
      for (let cursor; ;) {
        const r = await bucket.list({ prefix, cursor });
        keys.push(...r.objects.map((o) => o.key));
        if (!r.truncated) return keys;
        cursor = r.cursor;
      }
    },
    del: (key) => bucket.delete(key),
    kvPut: (key, value) => bucket.put(lookupKey(key), JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } }),
    kvDel: (key) => bucket.delete(lookupKey(key)),
  };
}

const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript', webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff', txt: 'text/plain; charset=utf-8' };

// Upload a finished copy folder (desktop.html, mobile.html, a/*) as a new version. Visitors keep seeing the old
// version until setCopy() points at the new one.
export async function uploadVersion(store, { dir, id, version, concurrency = 8 }) {
  const files = ['desktop.html', 'mobile.html', ...fs.readdirSync(path.join(dir, 'a')).map((f) => `a/${f}`)];
  let i = 0, bytes = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < files.length) {
      const f = files[i++];
      const body = fs.readFileSync(path.join(dir, f));
      bytes += body.length;
      await store.put(`copies/${id}/v${version}/${f}`, body, TYPES[f.split('.').pop()] || 'application/octet-stream');
    }
  }));
  return { files: files.length, bytes };
}

// Upload a version in the page layout (storage format 2, design A2), used for new copies from 2026-10-18:
//   copies/<id>/a/<file>                       files shared by every page and version (names are content hashes)
//   copies/<id>/v<n>/manifest.json             {pages: [{page_id, path, title}], layouts}
//   copies/<id>/v<n>/p/<page_id>/<layout>.html
// pages: [{page_id, path, title, dir}], each dir holding desktop.html, mobile.html and a/. Shared files already stored
// for this copy (an earlier version, another page) aren't uploaded again.
export async function uploadPages(store, { id, version, pages, concurrency = 8 }) {
  const have = new Set(await store.list(`copies/${id}/a/`));
  const jobs = [];
  for (const p of pages) {
    for (const layout of LAYOUTS) jobs.push([path.join(p.dir, `${layout}.html`), `copies/${id}/v${version}/p/${p.page_id}/${layout}.html`]);
    for (const f of fs.readdirSync(path.join(p.dir, 'a'))) {
      const key = `copies/${id}/a/${f}`;
      if (!have.has(key)) { have.add(key); jobs.push([path.join(p.dir, 'a', f), key]); }
    }
  }
  let i = 0, bytes = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < jobs.length) {
      const [file, key] = jobs[i++];
      const body = fs.readFileSync(file);
      bytes += body.length;
      await store.put(key, body, TYPES[key.split('.').pop()] || 'application/octet-stream');
    }
  }));
  const manifest = { format: 2, pages: pages.map(({ page_id, path: p, title }) => ({ page_id, path: p, title: title || null })), layouts: LAYOUTS };
  await store.put(`copies/${id}/v${version}/manifest.json`, JSON.stringify(manifest), 'application/json');
  return { files: jobs.length + 1, bytes };
}
const LAYOUTS = ['desktop', 'mobile'];

// What visitors see for a copy: which version, or paused/deleted. A version in the page layout also says so (fmt 2)
// and lists its pages by path ('' = the entry page), which is how the viewer finds them.
export const setCopy = (store, { id, version, status = 'live', studio, name, fmt, pages }) =>
  store.kvPut(`copy:${id}`, fmt === 2 ? { v: version, status, studio, name, fmt, pages } : { v: version, status, studio, name });

// Friendly names. A rename writes the new name and repoints every old name at it, so old links redirect.
export async function setNames(store, { studio, id, current, old = [] }) {
  await store.kvPut(`name:${studio}/${current}`, { id, current });
  for (const n of old) await store.kvPut(`name:${studio}/${n}`, { id, current });
}
