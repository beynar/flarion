import { describe, expect, test } from 'vitest';
import {
	analyzeFormula,
	computeFormula,
	envFromProperties,
	evaluateFormula,
	formatError,
	formatWithPattern,
	fromPropValue,
	parseFormula,
	toPropValue,
	type FormulaValue
} from '../../../src/lib/shared/formula';
import type { PropertyDef } from '../../../src/lib/shared/property-types';

const NOW = Date.UTC(2026, 10, 7, 15, 30, 0);
const day = (s: string): FormulaValue => ({ start: Date.parse(`${s}T00:00:00Z`), end: null, time: false });

const PROPS: Record<string, FormulaValue> = {
	Name: 'Écrire le plan',
	Price: 12.5,
	Qty: 4,
	Empty: null,
	Done: false,
	Tags: ['alpha', 'beta', 'gamma'],
	Due: day('2026-11-20'),
	Span: { start: Date.parse('2026-11-01T00:00:00Z'), end: Date.parse('2026-11-05T00:00:00Z'), time: false }
};
const ctx = { prop: (n: string) => PROPS[n] ?? null, now: NOW };

function ev(src: string): FormulaValue {
	const p = parseFormula(src);
	if (!p.ok) throw new Error(formatError(src, p.error));
	const r = evaluateFormula(p.ast, ctx);
	if (!r.ok) throw new Error(formatError(src, r.error));
	return r.value;
}
const iso = (v: FormulaValue) => (v && typeof v === 'object' && !Array.isArray(v) ? new Date(v.start).toISOString() : v);

