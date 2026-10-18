// Rebuilds copy variants for one site without re-measuring. Usage: node rebuild.mjs <siteDir> [variants]
import { startServer } from './server.mjs';
import { VARIANTS, buildVariant, serverVariants } from './build.mjs';
import { optimizeFirstScreen } from './atf.mjs';
const [siteDir, list = 'frozen,frozen-opt'] = process.argv.slice(2);
const srv = await startServer(siteDir, 0, serverVariants());
const port = srv.port;
for (const v of list.split(',')) {
  buildVariant(siteDir, v, srv);
  if (VARIANTS[v].optimize) await optimizeFirstScreen(`http://127.0.0.1:${port}`, siteDir, v, VARIANTS[v].source === 'server' ? { 'index.html': ['mobile', 'desktop'] } : { 'desktop.html': ['desktop'], 'mobile.html': ['mobile'] });
}
srv.server.close(); console.log('rebuilt', siteDir); process.exit(0);
