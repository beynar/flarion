/** The browser build of roaring-wasm is the one that runs in workerd; the package maps its types only for the root. */
declare module 'roaring-wasm/browser/index.mjs' {
	export * from 'roaring-wasm';
}

/** A `.wasm` import is a compiled module (a CompiledWasm module on Cloudflare). */
declare module 'roaring-wasm/index.wasm' {
	const compiled: WebAssembly.Module;
	export default compiled;
}
