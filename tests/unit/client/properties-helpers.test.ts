import { describe, expect, it } from 'vitest';
import {
	CREATABLE_TYPES,
	aiConfigValid,
	aiSourceCandidates,
	defaultAiConfig,
	normalizeAiConfig,
	TYPE_META,
	calendarDate,
	composeDate,
	configWithOption,
	configWithOptionChanged,
	configWithoutOption,
	formatDateText,
	formatDateValue,
	formatNumber,
	hrefFor,
	isEmpty,
	makeDateValue,
	makeOption,
	newPropertyDef,
	nextOptionColor,
	optionByName,
	optionColorName,
	optionsOf,
	parseNumber,
	plainText,
	shortId,
	statusGroups,
	suggestName,
	toDateOnly,
	valueIds
} from '#lib/components/properties/helpers.ts';
import { PROPERTY_TYPES, parsePropertyConfig, propertyDefSchema, type PropertyDef } from '#lib/shared/property-types.ts';
import * as v from 'valibot';

const select = (options: { id: string; name: string; color?: string }[]) =>
	({ id: 'p', name: 'P', type: 'select', config: { options } }) as unknown as PropertyDef;

describe('type catalogue', () => {
	it('has an entry for every property type and offers only valid creatable types', () => {
		for (const t of PROPERTY_TYPES) expect(TYPE_META[t]).toBeDefined();
		for (const t of CREATABLE_TYPES) expect(TYPE_META[t].creatable).toBe(true);
		expect(CREATABLE_TYPES).not.toContain('title');
		expect(CREATABLE_TYPES).not.toContain('formula');
	});

	it('builds a valid definition for every creatable type', () => {
		for (const t of CREATABLE_TYPES) {
			const def = newPropertyDef(t, ` ${t} `);
			expect(def.name).toBe(t);
			expect(v.safeParse(propertyDefSchema, def).success, t).toBe(true);
		}
		const status = newPropertyDef('status', 'Stage');
		expect(optionsOf(status).map((o) => o.id)).toEqual(['not_started', 'in_progress', 'done']);
		expect(parsePropertyConfig('status', status.config).ok).toBe(true);
	});

	it('offers the AI type with a config of its own', () => {
		expect(CREATABLE_TYPES).toContain('ai');
		const def = newPropertyDef('ai', 'Summary');
		expect(def.config).toEqual(defaultAiConfig());
		const custom = newPropertyDef('ai', 'Pitch', 'prop_pitch', normalizeAiConfig({ kind: 'custom', prompt: ' One line pitch ', language: 'French', sourceProps: ['prop_a'] }));
		expect(custom.config).toEqual({ kind: 'custom', prompt: 'One line pitch', sourceProps: ['prop_a'] });
		expect(parsePropertyConfig('ai', custom.config).ok).toBe(true);
		// A kind keeps only what it reads; the legacy `sources` name is read, written as `sourceProps`.
		expect(normalizeAiConfig({ kind: 'translation', language: ' Spanish ', prompt: 'x', sources: ['prop_b'] })).toEqual({ kind: 'translation', language: 'Spanish', sourceProps: ['prop_b'] });
		expect(aiConfigValid({ kind: 'custom', prompt: '  ' })).toBe(false);
		expect(aiConfigValid({ kind: 'custom', prompt: 'Go' })).toBe(true);
		expect(aiConfigValid({ kind: 'translation' })).toBe(true);
	});

	it('lists as AI sources the plain properties of the page, never itself, relations or rollups', () => {
		const defs = [
			{ id: 'a', name: 'Notes', type: 'text' },
			{ id: 'b', name: 'Related', type: 'relation' },
			{ id: 'c', name: 'Total', type: 'rollup' },
			{ id: 'd', name: 'Summary', type: 'ai' },
			{ id: 'e', name: 'Stage', type: 'status' }
		] as const;
		expect(aiSourceCandidates(defs, 'd').map((d) => d.id)).toEqual(['a', 'e']);
		expect(aiSourceCandidates(defs).map((d) => d.id)).toEqual(['a', 'd', 'e']);
	});

	it('suggests a unique name', () => {
		expect(suggestName('select', [])).toBe('Select');
		expect(suggestName('select', [{ name: 'select' }])).toBe('Select 2');
		expect(suggestName('select', [{ name: 'Select' }, { name: 'Select 2' }])).toBe('Select 3');
	});

	it('shortId is valid for idSchema', () => {
		expect(shortId('opt_')).toMatch(/^opt_[a-z0-9]{8}$/);
	});
});

