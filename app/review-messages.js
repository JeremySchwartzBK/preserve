// What the review screen says about each kind of suspected issue the quality check can find (harness/gate.mjs codes).
// One source for both the runner (platform/runner.mjs writes it on each marker) and the app (which shows it, so
// Preserves already in review get today's wording too).
//
// Rules (Jeremy, 2026-11-18 to 11-20, audit "Suspected-issue messages"): one short sentence about the spot the marker
// sits on (the marker already shows where, so no quotes from elsewhere on the page); about the layout on screen only;
// plain words, never jargon or tech terms (no "stylesheet", "widget", "pixels", "viewport" or screen widths); never
// "tablet" (there are only desktop and phone layouts).

// On a marker.
export const SPOT_MESSAGES = {
  'first-screen-differs': 'The top of the page, before scrolling, looks different from the live site.',
  'page-differs': 'This area looks different from the live site.',
  'blocks-stay-invisible': 'This part shows on the live site but stays blank here. Scroll past it to check.',
  'widget-frozen': 'This part moves on its own on the live site but stays still here.',
  'scroll-effect-lost': 'On the live site, this part moves or fades in as you scroll. Here it doesn’t.',
  'hover-effect-lost': 'On the live site, this part changes when you point at it. Here it doesn’t.',
  'drag-lost': 'On the live site, this part can be dragged or swiped. Here it doesn’t move.',
  'parts-overlap-differently': 'These parts overlap differently than on the live site, for example text running into a picture.',
  'part-size-differs': 'This part is a different size than on the live site.',
  'part-moved': 'This part sits in a different place than on the live site.',
  'picture-size-differs': 'This picture is a different size than on the live site.',
  'text-wraps-differently': 'This text breaks onto more or fewer lines than on the live site, often because the font is slightly different.',
  'part-cut-off': 'This part runs off the edge of the screen.',
  'broken-images': 'A picture here didn’t load.',
  'blank-images': 'A picture here stays blank.',
  'phone-menu-broken': 'The menu button doesn’t open the menu.',
  'dropdown-broken': 'This menu doesn’t open.',
  'gallery-does-not-advance': 'The arrows on this slideshow don’t move it.',
  'gallery-does-not-autoplay': 'This slideshow plays by itself on the live site but stays on one picture here.',
  'gallery-blank-slide': 'This slideshow shows an empty frame.',
  'video-hidden': 'A video plays here on the live site. The Preserve shows a still picture.',
  'animation-flattened': 'This moving picture shows as a still here.',
  'frame-missing': 'Something embedded on the live site (such as a sign-up form, booking tool or map) is missing here.',
  'frame-size-differs': 'This embedded item (such as a form, booking tool or map) is cropped or a different size than on the live site.',
  'overlay-left': 'A popup or banner from the live site still shows here.',
};

// In the list, for what the check couldn't place on the page.
export const PAGE_MESSAGES = {
  'page-length-differs': 'The Preserve is longer or shorter than the live site, so something may be missing or extra. Scroll through both to compare.',
  'font-not-on-google-fonts': 'We couldn’t get one of the live site’s fonts, so some text uses a plain stand-in font.',
  'unhandled-address': 'Some contact details may not have been replaced with placeholders. Check the emails, phone numbers and addresses on the page.',
  'no-reference': 'We couldn’t open the live site to compare, so please check the whole page yourself.',
  'copy-did-not-load': 'The Preserve didn’t finish loading when we checked it.',
  'overlay-left': 'A popup or banner from the live site may still show on the page.',
};

// Found by the check but never shown to the person: they can't see or judge these in review (other screen sizes,
// resizing the window) or they are ours to fix (leftovers from Squarespace or our capture, our own styling swap, the
// visitor note). They stay in the job's verdict for our triage.
export const HIDDEN = new Set(['differs-at-other-widths', 'breaks-on-resize', 'own-stylesheet-mismatch', 'squarespace-styles-left',
  'squarespace-addresses-left', 'capture-addresses-left', 'outside-requests', 'replica-notice-missing']);

export const spotMessage = (code) => SPOT_MESSAGES[code] || 'This area looks different from the live site.';
export const pageMessage = (code) => PAGE_MESSAGES[code] || SPOT_MESSAGES[code] || 'Something looks different from the live site.';
