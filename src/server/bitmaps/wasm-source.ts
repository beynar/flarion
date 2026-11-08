/**
 * Where the compiled roaring WebAssembly module comes from.
 *
 * workerd refuses to compile WebAssembly at run time, so the module has to be a Worker module of type CompiledWasm: sveltekit-cloudflare-worker
 * gives a `.wasm` import exactly that, in `vite dev` (built through workerd's unsafe-eval binding) and in a build (a hashed `.wasm` next to the
 * Worker, uploaded through Wrangler's CompiledWasm rule; `scripts/postbuild.mjs` keeps the import pointing at it when it splits the bundle).
 * The Vitest workers pool loads it the same way. The patched roaring-wasm (`patches/roaring-wasm.patch`) takes this module through
 * `globalThis.__ROARING_WASM_MODULE__` (`roaring.ts`) instead of compiling its own copy.
 */
import roaringModule from 'roaring-wasm/index.wasm';

export async function roaringWasmModule(): Promise<WebAssembly.Module> {
	return roaringModule;
}
