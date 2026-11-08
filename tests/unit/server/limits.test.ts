import { describe, expect, test } from 'vitest';
import { QUOTA_WARN_RATIO, STORAGE_ALERT_BYTES, storageLevel } from '../../../src/server/limits';

describe('limits', () => {
	test('storage alerts at 5 GB and is watched from 1 GB', () => {
		expect(storageLevel(10 * 1024 ** 2)).toBe('ok');
		expect(storageLevel(1024 ** 3)).toBe('watch');
		expect(storageLevel(STORAGE_ALERT_BYTES - 1)).toBe('watch');
		expect(storageLevel(STORAGE_ALERT_BYTES)).toBe('alert');
		expect(storageLevel(9 * 1024 ** 3)).toBe('alert');
	});

	test('a page is reported at 80% of its document quota', () => {
		expect(QUOTA_WARN_RATIO).toBe(0.8);
	});
});
