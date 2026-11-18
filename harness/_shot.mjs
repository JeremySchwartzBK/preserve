import { chromium } from 'playwright';
const [url, out, w=1440, h=900] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errs=[]; p.on('console', m => m.type()==='error' && errs.push(m.text())); p.on('requestfailed', r => errs.push('FAIL '+r.url()));
p.on('response', r => r.status()>=400 && errs.push(r.status()+' '+r.url()));
await p.goto(url, { waitUntil: 'load' }); await p.waitForTimeout(2500);
await p.screenshot({ path: out });
console.log(errs.slice(0,15).join('\n')); await b.close();
