// After `vite build`: puts the roaring WebAssembly module next to the built Worker so wrangler uploads it as a
// CompiledWasm module (src/server/bitmaps/wasm-source.ts imports it by name; wrangler.jsonc has the rule), and keeps it
// out of the static assets (the assets directory is the Worker's own directory).
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const outDir = '.svelte-kit/cloudflare';
if (!existsSync(outDir)) {
	console.log('[postbuild] no Worker build output, nothing to do');
	process.exit(0);
}
const require = createRequire(import.meta.url);
const wasm = join(dirname(require.resolve('roaring-wasm/package.json')), 'index.wasm');
copyFileSync(wasm, join(outDir, 'roaring.wasm'));
const ignore = join(outDir, '.assetsignore');
const lines = existsSync(ignore) ? readFileSync(ignore, 'utf8').split('\n') : [];
if (!lines.includes('roaring.wasm')) appendFileSync(ignore, `${lines.at(-1) === '' || lines.length === 0 ? '' : '\n'}roaring.wasm\n`);
console.log('[postbuild] roaring.wasm copied to', outDir);
