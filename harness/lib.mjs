// Shared helpers: device/network profiles and browser launch.
import { chromium } from 'playwright';

export const PROFILES = {
  // DevTools "Slow 4G": 150ms RTT, 1.6 Mbps down, 750 kbps up, plus 4x CPU slowdown (mid-range phone).
  mobile: {
    context: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    },
    network: { latency: 150, downloadThroughput: (1.6e6) / 8, uploadThroughput: (750e3) / 8 },
    cpu: 4,
    timeout: 45000,
  },
  // Typical 4G phone: 9 Mbps down, 85ms RTT, same phone and CPU slowdown as "mobile". Timing only (checks run on "mobile").
  'mobile-4g': {
    context: null, // filled in below from mobile
    network: { latency: 85, downloadThroughput: (9e6) / 8, uploadThroughput: (1.5e6) / 8 },
    cpu: 4,
    timeout: 30000,
    pages: 'mobile',
  },
  // WebPageTest "Cable": 28ms RTT, 5 Mbps down, 1 Mbps up, no CPU slowdown.
  desktop: {
    context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    network: { latency: 28, downloadThroughput: (5e6) / 8, uploadThroughput: (1e6) / 8 },
    cpu: 1,
    timeout: 30000,
  },
};

PROFILES['mobile-4g'].context = PROFILES.mobile.context;

