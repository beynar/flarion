/**
 * Relations, rollups, formulas and the dependency graph, through the real write path: `applyEavOp` for every op,
 * then `afterWrite` with their records, exactly as the Sync core's `apply()` runs them.
 */
import { describe, expect, test } from 'vitest';
import { analyzeFormula } from '../../../src/lib/shared/formula';
import type { PropertyDef } from '../../../src/lib/shared/property-types';
import { evenRanks } from '../../../src/lib/shared/sort-keys';
import { runQuery } from '../../../src/server/engine';
import { afterWrite, isEavError, readProperties, readValues, recomputeNowFormulas, usesNow, type ChangeRecord } from '../../../src/server/objects/workspace/eav';
import { apply, ctx, defineProperty, inWorkspace, rows, seedPage } from './helpers';
import type { WorkspaceClient } from '../../../src/server/db/workspace.client';

const opt = (id: string, name = id.toUpperCase()) => ({ id, name, color: 'default' as const });

const AMOUNT: PropertyDef = { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } };
const DONE: PropertyDef = { id: 'done', name: 'Done', type: 'checkbox', config: {} };
const DUE: PropertyDef = { id: 'due', name: 'Due', type: 'date', config: { includeTime: false } };
const PRIO: PropertyDef = { id: 'prio', name: 'Priority', type: 'select', config: { options: [opt('hi', 'High'), opt('lo', 'Low')] } };
const TAGS: PropertyDef = { id: 'tags', name: 'Tags', type: 'multi_select', config: { options: [opt('a', 'Alpha'), opt('b', 'Beta'), opt('c', 'Gamma')] } };
const REL: PropertyDef = { id: 'rel', name: 'Children', type: 'relation', config: { limit: 'many', twoWay: true, reverseName: 'Parents' } };
const REL1: PropertyDef = { id: 'rel1', name: 'Owner page', type: 'relation', config: { limit: 'one' } };

const rollup = (id: string, fn: string, targetProp: string, relationProp = 'rel', name = id): PropertyDef =>
	({ id, name, type: 'rollup', config: { relationProp, targetProp, fn, resultType: 'number' } }) as PropertyDef;
const formula = (id: string, expression: string, name = id): PropertyDef =>
	({ id, name, type: 'formula', config: { expression, resultType: 'text' } }) as PropertyDef;

async function pages(db: WorkspaceClient, n: number): Promise<void> {
	for (let i = 1; i <= n; i++) await seedPage(db, `p${i}`, i);
}

/** A page created after the properties: the Sync core's `create` record seeds its computed values. */
async function createPage(db: WorkspaceClient, id: string, num: number): Promise<ChangeRecord[]> {
	await seedPage(db, id, num);
	return db.$transaction((tx) => afterWrite(tx, [{ kind: 'create', page: id, prop: null, old: null, new: null }], ctx));
}

const set = (db: WorkspaceClient, page: string, prop: string, value: unknown) => apply(db, [{ op: 'setProp', page, prop, value } as never]);
const values = async (db: WorkspaceClient, id: string) => (await readValues(db, [id])).get(id) ?? {};

/** Marks a page (and, for the test, nothing else) as in the trash / restores it, with the records the Sync core emits. */
async function trash(db: WorkspaceClient, id: string): Promise<ChangeRecord[]> {
	await db.$executeRawUnsafe("UPDATE page SET deleted_at = '2026-01-10T00:00:00.000Z', trash_root = ? WHERE id = ?", id, id);
	return db.$transaction((tx) => afterWrite(tx, [{ kind: 'trash', page: id, prop: null, old: null, new: null }], ctx));
}
async function restore(db: WorkspaceClient, id: string): Promise<ChangeRecord[]> {
	await db.$executeRawUnsafe('UPDATE page SET deleted_at = NULL, trash_root = NULL WHERE id = ?', id);
	return db.$transaction((tx) => afterWrite(tx, [{ kind: 'restore', page: id, prop: null, old: null, new: null }], ctx));
}

async function failure(run: () => Promise<unknown>): Promise<{ code: string; message: string; paths: string[] }> {
	try {
		await run();
	} catch (e) {
		if (isEavError(e)) return { code: e.code, message: e.message, paths: e.issues.map((i) => i.path) };
		throw e;
	}
	throw new Error('expected the operation to fail');
}

