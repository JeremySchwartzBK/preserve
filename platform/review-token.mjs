// Signed review links (production-readiness review, item A5). A Preserve in review is shown only through a link that
// carries a token: "<expiry in seconds>.<HMAC-SHA256 of '<copyId>.<expiry>' in hex>". The viewer checks it
// (worker/src/index.js, reviewTokenOk); the app gets its tokens from the database (schema-review-links.sql); the
// runner makes one for each job here; and the team can make a longer-lived link by hand:
//   REVIEW_SECRET=... node review-token.mjs <copyId> [days, default 30] [layout, default desktop]
import crypto from 'node:crypto';

export function mintReviewToken(secret, id, seconds, now = Date.now()) {
  const exp = Math.floor(now / 1000) + seconds;
  return `${exp}.${crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex')}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, days = '30', layout = 'desktop'] = process.argv.slice(2);
  if (!/^[a-z0-9]{8}$/.test(id || '') || !process.env.REVIEW_SECRET) { console.error('Usage: REVIEW_SECRET=... node review-token.mjs <copyId> [days] [layout]'); process.exit(1); }
  console.log(`${process.env.PRESERVE_VIEW_BASE || 'https://preserve-view.pages.dev'}/c/${id}/${layout}?review=${mintReviewToken(process.env.REVIEW_SECRET, id, Number(days) * 86400)}`);
}
