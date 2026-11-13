// Embedded widgets saved as real content (frames.mjs): the saved document carries each view, its files, the view
// switching and the snapshot note, and loads nothing from the widget's site. Usage: node test-frames.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
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
  ],
}));
const copied = [];
const d = frameDoc(dir, 'desktop-0', (name, file) => { copied.push(name); return fs.existsSync(file) ? `a/${name}` : null; });
assert.ok(d, 'a saved frame gives a document');
assert.equal(d.autosize, true);
assert.equal(d.views, 2, 'both views are kept');
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
fs.rmSync(dir, { recursive: true, force: true });
console.log('frames: ok');
