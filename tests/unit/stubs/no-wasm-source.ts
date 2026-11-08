/**
 * The unit project runs in Node, which cannot load a `.wasm` import: it gets no roaring module (`ensureRoaring()` answers false and every
 * caller keeps its SQL path, as it does wherever bitmaps are unavailable). The workers project loads the real module (src/server/bitmaps/wasm-source.ts).
 */
export async function roaringWasmModule(): Promise<WebAssembly.Module> {
	throw new Error('the unit project has no WebAssembly module');
}
