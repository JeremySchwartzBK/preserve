// The viewer and the quality check must serve Preserves with the same rules (policy.mjs). Usage: node test-policy.mjs
import fs from 'node:fs';
import { PRESERVE_CSP } from './policy.mjs';
const worker = fs.readFileSync(new URL('../platform/worker/src/index.js', import.meta.url), 'utf8');
const m = /const PRESERVE_CSP = "([^"]+)"/.exec(worker);
if (!m || m[1] !== PRESERVE_CSP) { console.error('viewer and policy.mjs differ:\n  viewer: ' + (m?.[1] || '(missing)') + '\n  policy: ' + PRESERVE_CSP); process.exit(1); }
console.log('policy matches');