describe('two-way relations', () => {
	test('the reverse side is a synthetic property computed by a range scan; no mirrored rows are stored', async () => {
		await inWorkspace(async (state, db) => {
			await pages(db, 4);
			await defineProperty(db, REL);
			const list = await readProperties(db);
			expect(list.find((p) => p.id === 'rel:reverse')).toMatchObject({ name: 'Parents', type: 'relation', config: { reverseOf: 'rel', limit: 'many' } });

			await set(db, 'p1', 'rel', ['p3']);
			await set(db, 'p2', 'rel', ['p3', 'p4']);
			// One row per relation value, none for the reverse side.
			expect(rows(state, 'SELECT prop, v, page FROM p_ref ORDER BY page, v')).toEqual([
				{ prop: 1, v: '3', page: 1 },
				{ prop: 1, v: '3', page: 2 },
				{ prop: 1, v: '4', page: 2 }
			]);
			expect((await values(db, 'p3'))['rel:reverse']).toEqual(['p1', 'p2']);
			expect((await values(db, 'p4'))['rel:reverse']).toEqual(['p2']);
			expect((await values(db, 'p1'))['rel:reverse']).toBeUndefined();

			// The engine reads it the same way: contains, is empty, grouping.
			const visible = [1, 2, 3, 4];
			const q = (filter: object) => runQuery(db, { filter } as never, { visible, now: ctx.now });
			expect((await q({ and: [{ prop: 'rel:reverse', op: 'contains', value: 'p2' }] })).rows.map((r) => r.id)).toEqual(['p3', 'p4']);
			expect((await q({ and: [{ prop: 'rel:reverse', op: 'is_not_empty' }] })).rows.map((r) => r.id)).toEqual(['p3', 'p4']);
			expect((await q({ and: [{ prop: 'rel:reverse', op: 'is_empty' }] })).rows.map((r) => r.id)).toEqual(['p1', 'p2']);
			expect((await q({ and: [{ prop: 'rel:reverse', op: 'not_contains', value: 'p1' }] })).rows.map((r) => r.id)).toEqual(['p1', 'p2', 'p4']);
			const grouped = await runQuery(db, { groupBy: { prop: 'rel:reverse' } }, { visible, now: ctx.now });
			expect(grouped.groups?.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
				['p1', ['p3']],
				['p2', ['p3', 'p4']],
				['$empty', ['p1', 'p2']]
			]);
		});
	});

	test('the reverse side is read-only, cannot be deleted or used as an id, and renames follow', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 2);
			await defineProperty(db, REL);
			expect((await failure(() => set(db, 'p1', 'rel:reverse', ['p2']))).code).toBe('read_only');
			expect((await failure(() => apply(db, [{ op: 'deleteProperty', id: 'rel:reverse' }]))).code).toBe('read_only');
			expect((await failure(() => apply(db, [{ op: 'updateProperty', id: 'rel:reverse', name: 'X' }]))).code).toBe('read_only');
			expect((await failure(() => defineProperty(db, { id: 'x:reverse', name: 'X', type: 'text', config: {} }))).code).toBe('reserved_id');
			expect((await failure(() => defineProperty(db, { id: 'y', name: 'Y', type: 'relation', config: { reverseOf: 'rel' } } as never))).code).toBe('invalid_config');
			const long = 'r'.repeat(60);
			expect((await failure(() => defineProperty(db, { id: long, name: 'Long', type: 'relation', config: { twoWay: true } } as never))).code).toBe('invalid_config');

			await apply(db, [{ op: 'updateProperty', id: 'rel', name: 'Subtasks' }]);
			expect((await readProperties(db)).find((p) => p.id === 'rel:reverse')?.name).toBe('Parents');
			await apply(db, [{ op: 'updateProperty', id: 'rel', config: { limit: 'many', twoWay: true } }]);
			expect((await readProperties(db)).find((p) => p.id === 'rel:reverse')?.name).toBe('Subtasks (reverse)');
			await apply(db, [{ op: 'updateProperty', id: 'rel', config: { limit: 'many' } }]);
			expect((await readProperties(db)).some((p) => p.id === 'rel:reverse')).toBe(false);
		});
	});
});

describe('relations to tombstones', () => {
	test('a to-one relation to a trashed page reads null; to-many drops it; a restore is lossless', async () => {
		await inWorkspace(async (state, db) => {
			await pages(db, 4);
			await defineProperty(db, REL);
			await defineProperty(db, REL1);
			await set(db, 'p1', 'rel1', ['p2']);
			await set(db, 'p1', 'rel', ['p2', 'p3']);
			await set(db, 'p4', 'rel', ['p2']);
			expect((await values(db, 'p1')).rel1).toEqual(['p2']);

			await trash(db, 'p2');
			const v1 = await values(db, 'p1');
			expect(v1.rel1).toBeNull();
			expect(v1.rel).toEqual(['p3']);
			expect((await values(db, 'p4')).rel).toBeNull();
			// The rows and props_json keep the id.
			expect(rows(state, 'SELECT v FROM p_ref WHERE page = 1 AND prop = 2').length).toBe(1);
			expect(JSON.parse(rows<{ props_json: string }>(state, "SELECT props_json FROM page WHERE id = 'p1'")[0].props_json).rel1).toEqual(['p2']);

			// The engine honours it: is empty, is not empty, contains.
			const visible = [1, 2, 3, 4];
			const q = async (filter: object) => (await runQuery(db, { filter } as never, { visible, now: ctx.now })).rows.map((r) => r.id);
			expect(await q({ and: [{ prop: 'rel1', op: 'is_empty' }] })).toEqual(['p1', 'p3', 'p4']);
			expect(await q({ and: [{ prop: 'rel1', op: 'is_not_empty' }] })).toEqual([]);
			expect(await q({ and: [{ prop: 'rel', op: 'contains', value: 'p2' }] })).toEqual([]);
			expect(await q({ and: [{ prop: 'rel', op: 'not_contains', value: 'p2' }] })).toEqual(['p1', 'p3', 'p4']);
			expect(await q({ and: [{ prop: 'rel', op: 'is_empty' }] })).toEqual(['p3', 'p4']);
			expect(await q({ and: [{ prop: 'rel', op: 'contains', value: 'p3' }] })).toEqual(['p1']);
			const grouped = await runQuery(db, { groupBy: { prop: 'rel' } }, { visible, now: ctx.now });
			expect(grouped.groups?.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
				['p3', ['p1']],
				['$empty', ['p3', 'p4']]
			]);
			// A trashed holder is no holder: the reverse side skips it.
			await trash(db, 'p1');
			expect((await values(db, 'p3'))['rel:reverse']).toBeUndefined();

			await restore(db, 'p1');
			await restore(db, 'p2');
			expect((await values(db, 'p1')).rel1).toEqual(['p2']);
			expect((await values(db, 'p1')).rel).toEqual(['p2', 'p3']);
			expect(await q({ and: [{ prop: 'rel', op: 'contains', value: 'p2' }] })).toEqual(['p1', 'p4']);
			expect((await values(db, 'p3'))['rel:reverse']).toEqual(['p1']);
		});
	});
});

