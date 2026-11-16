import { build } from 'esbuild';
// Prefer ES module builds: jsonc-parser's UMD build hides its requires from the bundler.
await build({ entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', mainFields: ['module', 'main'], outfile: 'dist/cli.js', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
