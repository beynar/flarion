import { describe, expect, it } from 'vitest';
import { CONTRAST_CHOICES, resolvesHigh } from '#lib/client/a11y.svelte.ts';

describe('contrast choice', () => {
	it('follows the OS only on "system"', () => {
		expect(resolvesHigh('system', true)).toBe(true);
		expect(resolvesHigh('system', false)).toBe(false);
	});

	it('"high" and "default" ignore the OS', () => {
		expect(resolvesHigh('high', false)).toBe(true);
		expect(resolvesHigh('default', true)).toBe(false);
	});

	it('offers exactly the three choices the settings page shows', () => {
		expect([...CONTRAST_CHOICES]).toEqual(['system', 'high', 'default']);
	});
});