describe('rollups', () => {
	async function fixture(db: WorkspaceClient) {
		await pages(db, 5);
		for (const p of [AMOUNT, DONE, DUE, PRIO, TAGS, REL]) await defineProperty(db, p);
		await apply(db, [
			{ op: 'setProp', page: 'p2', prop: 'amount', value: 10 },
			{ op: 'setProp', page: 'p3', prop: 'amount', value: 4 },
			{ op: 'setProp', page: 'p4', prop: 'amount', value: 4 },
			{ op: 'setProp', page: 'p2', prop: 'done', value: true },
			{ op: 'setProp', page: 'p3', prop: 'done', value: false },
			{ op: 'setProp', page: 'p2', prop: 'due', value: { start: '2026-03-10' } },
			{ op: 'setProp', page: 'p3', prop: 'due', value: { start: '2026-03-01', end: '2026-03-04' } },
			{ op: 'setProp', page: 'p4', prop: 'due', value: { start: '2026-03-08', end: '2026-03-20' } },
			{ op: 'setProp', page: 'p2', prop: 'prio', value: 'hi' },
			{ op: 'setProp', page: 'p3', prop: 'prio', value: 'lo' },
			{ op: 'setProp', page: 'p4', prop: 'prio', value: 'hi' },
			{ op: 'setProp', page: 'p2', prop: 'tags', value: ['a', 'b'] },
			{ op: 'setProp', page: 'p3', prop: 'tags', value: ['b'] },
			{ op: 'setProp', page: 'p2', prop: 'title', value: 'Two' },
			{ op: 'setProp', page: 'p3', prop: 'title', value: 'Three' },
			{ op: 'setProp', page: 'p1', prop: 'rel', value: ['p2', 'p3', 'p4', 'p5'] }
		]);
	}

	const CASES: [string, string, string, unknown][] = [
		['count_all', 'amount', 'number', 4],
		['count_values', 'amount', 'number', 3],
		['not_empty', 'amount', 'number', 3],
		['empty', 'amount', 'number', 1],
		['count_unique', 'amount', 'number', 2],
		['count_unique', 'tags', 'number', 2],
		['percent_empty', 'amount', 'number', 25],
		['percent_not_empty', 'amount', 'number', 75],
		['sum', 'amount', 'number', 18],
		['average', 'amount', 'number', 6],
		['median', 'amount', 'number', 4],
		['min', 'amount', 'number', 4],
		['max', 'amount', 'number', 10],
		['range', 'amount', 'number', 6],
		['checked', 'done', 'number', 1],
		['unchecked', 'done', 'number', 3],
		['percent_checked', 'done', 'number', 25],
		['percent_unchecked', 'done', 'number', 75],
		['earliest', 'due', 'date', { start: '2026-03-01' }],
		['latest', 'due', 'date', { start: '2026-03-10' }],
		['date_range', 'due', 'date', { start: '2026-03-01', end: '2026-03-20' }],
		['show_unique', 'prio', 'text', 'High, Low'],
		['show_original', 'prio', 'text', 'High, Low, High'],
		['show_unique', 'tags', 'text', 'Alpha, Beta'],
		['show_original', 'title', 'text', 'Two, Three']
	];

	test('every function computes, stored in the table of its result type', async () => {
		await inWorkspace(async (state, db) => {
			await fixture(db);
			for (const [i, [fn, target, resultType]] of CASES.entries()) await defineProperty(db, rollup(`r${i}`, fn, target));
			const got = await values(db, 'p1');
			for (const [i, [fn, target, resultType, expected]] of CASES.entries()) {
				expect(got[`r${i}`], `${fn}(${target})`).toEqual(expected);
				const def = (await readProperties(db)).find((p) => p.id === `r${i}`);
				expect((def?.config as { resultType: string }).resultType).toBe(resultType);
			}
			// Result types pick the table: numbers in p_num, dates in p_date, text in p_text.
			const tables = (t: string) => rows<{ n: number }>(state, `SELECT COUNT(*) AS n FROM ${t} WHERE computed = 1`)[0].n;
			expect(tables('p_num')).toBeGreaterThan(0);
			expect(tables('p_date')).toBeGreaterThan(0);
			expect(tables('p_text')).toBeGreaterThan(0);
			// The other pages relate to nothing: counts are 0, aggregates of nothing are empty.
			const none = await values(db, 'p2');
			expect(none.r0).toBe(0);
			expect(none.r8).toBe(0);
			expect(none.r10).toBeUndefined();
		});
	});

	test('a rollup follows its sources: value edits, relation edits, trash and restore of a related page', async () => {
		await inWorkspace(async (_state, db) => {
			await fixture(db);
			await defineProperty(db, rollup('total', 'sum', 'amount'));
			await defineProperty(db, rollup('n', 'count_all', 'amount'));
			const total = async () => (await values(db, 'p1')).total;
			expect(await total()).toBe(18);

			// A value edit on a related page: one record per changed dependent.
			const edit = await set(db, 'p2', 'amount', 11);
			expect(edit.map((c) => [c.page, c.prop, c.old, c.new])).toEqual([
				['p2', 'amount', 10, 11],
				['p1', 'total', 18, 19]
			]);
			expect(await total()).toBe(19);
			// A write that changes nothing the rollup reads writes nothing.
			expect((await set(db, 'p2', 'done', false)).map((c) => c.prop)).toEqual(['done']);

			// Relation edits, both directions.
			await set(db, 'p1', 'rel', ['p2', 'p3']);
			expect(await total()).toBe(15);
			await apply(db, [{ op: 'addOption', page: 'p1', prop: 'rel', option: 'p4' }]);
			expect(await total()).toBe(19);
			await set(db, 'p5', 'rel', ['p3']);
			expect((await values(db, 'p5')).total).toBe(4);

			// Trashing a related page removes it from the sum, restoring it brings it back; the records flow out.
			const out = await trash(db, 'p4');
			expect(out.map((c) => [c.page, c.prop, c.old, c.new])).toEqual([
				['p1', 'total', 19, 15],
				['p1', 'n', 3, 2]
			]);
			expect(await total()).toBe(15);
			const back = await restore(db, 'p4');
			expect(back.map((c) => c.prop).sort()).toEqual(['n', 'total']);
			expect(await total()).toBe(19);
			// The page itself can be the one in the trash: its rollup is kept (a restore is lossless).
			await trash(db, 'p1');
			await set(db, 'p3', 'amount', 5);
			await restore(db, 'p1');
			expect(await total()).toBe(20);
		});
	});

	test('a rollup over the reverse side of a two-way relation', async () => {
		await inWorkspace(async (_state, db) => {
			await fixture(db);
			await defineProperty(db, rollup('back', 'sum', 'amount', 'rel:reverse'));
			await defineProperty(db, rollup('backCount', 'count_all', 'title', 'rel:reverse'));
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'amount', value: 100 }]);
			// p2, p3, p4, p5 are children of p1: p1 is their parent, the reverse side holds p1.
			expect((await values(db, 'p2')).back).toBe(100);
			expect((await values(db, 'p5')).back).toBe(100);
			expect((await values(db, 'p1')).back).toBe(0);
			// Changing the relation updates the pages that left AND the pages that joined.
			await set(db, 'p1', 'rel', ['p2']);
			expect((await values(db, 'p2')).back).toBe(100);
			expect((await values(db, 'p3')).back).toBe(0);
			expect((await values(db, 'p3')).backCount).toBe(0);
			await set(db, 'p2', 'rel', ['p3']);
			expect((await values(db, 'p3')).back).toBe(10);
			// Trashing the holder removes it from the reverse side.
			await trash(db, 'p2');
			expect((await values(db, 'p3')).back).toBe(0);
		});
	});

	test('definitions are checked: relation, target, function, result type', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 2);
			for (const p of [AMOUNT, DONE, PRIO, REL]) await defineProperty(db, p);
			expect((await failure(() => defineProperty(db, rollup('x', 'sum', 'amount', 'amount')))).paths).toEqual(['/property/config/relationProp']);
			expect((await failure(() => defineProperty(db, rollup('x', 'sum', 'ghost')))).code).toBe('unknown_property');
			expect((await failure(() => defineProperty(db, rollup('x', 'sum', 'prio')))).paths).toEqual(['/property/config/fn']);
			expect((await failure(() => defineProperty(db, rollup('x', 'checked', 'amount')))).paths).toEqual(['/property/config/fn']);
			expect((await failure(() => defineProperty(db, rollup('x', 'count_all', 'rel')))).paths).toEqual(['/property/config/targetProp']);
			// The result type follows from the function, whatever the client said.
			await defineProperty(db, { id: 'ok', name: 'OK', type: 'rollup', config: { relationProp: 'rel', targetProp: 'amount', fn: 'show_original', resultType: 'number' } });
			expect((await readProperties(db)).find((p) => p.id === 'ok')?.config).toMatchObject({ resultType: 'text' });
		});
	});
});

