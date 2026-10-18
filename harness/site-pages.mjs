// Writes the hosting extras around exported copies: _routes.json (edge code only on copy roots), an embed snippet and a
// demo portfolio page per site, and a small index. Usage: node site-pages.mjs <outRoot> <publicBase> <site...>
import fs from 'node:fs';
import path from 'node:path';
const [outRoot, pub, ...sites] = process.argv.slice(2);
const NAMES = { minaab: 'minaab', breathpod: 'Breathpod', kosa: 'Kosa', designforward: 'Design Forward', xanadu: 'Xanadu' };
fs.writeFileSync(path.join(outRoot, '_routes.json'), JSON.stringify({ version: 1, include: sites.flatMap((s) => [`/${s}`, `/${s}/`]), exclude: [] }));
fs.copyFileSync(path.join('edge', '_worker.js'), path.join(outRoot, '_worker.js'));
// Pages allows one splat per rule, so each site's asset folder gets its own long-cache rule (file names are content hashes).
// Copies are previews, never stand-ins for the real sites: every response says "don't index" (pages, images, fonts),
// on every hostname Pages serves the project under, including per-deployment preview URLs.
export const ROBOTS = 'noindex, nofollow, noarchive, nosnippet, noimageindex';
fs.writeFileSync(path.join(outRoot, '_headers'), `/*\n  X-Robots-Tag: ${ROBOTS}\n` + sites.map((s) => `/${s}/a/*\n  Cache-Control: public, max-age=31536000, immutable\n`).join(''));
// Search engines may crawl (that's how they read the "don't index" tag; blocking them here would hide it), but AI
// training crawlers and archives are asked to stay out entirely.
fs.writeFileSync(path.join(outRoot, 'robots.txt'), ['GPTBot', 'ChatGPT-User', 'CCBot', 'ClaudeBot', 'anthropic-ai', 'Google-Extended', 'Applebot-Extended', 'PerplexityBot', 'Bytespider', 'Amazonbot', 'meta-externalagent', 'cohere-ai', 'Diffbot', 'ia_archiver', 'archive.org_bot'].map((b) => `User-agent: ${b}\nDisallow: /\n`).join('\n') + '\nUser-agent: *\nAllow: /\n');
// The snippet picks the layout from the frame's own width before loading it, so the frame needs no extra round trip.
export const snippet = (s) => `<div class="preserve-embed" style="position:relative;width:100%;aspect-ratio:16/10;max-height:90vh">
<style>@media (max-width:767px){.preserve-embed{aspect-ratio:auto!important;height:78vh}}</style>
<iframe title="Interactive preview of the ${NAMES[s] || s} website" style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.15);background:#fff" loading="eager" referrerpolicy="no-referrer"></iframe>
<script>(function(f){f.src='${pub}/${s}/'+(f.parentNode.offsetWidth<768?'mobile':'desktop')})(document.currentScript.previousElementSibling)</script>
</div>`;
let snips = '';
for (const s of sites) {
  fs.writeFileSync(path.join(outRoot, s, 'embed-demo.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${ROBOTS}"><title>Project: ${NAMES[s] || s}</title>
<style>body{margin:0;font:16px/1.5 Georgia,serif;color:#222;background:#f6f3ee}main{max-width:1180px;margin:0 auto;padding:24px 16px}h1{font-size:28px;margin:0 0 8px}p{margin:0 0 16px}</style></head><body><main>
<h1>Project: ${NAMES[s] || s}</h1><p>Website design and build, 2025. Scroll inside the preview to explore the live design.</p>
${snippet(s)}
<p style="margin-top:16px">More about the project…</p></main></body></html>`);
  snips += `## ${NAMES[s] || s}\n\nLink: ${pub}/${s}/\n\nEmbed:\n\n\`\`\`html\n${snippet(s)}\n\`\`\`\n\n`;
}
fs.writeFileSync(path.join(outRoot, 'snippets.md'), snips);
fs.writeFileSync(path.join(outRoot, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${ROBOTS}"><title>Preview copies</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}a{color:#0b57d0}li{margin:6px 0}</style></head><body><h1>Preview copies</h1><ul>
${sites.map((s) => `<li>${NAMES[s] || s}: <a href="/${s}/">full window</a> · <a href="/${s}/embed-demo">embedded in a page</a></li>`).join('\n')}
</ul></body></html>`);
console.log('ok');
