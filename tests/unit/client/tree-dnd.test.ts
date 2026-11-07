import { describe, expect, it } from 'vitest';
import { zoneAt } from '#lib/components/shell/tree-dnd.ts';

describe('zoneAt', () => {
	it('drops before in the top quarter, after in the bottom quarter and into in the middle', () => {
		expect(zoneAt(100, 28, 101)).toBe('before');
		expect(zoneAt(100, 28, 114)).toBe('into');
		expect(zoneAt(100, 28, 127)).toBe('after');
	});
});
