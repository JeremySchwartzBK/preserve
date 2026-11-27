// A page that leaves itself during capture is captured again (capture.mjs). Usage: node test-capture-leave.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { capture } from './capture.mjs';

let visits = 0;
const srv = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html' });
  if (q.url.startsWith('/newsletter')) return r.end('<!doctype html><title>Newsletter</title><h1>Sign up</h1>');
  // The first visit leaves for /newsletter a moment in (as Xanadu's signup widget did); later visits stay.
  visits++;
  r.end(`<!doctype html><title>Home</title><meta name="viewport" content="width=device-width"><h1>Home page</h1>${visits === 1 ? '<script>setTimeout(function(){location.href="/newsletter"},2500)</script>' : ''}`);
}).listen(0);
await new Promise((o) => srv.once('listening', o));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pvleave-'));
const { info } = await capture(`http://127.0.0.1:${srv.address().port}/`, out);
srv.close();
for (const l of ['desktop', 'mobile']) assert.match(fs.readFileSync(path.join(out, `rendered-${l}.html`), 'utf8'), /<title>Home<\/title>/, `${l} saved as the submitted page`);
assert.ok(info.errors.some((e) => /went to \/newsletter during capture; captured again/.test(e)), 'the run notes it');
console.log('capture-leave: ok');
process.exit(0);
