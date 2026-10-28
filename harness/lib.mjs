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
  return chromium.launch({ proxy, args: ['--disable-features=HttpsUpgrades'] });
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
// Squarespace's own galleries, the ones capture.mjs records for the copy's player. A carousel from the site's own
// code (elahousestudio's blog carousel holds whole page sections) is left as captured: custom code is on hold.
export const SQS_GALLERY_SEL = '.sqs-gallery-container, .gallery-slideshow, .gallery-reel, .gallery-fullscreen-slideshow, .gallery-strips, .user-items-list-carousel, .user-items-list-banner-slideshow, .summary-carousel, .summary-block-wrapper, .sqs-gallery-block-slideshow, .sqs-gallery-block-carousel';
