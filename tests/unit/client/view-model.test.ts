import { describe, expect, it } from 'vitest';
import { GROUP_EMPTY } from '#lib/shared/filter-ast.ts';
import { createRegistry, TITLE_PROP_ID, type PropertyDef } from '#lib/shared/property-types.ts';
import type { ViewDef } from '#lib/shared/definitions.ts';
import {
	allColumns,
	columnsFromEntries,
	dateProps,
	defaultGroupProp,
	groupMeta,
	moveEntry,
	neededProps,
	newRowInit,
	rangeFilter,
	rowDates,
	searchFilter,
	toDateValue,
	valueOfGroup,
	valuesFromFilter,
	viewSubscription,
	visibleColumns,
	withColumnShown
} from '#lib/components/views/view-model.ts';

const title: PropertyDef = { id: TITLE_PROP_ID, name: 'Name', type: 'title', config: {} };
const status = {
	id: 'status',
	name: 'Status',
	type: 'status',
	config: {
		options: [
			{ id: 'todo', name: 'To do', color: 'gray' },
			{ id: 'doing', name: 'Doing', color: 'blue' }
		],
		groups: [{ id: 'g1', name: 'Active', optionIds: ['doing'] }]
	}
} as PropertyDef;
const tags = { id: 'tags', name: 'Tags', type: 'multi_select', config: { options: [{ id: 'a', name: 'A' }] } } as PropertyDef;
const owner = { id: 'owner', name: 'Owner', type: 'person', config: {} } as PropertyDef;
const due = { id: 'due', name: 'Due', type: 'date', config: {} } as PropertyDef;
const done = { id: 'done', name: 'Done', type: 'checkbox', config: {} } as PropertyDef;
const props = [title, status, tags, owner, due, done];
const registry = createRegistry(props);

const view = (over: Partial<ViewDef> = {}): ViewDef => ({
	id: 'v1',
	collectionId: 'c1',
	type: 'table',
	name: 'Table',
	filter: { and: [] },
	sorts: [],
	groupBy: null,
	columns: { columns: [], options: {} },
	rank: '10',
	...over
});

describe('columns', () => {
	it('leads with the title and falls back to the collection shown properties', () => {
		const cols = visibleColumns(view(), { shownProps: ['status', 'due'] }, props);
		expect(cols.map((c) => c.def.id)).toEqual([TITLE_PROP_ID, 'status', 'due']);
	});

	it('uses the view columns in order, skips hidden and unknown ones, and keeps widths', () => {
		const v = view({ columns: { columns: [{ prop: 'due', width: 222 }, { prop: 'gone' }, { prop: 'status', hidden: true }, { prop: 'owner' }], options: {} } });
		const cols = visibleColumns(v, { shownProps: ['status'] }, props);
		expect(cols.map((c) => c.def.id)).toEqual([TITLE_PROP_ID, 'due', 'owner']);
		expect(cols[1].width).toBe(222);
	});

	it('lists every property, hidden ones after the shown', () => {
		const entries = allColumns(view(), { shownProps: ['status'] }, props);
		expect(entries.filter((e) => !e.hidden).map((e) => e.def.id)).toEqual([TITLE_PROP_ID, 'status']);
		expect(entries.filter((e) => e.hidden).map((e) => e.def.id)).toEqual(['tags', 'owner', 'due', 'done']);
	});

	it('shows and hides a column, keeping widths, and never hides the title', () => {
		const v = view({ columns: { columns: [{ prop: 'status', width: 180 }], options: {} } });
		const shown = withColumnShown(v, null, props, 'due', true);
		expect(shown.find((c) => c.prop === 'due')?.hidden).toBeUndefined();
		expect(shown.find((c) => c.prop === 'status')?.width).toBe(180);
		const hidden = withColumnShown(v, null, props, 'status', false);
		expect(hidden.find((c) => c.prop === 'status')?.hidden).toBe(true);
		expect(withColumnShown(v, null, props, TITLE_PROP_ID, false).some((c) => c.prop === TITLE_PROP_ID && c.hidden)).toBe(false);
	});

	it('moves an entry and rebuilds columns_json', () => {
		const entries = allColumns(view({ columns: { columns: [{ prop: 'status' }, { prop: 'due' }], options: {} } }), null, props);
		const moved = moveEntry(entries, 'due', 1);
		expect(moved.slice(0, 3).map((e) => e.def.id)).toEqual([TITLE_PROP_ID, 'due', 'status']);
		expect(columnsFromEntries(moved.slice(0, 3), { due: 150.4 })[1]).toEqual({ prop: 'due', width: 150 });
	});
});

describe('subscription', () => {
	it('sends sorts and group-by as the view has them, and only groups boards', () => {
		const sorts = [{ prop: 'due', dir: 'asc' as const }];
		const groupBy = { prop: 'status' };
		const table = viewSubscription({ collectionId: 'c1', view: view({ sorts, groupBy }), props: ['due', 'due'], limit: 100 });
		expect(table).toMatchObject({ kind: 'view', viewId: 'v1', sorts, groupBy: null, props: ['due'], limit: 100 });
		expect(table).not.toHaveProperty('filter');
		const board = viewSubscription({ collectionId: 'c1', view: view({ type: 'board', groupBy }), props: [], limit: 25 });
		expect(board).toMatchObject({ groupBy });
	});

	it('ANDs the local filter, the search and the range into one filter', () => {
		const local = { and: [{ prop: 'status', op: 'is' as const, value: 'todo' }] };
		const sub = viewSubscription({ collectionId: 'c1', view: view(), localFilter: local, extraFilter: searchFilter(' spec '), props: [], limit: 10 });
		expect(JSON.stringify(sub)).toContain('"contains"');
		expect(JSON.stringify(sub)).toContain('spec');
		expect(searchFilter('   ')).toBeNull();
		const r = rangeFilter('due', 'end', '2026-11-01', '2026-12-01');
		expect('or' in r && r.or).toHaveLength(2);
	});

	it('asks for the columns and what the layout reads, once, never the title', () => {
		const v = view({ type: 'calendar', groupBy: { prop: 'status' }, columns: { columns: [], options: { dateProp: 'due', coverProp: 'files' } } });
		const cols = visibleColumns(v, { shownProps: ['owner'] }, props);
		expect(neededProps(v, cols, ['due', null]).sort()).toEqual(['due', 'files', 'owner', 'status']);
	});
});

