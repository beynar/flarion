import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageLocks } from '#lib/components/editor/page-lock.svelte.ts';
import type { PageLock } from '#lib/shared/schemas.ts';

const state = (patch: Partial<PageLock> = {}): PageLock => ({ locked: false, lockedBy: null, lockedAt: null, bypass: false, ...patch });

// The unit project runs in node: a minimal `document` for the visibility listener.
beforeEach(() => vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' })));
afterEach(() => vi.unstubAllGlobals());

describe('page lock cache', () => {
	it("applies a pushed change on top of the state it read, keeping the receiver's own bypass", async () => {
		const fetcher = vi.fn(async () => state({ bypass: true }));
		const stop = pageLocks.watch('page-a', fetcher);
		await vi.waitFor(() => expect(pageLocks.get('page-a')).toBeDefined());
		pageLocks.apply('page-a', { locked: true, lockedBy: 'u1', lockedAt: 9 });
		expect(pageLocks.get('page-a')).toEqual({ locked: true, lockedBy: 'u1', lockedAt: 9, bypass: true });
		expect(pageLocks.blocks('page-a')).toBe(false); // full access edits through a lock
		expect(fetcher).toHaveBeenCalledTimes(1); // pushed: no extra read
		stop();
	});

	it('reads a watched page it has no state for instead of guessing its bypass', async () => {
		const fetcher = vi.fn(() => new Promise<PageLock>(() => undefined)); // the first read never answers
		const stop = pageLocks.watch('page-b', fetcher);
		pageLocks.apply('page-b', { locked: true, lockedBy: 'u2', lockedAt: 1 });
		expect(fetcher).toHaveBeenCalledTimes(2); // the watch's read, then the one the push asked for
		expect(pageLocks.get('page-b')).toBeUndefined();
		stop();
	});

	it('does not poll, and a reconnect reads the open pages again', async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi.fn(async () => state());
			const stop = pageLocks.watch('page-d', fetcher);
			await vi.advanceTimersByTimeAsync(0);
			expect(fetcher).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(fetcher).toHaveBeenCalledTimes(1);
			pageLocks.refreshWatched();
			await vi.advanceTimersByTimeAsync(0);
			expect(fetcher).toHaveBeenCalledTimes(2);
			stop();
			pageLocks.refreshWatched();
			await vi.advanceTimersByTimeAsync(0);
			expect(fetcher).toHaveBeenCalledTimes(2); // closed pages are not read
		} finally {
			vi.useRealTimers();
		}
	});
});