describe('formulas', () => {
	test('analyze on create, the result type picks the storage table, values are computed rows', async () => {
		await inWorkspace(async (state, db) => {
			await pages(db, 3);
			for (const p of [AMOUNT, DONE, PRIO, DUE]) await defineProperty(db, p);
			await apply(db, [
				{ op: 'setProp', page: 'p1', prop: 'amount', value: 20 },
				{ op: 'setProp', page: 'p2', prop: 'amount', value: 3 },
				{ op: 'setProp', page: 'p1', prop: 'prio', value: 'hi' },
				{ op: 'setProp', page: 'p1', prop: 'due', value: { start: '2026-02-01' } }
			]);
			await defineProperty(db, { id: 'double', name: 'Double', type: 'formula', config: { expression: 'prop("Amount") * 2', resultType: 'text' } });
			await defineProperty(db, { id: 'big', name: 'Big', type: 'formula', config: { expression: 'prop("Amount") >= 10', resultType: 'number' } });
			await defineProperty(db, { id: 'label', name: 'Label', type: 'formula', config: { expression: 'prop("Priority") + " " + format(prop("Amount"))', resultType: 'number' } });
			await defineProperty(db, { id: 'when', name: 'When', type: 'formula', config: { expression: 'prop("Due")', resultType: 'text' } });

			// The client's resultType is advisory: the analysis decides.
			const defs = await readProperties(db);
			const cfg = (id: string) => (defs.find((p) => p.id === id)?.config as { resultType: string }).resultType;
			expect([cfg('double'), cfg('big'), cfg('label'), cfg('when')]).toEqual(['number', 'checkbox', 'text', 'date']);

			expect(await values(db, 'p1')).toMatchObject({ double: 40, big: true, label: 'High 20', when: { start: '2026-02-01' } });
			expect(await values(db, 'p2')).toMatchObject({ double: 6, big: false, label: ' 3' });
			// Empty inputs read as 0 / empty: the third page has no amount at all.
			expect((await values(db, 'p3')).double).toBe(0);
			expect(rows(state, 'SELECT prop, v, page, computed FROM p_num WHERE prop = 1 ORDER BY page')).toEqual([{ prop: 1, v: 20, page: 1, computed: 0 }, { prop: 1, v: 3, page: 2, computed: 0 }]);
			expect(rows<{ page: number; v: number }>(state, 'SELECT page, v FROM p_num WHERE prop = 5 AND computed = 1 ORDER BY page')).toEqual([
				{ page: 1, v: 40 },
				{ page: 2, v: 6 },
				{ page: 3, v: 0 }
			]);
			expect(rows(state, 'SELECT page, v FROM p_num WHERE prop = 6 AND computed = 1 ORDER BY page')).toEqual([
				{ page: 1, v: 1 },
				{ page: 2, v: 0 },
				{ page: 3, v: 0 }
			]);
			expect(rows(state, 'SELECT page, v FROM p_text WHERE prop = 7 AND computed = 1 ORDER BY page').length).toBe(3);
			expect(rows(state, 'SELECT page, v FROM p_date WHERE prop = 8 AND computed = 1')).toHaveLength(1);

			// A new page gets its values from the create record; an edit recomputes the page.
			await createPage(db, 'p4', 4);
			expect((await values(db, 'p4')).double).toBe(0);
			const edit = await set(db, 'p4', 'amount', 7);
			// `big` stays false: only values that change are written.
			expect(edit.map((c) => c.prop).sort()).toEqual(['amount', 'double', 'label']);
			expect((await values(db, 'p4')).double).toBe(14);
		});
	});

	test('type errors and syntax errors are refused with a clear message', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 1);
			await defineProperty(db, AMOUNT);
			const bad = async (expression: string) =>
				failure(() => defineProperty(db, { id: 'f', name: 'F', type: 'formula', config: { expression, resultType: 'text' } }));
			const syntax = await bad('prop("Amount") +');
			expect(syntax.code).toBe('invalid_formula');
			expect(syntax.paths).toEqual(['/property/config/expression']);
			const unknown = await bad('prop("Nope") + 1');
			expect(unknown.message).toContain('Unknown property "Nope"');
			expect(unknown.message).toContain('line 1, column');
			expect((await bad('prop("Amount") and 1')).message).toMatch(/checkbox/);
			expect((await bad('foo(1)')).message).toContain('Unknown function "foo"');
			// Nothing was created.
			expect((await readProperties(db)).some((p) => p.id === 'f')).toBe(false);
		});
	});

	test('updating the expression recomputes; a new result type moves the rows to another table', async () => {
		await inWorkspace(async (state, db) => {
			await pages(db, 2);
			await defineProperty(db, AMOUNT);
			await apply(db, [
				{ op: 'setProp', page: 'p1', prop: 'amount', value: 5 },
				{ op: 'setProp', page: 'p2', prop: 'amount', value: 8 }
			]);
			await defineProperty(db, { id: 'f', name: 'F', type: 'formula', config: { expression: 'prop("Amount") + 1', resultType: 'number' } });
			expect((await values(db, 'p1')).f).toBe(6);
			const changes = await apply(db, [{ op: 'updateProperty', id: 'f', config: { expression: 'prop("Amount") * 10', resultType: 'number' } }]);
			expect(changes.filter((c) => c.kind === 'setProp').map((c) => [c.page, c.old, c.new])).toEqual([['p1', 6, 50], ['p2', 9, 80]]);

			await apply(db, [{ op: 'updateProperty', id: 'f', config: { expression: 'format(prop("Amount")) + " pts"', resultType: 'number' } }]);
			expect((await readProperties(db)).find((p) => p.id === 'f')?.config).toMatchObject({ resultType: 'text' });
			expect(await values(db, 'p1')).toMatchObject({ f: '5 pts' });
			// The old rows are gone from p_num (prop 2 = f), the new ones are in p_text.
			expect(rows(state, 'SELECT * FROM p_num WHERE prop = 2')).toEqual([]);
			expect(rows(state, 'SELECT computed FROM p_text WHERE prop = 2')).toEqual([{ computed: 1 }, { computed: 1 }]);
			// An invalid update changes nothing.
			expect((await failure(() => apply(db, [{ op: 'updateProperty', id: 'f', config: { expression: 'prop("x"', resultType: 'text' } }]))).code).toBe('invalid_formula');
			expect(await values(db, 'p1')).toMatchObject({ f: '5 pts' });
		});
	});

	test('formulas read option names, relation titles and follow their renames', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 3);
			for (const p of [PRIO, TAGS, REL]) await defineProperty(db, p);
			await apply(db, [
				{ op: 'setProp', page: 'p1', prop: 'prio', value: 'hi' },
				{ op: 'setProp', page: 'p1', prop: 'tags', value: ['b', 'a'] },
				{ op: 'setProp', page: 'p2', prop: 'title', value: 'Two' },
				{ op: 'setProp', page: 'p3', prop: 'title', value: 'Three' },
				{ op: 'setProp', page: 'p1', prop: 'rel', value: ['p3', 'p2'] }
			]);
			await defineProperty(db, formula('f', 'prop("Priority") + ": " + join(prop("Tags"), "+") + " / " + join(prop("Children"), "|") + " / " + join(prop("Parents"), "|")'));
			expect((await values(db, 'p1')).f).toBe('High: Beta+Alpha / Three|Two / ');
			expect((await values(db, 'p2')).f).toBe(':  /  / ');
			// The title of a related page changed: the formula on the page that points at it follows (via the relation).
			await set(db, 'p2', 'title', 'Deux');
			expect((await values(db, 'p1')).f).toBe('High: Beta+Alpha / Three|Deux / ');
			// The reverse side is read by the pages it lists: p3's parents are the pages that point at it (p1, untitled).
			await set(db, 'p1', 'title', 'Root');
			await set(db, 'p3', 'title', 'Trois');
			expect((await values(db, 'p3')).f).toBe(':  /  / Root');
			expect((await values(db, 'p2')).f).toBe(':  /  / Root');

			// Option rename: the name is what the formula reads.
			await apply(db, [{ op: 'updateProperty', id: 'prio', config: { options: [opt('hi', 'Urgent'), opt('lo', 'Low')] } }]);
			expect((await values(db, 'p1')).f).toBe('Urgent: Beta+Alpha / Trois|Deux / ');
			// A trashed target drops out of the titles; restoring brings it back.
			await trash(db, 'p2');
			expect((await values(db, 'p1')).f).toBe('Urgent: Beta+Alpha / Trois / ');
			await restore(db, 'p2');
			expect((await values(db, 'p1')).f).toBe('Urgent: Beta+Alpha / Trois|Deux / ');

			// Renaming a property rewrites the formulas that read it by name.
			const changes = await apply(db, [{ op: 'updateProperty', id: 'prio', name: 'Urgency' }]);
			expect(changes.find((c) => c.prop === 'f')).toMatchObject({ kind: 'updateProperty' });
			expect(((await readProperties(db)).find((p) => p.id === 'f')?.config as { expression: string }).expression).toContain('prop("Urgency")');
			expect((await values(db, 'p1')).f).toBe('Urgent: Beta+Alpha / Trois|Deux / ');
		});
	});
});

