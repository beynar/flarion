/**
 * Grouping for boards: status groups, hidden groups, group order, "No value" placement, per-group windows and
 * counts, multi-select, person, checkbox, relation and date buckets, and `groupKeysOf` for the live loop.
 */
import { describe, expect, test } from 'vitest';
import type { GroupBySpec } from '../../../src/lib/shared/filter-ast';
import type { PropertyDef } from '../../../src/lib/shared/property-types';
import { evenRanks } from '../../../src/lib/shared/sort-keys';
import { groupKeysOf, orderGroups, runQuery } from '../../../src/server/engine';
import { queryViewRows } from '../../../src/server/engine/view';
import { loadEavRegistry } from '../../../src/server/objects/workspace/eav';
import { apply, ctx, defineProperty, inWorkspace, seedPage } from '../eav/helpers';
import type { WorkspaceClient } from '../../../src/server/db/workspace.client';

const opt = (id: string, name = id) => ({ id, name, color: 'default' as const });
const PROPS: PropertyDef[] = [
	{ id: 'stage', name: 'Stage', type: 'status', config: { options: [], groups: [] } },
	{ id: 'tags', name: 'Tags', type: 'multi_select', config: { options: [opt('a', 'Alpha'), opt('b', 'Beta'), opt('c', 'Gamma')] } },
	{ id: 'owner', name: 'Owner', type: 'person', config: {} },
	{ id: 'done', name: 'Done', type: 'checkbox', config: {} },
	{ id: 'due', name: 'Due', type: 'date', config: { includeTime: false } },
	{ id: 'proj', name: 'Project', type: 'relation', config: { limit: 'one' } }
];

async function board(db: WorkspaceClient): Promise<number[]> {
	for (let i = 1; i <= 8; i++) await seedPage(db, `p${i}`, i);
	for (const p of PROPS) await defineProperty(db, p);
	const set = (page: string, prop: string, value: unknown) => ({ op: 'setProp', page, prop, value }) as never;
	await apply(db, [
		set('p1', 'stage', 'not_started'),
		set('p2', 'stage', 'in_progress'),
		set('p3', 'stage', 'done'),
		set('p4', 'stage', 'not_started'),
		set('p5', 'stage', 'done'),
		set('p1', 'tags', ['a', 'b']),
		set('p2', 'tags', ['b']),
		set('p1', 'owner', ['u1', 'u2']),
		set('p2', 'owner', ['u2']),
		set('p1', 'done', true),
		set('p2', 'done', false),
		set('p1', 'due', { start: '2026-11-02' }),
		set('p2', 'due', { start: '2026-11-08' }),
		set('p3', 'due', { start: '2026-11-09' }),
		set('p4', 'due', { start: '2027-01-01' }),
		set('p1', 'proj', ['p6']),
		set('p2', 'proj', ['p6']),
		set('p3', 'proj', ['p7']),
		set('p4', 'proj', ['p8']),
		set('p6', 'title', 'Six'),
		set('p7', 'title', 'Seven')
	]);
	return [1, 2, 3, 4, 5, 6, 7, 8];
}

const group = async (db: WorkspaceClient, groupBy: GroupBySpec, visible: number[], extra: object = {}) => {
	const r = await runQuery(db, { groupBy, sorts: [{ prop: 'title', dir: 'asc' }] }, { visible, now: ctx.now, ...extra });
	return (r.groups ?? []).map((g) => [g.key, g.total, g.rows.map((x) => x.id)] as const);
};

