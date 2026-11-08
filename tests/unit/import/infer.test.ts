import { describe, expect, it } from 'vitest';
import {
	OptionBook,
	convertCell,
	detectDateOrder,
	headerNames,
	inferColumns,
	parseLooseDate,
	parseNumber,
	splitList,
	type ImportColumn
} from '../../../src/lib/shared/import/infer';

const typeOf = (values: string[], header = 'Col', delimiter = ',') => inferColumns(['Title', header], values.map((v) => ['row', v]), { delimiter })[1]!;

describe('header names', () => {
	it('are trimmed, never empty and unique', () => {
		expect(headerNames(['Name', ' name ', '', 'A  B', 'Name'])).toEqual(['Name', 'name 2', 'Column 3', 'A B', 'Name 3']);
		expect(headerNames(['x'.repeat(300)])[0]).toHaveLength(94);
	});
});

describe('type inference', () => {
	it('makes the first column the title, whatever it holds', () => {
		const cols = inferColumns(['ID', 'Name'], [['1', 'a'], ['2', 'b']]);
		expect(cols[0]).toMatchObject({ index: 0, type: 'title', name: 'ID' });
	});

	it('numbers', () => {
		expect(typeOf(['1', '2.5', '-3', '1,234.50', '1e3']).type).toBe('number');
		expect(typeOf(['1,5', '2,75', '1.234,5'], 'Col', ';')).toMatchObject({ type: 'number', decimalComma: true });
		// ids with leading zeros and very long digit strings stay text
		expect(typeOf(['007', '042', '100']).type).not.toBe('number');
		expect(typeOf(['12345678901234567890', '1']).type).not.toBe('number');
	});

	it('checkboxes', () => {
		expect(typeOf(['true', 'false', 'TRUE', '']).type).toBe('checkbox');
		expect(typeOf(['yes', 'no', 'Yes']).type).toBe('checkbox');
		expect(typeOf(['x', '', 'x']).type).toBe('checkbox');
		// 0 and 1 are numbers
		expect(typeOf(['0', '1', '1']).type).toBe('number');
	});

	it('dates in several formats', () => {
		expect(typeOf(['2026-01-15', '2026-02-01'])).toMatchObject({ type: 'date', dateOrder: 'mdy' });
		expect(typeOf(['2026-01-15T10:30:00Z', '2026-02-01'])).toMatchObject({ type: 'date', includeTime: true });
		expect(typeOf(['2026/01/15', '2026/03/04'])).toMatchObject({ type: 'date' });
		expect(typeOf(['15/01/2026', '03/02/2026'])).toMatchObject({ type: 'date', dateOrder: 'dmy' });
		expect(typeOf(['01/15/2026', '02/03/2026'])).toMatchObject({ type: 'date', dateOrder: 'mdy' });
		expect(typeOf(['15.01.2026', '2.3.2026'])).toMatchObject({ type: 'date', dateOrder: 'dmy' });
		expect(typeOf(['15 Jan 2026', '3 March 2026'])).toMatchObject({ type: 'date' });
		expect(typeOf(['January 15, 2026', 'Feb 3, 2026'])).toMatchObject({ type: 'date' });
		expect(typeOf(['01/02/2026 3:45 PM', '03/04/2026 10:00 AM'])).toMatchObject({ type: 'date', includeTime: true });
		// both day-first and month-first evidence: not a date column
		expect(typeOf(['15/01/2026', '01/15/2026']).type).not.toBe('date');
	});

	it('parses dates to canonical text', () => {
		expect(parseLooseDate('15/01/2026', 'dmy')?.value).toBe('2026-01-15');
		expect(parseLooseDate('01/15/2026', 'mdy')?.value).toBe('2026-01-15');
		expect(parseLooseDate('1/2/26', 'dmy')?.value).toBe('2026-02-01');
		expect(parseLooseDate('15 Jan 2026')?.value).toBe('2026-01-15');
		expect(parseLooseDate('Jan 15th, 2026')?.value).toBe('2026-01-15');
		expect(parseLooseDate('2026-01-15 10:30')?.value).toBe('2026-01-15T10:30:00Z');
		expect(parseLooseDate('01/15/2026 3:45 PM')?.value).toBe('2026-01-15T15:45:00Z');
		expect(parseLooseDate('01/15/2026 12:05 AM')?.value).toBe('2026-01-15T00:05:00Z');
		expect(parseLooseDate('31/02/2026', 'dmy')).toBeNull();
		expect(parseLooseDate('13/13/2026')).toBeNull();
		expect(parseLooseDate('hello')).toBeNull();
		expect(detectDateOrder(['15/01/2026'])).toBe('dmy');
		expect(detectDateOrder(['01/02/2026'])).toBeNull();
	});

	it('emails, urls and phones', () => {
		expect(typeOf(['a@b.co', 'jo.smith@example.com']).type).toBe('email');
		expect(typeOf(['https://a.co/x?y=1', 'http://b.org']).type).toBe('url');
		expect(typeOf(['+33 6 12 34 56 78', '+1 (555) 123-4567']).type).toBe('phone');
		expect(typeOf(['(555) 123-4567', '555-123-4567']).type).toBe('phone');
		expect(typeOf(['a@b.co', 'not an email']).type).not.toBe('email');
	});

	it('select for few repeating values, multi-select for comma lists, text otherwise', () => {
		expect(typeOf(['Todo', 'Done', 'Todo', 'Done', 'Doing', 'Done']).type).toBe('select');
		expect(typeOf(['red, blue', 'blue', 'green, red', 'red', 'blue, green', 'red']).type).toBe('multi_select');
		// all different: text
		expect(typeOf(['one', 'two', 'three', 'four', 'five', 'six']).type).toBe('text');
		// prose with commas stays text
		expect(typeOf(['Hello, my name is Ann and I like long walks', 'Well, it depends on the weather today', 'No, thanks']).type).toBe('text');
		expect(typeOf([]).type).toBe('text');
	});
});

