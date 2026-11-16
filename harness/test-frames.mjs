// Embedded widgets saved as real content (frames.mjs): the saved document carries each view, its files, the view
// switching and the snapshot note, and loads nothing from the widget's site. Usage: node test-frames.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { frameDoc, PAGE_SCRIPT } from './frames.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'));
fs.mkdirSync(path.join(dir, 'frames', 'files'), { recursive: true });
fs.writeFileSync(path.join(dir, 'frames', 'files', 'pf-aaa.png'), 'png');
const body = (view) => `<body class="w"><div><button data-pv-ctl="CARD">CARD</button><button data-pv-ctl="LIST">LIST</button></div><div style="background:url('pfa:pf-aaa.png')">${view} view</div><img src="pfa:pf-aaa.png"><a href="#">Event</a></body>`;
fs.writeFileSync(path.join(dir, 'frames', 'desktop-0.json'), JSON.stringify({
  src: 'https://widgets.example/w/1', autosize: true, height: 600,
  states: [
    { key: 'CARD', html: [['lang', 'en']], body: body('Card'), css: '.w{color:red}</style><script>x</script>', h: 600, text: 'Card view' },
    { key: 'LIST', html: [['lang', 'en']], body: body('List'), css: '.w{color:red}', h: 300, text: 'List view' },
    { key: 'pv:d0', ov: '<div class="modal"><button data-pv-ctl="pv:close">×</button><img src="pfa:pf-aaa.png">Event details $\' text</div>', host: [], ch: [[[], [['class', 'w open'], ['inert', null]]]], css: '.w{color:red}', h: 0, text: 'Event details' },
  ],
}));
const copied = [];
const d = frameDoc(dir, 'desktop-0', (name, file) => { copied.push(name); return fs.existsSync(file) ? `a/${name}` : null; });
assert.ok(d, 'a saved frame gives a document');
assert.equal(d.autosize, true);
assert.equal(d.views, 2, 'both views are kept');
assert.equal(d.details, 1, 'the detail window is kept');
assert.ok(d.doc.includes('pv:d0') && d.doc.includes('Event details $\' text'), 'the detail window travels with the document, text as it was');
assert.ok(d.doc.includes('cur="CARD"'), 'the frame starts on the first view');
assert.ok(copied.includes('pf-aaa.png'), 'its files are copied with the Preserve');
assert.ok(!d.doc.includes('pfa:'), 'every saved-file address is replaced');
assert.ok(d.doc.includes('a/pf-aaa.png'));
assert.ok(!/https?:\/\/widgets\.example/.test(d.doc), 'nothing points at the widget\'s site');
assert.ok(!/<\/style><script>x/.test(d.doc), 'CSS text cannot close its style tag');
assert.equal((d.doc.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').match(/<script>/g) || []).length, 1, 'one script: the view switcher');
assert.ok(!/<\/script>(?!<\/html>$)/.test(d.doc.slice(d.doc.lastIndexOf('<script>'))), 'the views inside the script cannot close it early');
assert.ok(d.doc.includes('"List view') || d.doc.includes('List view'), 'the List view travels with the document');
assert.ok(PAGE_SCRIPT.includes('preserve-frames') && PAGE_SCRIPT.includes('data-pv-autosize'));
assert.equal(frameDoc(dir, 'mobile-9', () => null), null, 'no saved frame, no document');
// After scrub.py the saved document has no raw < or >: text edits on the page (the viewer adds its scripts before the
// first </body>) can't land inside the frame. Contact details inside the frame are replaced too.
const site = path.join(dir, 'site'); fs.mkdirSync(path.join(site, 'a'), { recursive: true });
const esc = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const inner = d.doc.replace('Card view', 'Card view, write to jane@acme-studio.com');
fs.writeFileSync(path.join(site, 'desktop.html'), `<!doctype html><html><head></head><body><iframe data-preserve-frame="desktop-0" srcdoc="${esc(inner)}"></iframe></body></html>`);
execFileSync('python3', ['scrub.py', site, 'https://acme-studio.com/'], { stdio: 'pipe' });
const page = fs.readFileSync(path.join(site, 'desktop.html'), 'utf8');
assert.equal(page.match(/<\/body>/g).length, 1, 'the only raw </body> is the page\'s own');
assert.ok(/srcdoc="[^"<>]*"/.test(page), 'the frame document is fully escaped');
assert.ok(!page.includes('jane@acme-studio.com') && page.includes('name@yourcompany.com'), 'contact details inside the frame are replaced');
fs.rmSync(dir, { recursive: true, force: true });
console.log('frames: ok');
