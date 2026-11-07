import { describe, expect, test } from 'vitest';
import {
	analyzeFormula,
	envFromProperties,
	formatError,
	formulaTypeOf,
	resultTypeOf,
	type FType
} from '../../../src/lib/shared/formula';
import type { PropertyDef } from '../../../src/lib/shared/property-types';

const opt = (id: string) => ({ id, name: id, color: 'default' as const });
const DEFS: PropertyDef[] = [
	{ id: 'title', name: 'Name', type: 'title', config: {} },
	{ id: 'price', name: 'Price', type: 'number', config: { format: 'number' } },
	{ id: 'qty', name: 'Qty', type: 'number', config: { format: 'number' } },
	{ id: 'due', name: 'Due', type: 'date', config: { includeTime: false } },
	{ id: 'done', name: 'Done', type: 'checkbox', config: {} },
	{ id: 'tags', name: 'Tags', type: 'multi_select', config: { options: [opt('a')] } },
	{ id: 'st', name: 'Status', type: 'select', config: { options: [opt('a')] } },
	{ id: 'ct', name: 'Created', type: 'created_time', config: {} },
	{ id: 'f', name: 'Total', type: 'formula', config: { expression: '1', resultType: 'number' } }
];
const env = envFromProperties(DEFS);

const typeOf = (src: string): FType => {
	const r = analyzeFormula(src, env);
	if (!r.ok) throw new Error(r.errors.map((e) => formatError(src, e)).join('\n'));
	return r.type;
};
const errorsOf = (src: string): string[] => {
	const r = analyzeFormula(src, env);
	expect(r.ok, src).toBe(false);
	return r.ok ? [] : r.errors.map((e) => `${e.message} @${e.start}-${e.end}`);
};

describe('result types', () => {
	test('property types map to formula types', () => {
		expect(DEFS.map(formulaTypeOf)).toEqual(['text', 'number', 'number', 'date', 'checkbox', { list: 'text' }, 'text', 'date', 'number']);
	});

	test('operators and literals', () => {
		expect(typeOf('1 + 2')).toBe('number');
		expect(typeOf('"a" + 1')).toBe('text');
		expect(typeOf('prop("Price") * prop("Qty")')).toBe('number');
		expect(typeOf('prop("Price") > 3 and prop("Done")')).toBe('checkbox');
		expect(typeOf('prop("Name") == "x"')).toBe('checkbox');
		expect(typeOf('not prop("Done")')).toBe('checkbox');
		expect(typeOf('-prop("Price")')).toBe('number');
		expect(typeOf('prop("Due") < now()')).toBe('checkbox');
	});

	test('functions', () => {
		expect(typeOf('concat(prop("Name"), "-", prop("Price"))')).toBe('text');
		expect(typeOf('length(prop("Name"))')).toBe('number');
		expect(typeOf('length(prop("Tags"))')).toBe('number');
		expect(typeOf('round(prop("Price") / 3, 2)')).toBe('number');
		expect(typeOf('sum(prop("Price"), 1, 2)')).toBe('number');
		expect(typeOf('sum([1, 2, 3])')).toBe('number');
		expect(typeOf('dateAdd(prop("Due"), 1, "week")')).toBe('date');
		expect(typeOf('dateBetween(now(), prop("Due"), "days")')).toBe('number');
		expect(typeOf('formatDate(prop("Created"), "YYYY")')).toBe('text');
		expect(typeOf('start(prop("Due"))')).toBe('date');
		expect(typeOf('join(prop("Tags"), ", ")')).toBe('text');
		expect(typeOf('first(prop("Tags"))')).toBe('text');
		expect(typeOf('includes(prop("Tags"), "a")')).toBe('checkbox');
		expect(typeOf('map(prop("Tags"), upper(current))')).toEqual({ list: 'text' });
		expect(typeOf('filter([1, 2, 3], current > index)')).toEqual({ list: 'number' });
		expect(typeOf('if(prop("Done"), 1, 2)')).toBe('number');
		expect(typeOf('prop("Done") ? "yes" : "no"')).toBe('text');
	});

	test('result type picks the storage table', () => {
		expect(resultTypeOf('number')).toBe('number');
		expect(resultTypeOf('date')).toBe('date');
		expect(resultTypeOf('checkbox')).toBe('checkbox');
		expect(resultTypeOf('text')).toBe('text');
		expect(resultTypeOf({ list: 'text' })).toBe('text');
		expect(resultTypeOf('any')).toBe('text');
		const r = analyzeFormula('prop("Price") > 1', env);
		expect(r.ok && r.resultType).toBe('checkbox');
	});

	test('without a property environment, properties are unchecked', () => {
		const r = analyzeFormula('prop("Whatever") + 1');
		expect(r.ok && r.type).toBe('any');
	});
});

describe('type errors', () => {
	test('are readable and positioned', () => {
		expect(errorsOf('prop("Nope") + 1')).toEqual(['Unknown property "Nope" @0-12']);
		expect(errorsOf('foo(1)')).toEqual(['Unknown function "foo" @0-6']);
		expect(errorsOf('1 - "a"')).toEqual(['"-" needs numbers, got text @4-7']);
		expect(errorsOf('if(1, 2, 3)')).toEqual(['The condition of if() must be a checkbox, got number @3-4']);
		expect(errorsOf('if(true, 1, "a")')).toEqual(['The two outcomes of if() must have the same type, got number and text @0-16']);
		expect(errorsOf('round()')).toEqual(['round() takes 1 to 2 arguments, got 0 @0-7']);
		expect(errorsOf('upper(1)')).toEqual(['Expected text, got number @6-7']);
		expect(errorsOf('current')).toEqual(['"current" is only available inside map() and filter() @0-7']);
		expect(errorsOf('1 == "a"')).toEqual(['Cannot compare number with text @0-8']);
		expect(errorsOf('prop("Due") + 1')).toEqual(['Cannot add date and number (use dateAdd for dates) @0-15']);
		expect(errorsOf('[1, "a"]')).toEqual(['List items must share one type, found number and text @4-7']);
		expect(errorsOf('true < false')).toEqual(['"<" compares numbers, text or dates, not checkbox @0-12']);
	});

	test('every problem is reported, not just the first', () => {
		expect(errorsOf('upper(1) + lower(2)').length).toBe(2);
	});

	test('syntax errors come back as one error', () => {
		expect(errorsOf('1 +')).toEqual(['Expected a value, found the end of the formula @3-4']);
	});
});

describe('dependencies and the clock', () => {
	test('the properties a formula reads, in order, once', () => {
		const r = analyzeFormula('prop("Price") * prop("Qty") + prop("Price") + length(prop("Tags"))', env);
		expect(r.ok && r.deps).toEqual(['Price', 'Qty', 'Tags']);
		expect(r.ok && r.usesNow).toBe(false);
	});

	test('now() and today() are flagged, wherever they appear', () => {
		for (const src of ['now()', 'dateBetween(now(), prop("Due"), "days") > 3', 'if(true, 1, dateBetween(today(), prop("Due"), "days"))']) {
			const r = analyzeFormula(src, env);
			expect(r.ok && r.usesNow, src).toBe(true);
		}
		expect((analyzeFormula('prop("Due")', env) as { usesNow: boolean }).usesNow).toBe(false);
	});
});