describe('formulas that read the page stamps', () => {
	test('a formula over last-edited time follows every write to its page', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 2);
			await defineProperty(db, AMOUNT);
			await defineProperty(db, { id: 'edited', name: 'Edited', type: 'last_edited_time', config: {} });
			await defineProperty(db, { id: 'fe', name: 'Fe', type: 'formula', config: { expression: 'prop("Edited")', resultType: 'date' } });
			const t1 = { actorId: 'u1', now: Date.UTC(2026, 2, 1, 9, 30) };
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'amount', value: 1 }], t1);
			expect((await values(db, 'p1')).fe).toEqual({ start: '2026-03-01T09:30:00Z' });
			const t2 = { actorId: 'u1', now: Date.UTC(2026, 2, 5, 18, 0) };
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'amount', value: 2 }], t2);
			expect((await values(db, 'p1')).fe).toEqual({ start: '2026-03-05T18:00:00Z' });
			// Another page's write does not touch this one.
			await apply(db, [{ op: 'setProp', page: 'p2', prop: 'amount', value: 9 }], { actorId: 'u1', now: Date.UTC(2026, 2, 9) });
			expect((await values(db, 'p1')).fe).toEqual({ start: '2026-03-05T18:00:00Z' });
		});
	});
});

describe('the dependency graph', () => {
	const edges = (state: DurableObjectState) =>
		rows<{ source_prop: string; target_prop: string; via_relation: string }>(state, 'SELECT * FROM dependency ORDER BY target_prop, source_prop, via_relation').map((r) => `${r.source_prop}>${r.target_prop}@${r.via_relation}`);

	test('edges are built when a rollup or a formula is defined and updated, and removed with the property', async () => {
		await inWorkspace(async (state, db) => {
			await pages(db, 2);
			for (const p of [AMOUNT, REL]) await defineProperty(db, p);
			await defineProperty(db, rollup('r', 'sum', 'amount', 'rel', 'R'));
			await defineProperty(db, formula('f', 'prop("R") + prop("Amount")', 'F'));
			await defineProperty(db, { ...rollup('rb', 'count_all', 'title', 'rel:reverse'), name: 'RB' });
			expect(edges(state)).toEqual([
				// f reads r and amount on its own page
				'amount>f@',
				'r>f@',
				// r: the relation's membership on its own page, the target property through the relation
				'amount>r@rel',
				'rel>r@',
				// rb over the reverse side: membership through the reverse, titles through it
				'rel>rb@rel:reverse',
				'title>rb@rel:reverse'
			]);
			await apply(db, [{ op: 'updateProperty', id: 'f', config: { expression: 'prop("Amount")', resultType: 'number' } }]);
			expect(edges(state).filter((e) => e.includes('>f@'))).toEqual(['amount>f@']);
			await apply(db, [{ op: 'deleteProperty', id: 'f' }]);
			expect(edges(state).some((e) => e.includes('>f@'))).toBe(false);
		});
	});

	test('cycles are refused at definition time, whatever the path', async () => {
		await inWorkspace(async (state, db) => {
			await pages(db, 2);
			for (const p of [AMOUNT, REL]) await defineProperty(db, p);
			await defineProperty(db, formula('a', 'prop("Amount") + 1', 'A'));
			await defineProperty(db, formula('b', 'prop("A") + 1', 'B'));
			await defineProperty(db, formula('c', 'prop("B") + 1', 'C'));
			// a -> b -> c, and now a reads c.
			const loop = await failure(() => apply(db, [{ op: 'updateProperty', id: 'a', config: { expression: 'prop("C") + 1', resultType: 'number' } }]));
			expect(loop.code).toBe('cycle');
			expect(loop.message).toBe('/config: Circular dependency: A → B → C → A');
			// A property cannot read itself.
			const self = await failure(() => apply(db, [{ op: 'updateProperty', id: 'a', config: { expression: 'prop("A")', resultType: 'number' } }]));
			expect(self.message).toContain('A → A');
			// Through a relation: a rollup of a formula that reads that rollup.
			await defineProperty(db, rollup('r', 'sum', 'a', 'rel', 'R'));
			const viaRelation = await failure(() => apply(db, [{ op: 'updateProperty', id: 'a', config: { expression: 'prop("R")', resultType: 'number' } }]));
			expect(viaRelation.code).toBe('cycle');
			const rollupSelf = await failure(() => apply(db, [{ op: 'updateProperty', id: 'r', config: { relationProp: 'rel', targetProp: 'r', fn: 'sum', resultType: 'number' } }]));
			expect(rollupSelf.code).toBe('cycle');
			// Refused definitions leave the stored ones untouched.
			expect(((await readProperties(db)).find((p) => p.id === 'a')?.config as { expression: string }).expression).toBe('prop("Amount") + 1');
			expect(edges(state).filter((e) => e.endsWith('>a@'))).toEqual(['amount>a@']);
		});
	});

	test('chains recompute in dependency order, transitively; an unchanged value stops the chain', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 4);
			for (const p of [AMOUNT, REL]) await defineProperty(db, p);
			// double (formula) -> sum (rollup over rel) -> report (formula) -> best (rollup of report through rel)
			await defineProperty(db, formula('double', 'prop("Amount") * 2', 'Double'));
			await defineProperty(db, rollup('sum', 'sum', 'double', 'rel', 'Sum'));
			await defineProperty(db, formula('report', 'prop("Sum") + 1', 'Report'));
			await defineProperty(db, rollup('best', 'max', 'report', 'rel:reverse', 'Best'));
			await apply(db, [
				{ op: 'setProp', page: 'p2', prop: 'rel', value: ['p3', 'p4'] },
				{ op: 'setProp', page: 'p3', prop: 'amount', value: 5 },
				{ op: 'setProp', page: 'p4', prop: 'amount', value: 7 },
				{ op: 'setProp', page: 'p1', prop: 'rel', value: ['p2'] }
			]);
			const get = async (id: string) => values(db, id);
			expect(await get('p2')).toMatchObject({ sum: 24, report: 25 });
			// p1 points at p2, so p2's reverse side holds p1; p3 and p4 have p2 as parent: best of p3 = report of p2.
			expect((await get('p3')).best).toBe(25);
			expect((await get('p1')).sum).toBe(0);

			const edit = await set(db, 'p4', 'amount', 8);
			expect(edit.map((c) => `${c.page}.${c.prop}:${String(c.new)}`)).toEqual(['p4.amount:8', 'p4.double:16', 'p2.sum:26', 'p2.report:27', 'p3.best:27', 'p4.best:27']);
			expect((await get('p2')).report).toBe(27);

			// A write whose effect is absorbed (the new value gives the same sum) stops at the first unchanged value.
			const same = await apply(db, [
				{ op: 'setProp', page: 'p3', prop: 'amount', value: 6 },
				{ op: 'setProp', page: 'p4', prop: 'amount', value: 7 }
			]);
			expect(same.map((c) => `${c.page}.${c.prop}`)).toEqual(['p3.amount', 'p4.amount', 'p3.double', 'p4.double']);
			expect((await get('p2')).sum).toBe(26);

			// Moving p4 out of the relation updates the chain below and the page that lost it.
			const out = await set(db, 'p2', 'rel', ['p3']);
			expect(out.map((c) => `${c.page}.${c.prop}:${String(c.new)}`)).toEqual(['p2.rel:p3', 'p2.sum:12', 'p2.report:13', 'p3.best:13', 'p4.best:null']);
			expect((await get('p4')).best).toBeUndefined();
		});
	});

	test('properties that other properties read cannot be deleted; deleting the readers first works', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 2);
			for (const p of [AMOUNT, REL]) await defineProperty(db, p);
			await defineProperty(db, rollup('r', 'sum', 'amount', 'rel', 'R'));
			await defineProperty(db, formula('f', 'prop("R") * 2', 'F'));
			const refused = await failure(() => apply(db, [{ op: 'deleteProperty', id: 'amount' }]));
			expect(refused.code).toBe('in_use');
			expect(refused.message).toContain('"R"');
			expect((await failure(() => apply(db, [{ op: 'deleteProperty', id: 'rel' }]))).code).toBe('in_use');
			expect((await failure(() => apply(db, [{ op: 'deleteProperty', id: 'r' }]))).message).toContain('"F"');
			// Turning off two-way while something reads the reverse side is refused too.
			await defineProperty(db, rollup('back', 'count_all', 'title', 'rel:reverse', 'Back'));
			expect((await failure(() => apply(db, [{ op: 'updateProperty', id: 'rel', config: { limit: 'many' } }]))).code).toBe('in_use');
			await apply(db, [
				{ op: 'deleteProperty', id: 'f' },
				{ op: 'deleteProperty', id: 'r' },
				{ op: 'deleteProperty', id: 'back' },
				{ op: 'deleteProperty', id: 'amount' }
			]);
			expect((await readProperties(db)).map((p) => p.id)).not.toContain('amount');
		});
	});

	test('changing a formula result type is checked against the formulas that read it, and cascades', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 1);
			await defineProperty(db, AMOUNT);
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'amount', value: 4 }]);
			await defineProperty(db, formula('a', 'prop("Amount") + 1', 'A'));
			await defineProperty(db, formula('b', 'prop("A") + 1', 'B'));
			await defineProperty(db, formula('c', 'prop("A") * 2', 'C'));
			expect(await values(db, 'p1')).toMatchObject({ a: 5, b: 6, c: 10 });
			// a becomes text: b (text + 1 is text) follows, c (text * 2) would break: refused.
			const refused = await failure(() => apply(db, [{ op: 'updateProperty', id: 'a', config: { expression: 'format(prop("Amount"))', resultType: 'text' } }]));
			expect(refused.message).toContain('"C" would stop working');
			expect(await values(db, 'p1')).toMatchObject({ a: 5, b: 6, c: 10 });
			await apply(db, [{ op: 'deleteProperty', id: 'c' }]);
			await apply(db, [{ op: 'updateProperty', id: 'a', config: { expression: 'format(prop("Amount"))', resultType: 'text' } }]);
			expect(await values(db, 'p1')).toMatchObject({ a: '4', b: '41' });
			expect((await readProperties(db)).find((p) => p.id === 'b')?.config).toMatchObject({ resultType: 'text' });
		});
	});
});