describe('cell conversion', () => {
	const col = (extra: Partial<ImportColumn> & Pick<ImportColumn, 'type'>): ImportColumn => ({ index: 1, name: 'C', ...extra });

	it('converts each type and drops what does not fit', () => {
		expect(convertCell(col({ type: 'number' }), ' 1,234.5 ')).toEqual({ value: 1234.5 });
		expect(convertCell(col({ type: 'number' }), 'abc')).toEqual({ value: null, rejected: true });
		expect(convertCell(col({ type: 'number' }), '')).toEqual({ value: null });
		expect(convertCell(col({ type: 'checkbox' }), 'Yes')).toEqual({ value: true });
		expect(convertCell(col({ type: 'checkbox' }), 'maybe')).toEqual({ value: null, rejected: true });
		expect(convertCell(col({ type: 'date', dateOrder: 'dmy' }), '15/01/2026')).toEqual({ value: { start: '2026-01-15' } });
		expect(convertCell(col({ type: 'email' }), 'a@b.co')).toEqual({ value: 'a@b.co' });
		expect(convertCell(col({ type: 'email' }), 'nope')).toEqual({ value: null, rejected: true });
		expect(convertCell(col({ type: 'skip' }), 'x')).toEqual({ value: null });
		expect(convertCell(col({ type: 'text' }), 'x'.repeat(20_050))).toMatchObject({ truncated: true });
	});

	it('selects grow an option book, folding case', () => {
		const book = new OptionBook(['Todo']);
		expect(convertCell(col({ type: 'select' }), 'todo', book)).toEqual({ value: 'o1' });
		expect(convertCell(col({ type: 'select' }), 'Done', book)).toEqual({ value: 'o2' });
		expect(book.labels).toEqual(['Todo', 'Done']);
		expect(convertCell(col({ type: 'multi_select' }), 'done, New, todo, new', book)).toEqual({ value: ['o2', 'o3', 'o1'] });
		expect(book.options().map((o) => o.name)).toEqual(['Todo', 'Done', 'New']);
		expect(splitList('a, b;c | a')).toEqual(['a', 'b', 'c']);
	});

	it('a full book rejects new values', () => {
		const book = new OptionBook(Array.from({ length: 200 }, (_, i) => `v${i}`));
		expect(convertCell(col({ type: 'select' }), 'brand new', book)).toEqual({ value: null, rejected: true });
		expect(convertCell(col({ type: 'select' }), 'v5', book)).toEqual({ value: 'o6' });
	});

	it('parses numbers by rule', () => {
		expect(parseNumber('1.234,56', true)).toBe(1234.56);
		expect(parseNumber('1,5', true)).toBe(1.5);
		expect(parseNumber('1,234')).toBe(1234);
		expect(parseNumber('0.5')).toBe(0.5);
		expect(parseNumber('.5')).toBe(0.5);
		expect(parseNumber('+7')).toBe(7);
		expect(parseNumber('0')).toBe(0);
		expect(parseNumber('007')).toBeNull();
	});
});
