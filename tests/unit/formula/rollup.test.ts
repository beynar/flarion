import { describe, expect, test } from 'vitest';
import { computeRollup, rollupResultType, rollupTargetKind, targetKindOf, type RollupItem } from '../../../src/lib/shared/formula';
import { ROLLUP_FUNCTIONS, propertyDefSchema, type PropertyDef, type RollupFunction } from '../../../src/lib/shared/property-types';
import * as v from 'valibot';

const num = (n: number | null): RollupItem => ({ value: n, keys: n === null ? [] : [String(n)], texts: n === null ? [] : [String(n)] });
const text = (...t: string[]): RollupItem => ({ value: t.length ? t.join(', ') : null, keys: t, texts: t });
const date = (start: string, end?: string): RollupItem => ({ value: end ? { start, end } : { start }, keys: [start], texts: [start] });
const flag = (b: boolean | null): RollupItem => ({ value: b, keys: b === null ? [] : [String(b)], texts: b === null ? [] : [String(b)] });

describe('rollup aggregates', () => {
	const run = (fn: RollupFunction, items: RollupItem[]) => computeRollup(fn, items);

	test('counts', () => {
		const items = [num(1), num(1), num(null), num(5)];
		expect(run('count_all', items)).toBe(4);
		expect(run('count_values', items)).toBe(3);
		expect(run('not_empty', items)).toBe(3);
		expect(run('empty', items)).toBe(1);
		expect(run('count_unique', items)).toBe(2);
		expect(run('percent_empty', items)).toBe(25);
		expect(run('percent_not_empty', items)).toBe(75);
		// Members of multi-valued properties count one by one for unique, once per page for values.
		const tags = [text('a', 'b'), text('b'), text()];
		expect(run('count_values', tags)).toBe(2);
		expect(run('count_unique', tags)).toBe(2);
		// Nothing related: counts are 0 and percentages are 0, never NaN.
		for (const fn of ['count_all', 'count_values', 'empty', 'not_empty', 'count_unique', 'percent_empty', 'percent_not_empty', 'checked', 'unchecked', 'percent_checked', 'percent_unchecked'] as const)
			expect(run(fn, [])).toBe(0);
	});

	test('numbers: sum of nothing is 0, the other aggregates of nothing are empty', () => {
		const items = [num(2), num(8), num(null), num(5)];
		expect(run('sum', items)).toBe(15);
		expect(run('average', items)).toBe(5);
		expect(run('median', items)).toBe(5);
		expect(run('median', [num(1), num(2), num(3), num(10)])).toBe(2.5);
		expect(run('min', items)).toBe(2);
		expect(run('max', items)).toBe(8);
		expect(run('range', items)).toBe(6);
		expect(run('sum', [])).toBe(0);
		for (const fn of ['average', 'median', 'min', 'max', 'range'] as const) {
			expect(run(fn, [])).toBeNull();
			expect(run(fn, [num(null)])).toBeNull();
		}
	});

	test('checkboxes count a missing value as unchecked', () => {
		const items = [flag(true), flag(false), flag(null), flag(true)];
		expect(run('checked', items)).toBe(2);
		expect(run('unchecked', items)).toBe(2);
		expect(run('percent_checked', items)).toBe(50);
		expect(run('percent_unchecked', items)).toBe(50);
	});

	test('dates: earliest, latest and the range between them', () => {
		const items = [date('2026-03-10'), date('2026-03-01', '2026-03-04'), date('2026-03-08', '2026-03-20'), { value: null, keys: [], texts: [] }];
		expect(run('earliest', items)).toEqual({ start: '2026-03-01' });
		expect(run('latest', items)).toEqual({ start: '2026-03-10' });
		expect(run('date_range', items)).toEqual({ start: '2026-03-01', end: '2026-03-20' });
		expect(run('date_range', [date('2026-03-10')])).toEqual({ start: '2026-03-10' });
		for (const fn of ['earliest', 'latest', 'date_range'] as const) expect(run(fn, [])).toBeNull();
	});

	test('show original keeps every label, show unique drops repeats', () => {
		const items = [text('High'), text('Low'), text('High'), text()];
		expect(run('show_original', items)).toBe('High, Low, High');
		expect(run('show_unique', items)).toBe('High, Low');
		expect(run('show_original', [])).toBeNull();
		expect(run('show_unique', [text()])).toBeNull();
	});

	test('every function has a result type and a target kind', () => {
		for (const fn of ROLLUP_FUNCTIONS) {
			expect(['number', 'date', 'text']).toContain(rollupResultType(fn));
			expect(['any', 'number', 'date', 'checkbox']).toContain(rollupTargetKind(fn));
		}
		expect(rollupResultType('earliest')).toBe('date');
		expect(rollupResultType('show_original')).toBe('text');
		expect(rollupResultType('sum')).toBe('number');
		expect(rollupTargetKind('sum')).toBe('number');
		expect(rollupTargetKind('date_range')).toBe('date');
		expect(rollupTargetKind('percent_checked')).toBe('checkbox');
		expect(rollupTargetKind('count_all')).toBe('any');
	});

	test('the kind of value a property holds', () => {
		const def = (type: string, config: unknown = {}) => v.parse(propertyDefSchema, { id: 'x', name: 'X', type, config }) as PropertyDef;
		expect(targetKindOf(def('number'))).toBe('number');
		expect(targetKindOf(def('unique_id'))).toBe('number');
		expect(targetKindOf(def('date'))).toBe('date');
		expect(targetKindOf(def('created_time'))).toBe('date');
		expect(targetKindOf(def('checkbox'))).toBe('checkbox');
		expect(targetKindOf(def('formula', { expression: '1', resultType: 'number' }))).toBe('number');
		expect(targetKindOf(def('rollup', { relationProp: 'r', targetProp: 't', fn: 'earliest', resultType: 'date' }))).toBe('date');
		expect(targetKindOf(def('formula', { expression: '"x"', resultType: 'text' }))).toBe('any');
		expect(targetKindOf(def('select'))).toBe('any');
	});
});
