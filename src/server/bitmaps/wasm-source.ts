/**
 * Where the compiled roaring WebAssembly module comes from in the deployed Worker.
 *
 * workerd refuses to compile WebAssembly at run time, so the module must be a Worker module of type CompiledWasm: the
 * build copies `node_modules/roaring-wasm/index.wasm` next to `_worker.js` as `roaring.wasm` (`scripts/postbuild.mjs`)
 * and wrangler uploads it (`find_additional_modules` + a `CompiledWasm` rule in wrangler.jsonc). It is imported
 * dynamically, with a specifier the bundlers cannot see, because the esbuild pass of sveltekit-cloudflare-worker that
 * bundles `src/worker.ts` has no `.wasm` loader. The workers tests alias this file to a static import
 * (`tests/workers/scale/wasm-source.ts`), which is how the test pool loads CompiledWasm.
 */
export async function roaringWasmModule(): Promise<WebAssembly.Module> {
	const specifier = ['./roaring', 'wasm'].join('.');
	const loaded = (await import(/* @vite-ignore */ specifier)) as { default: WebAssembly.Module };
	return loaded.default;
}
