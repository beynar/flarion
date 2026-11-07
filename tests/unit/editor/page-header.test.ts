import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COVER_PRESETS, clampPosition, coverBackground, safeCoverUrl } from '../../../src/lib/components/page-header/covers';
import { TITLE_DEBOUNCE_MS, debounced } from '../../../src/lib/components/page-header/debounce';
import { canEditHeader } from '../../../src/lib/components/page-header/types';

describe('title debounce', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('is 300 ms and sends only the last value of a burst', () => {
		expect(TITLE_DEBOUNCE_MS).toBe(300);
		const send = vi.fn();
		const title = debounced<string>(send, TITLE_DEBOUNCE_MS);
		title.schedule('A');
		vi.advanceTimersByTime(200);
		title.schedule('AB');
		vi.advanceTimersByTime(299);
		expect(send).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith('AB');
		expect(title.pending).toBe(false);
	});

	it('flush sends a pending value at once and only once; cancel drops it', () => {
		const send = vi.fn();
		const title = debounced<string>(send, 300);
		title.schedule('x');
		expect(title.pending).toBe(true);
		title.flush();
		title.flush();
		vi.advanceTimersByTime(1000);
		expect(send.mock.calls).toEqual([['x']]);
		title.schedule('gone');
		title.cancel();
		vi.advanceTimersByTime(1000);
		expect(send).toHaveBeenCalledOnce();
	});
});

describe('covers', () => {
	it('accepts presets, https images, same-origin paths and data images only', () => {
		expect(coverBackground('lake')).toEqual({ image: COVER_PRESETS.lake, isImage: false });
		expect(coverBackground('https://x.test/a.jpg')?.isImage).toBe(true);
		expect(coverBackground('/files/abc')?.isImage).toBe(true);
		expect(coverBackground('data:image/png;base64,AAAA')?.isImage).toBe(true);
		for (const bad of [null, '', 'nope', 'javascript:alert(1)', '//evil.test/x', 'http://insecure.test/x', 'data:image/svg+xml;base64,AAAA', 'data:text/html,<script>']) {
			expect(coverBackground(bad)).toBeNull();
		}
		expect(safeCoverUrl('  https://x.test/a b.jpg ')).toBe('https://x.test/a b.jpg');
	});

	it('quotes a url so it cannot leave the css url()', () => {
		expect(coverBackground('https://x.test/a".jpg')?.image).toBe('url("https://x.test/a%22.jpg")');
	});

	it('clamps the position to 0..100 and centres a missing one', () => {
		expect([clampPosition(undefined), clampPosition(null), clampPosition(-5), clampPosition(130), clampPosition(37), clampPosition(NaN)]).toEqual([50, 50, 0, 100, 37, 50]);
	});
});

describe('who edits the header', () => {
	it('writers and full access only', () => {
		expect(['read', 'comment', 'write', 'full'].map((a) => canEditHeader(a as never))).toEqual([false, false, true, true]);
	});
});
