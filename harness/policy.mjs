// The rules every Preserve page is served with (custom code stage one, Jeremy 2026-10-29), so what a viewer sees is what
// the person reviewed and owner code can do nothing a Preserve shouldn't:
//   - no network: nothing may load from anywhere but the Preserve's own files, and no connections at all (fetch, XHR,
//     WebSocket, beacons), so zero reliance on the original site is something the browser enforces;
//   - a sealed box (the sandbox rule, no allow-same-origin): one Preserve can't read or change another's saved data,
//     even though all of them share one web address. Its own files then load as cross-origin requests, which is why
//     they are served with Access-Control-Allow-Origin, and why SVG icons are put in the page (export-static.mjs).
// The viewer (platform/worker/src/index.js) sends the same text; test-policy.mjs checks the two match. The quality
// check serves copies with these rules too, so it checks what visitors get.
export const PRESERVE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "frame-src 'self'",
  "connect-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation',
].join('; ');

// Headers for one file of a Preserve, by its extension. A sealed page asks for its own files from no origin, so
// every file allows any origin: fonts and images marked crossorigin load only that way. They are public anyway.
export function policyHeaders(ext) {
  if (ext === 'html') return { 'content-security-policy': PRESERVE_CSP };
  return { 'access-control-allow-origin': '*' };
}
