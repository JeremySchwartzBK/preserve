// What a refinement does about each confirmed issue (Jeremy, 2026-11-24): never "the same thing again, but harder". Each
// kind of issue the quality check finds has its own short list of targeted actions, applied only to the part it flagged,
// and each round uses an action that hasn't been tried on that issue yet. When the list holds more than one untried
// action the AI picks (ai-pins.mjs), from those only; it never writes code. A kind with nothing (left) on its list gets
// no action at all: nothing is pretended.
//
// The actions (each one is built and tested; a new kind of fix gets a new entry here, never generated code):
//   wait-longer    capture waits much longer at the part before saving it (pins.mjs focusPins)
//   still          the part is photographed on the live site and shown in its place (pins.mjs markPinStills)
//   add-drag       the slideshows in the part follow a drag or swipe, even where capture's own test said they don't
//   record-longer  the slideshows in the part are watched and stepped through for much longer while they're recorded
//   play-on-timer  the slideshows in the part play by themselves, on their recorded timing or every five seconds
export const FIXES = {
  // How a slideshow or gallery moves
  'drag-lost': ['add-drag'],
  'gallery-drag-broken': ['add-drag'],
  'gallery-does-not-autoplay': ['record-longer', 'play-on-timer'],
  'widget-frozen': ['record-longer', 'play-on-timer', 'still'],
  'gallery-does-not-advance': ['record-longer'],
  'gallery-dots-broken': ['record-longer'],
  'gallery-blank-slide': ['record-longer', 'wait-longer'],
  // Things that hadn't finished loading or drawing
  'blank-images': ['wait-longer', 'still'],
  'broken-images': ['wait-longer', 'still'],
  'blocks-stay-invisible': ['wait-longer'],
  'video-hidden': ['wait-longer'],
  'frame-missing': ['wait-longer', 'still'],
  'frame-size-differs': ['wait-longer', 'still'],
  'animation-flattened': ['wait-longer'],
  // How a part looks
  'part-size-differs': ['wait-longer', 'still'],
  'picture-size-differs': ['wait-longer', 'still'],
  'part-cut-off': ['wait-longer', 'still'],
  'part-moved': ['wait-longer'],
  'parts-overlap-differently': ['wait-longer'],
  'text-wraps-differently': ['wait-longer'],
  'first-screen-differs': ['wait-longer'],
};
export const ACTION_IDS = ['wait-longer', 'still', 'add-drag', 'record-longer', 'play-on-timer'];

// The issue's kind, from where the pin came from ('quality-check:<code>'); null for the person's own pins.
export const codeOf = (pin) => (/^quality-check:/.test(pin?.from || '') ? pin.from.slice('quality-check:'.length) || null : null);

// The untried actions for one of our findings, in order.
export const optionsFor = (pin) => {
  const tried = new Set(pin.tried || []);
  return (FIXES[codeOf(pin)] || []).filter((a) => !tried.has(a));
};

// Movement issues are rechecked by trying the movement (gate.mjs), not by comparing pictures: a drag or a timer doesn't
// show in a still picture. Each code here is answered "still there" when this round's check reports any code of the
// same family on the same part.
export const MOVE_FAMILY = {
  'drag-lost': 'drag', 'gallery-drag-broken': 'drag',
  'gallery-does-not-autoplay': 'play', 'widget-frozen': 'play',
  'gallery-does-not-advance': 'arrows', 'gallery-dots-broken': 'dots',
  'hover-effect-lost': 'hover', 'pointer-missing': 'pointer', 'scroll-effect-lost': 'scroll',
  'phone-menu-broken': 'menu', 'dropdown-broken': 'menu',
};