describe('new rows satisfy the filter', () => {
	it('derives values from a conjunction, the first OR branch, and "me"', () => {
		const filter = {
			and: [
				{ prop: 'status', op: 'is' as const, value: 'doing' },
				{ prop: 'tags', op: 'contains' as const, value: 'a' },
				{ prop: 'owner', op: 'is_me' as const },
				{ prop: 'done', op: 'is' as const, value: false },
				{ or: [{ prop: 'due', op: 'is' as const, value: { kind: 'exact' as const, date: '2026-11-21' } }, { prop: 'status', op: 'is' as const, value: 'todo' }] },
				{ prop: 'status', op: 'is_not' as const, value: 'todo' }
			]
		};
		const { values } = valuesFromFilter(filter, registry, 'u_me');
		expect(values).toEqual({ status: 'doing', tags: ['a'], owner: ['u_me'], done: false, due: { start: '2026-11-21' } });
	});

	it('turns a relative date into a day and reads the parent', () => {
		const now = Date.UTC(2026, 10, 7, 15);
		const { values, parentId } = valuesFromFilter(
			{ and: [{ prop: 'due', op: 'is', value: { kind: 'relative', unit: 'day', offset: 1 } }, { prop: '$parent', op: 'is', value: 'dbpage' }] },
			registry,
			'u',
			now
		);
		expect(values.due).toEqual({ start: '2026-11-08' });
		expect(parentId).toBe('dbpage');
	});

	it('layers collection defaults, membership, the view filter and the board column, parent first', () => {
		const init = newRowInit({
			collection: { pageId: 'page', defaults: { status: 'todo', done: false }, sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'page' }] } },
			view: { filter: { and: [{ prop: 'status', op: 'is', value: 'doing' }] } },
			registry,
			meId: 'u',
			extra: { owner: ['x'] }
		});
		expect(init).toEqual({ parentId: 'page', values: { status: 'doing', done: false, owner: ['x'] } });
	});

	it('names the value a board column stands for', () => {
		expect(valueOfGroup(status, 'doing')).toBe('doing');
		expect(valueOfGroup(status, 'g1', { prop: 'status', by: 'group' })).toBe('doing');
		expect(valueOfGroup(tags, 'a')).toEqual(['a']);
		expect(valueOfGroup(done, 'true')).toBe(true);
		expect(valueOfGroup(status, GROUP_EMPTY)).toBeUndefined();
	});
});

describe('groups', () => {
	it('titles columns by option, person, checkbox and the empty group', () => {
		expect(groupMeta(status, 'doing')).toMatchObject({ label: 'Doing', color: 'blue' });
		expect(groupMeta(status, 'g1', { spec: { prop: 'status', by: 'group' } }).label).toBe('Active');
		expect(groupMeta(owner, 'u1', { member: () => 'Ada' }).label).toBe('Ada');
		expect(groupMeta(done, 'true').label).toBe('Checked');
		expect(groupMeta(status, GROUP_EMPTY)).toMatchObject({ label: 'No status', empty: true });
	});

	it('picks a default group property: status, then select, then person', () => {
		expect(defaultGroupProp(props)?.id).toBe('status');
		expect(defaultGroupProp([title, owner, due])?.id).toBe('owner');
		expect(defaultGroupProp([title, due])).toBeNull();
	});
});

describe('dates', () => {
	it('reads a row date and an optional end property', () => {
		expect(rowDates({ start: '2026-11-21' })).toEqual({ start: '2026-11-21', end: null });
		expect(rowDates({ start: '2026-11-21', end: '2026-11-23' })).toEqual({ start: '2026-11-21', end: '2026-11-23' });
		expect(rowDates({ start: '2026-11-21' }, { start: '2026-11-25' })).toEqual({ start: '2026-11-21', end: '2026-11-25' });
		expect(rowDates(null)).toBeNull();
		expect(rowDates('nonsense')).toBeNull();
	});

	it('builds a date value: swaps a reversed range and drops a one-day end', () => {
		expect(toDateValue('2026-11-23', '2026-11-21')).toEqual({ start: '2026-11-21', end: '2026-11-23' });
		expect(toDateValue('2026-11-21', '2026-11-21')).toEqual({ start: '2026-11-21' });
		expect(toDateValue('2026-11-21', null)).toEqual({ start: '2026-11-21' });
	});

	it('picks the date properties of a calendar from its options or the first date', () => {
		const withOptions = view({ columns: { columns: [], options: { dateProp: 'due', endDateProp: 'end' } } });
		const end = { id: 'end', name: 'End', type: 'date', config: {} } as PropertyDef;
		expect(dateProps(withOptions, [...props, end])).toMatchObject({ start: { id: 'due' }, end: { id: 'end' } });
		expect(dateProps(view(), props).start?.id).toBe('due');
		expect(dateProps(view(), [title]).start).toBeNull();
	});
});