describe('options', () => {
	it('maps default to gray', () => {
		expect(optionColorName('default')).toBe('gray');
		expect(optionColorName(undefined)).toBe('gray');
		expect(optionColorName('red')).toBe('red');
	});

	it('picks the least used color for a new option', () => {
		expect(nextOptionColor([])).toBe('gray');
		expect(nextOptionColor([{ color: 'gray' }, { color: 'brown' }])).toBe('orange');
		const all = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'].map((color) => ({ color }));
		expect(nextOptionColor([...all, { color: 'gray' }])).toBe('brown');
	});

	it('adds, renames, recolors and removes options as whole configs', () => {
		const def = select([{ id: 'a', name: 'A', color: 'red' }]);
		const opt = makeOption(def, '  New one ', 'opt_x')!;
		expect(opt).toEqual({ id: 'opt_x', name: 'New one', color: 'gray' });
		expect(makeOption(def, '   ')).toBeNull();

		const added = configWithOption(def, opt) as { options: unknown[] };
		expect(added.options).toHaveLength(2);
		const renamed = configWithOptionChanged({ type: 'select', config: added as never }, 'a', { name: 'Alpha', color: 'blue' }) as { options: { id: string; name: string; color: string }[] };
		expect(renamed.options[0]).toEqual({ id: 'a', name: 'Alpha', color: 'blue' });
		const removed = configWithoutOption({ type: 'select', config: renamed as never }, 'a') as { options: { id: string }[] };
		expect(removed.options.map((o) => o.id)).toEqual(['opt_x']);
		expect(parsePropertyConfig('select', removed).ok).toBe(true);
	});

	it('keeps status groups consistent', () => {
		const def = newPropertyDef('status', 'S');
		const opt = { id: 'blocked', name: 'Blocked', color: 'red' as const };
		const cfg = configWithOption(def, opt, 'in_progress');
		expect(parsePropertyConfig('status', cfg).ok).toBe(true);
		const groups = statusGroups({ type: 'status', config: cfg as never });
		expect(groups.find((g) => g.id === 'in_progress')!.options.map((o) => o.id)).toEqual(['in_progress', 'blocked']);
		const without = configWithoutOption({ type: 'status', config: cfg as never }, 'in_progress');
		expect(parsePropertyConfig('status', without).ok).toBe(true);
		expect(statusGroups({ type: 'status', config: without as never }).map((g) => g.id)).toEqual(['todo', 'in_progress', 'complete']);
	});

	it('finds options by name ignoring case', () => {
		const def = select([{ id: 'a', name: 'Alpha' }]);
		expect(optionByName(def, ' alpha ')?.id).toBe('a');
		expect(optionByName(def, 'beta')).toBeUndefined();
	});

	it('valueIds normalizes single, list and empty values', () => {
		expect(valueIds('a')).toEqual(['a']);
		expect(valueIds(['a', 'b'])).toEqual(['a', 'b']);
		expect(valueIds(null)).toEqual([]);
	});
});

describe('numbers', () => {
	it('formats by config', () => {
		expect(formatNumber(1234.5)).toBe('1234.5');
		expect(formatNumber(1234.5, { format: 'number_with_commas' })).toBe('1,234.5');
		expect(formatNumber(3, { precision: 2 })).toBe('3.00');
		expect(formatNumber(12, { format: 'percent' })).toBe('12%');
		expect(formatNumber(1234.5, { format: 'dollar' })).toBe('$1,234.5')
		expect(formatNumber(1234.5, { format: 'dollar', precision: 2 })).toBe('$1,234.50');
		expect(formatNumber(1234, { format: 'euro', precision: 0 })).toBe('€1,234');
		expect(formatNumber(1500, { format: 'yen' })).toBe('¥1,500');
		expect(formatNumber(Number.NaN)).toBe('');
	});

	it('parses typed text', () => {
		expect(parseNumber('1,234.5')).toBe(1234.5);
		expect(parseNumber(' $12 ')).toBe(12);
		expect(parseNumber('45%')).toBe(45);
		expect(parseNumber('')).toBeNull();
		expect(parseNumber('abc')).toBeNull();
		expect(parseNumber('-')).toBeNull();
	});
});

