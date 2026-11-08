/**
 * Roaring bitmaps compiled to WebAssembly (CRoaring through `roaring-wasm`, pinned at 1.1.0 and patched so its loader
 * takes a precompiled module: `patches/roaring-wasm.patch`; `wasm-source.ts` says where the module comes from).
 *
 *   if (await ensureRoaring()) { const bits = createBitmap([1, 2, 3]); bits.has(2); bits.dispose(); }
 *
 * Bitmaps are an accelerator, never a dependency: `ensureRoaring()` resolves `false` when the module cannot be loaded
 * (an old local runtime, a bundler without the module) and every caller keeps its SQL path then, like the app does
 * for AI, Vectorize and Email. Bitmaps live in the WASM heap: `dispose()` releases one, and the library's
 * `FinalizationRegistry` covers a bitmap that is merely dropped, so long-lived bitmaps are disposed when replaced.
 */
import type * as RoaringLib from 'roaring-wasm/browser/index.mjs';
import { roaringWasmModule } from './wasm-source';

export type Bitmap = RoaringLib.RoaringBitmap32;

let lib: typeof RoaringLib | null = null;
let ready: Promise<boolean> | null = null;
let enabled = true;

/**
 * The kill switch (`BITMAPS = "off"` in the Worker's vars, read by the Workspace DO) and the knob the profiling harness
 * turns to compare the SQL paths with the bitmap paths in one run. Flip it before objects are created or woken: an
 * object builds its bitmaps only while bitmaps are on, and keeps working without them.
 */
export function setRoaringEnabled(on: boolean): void {
	enabled = on;
}

/** Loads and instantiates the library once per isolate. Never throws: `false` means "no bitmaps here". */
export function ensureRoaring(): Promise<boolean> {
	if (lib) return Promise.resolve(true);
	ready ??= (async () => {
		try {
			// The module is handed over through a global BEFORE the library is evaluated: its loader runs at import time.
			(globalThis as { __ROARING_WASM_MODULE__?: unknown }).__ROARING_WASM_MODULE__ = await roaringWasmModule();
			const loaded = await import('roaring-wasm/browser/index.mjs');
			await loaded.roaringLibraryInitialize();
			lib = loaded;
			console.log('[bitmaps] roaring-wasm ready');
			return true;
		} catch (error) {
			console.warn('[bitmaps] roaring-wasm is unavailable, filters keep their SQL path:', error instanceof Error ? error.message : error);
			return false;
		}
	})();
	return ready;
}

/** Whether bitmaps can be used right now (synchronous callers check this). */
export const roaringReady = (): boolean => lib !== null && enabled;

export function createBitmap(values?: Iterable<number>): Bitmap {
	if (!lib) throw new Error('roaring is not loaded: call ensureRoaring() first');
	return new lib.RoaringBitmap32(values as Iterable<number> | undefined);
}

export function deserializeBitmap(bytes: Uint8Array): Bitmap {
	if (!lib) throw new Error('roaring is not loaded: call ensureRoaring() first');
	return lib.RoaringBitmap32.deserialize(bytes, true);
}
