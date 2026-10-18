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
      if (r?.ok) return;
      const transient = err || r.status === 429 || r.status >= 500;
      const msg = err ? String(err.message) : `${r.status} ${(await r.text()).slice(0, 200)}`;
      if (!transient || i >= 5) throw new Error(`${init.method} ${p}: ${msg}`);
      await new Promise((s) => setTimeout(s, 1000 * 2 ** i));
    }
  };
  return {
    put: (key, body, type) => call(`/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, { method: 'PUT', body, headers: { 'content-type': type } }),
    del: (key) => call(`/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    // Lookup records live in R2 (lookup/<key>.json): KV's free tier allows only 1,000 writes a day.
    kvPut: (key, value) => call(`/r2/buckets/${bucket}/objects/${encodeURIComponent(lookupKey(key))}`, { method: 'PUT', body: JSON.stringify(value), headers: { 'content-type': 'application/json' } }),
    kvDel: (key) => call(`/r2/buckets/${bucket}/objects/${encodeURIComponent(lookupKey(key))}`, { method: 'DELETE' }),
  };
}

export function bindingStore({ bucket, kv }) {
  return {
    put: (key, body, type) => bucket.put(key, body, { httpMetadata: { contentType: type } }),
    del: (key) => bucket.delete(key),
    kvPut: (key, value) => bucket.put(lookupKey(key), JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } }),
    kvDel: (key) => bucket.delete(lookupKey(key)),
  };
}

const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript', webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', woff2: 'font/woff2', woff: 'font/woff' };

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

// What visitors see for a copy: which version, or paused/deleted.
export const setCopy = (store, { id, version, status = 'live', studio, name }) => store.kvPut(`copy:${id}`, { v: version, status, studio, name });

// Friendly names. A rename writes the new name and repoints every old name at it, so old links redirect.
export async function setNames(store, { studio, id, current, old = [] }) {
  await store.kvPut(`name:${studio}/${current}`, { id, current });
  for (const n of old) await store.kvPut(`name:${studio}/${n}`, { id, current });
}
