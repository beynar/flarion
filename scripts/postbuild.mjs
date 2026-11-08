// After `vite build`: puts the roaring WebAssembly module next to the built Worker so wrangler uploads it as a
// CompiledWasm module (src/server/bitmaps/wasm-source.ts imports it by name; wrangler.jsonc has the rule), and keeps it
// out of the static assets (the assets directory is the Worker's own directory).
import { appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

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
	// The facade of sveltekit-cloudflare-worker 0.1 (`createWorkerFacade`): SvelteKit's Worker is `svelteKit`, `next()` calls it once.
	const eager = "import svelteKit from './_sveltekit-worker.js';\n";
	const call = 'const next = () => (response ??= svelteKit.fetch(request, env, context));';
	if (source.includes(eager) && source.includes(call)) {
		source = source
			.replace(eager, '')
			.replace(call, "const next = () => (response ??= import('./_sveltekit-worker.js').then((m) => m.default.fetch(request, env, context)));");
		writeFileSync(entry, source);
		console.log('[postbuild] _worker.js loads SvelteKit lazily');
	} else if (source.includes("import('./_sveltekit-worker.js')")) {
		console.log('[postbuild] _worker.js already loads SvelteKit lazily');
	} else {
		console.warn('[postbuild] WARNING: _worker.js has an unexpected shape; SvelteKit stays eagerly loaded (slow socket dials)');
	}
}

// Start-up, second step (docs/ops/load-test.md "Third pass"): the plugin bundles `src/worker.ts` and SvelteKit into one script, and esbuild
// without `splitting` inlines every dynamic `import()` into it, so a socket dial parsed all 5.6 MB. Rebuild the entry here with code splitting:
// `_worker.js` keeps what the Worker evaluates at start (the exports, the object classes and what they import), every route, SvelteKit, the
// renderers and the workflows become `wc-*.js` chunks that wrangler uploads as separate modules (`rules` in wrangler.jsonc) and workerd only
// compiles when a request first imports them. The routes are server-rendered (`ssr` is on everywhere), so their server build (entasis, charts,
// every page: about 1.4 MB) is part of the SvelteKit chunks; it loads with SvelteKit on the first page request and never on a socket dial.
if (existsSync(entry) && readFileSync(entry, 'utf8').includes("'./_user-worker.js'") && process.env.WORKER_SPLIT !== 'off') {
	const pluginRequire = createRequire(realpathSync(resolve('node_modules/sveltekit-cloudflare-worker/package.json')));
	const { build } = pluginRequire('esbuild');
	const root = resolve('.');
	for (const f of readdirSync(outDir)) if (/^wc-.*\.js$/.test(f)) rmSync(join(outDir, f));
	const tsconfig = join(root, '.svelte-kit/tsconfig.json');
	const result = await build({
		entryPoints: { _worker: entry },
		outdir: outDir,
		entryNames: '[name]',
		chunkNames: 'wc-[name]-[hash]',
		allowOverwrite: true,
		splitting: true,
		bundle: true,
		format: 'esm',
		platform: 'browser',
		conditions: ['workerd'],
		external: ['cloudflare:*', 'node:*'],
		minify: process.env.WORKER_MINIFY !== 'off',
		keepNames: true,
		metafile: true,
		legalComments: 'none',
		logLevel: 'warning',
		...(existsSync(tsconfig) ? { tsconfig } : {}),
		plugins: [
			{
				name: 'flarion-split',
				setup(b) {
					// The plugin's single-file bundle of the user Worker is replaced by the source, so its dynamic imports stay dynamic.
					b.onResolve({ filter: /^\.\/_user-worker\.js$/ }, () => ({ path: join(root, 'src/worker.ts') }));
					// The `(dev)` routes (the editor test page, the SLO preview, the views bench) are development tools: their server build is dead weight
					// in the Worker (and each answers 404 or fails without a development server anyway).
					b.onLoad({ filter: /output[\\/]server[\\/]entries[\\/]pages[\\/]\(dev\)[\\/].*\.svelte\.js$/ }, () => ({
						contents: "export default function () { throw new Error('This page is for the development server'); }",
						loader: 'js',
					}));
					// roaring-wasm carries its own copy of the module as a base64 string (230 KB of every start); the Worker passes the compiled module.
					b.onLoad({ filter: /roaring-wasm[\\/]browser[\\/]index\.mjs$/ }, async (args) => ({
						contents: readFileSync(args.path, 'utf8').replace(/"data:application\/octet-stream;base64,[A-Za-z0-9+/=]+"/, '"data:application/octet-stream;base64,"'),
						loader: 'js',
					}));
				},
			},
		],
	});
	if (process.env.WORKER_META) writeFileSync(process.env.WORKER_META, JSON.stringify(result.metafile));
	const chunks = Object.entries(result.metafile.outputs).map(([file, o]) => [file.split('/').pop(), o.bytes]);
	const ignoreLines = new Set(readFileSync(ignore, 'utf8').split('\n'));
	if (!ignoreLines.has('wc-*.js')) appendFileSync(ignore, 'wc-*.js\n');
	const main = chunks.find(([n]) => n === '_worker.js');
	console.log(`[postbuild] split worker: entry ${(main?.[1] / 1024).toFixed(0)} KB, ${chunks.length - 1} chunks, ${(chunks.reduce((n, [, b]) => n + b, 0) / 1024).toFixed(0)} KB in all`);
}