describe('evaluation', () => {
	test('arithmetic, comparison, logic', () => {
		expect(ev('1 + 2 * 3')).toBe(7);
		expect(ev('2 ^ 10')).toBe(1024);
		expect(ev('-2 ^ 2')).toBe(-4);
		expect(ev('7 % 4')).toBe(3);
		expect(ev('10 / 4')).toBe(2.5);
		expect(ev('1 / 0')).toBeNull();
		expect(ev('prop("Price") * prop("Qty")')).toBe(50);
		expect(ev('prop("Empty") + 1')).toBe(1);
		expect(ev('1 < 2 and 3 >= 3')).toBe(true);
		expect(ev('not (1 == 2) or false')).toBe(true);
		expect(ev('"a" < "b"')).toBe(true);
		expect(ev('prop("Name") == "Écrire le plan"')).toBe(true);
		expect(ev('prop("Empty") == 0')).toBe(true);
		expect(ev('prop("Due") > now()')).toBe(true);
		expect(ev('[1, 2] == [1, 2]')).toBe(true);
	});

	test('if is lazy', () => {
		expect(ev('if(true, 1, 1 / 0 + "a" - 1)')).toBe(1);
		expect(ev('prop("Done") ? "yes" : "no"')).toBe('no');
		expect(ev('true or (1 - "x")')).toBe(true);
	});

	test('text functions', () => {
		expect(ev('concat("a", 1, true, prop("Empty"), "z")')).toBe('a1truez');
		expect(ev('"x" + 1.5')).toBe('x1.5');
		expect(ev('length("héllo😀")')).toBe(6);
		expect(ev('length(prop("Tags"))')).toBe(3);
		expect(ev('contains("hello", "ell")')).toBe(true);
		expect(ev('replace("a-b-c", "-", "+")')).toBe('a+b-c');
		expect(ev('replaceAll("a-b-c", "-", "+")')).toBe('a+b+c');
		expect(ev('lower("ÀB")')).toBe('àb');
		expect(ev('upper("àb")')).toBe('ÀB');
		expect(ev('slice("abcdef", 1, 3)')).toBe('bc');
		expect(ev('slice("abcdef", -2)')).toBe('ef');
		expect(ev('trim("  x ")')).toBe('x');
		expect(ev('format(0.1 + 0.2)')).toBe('0.3');
		expect(ev('format(prop("Tags"))')).toBe('alpha, beta, gamma');
		expect(ev('toNumber("1,234.5")')).toBe(1234.5);
		expect(ev('toNumber("abc")')).toBeNull();
		expect(ev('empty(prop("Empty"))')).toBe(true);
		expect(ev('empty("")')).toBe(true);
		expect(ev('empty(prop("Name"))')).toBe(false);
	});

	test('number functions', () => {
		expect(ev('round(2.5)')).toBe(3);
		expect(ev('round(-2.5)')).toBe(-3);
		expect(ev('round(3.14159, 2)')).toBe(3.14);
		expect(ev('round(1234, -2)')).toBe(1200);
		expect(ev('floor(-1.5)')).toBe(-2);
		expect(ev('ceil(1.2)')).toBe(2);
		expect(ev('abs(-3)')).toBe(3);
		expect(ev('min(3, 1, 2)')).toBe(1);
		expect(ev('max([3, 1, 2])')).toBe(3);
		expect(ev('sum(1, 2, 3.5)')).toBe(6.5);
		expect(ev('sum([])')).toBe(0);
		expect(ev('sqrt(16)')).toBe(4);
		expect(ev('sqrt(-1)')).toBeNull();
		expect(ev('pow(2, 8)')).toBe(256);
	});

	test('date functions', () => {
		expect(iso(ev('dateAdd(prop("Due"), 1, "week")'))).toBe('2026-11-27T00:00:00.000Z');
		expect(iso(ev('dateSubtract(prop("Due"), 2, "days")'))).toBe('2026-11-18T00:00:00.000Z');
		expect(iso(ev('dateAdd(date("2026-01-31"), 1, "month")'))).toBe('2026-02-28T00:00:00.000Z');
		expect(iso(ev('dateAdd(date("2024-01-31"), 1, "months")'))).toBe('2024-02-29T00:00:00.000Z');
		expect(iso(ev('dateAdd(date("2026-11-07"), 1, "year")'))).toBe('2027-11-07T00:00:00.000Z');
		expect(iso(ev('dateAdd(date("2026-11-07"), 5, "hours")'))).toBe('2026-11-07T05:00:00.000Z');
		expect(ev('dateBetween(prop("Due"), today(), "days")')).toBe(13);
		expect(ev('dateBetween(today(), prop("Due"), "days")')).toBe(-13);
		expect(ev('dateBetween(date("2026-03-31"), date("2026-02-28"), "months")')).toBe(1);
		expect(ev('dateBetween(date("2026-03-27"), date("2026-02-28"), "months")')).toBe(0);
		expect(ev('dateBetween(date("2028-11-07"), date("2026-11-08"), "years")')).toBe(1);
		expect(ev('dateBetween(now(), date("2026-11-07"), "hours")')).toBe(15);
		expect(ev('formatDate(prop("Due"))')).toBe('2026-11-20');
		expect(ev('formatDate(now())')).toBe('2026-11-07T15:30:00Z');
		expect(ev('formatDate(prop("Due"), "dddd, MMMM D, YYYY")')).toBe('Friday, November 20, 2026');
		expect(ev('formatDate(now(), "h:mm A [on] MMM D")')).toBe('3:30 PM on Nov 7');
		expect(iso(ev('end(prop("Span"))'))).toBe('2026-11-05T00:00:00.000Z');
		expect(iso(ev('start(prop("Span"))'))).toBe('2026-11-01T00:00:00.000Z');
		expect(ev('year(prop("Due"))')).toBe(2026);
		expect(ev('month(prop("Due"))')).toBe(11);
		expect(ev('day(prop("Due"))')).toBe(20);
		expect(ev('date("nope")')).toBeNull();
		expect(ev('timestamp(date("1970-01-02"))')).toBe(86_400_000);
		expect(ev('dateAdd(prop("Empty"), 1, "day")')).toBeNull();
	});

	test('list functions', () => {
		expect(ev('join(prop("Tags"), " / ")')).toBe('alpha / beta / gamma');
		expect(ev('join(prop("Tags"))')).toBe('alpha, beta, gamma');
		expect(ev('includes(prop("Tags"), "beta")')).toBe(true);
		expect(ev('first(prop("Tags"))')).toBe('alpha');
		expect(ev('last(prop("Tags"))')).toBe('gamma');
		expect(ev('at(prop("Tags"), 1)')).toBe('beta');
		expect(ev('first([])')).toBeNull();
		expect(ev('map([1, 2, 3], current * 10 + index)')).toEqual([10, 21, 32]);
		expect(ev('filter(prop("Tags"), length(current) == 4)')).toEqual(['beta']);
		expect(ev('join(map(prop("Tags"), upper(current)), "-")')).toBe('ALPHA-BETA-GAMMA');
		expect(ev('sum(map([1, 2, 3], current ^ 2))')).toBe(14);
	});

	test('runtime failures come back as errors with a span, never as exceptions', () => {
		const p = parseFormula('1 + prop("Name") - 2');
		expect(p.ok).toBe(true);
		if (p.ok) {
			const r = evaluateFormula(p.ast, ctx);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(formatError('1 + prop("Name") - 2', r.error)).toContain('Expected a number, got text');
		}
		const bad = parseFormula('dateAdd(prop("Due"), 1, "fortnight")');
		if (bad.ok) {
			const r = evaluateFormula(bad.ast, ctx);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error.message).toContain('Unknown unit "fortnight"');
		}
	});

	test('purity: the same inputs give the same output, and the tree is not changed', () => {
		const p = parseFormula('map(prop("Tags"), upper(current)) + at([1], 0) + now()');
		if (!p.ok) throw new Error('parse');
		const before = JSON.stringify(p.ast);
		const a = evaluateFormula(p.ast, ctx);
		const b = evaluateFormula(p.ast, ctx);
		expect(a).toEqual(b);
		expect(JSON.stringify(p.ast)).toBe(before);
	});
});

