import { build } from 'esbuild';
await build({ entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/cli.js', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