describe('dates', () => {
	it('formats date-only values as written', () => {
		expect(formatDateText('2026-11-21')).toBe('Nov 21, 2026');
		expect(formatDateValue({ start: '2026-11-21', end: '2026-11-28' })).toBe('Nov 21, 2026 → Nov 28, 2026');
		expect(formatDateValue(null)).toBe('');
	});

	it('formats timed values in UTC when asked', () => {
		expect(formatDateText('2026-11-21T09:05:00Z', { tz: 'UTC' })).toBe('Nov 21, 2026 9:05 AM');
		expect(formatDateText('2026-11-21T00:30:00Z', { tz: 'UTC' })).toBe('Nov 21, 2026 12:30 AM');
		expect(formatDateText('2026-11-21T13:00:00Z', { tz: 'UTC' })).toBe('Nov 21, 2026 1:00 PM');
	});

	it('round-trips a calendar day with and without a time', () => {
		const day = new Date(2026, 10, 21);
		expect(toDateOnly(day)).toBe('2026-11-21');
		expect(composeDate(day, null)).toBe('2026-11-21');
		const timed = composeDate(day, '09:30');
		expect(timed).toMatch(/Z$/);
		expect(calendarDate(timed)!.getDate()).toBe(21);
		expect(calendarDate('2026-11-21')!.getDate()).toBe(21);
		expect(calendarDate('nope')).toBeNull();
	});

	it('swaps a reversed range', () => {
		expect(makeDateValue('2026-11-28', '2026-11-21')).toEqual({ start: '2026-11-21', end: '2026-11-28' });
		expect(makeDateValue('2026-11-21', null)).toEqual({ start: '2026-11-21' });
	});
});

describe('links', () => {
	it('builds safe hrefs', () => {
		expect(hrefFor('url', 'example.com/a')).toBe('https://example.com/a');
		expect(hrefFor('url', 'http://example.com')).toBe('http://example.com/');
		expect(hrefFor('url', 'javascript:alert(1)')).toBeNull();
		expect(hrefFor('email', 'a@b.co')).toBe('mailto:a@b.co');
		expect(hrefFor('email', 'not an email')).toBeNull();
		expect(hrefFor('phone', '+1 (555) 123-4567')).toBe('tel:+15551234567');
		expect(hrefFor('phone', 'x')).toBeNull();
		expect(hrefFor('text', 'hi')).toBeNull();
		expect(hrefFor('url', '')).toBeNull();
	});
});

describe('emptiness and plain text', () => {
	it('treats zero and false as values', () => {
		expect(isEmpty({ type: 'number' }, 0)).toBe(false);
		expect(isEmpty({ type: 'number' }, null)).toBe(true);
		expect(isEmpty({ type: 'checkbox' }, false)).toBe(false);
		expect(isEmpty({ type: 'checkbox' }, null)).toBe(true);
		expect(isEmpty({ type: 'multi_select' }, [])).toBe(true);
		expect(isEmpty({ type: 'text' }, '')).toBe(true);
		expect(isEmpty({ type: 'date' }, { start: '2026-01-01' })).toBe(false);
	});

	it('renders labels instead of ids', () => {
		const def = select([{ id: 'a', name: 'Alpha' }]);
		expect(plainText(def, 'a')).toBe('Alpha');
		expect(plainText({ id: 'x', name: 'X', type: 'person', config: {} }, ['u1'], { person: () => 'Ada' })).toBe('Ada');
		expect(plainText({ id: 'x', name: 'X', type: 'number', config: { format: 'percent' } } as PropertyDef, 5)).toBe('5%');
	});
});
