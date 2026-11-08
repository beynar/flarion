// After `vite build`: puts the roaring WebAssembly module next to the built Worker so wrangler uploads it as a
// CompiledWasm module (src/server/bitmaps/wasm-source.ts imports it by name; wrangler.jsonc has the rule), and keeps it
// out of the static assets (the assets directory is the Worker's own directory).
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// Start-up (docs/ops/load-test.md "Start-up"): the generated `_worker.js` imports SvelteKit's server (the rendering of the whole
// app: entasis, charts, every page) at the top, so every isolate evaluates it, including the one that serves a WebSocket
// upgrade (a socket dial is served by a fresh isolate, and pays for all of it). Load it on the first page request instead.
const entry = join(outDir, '_worker.js');
if (existsSync(entry)) {
	let source = readFileSync(entry, 'utf8');
	const eager = "import worker_default from './_sveltekit-worker.js';\n";
	const call = 'nextResponse ??= worker_default.fetch(request, env, __waitUntilLast.ctx);';
	if (source.includes(eager) && source.includes(call)) {
		source = source
			.replace(eager, '')
			.replace(call, "nextResponse ??= import('./_sveltekit-worker.js').then((m) => m.default.fetch(request, env, __waitUntilLast.ctx));");
		writeFileSync(entry, source);
		console.log('[postbuild] _worker.js loads SvelteKit lazily');
	} else if (source.includes("import('./_sveltekit-worker.js')")) {
		console.log('[postbuild] _worker.js already loads SvelteKit lazily');
	} else {
		console.warn('[postbuild] WARNING: _worker.js has an unexpected shape; SvelteKit stays eagerly loaded (slow socket dials)');
	}
}
