// Links between the pages of a copy (design A4). When a copy has more than one page, a link on one page that points to
// another captured page becomes a relative link to that page of the copy, marked data-pv-internal so the replica note
// (build.mjs REPLICA_SCRIPT) lets it navigate. Every other link keeps showing "this is a preview copy". With one page
// (every copy so far) nothing is marked.
//
// pages: [{path, source_url, dir}] where path is the page's address inside the copy ('' = entry page, 'work/kosa') and
// dir holds its desktop.html and mobile.html.
// Usage: node link-pages.mjs <pages.json>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';

// The same page whatever the trailing slash, case of the host, "www." or query string.
const key = (u) => { const x = new URL(u); return x.hostname.replace(/^www\./, '').toLowerCase() + (x.pathname.replace(/\/+$/, '') || '/'); };

// Relative address from the page at `from` to the page at `to` (both copy paths), served as <path>/ by the viewer.
export const relPath = (from, to) => '../'.repeat(from ? from.split('/').length : 0) + (to ? `${to}/` : '') || './';

export function linkPages(pages) {
  const byKey = new Map(pages.map((p) => [key(p.source_url), p]));
  let marked = 0;
  if (pages.length < 2) return { marked };
  for (const p of pages) for (const layout of ['desktop', 'mobile']) {
    const file = path.join(p.dir, `${layout}.html`);
    const $ = cheerio.load(fs.readFileSync(file, 'utf8'));
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
      let u; try { u = new URL(href, p.source_url); } catch { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      const target = byKey.get(key(u.href));
      if (!target) return;
      $(el).attr('href', (target === p && u.hash ? '' : relPath(p.path, target.path)) + u.hash).attr('data-pv-internal', '');
      marked++;
    });
    fs.writeFileSync(file, $.html());
  }
  return { marked };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(linkPages(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))));
}