describe('values and storage', () => {
	const DEFS: PropertyDef[] = [
		{ id: 'p', name: 'Price', type: 'number', config: { format: 'number' } },
		{ id: 'd', name: 'Due', type: 'date', config: { includeTime: false } },
		{ id: 'c', name: 'Created', type: 'created_time', config: {} },
		{ id: 'n', name: 'Name', type: 'title', config: {} }
	];
	const env = envFromProperties(DEFS);

	test('stored values convert to formula values and back', () => {
		expect(fromPropValue({ start: '2026-11-20' })).toEqual({ start: Date.parse('2026-11-20T00:00:00Z'), end: null, time: false });
		expect(fromPropValue({ start: '2026-11-20T10:00:00Z', end: '2026-11-21T11:00:00Z' })).toEqual({ start: Date.parse('2026-11-20T10:00:00Z'), end: Date.parse('2026-11-21T11:00:00Z'), time: true });
		expect(fromPropValue('2026-11-20T10:00:00.000Z', DEFS[2])).toEqual({ start: Date.parse('2026-11-20T10:00:00Z'), end: null, time: true });
		expect(fromPropValue(null)).toBeNull();
		expect(toPropValue('date', { start: Date.parse('2026-11-20T00:00:00Z'), end: Date.parse('2026-11-22T00:00:00Z'), time: false })).toEqual({ start: '2026-11-20', end: '2026-11-22' });
		expect(toPropValue('number', NaN)).toBeNull();
		expect(toPropValue('number', -0)).toBe(0);
		expect(toPropValue('text', '')).toBeNull();
		expect(toPropValue('text', ['a', 'b'])).toBe('a, b');
		expect(toPropValue('checkbox', true)).toBe(true);
		expect(toPropValue('checkbox', 1)).toBeNull();
	});

	test('computeFormula: analyze, evaluate and shape the value to store', () => {
		const run = (src: string, values: Record<string, FormulaValue>) => computeFormula(src, env, { prop: (n) => values[n] ?? null, now: NOW });
		expect(run('prop("Price") * 2', { Price: 21 })).toMatchObject({ ok: true, value: 42, resultType: 'number' });
		expect(run('dateAdd(prop("Due"), 3, "days")', { Due: day('2026-11-20') })).toMatchObject({ ok: true, value: { start: '2026-11-23' }, resultType: 'date' });
		expect(run('prop("Price") > 10', { Price: 3 })).toMatchObject({ ok: true, value: false, resultType: 'checkbox' });
		expect(run('upper(prop("Name"))', { Name: 'abc' })).toMatchObject({ ok: true, value: 'ABC', resultType: 'text' });
		expect(run('prop("Nope")', {})).toMatchObject({ ok: false, message: 'Unknown property "Nope"' });
		expect(run('1 / 0', {})).toMatchObject({ ok: true, value: null });
	});

	test('formatWithPattern tokens', () => {
		const ms = Date.UTC(2026, 0, 5, 9, 7, 3);
		expect(formatWithPattern(ms, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-01-05 09:07:03');
		expect(formatWithPattern(ms, 'D/M/YY h:mm a')).toBe('5/1/26 9:07 am');
		expect(formatWithPattern(ms, '[Q]MMMM')).toBe('QJanuary');
	});

	test('analysis and evaluation agree on a formula that reads now', () => {
		const a = analyzeFormula('dateBetween(now(), prop("Due"), "days")', env);
		expect(a.ok && [a.usesNow, a.resultType, a.deps]).toEqual([true, 'number', ['Due']]);
	});
});
