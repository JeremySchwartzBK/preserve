// What the review screen says about each kind of suspected issue the quality check can find (harness/gate.mjs codes).
// One source for both the runner (platform/runner.mjs writes it on each marker) and the app (which shows it, so
// Preserves already in review get today's wording too).
//
// Rules (Jeremy, 2026-11-18 to 11-20, audit "Suspected-issue messages" and flow critique question 5): one short line
// about the spot the marker sits on (the marker already shows where, so no quotes from elsewhere on the page); about the
// layout on screen only; plain words, never jargon or tech terms (no "stylesheet", "widget", "pixels", "viewport" or
// screen widths); never "tablet". One pattern: what it is first, then how it differs, with "here" for the Preserve and
// "your site" for the original, e.g. "Image hidden here. Visible on your site." What it is (N) comes from the block's
// kind (runner nounOf: Image, Text, Button, Gallery, Video, Form, Section, Header, Footer), else "Content". The
// "Your site" / "Preserve" pictures beside each one (harness/finding-crops.mjs) show the rest.

// On a marker. N: what the marker is on.
export const SPOT_MESSAGES = {
  'first-screen-differs': () => 'First screen differs from your site.',
  'page-differs': (N) => `${N} looks different from your site.`,
  'blocks-stay-invisible': (N) => `${N} hidden here. Visible on your site.`,
  'widget-frozen': (N) => `${N} still here. It moves on its own on your site.`,
  'scroll-effect-lost': () => 'Scroll effect missing.',
  'hover-effect-lost': (N) => `${N} has no hover effect here. It has one on your site.`,
  'drag-lost': (N) => `${N} can’t be dragged or swiped here. It can on your site.`,
  'parts-overlap-differently': (N) => `${N} overlaps differently from your site.`,
  'part-size-differs': (N) => `${N} is a different size from your site.`,
  'part-moved': (N) => `${N} sits in a different place from your site.`,
  'picture-size-differs': () => 'Image is a different size from your site.',
  'text-wraps-differently': () => 'Text breaks onto a different number of lines from your site, often a sign the font is slightly off.',
  'part-cut-off': (N) => `${N} runs off the edge of the screen here.`,
  'broken-images': () => 'Image missing.',
  'blank-images': () => 'Image blank here. It shows on your site.',
  'phone-menu-broken': () => 'Menu doesn’t open here. It opens on your site.',
  'dropdown-broken': () => 'Dropdown menu doesn’t open here. It opens on your site.',
  'gallery-does-not-advance': () => 'Gallery arrows don’t move it here. They do on your site.',
  'gallery-does-not-autoplay': () => 'Gallery still here. It plays by itself on your site.',
  'gallery-blank-slide': () => 'Gallery shows an empty frame here.',
  'video-hidden': () => 'Video hidden behind a picture.',
  'animation-flattened': () => 'Animated image still here. It moves on your site.',
  'frame-missing': () => 'Embedded content (such as a sign-up form, booking tool or map) missing here.',
  'frame-size-differs': () => 'Embedded content (such as a form, booking tool or map) cropped or a different size here.',
  'overlay-left': () => 'Popup or banner from your site still shows here.',
};

// In the list, for what the check couldn't place on the page.
export const PAGE_MESSAGES = {
  'page-length-differs': 'Page is longer or shorter than your site, so something may be missing or extra. Scroll through both to compare.',
  'font-not-on-google-fonts': 'Font not available to us, so some text uses a plain stand-in.',
  'unhandled-address': 'Contact details may not all be replaced with placeholders. Check the emails, phone numbers and addresses on the page.',
  'no-reference': 'Your site couldn’t be opened to compare, so please check the whole page yourself.',
  'copy-did-not-load': 'Preserve didn’t finish loading when we checked it.',
  'overlay-left': 'Popup or banner from your site may still show on the page.',
};

// Found by the check but never shown to the person: they can't see or judge these in review (other screen sizes,
// resizing the window) or they are ours to fix (leftovers from Squarespace or our capture, our own styling swap, the
// visitor note). They stay in the job's verdict for our triage.
export const HIDDEN = new Set(['differs-at-other-widths', 'breaks-on-resize', 'own-stylesheet-mismatch', 'squarespace-styles-left',
  'squarespace-addresses-left', 'capture-addresses-left', 'outside-requests', 'replica-notice-missing']);

export const spotMessage = (code, noun) => { const N = noun || 'Content'; return (SPOT_MESSAGES[code] || ((n) => `${n} looks different from your site.`))(N); };
export const pageMessage = (code) => PAGE_MESSAGES[code] || (SPOT_MESSAGES[code] ? SPOT_MESSAGES[code]('Content') : 'Something looks different from your site.');
