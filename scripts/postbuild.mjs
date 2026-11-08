// After `vite build`: rebuilds the Worker with code splitting so a socket dial evaluates (and uploads) as little as possible.
//
// This step depends only on the layout sveltekit-cloudflare-worker documents (docs/architecture.md): `_worker.js` imports `./_sveltekit-worker.js`
// (the adapter's Worker, `export default { fetch }`) and `./_user-worker.js` (the bundle of `src/worker.ts`), and `.wasm` modules sit next to them
// with a content hash in their name. It never reads the facade's code.
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const outDir = '.svelte-kit/cloudflare';
if (!existsSync(outDir)) {
	console.log('[postbuild] no Worker build output, nothing to do');
	process.exit(0);
}
const ignore = join(outDir, '.assetsignore');
const entry = join(outDir, '_worker.js');

// Start-up, second step (docs/ops/load-test.md "Third pass"): the plugin bundles `src/worker.ts` and SvelteKit into one script, and esbuild
// without `splitting` inlines every dynamic `import()` into it, so a socket dial parsed all 5.6 MB. Rebuild the entry here with code splitting:
// `_worker.js` keeps what the Worker evaluates at start (the exports, the object classes and what they import), every route, SvelteKit, the
// renderers and the workflows become `wc-*.js` chunks that wrangler uploads as separate modules (`rules` in wrangler.jsonc) and workerd only
// compiles when a request first imports them. The routes are server-rendered (`ssr` is on everywhere), so their server build (entasis, charts,
// every page: about 1.4 MB) is part of the SvelteKit chunks; it loads with SvelteKit on the first page request and never on a socket dial.
if (existsSync(entry) && process.env.WORKER_SPLIT !== 'off') {
	const facade = readFileSync(entry, 'utf8');
	if (!facade.includes("'./_user-worker.js'") || !facade.includes("'./_sveltekit-worker.js'")) {
		throw new Error('[postbuild] _worker.js no longer imports ./_user-worker.js and ./_sveltekit-worker.js: the layout sveltekit-cloudflare-worker documents changed, update scripts/postbuild.mjs');
	}
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
		keepNames: process.env.WORKER_KEEP_NAMES !== 'off',
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
					// SvelteKit's Worker (the adapter's `export default { fetch }`: the rendering of the whole app, entasis, charts, every page) is imported
					// by the facade at the top, so every isolate would evaluate it, a socket dial's included. It becomes a chunk instead, loaded by the first
					// page request: the facade's `svelteKit` is a stand-in whose methods import the real module and call it.
					b.onResolve({ filter: /^\.\/_sveltekit-worker\.js$/ }, (args) =>
						args.namespace === 'lazy-sveltekit' ? undefined : { path: 'sveltekit-worker', namespace: 'lazy-sveltekit', pluginData: { real: join(root, outDir, '_sveltekit-worker.js') } }
					);
					b.onLoad({ filter: /.*/, namespace: 'lazy-sveltekit' }, (args) => ({
						contents: `const load = () => import(${JSON.stringify(args.pluginData.real)});\nexport default new Proxy({}, { get: (_, name) => async (...args) => (await load()).default[name](...args) });`,
						resolveDir: root,
						loader: 'js',
					}));
					// A `.wasm` import is a CompiledWasm module: the plugin's own build already wrote the file next to the Worker with a content hash in its name
					// (`<name>-<hash>.wasm`, appended to .assetsignore), Wrangler uploads it through its default CompiledWasm rule, and the chunks import it by that name.
					b.onResolve({ filter: /\.wasm(\?module)?$/ }, async (args) => {
						if (args.pluginData?.wasm) return undefined;
						const resolved = await b.resolve(args.path.replace(/\?module$/, ''), { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { wasm: true } });
						if (resolved.errors.length > 0) return { errors: resolved.errors };
						const stem = resolved.path.split(/[\\/]/).pop().replace(/\.wasm$/, '');
						const found = readdirSync(outDir).filter((f) => new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{8}\\.wasm$`).test(f));
						if (found.length !== 1) throw new Error(`[postbuild] expected one ${stem}-<hash>.wasm next to _worker.js for ${resolved.path}, found ${found.length}`);
						return { path: `./${found[0]}`, external: true };
					});
					// The `(dev)` routes (the editor test page, the SLO preview, the views bench) are development tools: their server build is dead weight
					// in the Worker (and each answers 404 or fails without a development server anyway).
					b.onLoad({ filter: /output[\\/]server[\\/]entries[\\/]pages[\\/]\(dev\)[\\/].*\.svelte\.js$/ }, () => ({
						contents: "export default function () { throw new Error('This page is for the development server'); }",
						loader: 'js',
					}));
					// entasis's code and diff components load shiki's grammars and themes (about 320 modules, 14 MB) with dynamic imports; the server render
					// never highlights, and every module a Worker uploads costs start-up (45 ms per MB), so the tables that point at them are emptied
					// (`bundledLanguages`, `bundledThemes`, `@pierre/highlights`' theme loader): the browser build, which loads them on demand, is untouched.
					b.onLoad({ filter: /output[\\/]server[\\/]chunks[\\/][^\\/]+\.js$/ }, (args) => {
						const source = readFileSync(args.path, 'utf8');
						// Grammar and theme tables (hundreds of dynamic imports) and the inlined oniguruma WebAssembly (200 KB of base64).
						const table = (source.match(/import\("\.\/[^"]+\.js"\)/g)?.length ?? 0) >= 40;
						const inlinedWasm = source.length > 150_000 && source.includes('Uint8Array.from(atob("');
						if (!table && !inlinedWasm) return undefined;
						const exported = /\nexport \{([^}]*)\};?/.exec(source)?.[1] ?? '';
						const names = exported.split(',').map((part) => part.trim().split(/\s+as\s+/).pop()).filter(Boolean);
						if (names.length === 0) return undefined;
						return { contents: names.map((name) => (name === 'default' ? 'export default {};' : `export const ${name} = {};`)).join('\n'), loader: 'js' };
					});
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
