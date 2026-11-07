import { describe, expect, it } from 'vitest';
import {
	DAY_MS,
	canonicalDate,
	dateOperandSchema,
	dateValueInterval,
	dateValueSchema,
	formatDate,
	intervalsOverlap,
	operandInterval,
	parseIsoDate,
	rangeInterval,
	unitInterval,
	type DateCtx
} from '../../../src/lib/shared/dates';
import * as v from 'valibot';
import { rng } from './helpers';

const utc = (s: string) => Date.parse(s);
// Saturday 2026-11-07 15:30 UTC
const ctx: DateCtx = { now: utc('2026-11-07T15:30:00Z') };

describe('parseIsoDate / formatDate', () => {
	it('parses dates and datetimes', () => {
		expect(parseIsoDate('2026-11-07')).toEqual({ ms: utc('2026-11-07T00:00:00Z'), dateOnly: true });
		expect(parseIsoDate('2026-11-07T10:00:00Z')).toEqual({ ms: utc('2026-11-07T10:00:00Z'), dateOnly: false });
		expect(parseIsoDate('2026-11-07T10:00')?.ms).toBe(utc('2026-11-07T10:00:00Z'));
		expect(parseIsoDate('2026-11-07T12:00:00+02:00')?.ms).toBe(utc('2026-11-07T10:00:00Z'));
		expect(parseIsoDate('2026-11-07T10:00:00.5Z')?.ms).toBe(utc('2026-11-07T10:00:00.500Z'));
	});

	it('rejects impossible dates and garbage', () => {
		for (const bad of ['2026-02-30', '2026-13-01', '2026-11-07T25:00:00Z', '2026-11-07T10:60Z', 'yesterday', '', '2026/11/07', '2026-11-07T10:00:00+25:00'])
			expect(parseIsoDate(bad), bad).toBeNull();
		expect(parseIsoDate('2028-02-29')).not.toBeNull();
		expect(parseIsoDate('2027-02-29')).toBeNull();
	});

	it('canonicalizes offsets to UTC and round-trips', () => {
		expect(canonicalDate('2026-11-07T12:00:00+02:00')).toBe('2026-11-07T10:00:00Z');
		expect(canonicalDate('2026-11-07T10:00:00.500Z')).toBe('2026-11-07T10:00:00.5Z');
		const r = rng(1);
		for (let i = 0; i < 300; i++) {
			const ms = r.int(0, 4_000_000_000_000);
			const dateOnly = r.bool();
			const base = dateOnly ? Math.floor(ms / DAY_MS) * DAY_MS : ms;
			const text = formatDate(base, dateOnly);
			expect(parseIsoDate(text)).toEqual({ ms: base, dateOnly });
		}
	});
});

describe('date value schema', () => {
	it('requires end >= start', () => {
		expect(v.safeParse(dateValueSchema, { start: '2026-11-07', end: '2026-11-09' }).success).toBe(true);
		expect(v.safeParse(dateValueSchema, { start: '2026-11-09', end: '2026-11-07' }).success).toBe(false);
		expect(v.safeParse(dateValueSchema, { start: 'nope' }).success).toBe(false);
		expect(v.safeParse(dateValueSchema, { start: '2026-11-07', end: null }).success).toBe(true);
	});
	it('validates operands', () => {
		expect(v.safeParse(dateOperandSchema, { kind: 'relative', unit: 'week', offset: -1 }).success).toBe(true);
		expect(v.safeParse(dateOperandSchema, { kind: 'relative', unit: 'decade', offset: 0 }).success).toBe(false);
		expect(v.safeParse(dateOperandSchema, { kind: 'exact', date: '2026-02-30' }).success).toBe(false);
	});
});

describe('intervals', () => {
	it('a date-only value covers its day, a timed value an instant, a range both ends', () => {
		expect(dateValueInterval({ start: '2026-11-07' })).toEqual({ start: utc('2026-11-07'), end: utc('2026-11-08') });
		const t = utc('2026-11-07T10:00:00Z');
		expect(dateValueInterval({ start: '2026-11-07T10:00:00Z' })).toEqual({ start: t, end: t + 1 });
		expect(dateValueInterval({ start: '2026-11-07', end: '2026-11-09' })).toEqual({ start: utc('2026-11-07'), end: utc('2026-11-10') });
	});

	it('resolves units around now (weeks start on Monday by default)', () => {
		expect(unitInterval(ctx.now, 'day', 0, ctx)).toEqual({ start: utc('2026-11-07'), end: utc('2026-11-08') });
		expect(unitInterval(ctx.now, 'week', 0, ctx)).toEqual({ start: utc('2026-11-02'), end: utc('2026-11-09') });
		expect(unitInterval(ctx.now, 'week', -1, ctx)).toEqual({ start: utc('2026-10-26'), end: utc('2026-11-02') });
		expect(unitInterval(ctx.now, 'week', 0, { ...ctx, weekStartsOn: 0 })).toEqual({ start: utc('2026-11-01'), end: utc('2026-11-08') });
		expect(unitInterval(ctx.now, 'month', 1, ctx)).toEqual({ start: utc('2026-12-01'), end: utc('2027-01-01') });
		expect(unitInterval(ctx.now, 'month', -11, ctx)).toEqual({ start: utc('2025-12-01'), end: utc('2026-01-01') });
		expect(unitInterval(ctx.now, 'year', 0, ctx)).toEqual({ start: utc('2026-01-01'), end: utc('2027-01-01') });
	});

	it('resolves operands and named ranges', () => {
		expect(operandInterval({ kind: 'relative', unit: 'day', offset: -1 }, ctx)).toEqual({ start: utc('2026-11-06'), end: utc('2026-11-07') });
		expect(operandInterval({ kind: 'exact', date: '2026-11-01' }, ctx)).toEqual({ start: utc('2026-11-01'), end: utc('2026-11-02') });
		expect(rangeInterval({ kind: 'named', range: 'this_month' }, ctx)).toEqual({ start: utc('2026-11-01'), end: utc('2026-12-01') });
		expect(rangeInterval({ kind: 'named', range: 'past_week' }, ctx)).toEqual({ start: utc('2026-10-31'), end: utc('2026-11-08') });
		expect(rangeInterval({ kind: 'named', range: 'next_week' }, ctx)).toEqual({ start: utc('2026-11-07'), end: utc('2026-11-15') });
		expect(rangeInterval({ kind: 'named', range: 'past_month' }, ctx)).toEqual({ start: utc('2026-10-07'), end: utc('2026-11-08') });
		expect(rangeInterval({ kind: 'named', range: 'next_year' }, ctx)).toEqual({ start: utc('2026-11-07'), end: utc('2027-11-08') });
		expect(
			rangeInterval({ kind: 'between', from: { kind: 'exact', date: '2026-11-01' }, to: { kind: 'exact', date: '2026-11-03' } }, ctx)
		).toEqual({ start: utc('2026-11-01'), end: utc('2026-11-04') });
	});

	it('clamps month arithmetic at the end of a short month', () => {
		const c = { now: utc('2026-03-31T10:00:00Z') };
		expect(rangeInterval({ kind: 'named', range: 'past_month' }, c)).toEqual({ start: utc('2026-02-28'), end: utc('2026-04-01') });
	});

	it('overlap is half open', () => {
		expect(intervalsOverlap({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
		expect(intervalsOverlap({ start: 0, end: 11 }, { start: 10, end: 20 })).toBe(true);
	});
});
