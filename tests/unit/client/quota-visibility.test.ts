import { describe, expect, test } from 'vitest';
import { setup, tick } from './helpers';

describe('page quota warning', () => {
	test('a page passing 80% of its document quota raises one toast, and another at every five points more', async () => {
		const { store, notices } = setup();
		store.receive({ t: 'quota', pageId: 'p1', bytes: 13_000_000, limit: 16_000_000 });
		expect(notices).toHaveLength(1);
		expect(notices[0].title).toBe('This page is nearly full');
		expect(notices[0].description).toContain('81%');
		// The same share again (a reconnect replays it): nothing new.
		store.receive({ t: 'quota', pageId: 'p1', bytes: 13_100_000, limit: 16_000_000 });
		expect(notices).toHaveLength(1);
		// Five points more.
		store.receive({ t: 'quota', pageId: 'p1', bytes: 13_900_000, limit: 16_000_000 });
		expect(notices).toHaveLength(2);
		// Another page has its own count.
		store.receive({ t: 'quota', pageId: 'p2', bytes: 13_000_000, limit: 16_000_000 });
		expect(notices).toHaveLength(3);
		store.dispose();
		await tick();
	});
});
