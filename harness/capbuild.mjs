// Capture one site and build its frozen-opt copy. Usage: node capbuild.mjs <site> <url> <workDir>
// PRESERVE_REUSE_CAPTURE=1 builds from a capture already in <workDir>/<site> (test corpus: same input, new code).
import fs from 'node:fs';
import path from 'node:path';
import { capture } from './capture.mjs';
import { startServer } from './server.mjs';
import { buildVariant, serverVariants } from './build.mjs';
import { optimizeFirstScreen } from './atf.mjs';
const [site, url, work] = process.argv.slice(2);
const dir = path.join(work, site);
if (!(process.env.PRESERVE_REUSE_CAPTURE === '1' && fs.existsSync(path.join(dir, 'capture-info.json')))) await capture(url, dir);
const srv = await startServer(dir, 0, serverVariants());
const port = srv.port;
buildVariant(dir, 'frozen-opt', srv);
await optimizeFirstScreen(`http://127.0.0.1:${port}`, dir, 'frozen-opt', { 'desktop.html': ['desktop'], 'mobile.html': ['mobile'] });
srv.server.close(); console.log('done', site); process.exit(0);
