// The visitor check's judging rules and the code-only effect inventory, without a browser.
import assert from 'node:assert';
import { compareVisitor } from './visitor.mjs';
import { inventory } from './inventory.mjs';

const ok = (name, cond) => { assert.ok(cond, name); console.log('ok  ', name); };
const t = (v) => Array(144).fill(v);

// Fade-ins: counted per block.
let lost = compareVisitor({ appear: { 'block-a#1': 0.9, 'block-a#2': 0.8, 'block-b#1': 0.05 }, act: {}, at: {} }, { appear: { 'block-a#1': 0, 'block-a#2': 0, 'block-b#1': 0 }, act: {}, at: {} });
ok('two fading parts in one block are one place', lost['appear-effect-lost'].length === 1 && /2 parts/.test(lost['appear-effect-lost'][0].detail));
// Menu button: opens on live, nothing in the copy.
lost = compareVisitor({ appear: {}, act: { 'other|header|1': { kind: 'other', changed: 0.34, text: '' } } }, { appear: {}, act: { 'other|header|1': { kind: 'other', changed: 0, text: '' } } });
ok('a button that opens something live and nothing in the copy is caught', lost['click-does-nothing'].length === 1);
lost = compareVisitor({ appear: {}, act: { 'menu|header|1': { kind: 'menu', changed: 0.5 } } }, { appear: {}, act: { 'menu|header|1': { kind: 'menu', changed: 0.48 } } });
ok('a menu that opens in both is fine', !lost['click-does-nothing'].length);
// Hover: blank picture in the copy; stuck hover; a hover that matches.
lost = compareVisitor({ appear: {}, act: { 'hover|s|1': { kind: 'hover', changed: 0.27, blank: 0, before: t(100), after: t(150), back: 0 } } }, { appear: {}, act: { 'hover|s|1': { kind: 'hover', changed: 0.27, blank: 1, before: t(100), after: t(250), back: 0 } } });
ok('a hover that leaves an empty picture is caught', lost['hover-effect-lost'].length === 1 && /empty picture/.test(lost['hover-effect-lost'][0].detail));
lost = compareVisitor({ appear: {}, act: { 'hover|s|1': { kind: 'hover', changed: 0.27, blank: 0, before: t(100), after: t(150), back: 0 } } }, { appear: {}, act: { 'hover|s|1': { kind: 'hover', changed: 0.27, blank: 0, before: t(100), after: t(150), back: 0.25 } } });
ok('a hover that doesn’t go back is caught', lost['hover-effect-lost'].length === 1);
lost = compareVisitor({ appear: {}, act: { 'hover|s|1': { kind: 'hover', changed: 0.27, blank: 0, before: t(100), after: t(150), back: 0 } } }, { appear: {}, act: { 'hover|s|1': { kind: 'hover', changed: 0.26, blank: 0, before: t(101), after: t(151), back: 0 } } });
ok('a hover that matches is fine', !lost['hover-effect-lost'].length);
// Videos: a note, not a broken button.
lost = compareVisitor({ appear: {}, act: { 'play|v|1': { kind: 'play', changed: 0.4 }, 'lightbox|v|1': { kind: 'lightbox', changed: 0.4 } } }, { appear: {}, act: { 'play|v|1': { kind: 'play', changed: 0 } } });
ok('a video that doesn’t play is its own kind (a known limitation)', lost['video-does-not-play'].length === 2 && !lost['click-does-nothing'].length);
// Jump links and contact text.
lost = compareVisitor({ appear: {}, act: { 'jump|-|1': { kind: 'jump', moved: 1800, text: 'Top' } } }, { appear: {}, act: { 'jump|-|1': { kind: 'jump', moved: 0 } }, contact: ['https://labels.demmo.link/x'] });
ok('a jump link that doesn’t move is caught', lost['jump-link-broken'].length === 1);
ok('a web address left showing is caught', lost['contact-details-left'].length === 1);

// Inventory from code alone.
const inv = inventory(`<html><head><script src="https://static1.squarespace.com/x.js"></script><!-- End of Squarespace Headers --><style>.a{transition:opacity 1s}</style></head>
<body class="tweak-global-animations-animation-type-fade tweak-global-animations-animation-style-fade">
<section data-section-id="s1" data-current-context='{"backgroundMediaEffect":{"type":"parallax"}}'>
<div id="block-1" class="sqs-block accordion-block sqs-block-accordion"></div>
<div id="block-2" class="sqs-block code-block sqs-block-code"><script>x()</script></div></section>
<script src="https://www.ghostplugins.dev/p.js"></script></body></html>`);
ok('site-wide fade animation found', inv.site.includes('site-animation:fade'));
ok('owner’s injected CSS effects found', inv.site.includes('custom:css-effects'));
ok('plugin script found by host', inv.site.includes('custom:script www.ghostplugins.dev'));
ok('Squarespace’s own script not counted as custom', !inv.site.some((f) => /squarespace/.test(f)));
ok('section effect and blocks listed by part', inv.parts['section:s1'].includes('section-effect:parallax') && inv.parts['block-1'].includes('block:accordion') && inv.parts['block-2'].includes('custom:code-block'));