export async function launch() {
  const proxy = process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY, bypass: '<-loopback>,localhost,127.0.0.1' }
    : undefined;
  // Software WebGL: the runner has no GPU, and Chromium no longer falls back to software on its own, so canvas effects
  // (Squarespace's section backgrounds) never drew there and capture had nothing to keep (backbipoc, 2026-11-10).
  // PRESERVE_CHROMIUM: a browser other than Playwright's own (a dev machine whose Playwright browsers differ).
  return chromium.launch({ proxy, ...(process.env.PRESERVE_CHROMIUM ? { executablePath: process.env.PRESERVE_CHROMIUM } : {}), args: ['--disable-features=HttpsUpgrades', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
}

export async function applyThrottle(page, profile) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // Every load uses a fresh browser, so the cache starts empty; leaving the cache on lets preloads be reused as in real browsers.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });
  if (profile.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  return cdp;
}

// Elements Squarespace uses for marketing overlays (announcement bar, promo popup, cookie banner).
export const OVERLAY_SELECTORS = [
  '.sqs-announcement-bar-dropzone',
  '.sqs-announcement-bar',
  '.sqs-popup-overlay',
  '.sqs-cookie-banner-v2',
  '.sqs-cookie-banner-v2-container',
  '#sqs-cookie-banner',
  '.sqs-cookie-banner',
  '[class*="cookie-banner"]',
  '[data-sqs-type="announcement-bar"]',
  // Promotions added by apps: referral/discount ribbons and tabs (Friendbuy and the like), and anything capture marked
  // as a promo (markPromos below).
  '[id^="fbt-ribbon"]',
  '[class*="Friendbuy-ribbon"]',
  '[data-preserve-promo]',
  // Email-signup popups from the newsletter tools Squarespace sites embed. They mark themselves as popups, and open on a
  // timer (State of Sage's Flodesk popup waits 30 seconds), so the dimmed-layer test in markPromos can miss them when
  // they open after it runs. Their inline forms (Flodesk's data-ff-type="inline", Kit's inline format) stay.
  '[data-ff-type="popup"]',
  '.mc-modal', '.mc-modal-bg', '.mc-banner',
  '.formkit-modal', 'form[data-format="modal"]', 'form[data-format="slide in"]', 'form[data-format="sticky bar"]',
  // Prototype Shopify adapter (PRESERVE_PLATFORM=shopify): theme announcement bars and email-signup / chat apps.
  ...(process.env.PRESERVE_PLATFORM === 'shopify' ? [
    '.shopify-section--announcement-bar', '.shopify-section-group-header-group[id*="announcement"]', 'announcement-bar', '.announcement-bar-section', '[id*="announcement-bar"]',
    '[class*="omnisend-form"]', '[id*="omnisend"]', '.needsclick.kl-private-reset-css-Xuajs1', '[class*="klaviyo-form"]', '[id^="privy"]', '[class*="privy-"]', '[id^="attentive_overlay"]', '#attentive_creative', '[id^="justuno"]', '[class*="ju_"]',
    '#shopify-pc__banner', '.shopify-pc__banner__dialog', '#shopify-chat', 'inbox-online-store-chat', '#gorgias-chat-container', '#tidio-chat', '[id*="smile-ui"]', '#locale-popup', '[class*="geolocation"]', 'localization-popup',
    'iframe[src*="referralcorner"]', 'iframe[src*="smile.io"]', '#smile-ui-lite-container', 'iframe[src*="rivo"]', '[id*="gw-"][class*="floating"]', '.cc-popup', '[class*="age_modal"]', '[class*="age-verif"]', '[id*="age-verif"]', '[class*="wheelio"]', '[class*="scratch"][class*="popup"]', '[id*="popup"][role="dialog"]',
  ] : []),
];

// Run in the page before saving it: marks marketing promotions pinned to the window that aren't part of the design.
// Two kinds: a layer over the whole window that dims the page (a modal popup or age check), and a small fixed element
// (under a fifth of the screen) outside the header with a close button and offer wording, e.g. a "GET 25% OFF" tab. Marked elements are removed from the copy and hidden in
// the live reference screenshots, so the comparison ignores them too.
export function markPromos() {
  const OFFER = /\d+\s*%\s*off|\$\s*\d+\s*off|discount|free shipping|refer a friend|give \$|get \$\d+|save \d+%|promo code|coupon/i;
  const CLOSE = /^\s*(x|×|✕|✖|close)\s*$/i;
  let n = 0;
  for (const e of document.querySelectorAll('body *')) {
    const s = getComputedStyle(e);
    if (s.position !== 'fixed' || s.display === 'none' || e.closest('header,#header,[data-preserve-promo]')) continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // A layer over the whole window that dims the page behind it is a modal someone has to dismiss: a signup or
    // rewards popup (Borrachito's, whose content is a frame from another host) or an age check (Dreamsake). It is
    // the site's way in, not its design.
    const bg = s.backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    const alpha = bg ? (bg[4] === undefined ? 1 : +bg[4]) * +s.opacity : 0;
    if (r.width * r.height >= innerWidth * innerHeight * 0.8 && alpha >= 0.3 && alpha <= 0.95) { e.setAttribute('data-preserve-promo', ''); n++; continue; }
    if (r.width * r.height > innerWidth * innerHeight * 0.2) continue;
    const text = (e.innerText || '').trim();
    if (!text || text.length > 200 || !OFFER.test(text)) continue;
    const closeBtn = [...e.querySelectorAll('*')].some((c) => CLOSE.test(c.textContent || '') || /close|dismiss/i.test(c.getAttribute('aria-label') || '') || /close|dismiss/i.test(c.className?.toString?.() || ''));
    if (!closeBtn) continue;
    e.setAttribute('data-preserve-promo', ''); n++;
  }
  return n;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Galleries, carousels and slideshows, and their "next" / "previous" arrows (check.mjs probeGalleries, capture.mjs
// recordGalleries). Only buttons and links count: 7.1 fullscreen slideshows also mark slides data-next. Squarespace 7.0 gallery and summary blocks, 7.1 gallery and list sections, and generic names.
export const GALLERY_SEL = '.sqs-gallery-container, .gallery-slideshow, .gallery-reel, .gallery-fullscreen-slideshow, .gallery-strips, .user-items-list-carousel, .user-items-list-banner-slideshow, .user-items-list-simple, .summary-carousel, .sqs-gallery-block-slideshow, .sqs-gallery-block-carousel, .swiper, .ps-gallery, [class*="slideshow" i], [class*="carousel" i]';
export const NEXT_SEL = '.gallery-slideshow-control-btn[data-next], button[data-next], a[data-next], [role="button"][data-next], .user-items-list-carousel__arrow-button--right, .gallery-reel-control-btn[data-next], .sqs-gallery-controls .next, .ps-gallery-controls .next, .summary-carousel-pager-next, .swiper-button-next, button[aria-label*="next" i]';
export const PREV_SEL = '.gallery-slideshow-control-btn[data-previous], button[data-previous], a[data-previous], [role="button"][data-previous], button[data-prev], .user-items-list-carousel__arrow-button--left, .gallery-reel-control-btn[data-previous], .sqs-gallery-controls .previous, .ps-gallery-controls .previous, .summary-carousel-pager-prev, .swiper-button-prev, button[aria-label*="prev" i]';
// The galleries capture.mjs records for the copy's player: Squarespace's own, and carousels a site's own code builds
// with Flickity (elahousestudio's "recent work" carousel never advanced in a Preserve; recorded like any other since
// 2026-11-14: the steps are what the page looked like, none of the site's code is kept).
export const SQS_GALLERY_SEL = '.sqs-gallery-container, .gallery-slideshow, .gallery-reel, .gallery-fullscreen-slideshow, .gallery-strips, .user-items-list-carousel, .user-items-list-banner-slideshow, .summary-carousel, .summary-block-wrapper, .sqs-gallery-block-slideshow, .sqs-gallery-block-carousel, .flickity-enabled';

// Puts each animated picture on the page on its first frame (ImageDecoder), as a still in its place.
export const FREEZE_ANIMATED_IMAGES = async () => {
  if (!('ImageDecoder' in window)) return 0;
  const TYPES = { webp: 'image/webp', gif: 'image/gif', png: 'image/png', apng: 'image/apng', avif: 'image/avif' };
  let n = 0;
  await Promise.all([...document.images].map(async (i) => {
    const u = i.currentSrc || i.src; const ext = (u.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    if (!TYPES[ext]) return;
    try {
      const r = await fetch(u); const type = /^image\//.test(r.headers.get('content-type') || '') ? r.headers.get('content-type').split(';')[0] : TYPES[ext];
      const d = new ImageDecoder({ data: r.body, type }); await d.tracks.ready;
      if (!d.tracks.selectedTrack || !d.tracks.selectedTrack.animated) { d.close(); return; }
      const { image } = await d.decode({ frameIndex: 0 });
      const c = document.createElement('canvas'); c.width = image.displayWidth; c.height = image.displayHeight; c.getContext('2d').drawImage(image, 0, 0); image.close(); d.close();
      const blob = await new Promise((res) => c.toBlob(res));
      const pic = i.parentElement && i.parentElement.tagName === 'PICTURE' ? i.parentElement : null;
      if (pic) pic.querySelectorAll('source').forEach((s) => s.remove());
      i.removeAttribute('srcset'); i.src = URL.createObjectURL(blob); await i.decode().catch(() => {}); n++;
    } catch {}
  }));
  return n;
};

// Animations that play forever (a strip of pictures sliding along, a spinning badge) paused, so two photos of a page
// don't catch them at different moments: at their start ('start'), at given moments (one per animation, in the order
// the page lists them), or where they are now. Returns the moments they were paused at. Entrance animations, which
// end, are left to finish.
export const PAUSE_LOOPS = (at) => {
  const out = []; let i = 0;
  for (const a of document.getAnimations()) {
    const t = a.effect && a.effect.getTiming && a.effect.getTiming();
    if (!t || t.iterations !== Infinity) continue;
    try { a.pause(); if (at === 'start') a.currentTime = 0; else if (Array.isArray(at) && at[i] != null) a.currentTime = at[i]; out.push(a.currentTime); } catch { out.push(null); }
    i++;
  }
  return out;
};
