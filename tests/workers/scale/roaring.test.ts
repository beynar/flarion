/** roaring-wasm runs inside workerd through the patched loader (docs/spikes/p4-scale.md "Bitmaps"). */
import { describe, expect, test } from 'vitest';
import { createBitmap, deserializeBitmap, ensureRoaring, roaringReady } from '../../../src/server/bitmaps/roaring';

describe('roaring-wasm in workerd', () => {
	test('instantiates from the compiled module and answers set operations', async () => {
		expect(await ensureRoaring()).toBe(true);
		expect(roaringReady()).toBe(true);
		const a = createBitmap([1, 2, 3, 70_000, 4_000_000_000]);
		const b = createBitmap([2, 3, 4, 70_000]);
		expect(a.has(70_000)).toBe(true);
		expect(a.andCardinality(b)).toBe(3);
		expect(a.orCardinality(b)).toBe(6);
		expect(a.toArray()).toEqual([1, 2, 3, 70_000, 4_000_000_000]);
		const bytes = a.serialize(true);
		expect(deserializeBitmap(bytes).isEqual(a)).toBe(true);
		a.dispose();
		b.dispose();
	});

	test('a large dense set stays small and fast', async () => {
		await ensureRoaring();
		const bits = createBitmap();
		bits.addRange(0, 50_000);
		bits.optimize();
		expect(bits.size).toBe(50_000);
		expect(bits.getSerializationSizeInBytes(true)).toBeLessThan(200);
		const t0 = performance.now();
		let hits = 0;
		for (let i = 0; i < 200_000; i++) if (bits.has(i)) hits++;
		console.log(`[roaring] 200k has() calls over WASM: ${(performance.now() - t0).toFixed(1)} ms`);
		expect(hits).toBe(50_000);
		bits.dispose();
	});
});
