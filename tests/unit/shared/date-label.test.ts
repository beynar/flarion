import { describe, expect, it } from 'vitest';
import { composeIso, dayOf, formatDateMention, isoDay, timeOf } from '../../../src/lib/shared/blocks/date-label';

// Saturday 7 November 2026, local noon.
const now = new Date(2026, 10, 7, 12, 0, 0);
const at = (iso: string, end?: string) => formatDateMention({ start: iso, ...(end ? { end } : {}) }, now);

describe('date mention labels', () => {
	it('reads the days around today relatively', () => {
		expect(at('2026-11-07')).toBe('Today');
		expect(at('2026-11-08')).toBe('Tomorrow');
		expect(at('2026-11-06')).toBe('Yesterday');
	});

	it('names weekdays: this week plain, the next ones "Next", the past ones "Last"', () => {
		// 7 Nov 2026 is a Saturday: Monday 9 Nov is the next week.
		expect(at('2026-11-09')).toBe('Next Monday');
		expect(at('2026-11-13')).toBe('Next Friday');
		expect(at('2026-11-20')).toBe('Nov 20');
		expect(at('2026-11-04')).toBe('Wednesday');
		expect(at('2026-11-02')).toBe('Monday');
		expect(at('2026-10-30')).toBe('Last Friday');
		// From a Wednesday, Friday of the same week is just "Friday".
		expect(formatDateMention({ start: '2026-11-13' }, new Date(2026, 10, 11, 9))).toBe('Friday');
		expect(formatDateMention({ start: '2026-11-16' }, new Date(2026, 10, 11, 9))).toBe('Next Monday');
	});

	it('falls back to a date, with the year when it is not this one', () => {
		expect(at('2026-03-02')).toBe('Mar 2');
		expect(at('2027-01-15')).toBe('Jan 15, 2027');
		expect(at('2025-12-24')).toBe('Dec 24, 2025');
	});

	it('shows times for timed values and ends for ranges', () => {
		const nine = composeIso(new Date(2026, 10, 7), '09:00');
		const ten = composeIso(new Date(2026, 10, 7), '10:30');
		expect(at(nine)).toBe('Today, 9:00 AM');
		expect(at(nine, ten)).toBe('Today, 9:00 AM → 10:30 AM');
		expect(at('2026-11-07', '2026-11-09')).toBe('Today → Next Monday');
		expect(at(composeIso(new Date(2026, 10, 8), '23:15'))).toBe('Tomorrow, 11:15 PM');
		expect(at(composeIso(new Date(2026, 10, 8), '00:05'))).toBe('Tomorrow, 12:05 AM');
	});

	it('is null for an invalid value', () => {
		expect(at('soon')).toBeNull();
	});

	it('composes and reads back ISO values', () => {
		const day = new Date(2026, 10, 7);
		expect(isoDay(day)).toBe('2026-11-07');
		expect(composeIso(day, null)).toBe('2026-11-07');
		const timed = composeIso(day, '14:45');
		expect(timed).toMatch(/Z$/);
		expect(timeOf(timed)).toBe('14:45');
		expect(isoDay(dayOf(timed)!)).toBe('2026-11-07');
		expect(timeOf('2026-11-07')).toBeNull();
		expect(dayOf('nope')).toBeNull();
	});
});
