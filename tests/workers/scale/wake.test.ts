/**
 * A Workspace DO loads the bitmap library itself while it wakes (nothing here calls `ensureRoaring`): the accelerator is on in a
 * deployed object without anyone arranging it. This file must not import anything that loads the library first.
 */
import { describe, expect, test } from 'vitest';
import { roaringReady } from '../../../src/server/bitmaps/roaring';
import { createWorkspace } from '../workspace/helpers';

describe('waking a Workspace DO', () => {
	test('loads roaring-wasm and exposes the option index', async () => {
		expect(roaringReady()).toBe(false);
		const ws = await createWorkspace('wake');
		const stats = await ws.stub.liveStats({ stale: false });
		expect(stats.bitmaps).not.toBeNull();
		expect(roaringReady()).toBe(true);
	});
});
