// Run: node test-address-guard.mjs
import assert from 'node:assert/strict';
import { isPublicIp, refuseAddress, jobEnv } from './address-guard.mjs';

for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '224.0.0.1'])
  assert.equal(isPublicIp(ip), false, ip);
for (const ip of ['8.8.8.8', '198.185.159.144', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicIp(ip), true, ip);

const to = (...ips) => async () => ips.map((address) => ({ address }));
assert.equal(await refuseAddress('https://www.example-studio.com/work', to('198.185.159.144')), null);
assert.match(await refuseAddress('https://sneaky.example.com/', to('198.185.159.144', '10.0.0.5')), /private address 10\.0\.0\.5/);
assert.match(await refuseAddress('http://metadata.example.com/', to('169.254.169.254')), /private/);
assert.match(await refuseAddress('http://127.0.0.1:8080/health'), /unusual port/);
assert.match(await refuseAddress('http://127.0.0.1/'), /private address/);
assert.match(await refuseAddress('http://[::1]/'), /private address/);
assert.match(await refuseAddress('http://2130706433/'), /private address/);   // 127.0.0.1 written as one number
assert.match(await refuseAddress('https://user:pw@example.com/'), /sign-in/);
assert.match(await refuseAddress('file:///etc/passwd'), /not a web address/);
assert.match(await refuseAddress('nonsense'), /not a web address/);
assert.equal(await refuseAddress('https://no-such-name.example.com/', async () => { throw new Error('ENOTFOUND'); }), null);

const env = jobEnv({ DATABASE_URL: 'x', CLOUDFLARE_API_TOKEN: 'y', WAKE_SECRET: 'z', RESEND_API_KEY: 'r', ANTHROPIC_API_KEY: 'a', PATH: '/bin', HTTPS_PROXY: 'p' });
assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'PATH']);
console.log('address guard: all checks pass');
