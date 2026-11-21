// What the review screen says about each kind of suspected issue the quality check can find (harness/gate.mjs codes).
// One source for both the runner (platform/runner.mjs writes it on each marker) and the app (which shows it, so
// Preserves already in review get today's wording too).
//
// Rules (Jeremy, 2026-11-18 to 11-21, audit "Suspected-issue messages", flow critique question 5, Gucha Gucha review):
// one sentence about the spot the marker sits on (the marker already shows where, so no quotes from elsewhere on the
// page); about the layout on screen only; plain words, never jargon or tech terms (no "stylesheet", "widget", "pixels",
// "viewport" or screen widths); never "tablet". One shape for every message: "The <part> is … here, but … on your site."
// e.g. "The text is static here, but moves on its own on your site." Say "static", never "still" (which also reads as
// "as before"). The part (n) comes from the block's kind (runner nounOf: Image, Text, Button, Gallery, Video, Form,
// Section, Header, Footer), else "content". The "Your site" / "Preserve" pictures beside each one
// (harness/finding-crops.mjs) show the rest.

// On a marker. n: what the marker is on, lower case.
export const SPOT_MESSAGES = {
  'first-screen-differs': () => 'The first screen looks different here than on your site.',
  'page-differs': (n) => `The ${n} looks different here than on your site.`,
  'blocks-stay-invisible': (n) => `The ${n} is hidden here, but visible on your site.`,
  'widget-frozen': (n) => `The ${n} is static here, but moves on its own on your site.`,
  'scroll-effect-lost': (n) => `The ${n} doesn’t move or fade in as you scroll here, but does on your site.`,
  'hover-effect-lost': (n) => `The ${n} doesn’t change when you point at it here, but does on your site.`,
  'drag-lost': (n) => `The ${n} can’t be dragged or swiped here, but can on your site.`,
  'parts-overlap-differently': (n) => `The ${n} overlaps other parts differently here than on your site.`,
  'part-size-differs': (n) => `The ${n} is a different size here than on your site.`,
  'part-moved': (n) => `The ${n} sits in a different place here than on your site.`,
  'picture-size-differs': () => 'The image is a different size here than on your site.',
  'text-wraps-differently': () => 'The text breaks onto a different number of lines here than on your site, often a sign the font is slightly different.',
  'part-cut-off': (n) => `The ${n} runs off the edge of the screen here, but fits on your site.`,
  'broken-images': () => 'The image is missing here, but shows on your site.',
  'blank-images': () => 'The image is blank here, but shows on your site.',
  'phone-menu-broken': () => 'The menu doesn’t open here, but opens on your site.',
  'dropdown-broken': () => 'The dropdown menu doesn’t open here, but opens on your site.',
  'gallery-does-not-advance': () => 'The gallery’s arrows don’t move it here, but do on your site.',
  'gallery-does-not-autoplay': () => 'The gallery is static here, but plays on its own on your site.',
  'gallery-blank-slide': () => 'The gallery shows an empty frame here, but not on your site.',
  'video-hidden': () => 'The video is hidden behind a picture here, but plays on your site.',
  'animation-flattened': () => 'The animated image is static here, but moves on your site.',
  'frame-missing': () => 'The embedded content (such as a sign-up form, booking tool or map) is missing here, but shows on your site.',
  'frame-size-differs': () => 'The embedded content (such as a form, booking tool or map) is cropped or a different size here than on your site.',
  'overlay-left': () => 'A popup or banner from your site shows here, covering part of the page.',
};

// For what the check couldn't place on the page (listed with the others, without a letter).
export const PAGE_MESSAGES = {
  'page-length-differs': 'The page is longer or shorter here than on your site, so something may be missing or extra. Scroll through both to compare.',
  'font-not-on-google-fonts': 'One of your site’s fonts wasn’t available to us, so some text here uses a plain stand-in.',
  'unhandled-address': 'Some contact details may not be replaced with placeholders here. Check the emails, phone numbers and addresses on the page.',
  'no-reference': 'Your site couldn’t be opened to compare, so please check the whole page yourself.',
  'copy-did-not-load': 'The Preserve didn’t finish loading when we checked it.',
  'overlay-left': 'A popup or banner from your site may show here, covering part of the page.',
};

// Found by the check but never shown to the person: they can't see or judge these in review (other screen sizes,
// resizing the window) or they are ours to fix (leftovers from Squarespace or our capture, our own styling swap, the
// visitor note). They stay in the job's verdict for our triage.
export const HIDDEN = new Set(['differs-at-other-widths', 'breaks-on-resize', 'own-stylesheet-mismatch', 'squarespace-styles-left',
  'squarespace-addresses-left', 'capture-addresses-left', 'outside-requests', 'replica-notice-missing']);

const part = (noun) => (noun || 'content').toLowerCase();
export const spotMessage = (code, noun) => (SPOT_MESSAGES[code] || ((n) => `The ${n} looks different here than on your site.`))(part(noun));
export const pageMessage = (code) => PAGE_MESSAGES[code] || (SPOT_MESSAGES[code] ? SPOT_MESSAGES[code]('content') : 'Something looks different here than on your site.');