describe('now formulas', () => {
	test('usesNow is transitive; the hourly recompute rewrites them and what depends on them', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 2);
			for (const p of [AMOUNT, REL]) await defineProperty(db, p);
			await defineProperty(db, formula('since', 'datebetween(now(), date("2026-01-01"), "days")', 'Since'));
			await defineProperty(db, formula('plain', 'prop("Amount") + 1', 'Plain'));
			await defineProperty(db, rollup('maxSince', 'max', 'since', 'rel', 'Max since'));
			await defineProperty(db, formula('chained', 'prop("Max since") + 1', 'Chained'));
			expect(await usesNow(db, 'since')).toBe(true);
			expect(await usesNow(db, 'maxSince')).toBe(true);
			expect(await usesNow(db, 'chained')).toBe(true);
			expect(await usesNow(db, 'plain')).toBe(false);
			expect(await usesNow(db, 'amount')).toBe(false);
			expect(await usesNow(db, 'missing')).toBe(false);
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'rel', value: ['p2'] }]);
			const before = await values(db, 'p1');
			expect(before.since).toBe(14);
			expect(before.chained).toBe(15);

			// Eight days later: both pages' `since`, the rollup and the chain over it move; `plain` does not.
			const later = { actorId: 'cron', now: ctx.now + 8 * 86_400_000 };
			const changes = await recomputeNowFormulas(db, later);
			expect(changes.map((c) => `${c.page}.${c.prop}:${String(c.new)}`).sort()).toEqual(['p1.chained:23', 'p1.maxSince:22', 'p1.since:22', 'p2.since:22']);
			expect((await values(db, 'p1')).since).toBe(22);
			// Nothing left to change at the same instant.
			expect(await recomputeNowFormulas(db, later)).toEqual([]);
			// Trashed pages are skipped (a restore recomputes them).
			await trash(db, 'p2');
			const again = await recomputeNowFormulas(db, { actorId: 'cron', now: later.now + 86_400_000 });
			expect(again.map((c) => c.page)).not.toContain('p2');
		});
	});

	test('a view cannot sort first by a formula that reads now()', async () => {
		await inWorkspace(async (_state, db) => {
			await pages(db, 1);
			await defineProperty(db, AMOUNT);
			await defineProperty(db, formula('since', 'datebetween(now(), date("2026-01-01"), "days")', 'Since'));
			await defineProperty(db, formula('plain', 'prop("Amount") + 1', 'Plain'));
			await apply(db, [{ op: 'createCollection', id: 'col', pageId: 'p1' }]);
			const view = (sorts: object[]) => apply(db, [{ op: 'createView', id: 'v' + Math.random(), collectionId: 'col', type: 'table', name: 'V', sorts, rank: evenRanks(1)[0] } as never]);
			const refused = await failure(() => view([{ prop: 'since', dir: 'asc' }]));
			expect(refused).toMatchObject({ code: 'now_sort', paths: ['/sorts/0/prop'] });
			await view([{ prop: 'plain', dir: 'asc' }]);
			// A now-formula as a secondary key is fine: ties are settled by the first one.
			await view([{ prop: 'plain', dir: 'asc' }, { prop: 'since', dir: 'desc' }]);
			expect(analyzeFormula('now()').ok).toBe(true);
		});
	});
});
