// The runner opens whatever address a person submits, from inside the machine that holds our database and storage
// keys. This refuses addresses that point back at that machine or its private network (loopback, private ranges,
// link-local and cloud metadata addresses), whether written as a number or reached through a name. The database
// already turns down numbers, ports and local names at submit time (schema-guards.sql); this is the second lock.
// It checks the address as submitted; redirects inside the browser are not covered here.
import dns from 'node:dns/promises';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) blocked.addSubnet(a, n, 'ipv6');

export function isPublicIp(ip) {
  const v = net.isIP(ip);
  if (!v) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicIp(mapped[1]);
  return !blocked.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

// null when the address is fine to open, otherwise why not. A name that doesn't resolve is left to the copy job,
// which reports "we couldn't open this page".
export async function refuseAddress(url, lookup = dns.lookup) {
  let u;
  try { u = new URL(url); } catch { return 'not a web address'; }
  if (!/^https?:$/.test(u.protocol)) return `not a web address (${u.protocol})`;
  if (u.username || u.password) return 'address carries a sign-in';
  if (u.port && !['80', '443'].includes(u.port)) return `unusual port ${u.port}`;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPublicIp(host) ? null : `private address ${host}`;
  let found;
  try { found = await lookup(host, { all: true }); } catch { return null; }
  const bad = found.find((x) => !isPublicIp(x.address));
  return bad ? `${host} points at private address ${bad.address}` : null;
}

// Secrets the copy job never needs. The job runs site owners' pages in a browser; it gets none of our keys.
export const RUNNER_ONLY_ENV = ['DATABASE_URL', 'CLOUDFLARE_API_TOKEN', 'WAKE_SECRET', 'RESEND_API_KEY'];
export const jobEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !RUNNER_ONLY_ENV.includes(k)));
