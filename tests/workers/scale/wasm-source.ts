/** Test-pool stand-in for `src/server/bitmaps/wasm-source.ts` (vitest.config.ts aliases it): a static `.wasm` import is CompiledWasm here. */
import roaringModule from 'roaring-wasm/index.wasm';

export async function roaringWasmModule(): Promise<WebAssembly.Module> {
	return roaringModule;
}
