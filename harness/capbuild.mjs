// Capture one site and build its frozen-opt copy. Usage: node capbuild.mjs <site> <url> <workDir>
import path from 'node:path';
import { capture } from './capture.mjs';
import { startServer } from './server.mjs';
import { buildVariant, serverVariants } from './build.mjs';
import { optimizeFirstScreen } from './atf.mjs';
const [site, url, work] = process.argv.slice(2);
const dir = path.join(work, site);
await capture(url, dir);
const port = 8600 + Math.floor(Math.random() * 90);
const srv = await startServer(dir, port, serverVariants());
buildVariant(dir, 'frozen-opt', srv);
await optimizeFirstScreen(`http://127.0.0.1:${port}`, dir, 'frozen-opt', { 'desktop.html': ['desktop'], 'mobile.html': ['mobile'] });
srv.server.close(); console.log('done', site); process.exit(0);
