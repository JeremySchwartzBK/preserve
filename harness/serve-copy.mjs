import { startServer } from './server.mjs'; import { serverVariants } from './build.mjs';
await startServer(process.argv[2], +process.argv[3], serverVariants()); console.log('up');
