import { describe, expect, it } from 'vitest';
import { cellText } from '../../../src/lib/components/views/format-cell';

const now = new Date(2026, 10, 7, 12);
const options = [
	{ id: 'todo', name: 'To do', color: 'gray' },
	{ id: 'done', name: 'Done', color: 'green' }
];

describe('read-only table cells', () => {
	it('prints each property type as text', () => {
		const members = new Map([['u1', 'Ada'], ['u2', 'Bob']]);
		expect(cellText({ type: 'text', config: {} }, 'hello', members, now)).toBe('hello');
		expect(cellText({ type: 'number', config: { format: 'number' } }, 42, members, now)).toBe('42');
		expect(cellText({ type: 'checkbox', config: {} }, true, members, now)).toBe('Yes');
		expect(cellText({ type: 'checkbox', config: {} }, false, members, now)).toBe('');
		expect(cellText({ type: 'select', config: { options } }, 'done', members, now)).toBe('Done');
		expect(cellText({ type: 'status', config: { options, groups: [] } }, 'gone', members, now)).toBe('gone');
		expect(cellText({ type: 'multi_select', config: { options } }, ['todo', 'done'], members, now)).toBe('To do, Done');
		expect(cellText({ type: 'person', config: {} }, ['u1', 'u9'], members, now)).toBe('Ada, Someone');
		expect(cellText({ type: 'files', config: {} }, ['f1', 'f2'], members, now)).toBe('2 files');
		expect(cellText({ type: 'relation', config: {} } as never, ['p1'], members, now)).toBe('1 page');
		expect(cellText({ type: 'date', config: { includeTime: false } }, { start: '2026-11-07' }, members, now)).toBe('Today');
		expect(cellText({ type: 'date', config: { includeTime: false } }, { start: '2026-11-08', end: '2026-11-09' }, members, now)).toBe('Tomorrow → Next Monday');
		expect(cellText({ type: 'created_by', config: {} }, 'u2', members, now)).toBe('Bob');
	});

	it('shows nothing for an empty value or an unknown property', () => {
		expect(cellText({ type: 'text', config: {} }, null)).toBe('');
		expect(cellText(undefined, undefined)).toBe('');
		expect(cellText(undefined, 'raw')).toBe('raw');
	});
});
