// Adds (or refreshes) the header menu script in already-exported copies, without re-capturing.
// Usage: node inject-menu.mjs <hostedRoot> [site ...]
import fs from 'node:fs';
import path from 'node:path';
import { MENU_SCRIPT } from './build.mjs';

const [root, ...only] = process.argv.slice(2);
const sites = only.length ? only : fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'desktop.html')));
for (const site of sites) for (const page of ['desktop.html', 'mobile.html']) {
  const p = path.join(root, site, page);
  let html = fs.readFileSync(p, 'utf8').replace(/<script id="preserve-menu">[\s\S]*?<\/script>/, '');
  const at = html.indexOf('<script id="preserve-replica">');
  html = at >= 0 ? html.slice(0, at) + MENU_SCRIPT + html.slice(at) : html.replace(/<\/body>/i, MENU_SCRIPT + '</body>');
  fs.writeFileSync(p, html);
  console.log(site, page, 'ok');
}
