// Checks links between pages of a copy (link-pages.mjs): node test-link-pages.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { linkPages, relPath } from './link-pages.mjs';

assert.equal(relPath('', ''), './');
assert.equal(relPath('', 'about'), 'about/');
assert.equal(relPath('about', ''), '../');
assert.equal(relPath('work/kosa', 'about'), '../../about/');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'link-pages-'));
const html = '<html><body><a id="home" href="/">Home</a><a id="about" href="/about/">About</a><a id="kosa" href="https://www.site.com/work/kosa?x=1#top">Kosa</a>'
  + '<a id="shop" href="/shop">Shop</a><a id="ext" href="https://elsewhere.com/about">Other</a><a id="mail" href="mailto:a@b.c">Mail</a><a id="jump" href="#x">Jump</a></body></html>';
const pages = [['', 'https://site.com/'], ['about', 'https://site.com/about'], ['work/kosa', 'https://site.com/work/kosa']].map(([p, u]) => {
  const dir = path.join(tmp, p || 'home'); fs.mkdirSync(dir, { recursive: true });
  for (const l of ['desktop', 'mobile']) fs.writeFileSync(path.join(dir, `${l}.html`), html);
  return { path: p, source_url: u, dir };
});

assert.deepEqual(linkPages([pages[0]]), { marked: 0 }, 'one page: nothing marked');
assert.equal(fs.readFileSync(path.join(pages[0].dir, 'desktop.html'), 'utf8'), html);

const r = linkPages(pages);
assert.equal(r.marked, 3 * 3 * 2);
const kosa = fs.readFileSync(path.join(pages[2].dir, 'mobile.html'), 'utf8');
assert.match(kosa, /id="home" href="\.\.\/\.\.\/" data-pv-internal/);
assert.match(kosa, /id="about" href="\.\.\/\.\.\/about\/" data-pv-internal/);
assert.match(kosa, /id="kosa" href="#top" data-pv-internal/);
assert.match(kosa, /id="shop" href="\/shop">/, 'uncaptured page left alone');
assert.match(kosa, /id="ext" href="https:\/\/elsewhere.com\/about">/, 'other site left alone');
const home = fs.readFileSync(path.join(pages[0].dir, 'desktop.html'), 'utf8');
assert.match(home, /id="kosa" href="work\/kosa\/#top" data-pv-internal/);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('links between pages: all checks passed');
