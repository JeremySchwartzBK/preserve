// Adobe Fonts (Typekit) API for the Adobe Fonts connection (schema-adobe.sql). Docs: https://fonts.adobe.com/docs/api
// The designer's own API key (made at https://typekit.com/account/tokens) is sent as X-Typekit-Token. There is no
// account-status call: a refused key, or a kit whose fonts don't load, is how a lapse shows (checkConnection below).
//
// We keep one web project ("kit") named "Preserve" per studio. Web projects need no domain list (Adobe help), so the
// kit works on view.preserve.studio and in embeds. Publishing reaches Adobe's servers in up to a minute for a new kit
// and up to five minutes for a change.

const API = 'https://typekit.com/api/v1/json';
export const KIT_NAME = 'Preserve';
export const kitCss = (kit) => `https://use.typekit.net/${kit}.css`;

export class AdobeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
  // 401/403: the key is wrong, revoked, or the account no longer has Adobe Fonts.
  get refused() { return this.status === 401 || this.status === 403; }
}

export function adobe(token, { fetch: f = fetch } = {}) {
  async function call(method, path, form) {
    const r = await f(`${API}/${path}`, {
      method,
      redirect: 'manual',
      headers: { 'X-Typekit-Token': token, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    // families/<slug> answers 302 with the family's id in the Location and the body.
    if (r.status === 302) return { redirect: r.headers.get('location') || '', ...(await r.json().catch(() => ({}))) };
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new AdobeError(r.status, (body.errors || [`Adobe answered ${r.status}`]).join('; '));
    return body;
  }
  return {
    kits: async () => (await call('GET', 'kits')).kits || [],
    kit: async (id) => (await call('GET', `kits/${encodeURIComponent(id)}`)).kit,
    createKit: async () => (await call('POST', 'kits', { name: KIT_NAME })).kit,
    // Adobe's family id for a css name (proxima-nova), or null when Adobe has no such family.
    async familyId(cssName) {
      try {
        const r = await call('GET', `families/${encodeURIComponent(cssName)}`);
        const fromLocation = /\/families\/([a-z0-9]+)/i.exec(r.redirect || '')?.[1];
        return fromLocation || r.family?.id || null;
      } catch (e) { if (e.status === 404) return null; throw e; }
    },
    // All variations of the family (the page may use any weight); Adobe's default subset.
    addFamily: (kit, familyId) => call('POST', `kits/${encodeURIComponent(kit)}/families/${encodeURIComponent(familyId)}`, { variations: 'all' }),
    publish: (kit) => call('POST', `kits/${encodeURIComponent(kit)}/publish`),
  };
}

// Find the studio's "Preserve" kit (made by us earlier, possibly before a disconnect), or make one.
export async function ensureKit(api, known) {
  if (known) { try { await api.kit(known); return known; } catch (e) { if (e.refused) throw e; } }
  const mine = (await api.kits()).find((k) => k.name === KIT_NAME);
  if (mine) return mine.id;
  return (await api.createKit()).id;
}

// Add the families the studio's Preserves use that the kit doesn't have yet, then publish. Returns the updated
// css name -> family id map (null where Adobe has no such family) and whether anything was added.
export async function syncFamilies(api, kit, wanted, known = {}) {
  const map = { ...known };
  const have = new Set(((await api.kit(kit))?.families || []).map((f) => f.id));
  let added = 0;
  for (const name of wanted) {
    if (!(name in map)) map[name] = await api.familyId(name);
    if (map[name] && !have.has(map[name])) { await api.addFamily(kit, map[name]); have.add(map[name]); added++; }
  }
  if (added) await api.publish(kit);
  return { families: map, added };
}

// The daily check: the key still works (Adobe answers for the kit) and the kit's fonts actually load. A refused key
// is 'key-refused'; a kit that answers but serves no fonts (Adobe stops a lapsed account's web fonts) is
// 'not-loading'. Network trouble on our side throws, so the caller keeps the last state instead of switching
// every Preserve to lookalikes over a blip.
export async function checkConnection(api, kit, { fetch: f = fetch } = {}) {
  try { await api.kit(kit); } catch (e) { if (e.refused) return { state: 'key-refused', problem: e.message }; throw e; }
  const css = await f(kitCss(kit));
  if (!css.ok) return { state: 'not-loading', problem: `kit stylesheet answered ${css.status}` };
  const text = await css.text();
  const font = /url\("?(https:\/\/use\.typekit\.net\/af\/[^")]+)"?\)/.exec(text)?.[1];
  if (!font) return { state: text.includes('@font-face') ? 'not-loading' : 'ok', problem: text.includes('@font-face') ? 'kit stylesheet names no font files' : null };
  const r = await f(font, { headers: { origin: 'https://view.preserve.studio' } });
  if (!r.ok) return { state: 'not-loading', problem: `font file answered ${r.status}` };
  return { state: 'ok', problem: null };
}