describe('boards', () => {
	test('status: by option, by group (To-do, In progress, Complete), with counts and per-group windows', async () => {
		await inWorkspace(async (_state, db) => {
			const visible = await board(db);
			const byOption = await group(db, { prop: 'stage' }, visible);
			expect(byOption).toEqual([
				['not_started', 2, ['p1', 'p4']],
				['in_progress', 1, ['p2']],
				['done', 2, ['p3', 'p5']],
				['$empty', 3, ['p7', 'p6', 'p8']]
			]);
			const byGroup = await group(db, { prop: 'stage', by: 'group' }, visible);
			expect(byGroup).toEqual([
				['todo', 2, ['p1', 'p4']],
				['in_progress', 1, ['p2']],
				['complete', 2, ['p3', 'p5']],
				['$empty', 3, ['p7', 'p6', 'p8']]
			]);
			// Each group has its own window, and its total counts every page of the group.
			const windowed = await runQuery(db, { groupBy: { prop: 'stage', by: 'group' } }, { visible, now: ctx.now, window: { limit: 1 }, groupWindows: { complete: { offset: 1, limit: 5 }, $empty: { limit: 2 } } });
			expect(windowed.groups?.map((g) => [g.key, g.total, g.rows.length])).toEqual([['todo', 2, 1], ['in_progress', 1, 1], ['complete', 2, 1], ['$empty', 3, 2]]);
			expect(windowed.total).toBe(8);
		});
	});

	test('hidden groups, group order and the placement of "No value"', async () => {
		await inWorkspace(async (_state, db) => {
			const visible = await board(db);
			const keys = async (spec: GroupBySpec) => (await group(db, spec, visible)).map(([k]) => k);
			expect(await keys({ prop: 'stage', by: 'group', hidden: ['in_progress', '$empty'] })).toEqual(['todo', 'complete']);
			expect(await keys({ prop: 'stage', by: 'group', order: ['complete', '$empty', 'todo'] })).toEqual(['complete', '$empty', 'todo', 'in_progress']);
			expect(await keys({ prop: 'stage', order: ['$empty'] })).toEqual(['$empty', 'not_started', 'in_progress', 'done']);
			// asc / desc sort by option name: Done, In progress, Not started.
			expect(await keys({ prop: 'stage', sort: 'asc' })).toEqual(['done', 'in_progress', 'not_started', '$empty']);
			expect(await keys({ prop: 'stage', hideEmpty: true })).toEqual(['not_started', 'in_progress', 'done']);
			// Nobody in the empty group: it is not listed.
			expect((await group(db, { prop: 'stage' }, [1, 2, 3])).map(([k]) => k)).toEqual(['not_started', 'in_progress', 'done']);
			// Hidden groups remove their pages from the board, not from the total.
			const r = await runQuery(db, { groupBy: { prop: 'stage', hidden: ['done'] } }, { visible, now: ctx.now });
			expect(r.total).toBe(8);
			expect(r.groups?.some((g) => g.key === 'done')).toBe(false);
		});
	});

	test('multi-select pages appear in every group; people, checkboxes, relations and date buckets', async () => {
		await inWorkspace(async (_state, db) => {
			const visible = await board(db);
			expect(await group(db, { prop: 'tags' }, visible)).toEqual([
				['a', 1, ['p1']],
				['b', 2, ['p1', 'p2']],
				['c', 0, []],
				['$empty', 6, ['p7', 'p6', 'p3', 'p4', 'p5', 'p8']]
			]);
			expect(await group(db, { prop: 'owner' }, visible)).toEqual([
				['u1', 1, ['p1']],
				['u2', 2, ['p1', 'p2']],
				['$empty', 6, ['p7', 'p6', 'p3', 'p4', 'p5', 'p8']]
			]);
			expect((await group(db, { prop: 'done' }, visible)).map(([k, n]) => [k, n])).toEqual([['false', 7], ['true', 1]]);
			expect(await group(db, { prop: 'proj' }, visible)).toEqual([
				['p6', 2, ['p1', 'p2']],
				['p7', 1, ['p3']],
				['p8', 1, ['p4']],
				['$empty', 4, ['p7', 'p6', 'p5', 'p8']]
			]);
			expect((await group(db, { prop: 'due', bucket: 'week' }, visible)).map(([k, n]) => [k, n])).toEqual([['2026-11-02', 2], ['2026-11-09', 1], ['2026-12-28', 1], ['$empty', 4]]);
			expect((await group(db, { prop: 'due', bucket: 'month', sort: 'desc' }, visible)).map(([k, n]) => [k, n])).toEqual([['2027-01-01', 1], ['2026-11-01', 3], ['$empty', 4]]);
			expect((await group(db, { prop: 'due', bucket: 'year' }, visible)).map(([k, n]) => [k, n])).toEqual([['2026-01-01', 3], ['2027-01-01', 1], ['$empty', 4]]);
			// A relation to a trashed page is no group (and the page itself is gone): its holders move to "No value".
			await db.$executeRawUnsafe("UPDATE page SET deleted_at = '2026-01-02T00:00:00Z', trash_root = 'p6' WHERE id = 'p6'");
			expect((await group(db, { prop: 'proj' }, visible)).map(([k, n]) => [k, n])).toEqual([['p7', 1], ['p8', 1], ['$empty', 5]]);
		});
	});

	test('groupKeysOf: the groups of one page, or of many, as the live loop asks', async () => {
		await inWorkspace(async (_state, db) => {
			await board(db);
			const now = ctx.now;
			expect(await groupKeysOf(db, { prop: 'tags' }, 1, { now })).toEqual(['a', 'b']);
			expect(await groupKeysOf(db, { prop: 'tags' }, 3, { now })).toEqual(['$empty']);
			expect(await groupKeysOf(db, { prop: 'stage', by: 'group' }, 3, { now })).toEqual(['complete']);
			expect(await groupKeysOf(db, { prop: 'due', bucket: 'month' }, 1, { now })).toEqual(['2026-11-01']);
			const many = await groupKeysOf(db, { prop: 'owner' }, [1, 2, 3], { now });
			expect([...many]).toEqual([[1, ['u1', 'u2']], [2, ['u2']], [3, ['$empty']]]);
			// A write moves the page: before and after.
			await apply(db, [{ op: 'setProp', page: 'p3', prop: 'stage', value: 'not_started' } as never]);
			expect(await groupKeysOf(db, { prop: 'stage', by: 'group' }, 3, { now })).toEqual(['todo']);
			// Raw keys include hidden groups; `orderGroups` is what a view lists.
			const spec: GroupBySpec = { prop: 'stage', by: 'group', hidden: ['todo'] };
			expect(await groupKeysOf(db, spec, 3, { now })).toEqual(['todo']);
			const registry = await loadEavRegistry(db);
			expect(orderGroups(registry.get('stage') as PropertyDef, spec, new Map([['todo', 3], ['complete', 1]]))).toEqual(['in_progress', 'complete']);
			// An unknown property is one group.
			expect(await groupKeysOf(db, { prop: 'ghost' }, 1, { now })).toEqual(['$empty']);
		});
	});

	test('a saved view carries its group spec; queryView lists the groups with rows', async () => {
		await inWorkspace(async (state, db) => {
			await board(db);
			await apply(db, [{ op: 'createCollection', id: 'col', pageId: 'p8', sourceAst: { and: [] } } as never]);
			const groupBy: GroupBySpec = { prop: 'stage', by: 'group', hidden: ['in_progress'], order: ['complete', '$empty'], sort: 'manual', hideEmpty: false };
			await apply(db, [{ op: 'createView', id: 'board', collectionId: 'col', type: 'board', name: 'Board', groupBy, rank: evenRanks(1)[0] } as never]);
			const out = await queryViewRows(
				db,
				{ collectionId: 'col', viewId: 'board', window: { limit: 2 }, groupWindows: { $empty: { limit: 1 } }, props: ['stage', 'proj'] },
				{ userId: 'u1', visible: [1, 2, 3, 4, 5, 6, 7, 8], seq: 1, now: ctx.now }
			);
			expect(out.groups?.map((g) => [g.key, g.total, g.rows.length])).toEqual([['complete', 2, 2], ['$empty', 3, 1], ['todo', 2, 2]]);
			expect(out.props.group).toEqual(['stage']);
			// A bad group spec is refused with a path.
			let failed: unknown;
			try {
				await apply(db, [{ op: 'updateView', id: 'board', groupBy: { prop: 'stage', hidden: ['a', 'a'] } } as never]);
			} catch (e) {
				failed = e;
			}
			expect(failed).toMatchObject({ code: 'invalid_query' });
			void state;
		});
	});
});
