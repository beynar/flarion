import { describe, expect, test } from 'vitest';
import { createMigrationClient } from 'viborm/migrations';
import { evaluate } from '../../../src/lib/shared/filter-ast';
import { type PropertyDef } from '../../../src/lib/shared/property-types';
import { evenRanks, textSortKey } from '../../../src/lib/shared/sort-keys';
import { WORKSPACE_TABLES } from '../../../src/server/db/workspace.schema';
import {
	EavError,
	defaultsForView,
	loadEavRegistry,
	loadRegistry,
	readValues,
	reverseRelation,
	purgePageEav,
	selectivity,
	writeInitialValues
} from '../../../src/server/objects/workspace/eav';
import { ensureEavLayout } from '../../../src/server/objects/workspace/eav/layout';
import { apply, ctx, defineProperty, inWorkspace, rows, seedPage } from './helpers';

const STATUS: PropertyDef = {
	id: 'status',
	name: 'Status',
	type: 'select',
	config: {
		options: [
			{ id: 'todo', name: 'To do', color: 'gray' },
			{ id: 'doing', name: 'Doing', color: 'blue' },
			{ id: 'done', name: 'Done', color: 'green' }
		]
	}
};
const TAGS: PropertyDef = {
	id: 'tags',
	name: 'Tags',
	type: 'multi_select',
	config: {
		options: [
			{ id: 'a', name: 'Alpha', color: 'red' },
			{ id: 'b', name: 'Beta', color: 'blue' },
			{ id: 'c', name: 'Gamma', color: 'green' }
		]
	}
};

describe('layout', () => {
	test('EAV tables are WITHOUT ROWID, viborm sees no drift, and the step is idempotent', async () => {
		await inWorkspace(async (state, db) => {
			const sqls = rows<{ name: string; sql: string }>(state, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('p_text','p_num','p_date','p_ref','value_count')");
			expect(sqls).toHaveLength(5);
			for (const t of sqls) expect(t.sql).toMatch(/WITHOUT ROWID/);
			const idx = rows<{ name: string }>(state, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'p\\_%\\_page\\_prop\\_idx' ESCAPE '\\'");
			expect(idx.map((i) => i.name).sort()).toEqual(['p_date_page_prop_idx', 'p_num_page_prop_idx', 'p_ref_page_prop_idx', 'p_text_page_prop_idx']);
			const m = createMigrationClient(db, { tables: WORKSPACE_TABLES });
			expect((await m.push({ dryRun: true })).statements).toEqual([]);
			expect(ensureEavLayout(state.storage)).toEqual([]);
		});
	});

	test('converts populated rowid tables without losing rows', async () => {
		await inWorkspace(async (state, db) => {
			await seedPage(db, 'p1', 1);
			await defineProperty(db, STATUS);
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'status', value: 'doing' }]);
			// Rebuild as a plain rowid table, then convert back.
			state.storage.transactionSync(() => {
				const sql = state.storage.sql;
				sql.exec('CREATE TABLE tmp_ref AS SELECT * FROM p_ref');
				sql.exec('DROP TABLE p_ref');
				sql.exec('CREATE TABLE p_ref ("prop" INTEGER NOT NULL, "v" TEXT NOT NULL, "page" INTEGER NOT NULL, "computed" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("prop","v","page"))');
				sql.exec('CREATE INDEX p_ref_page_prop_idx ON p_ref (page, prop)');
				sql.exec('INSERT INTO p_ref SELECT * FROM tmp_ref');
				sql.exec('DROP TABLE tmp_ref');
			});
			expect(ensureEavLayout(state.storage)).toEqual(['p_ref']);
			expect(rows(state, 'SELECT prop, v, page FROM p_ref')).toEqual([{ prop: 1, v: 'doing', page: 1 }]);
		});
	});
});

describe('typed writes', () => {
	test('a title write updates page.title, the folded p_text row and props_json', async () => {
		await inWorkspace(async (state, db) => {
			await seedPage(db, 'p1', 1);
			const changes = await apply(db, [{ op: 'setProp', page: 'p1', prop: 'title', value: 'Été Plan' }]);
			expect(changes).toEqual([{ kind: 'setProp', page: 'p1', prop: 'title', old: null, new: 'Été Plan' }]);
			const [page] = rows<{ title: string; props_json: string; updated_by: string; updated_at: string }>(state, 'SELECT title, props_json, updated_by, updated_at FROM page');
			expect(page.title).toBe('Été Plan');
			expect(JSON.parse(page.props_json)).toEqual({ title: 'Été Plan' });
			expect(page.updated_by).toBe('u1');
			expect(page.updated_at).toBe(new Date(ctx.now).toISOString());
			expect(rows(state, 'SELECT prop, v, page FROM p_text')).toEqual([{ prop: 0, v: textSortKey('Été Plan'), page: 1 }]);
			// Clearing the title.
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'title', value: null }]);
			expect(rows<{ title: string }>(state, 'SELECT title FROM page')[0].title).toBe('');
			expect(rows(state, 'SELECT * FROM p_text')).toEqual([]);
		});
	});

	test('multi-select stores one row per option; add and remove touch one member', async () => {
		await inWorkspace(async (state, db) => {
			await seedPage(db, 'p1', 1);
			await defineProperty(db, TAGS);
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'tags', value: ['b', 'a'] }]);
			const refs = () => rows<{ v: string }>(state, 'SELECT v FROM p_ref ORDER BY v').map((r) => r.v);
			expect(refs()).toEqual(['a', 'b']);
			const add = await apply(db, [{ op: 'addOption', page: 'p1', prop: 'tags', option: 'c' }]);
			expect(add[0]).toMatchObject({ old: ['b', 'a'], new: ['b', 'a', 'c'] });
			expect(refs()).toEqual(['a', 'b', 'c']);
			await apply(db, [{ op: 'removeOption', page: 'p1', prop: 'tags', option: 'a' }]);
			expect(refs()).toEqual(['b', 'c']);
			// props_json keeps the user's order.
			expect(JSON.parse(rows<{ props_json: string }>(state, 'SELECT props_json FROM page')[0].props_json)).toEqual({ tags: ['b', 'c'] });
			// Adding an existing member is a no-op: no change record.
			expect(await apply(db, [{ op: 'addOption', page: 'p1', prop: 'tags', option: 'b' }])).toEqual([]);
			// removeOption of the last one clears the property.
			await apply(db, [
				{ op: 'removeOption', page: 'p1', prop: 'tags', option: 'b' },
				{ op: 'removeOption', page: 'p1', prop: 'tags', option: 'c' }
			]);
			expect(refs()).toEqual([]);
			expect(rows<{ props_json: string }>(state, 'SELECT props_json FROM page')[0].props_json).toBe('{}');
		});
	});

	test('renaming an option is one config write and leaves stored rows untouched; removing one strips it', async () => {
		await inWorkspace(async (state, db) => {
			await seedPage(db, 'p1', 1);
			await seedPage(db, 'p2', 2);
			await defineProperty(db, TAGS);
			await apply(db, [
				{ op: 'setProp', page: 'p1', prop: 'tags', value: ['a', 'b'] },
				{ op: 'setProp', page: 'p2', prop: 'tags', value: ['b'] }
			]);
			const before = rows(state, 'SELECT * FROM p_ref ORDER BY page, v');
			const beforeProps = rows(state, 'SELECT id, props_json FROM page ORDER BY id');
			const beforeCounts = rows(state, 'SELECT * FROM value_count ORDER BY prop, v');
			const renamed = { options: TAGS.type === 'multi_select' ? TAGS.config.options.map((o) => (o.id === 'a' ? { ...o, name: 'Alpha renamed' } : o)) : [] };
			const changes = await apply(db, [{ op: 'updateProperty', id: 'tags', config: renamed }]);
			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({ kind: 'updateProperty', prop: 'tags' });
			expect(rows(state, 'SELECT * FROM p_ref ORDER BY page, v')).toEqual(before);
			expect(rows(state, 'SELECT id, props_json FROM page ORDER BY id')).toEqual(beforeProps);
			expect(rows(state, 'SELECT * FROM value_count ORDER BY prop, v')).toEqual(beforeCounts);
			const reg = await loadEavRegistry(db);
			expect(JSON.stringify(reg.get('tags'))).toContain('Alpha renamed');

			// Drop option b: both pages lose it, counts follow.
			const drop = await apply(db, [{ op: 'updateProperty', id: 'tags', config: { options: renamed.options.filter((o) => o.id !== 'b') } }]);
			expect(drop.filter((c) => c.kind === 'setProp').map((c) => [c.page, c.new])).toEqual(expect.arrayContaining([['p1', ['a']], ['p2', null]]));
			expect(rows(state, 'SELECT page, v FROM p_ref ORDER BY page')).toEqual([{ page: 1, v: 'a' }]);
			expect(rows(state, 'SELECT v, n FROM value_count ORDER BY v')).toEqual([{ v: '', n: 1 }, { v: 'a', n: 1 }]);
		});
	});

	test('a relation stores the target num; a reverse scan lists the pages pointing at it', async () => {
		await inWorkspace(async (state, db) => {
			await seedPage(db, 'proj', 7);
			await seedPage(db, 'proj2', 8);
			for (const [i, id] of ['t1', 't2', 't3'].entries()) await seedPage(db, id, 20 + i);
			await defineProperty(db, { id: 'project', name: 'Project', type: 'relation', config: { limit: 'many' } });
			await apply(db, [
				{ op: 'setProp', page: 't1', prop: 'project', value: ['proj'] },
				{ op: 'setProp', page: 't2', prop: 'project', value: ['proj', 'proj2'] },
				{ op: 'addOption', page: 't3', prop: 'project', option: 'proj2' }
			]);
			expect(rows(state, 'SELECT v, page FROM p_ref ORDER BY page, v')).toEqual([
				{ v: '7', page: 20 },
				{ v: '7', page: 21 },
				{ v: '8', page: 21 },
				{ v: '8', page: 22 }
			]);
			expect(await reverseRelation(db, 'project', 'proj')).toEqual(['t1', 't2']);
			expect(await reverseRelation(db, 'project', 'proj2')).toEqual(['t2', 't3']);
			// props_json keeps ids, not nums.
			expect((await readValues(db, ['t2'])).get('t2')).toEqual({ project: ['proj', 'proj2'] });
			// Unknown target: refused, nothing written.
			await expect(apply(db, [{ op: 'setProp', page: 't1', prop: 'project', value: ['ghost'] }])).rejects.toBeInstanceOf(EavError);
			expect(await reverseRelation(db, 'project', 'proj')).toEqual(['t1', 't2']);
			// limit one.
			await defineProperty(db, { id: 'parentproj', name: 'Parent', type: 'relation', config: { limit: 'one' } });
			await expect(apply(db, [{ op: 'setProp', page: 't1', prop: 'parentproj', value: ['proj', 'proj2'] }])).rejects.toMatchObject({ code: 'invalid_value' });
		});
	});

	test('an invalid value throws and rolls back the whole transaction', async () => {
		await inWorkspace(async (state, db) => {
			await seedPage(db, 'p1', 1);
			await defineProperty(db, STATUS);
			await defineProperty(db, { id: 'n', name: 'N', type: 'number', config: { format: 'number' } });
			await expect(
				apply(db, [
					{ op: 'setProp', page: 'p1', prop: 'title', value: 'Rolled back' },
					{ op: 'setProp', page: 'p1', prop: 'n', value: 3 },
					{ op: 'setProp', page: 'p1', prop: 'status', value: 'nope' }
				])
			).rejects.toMatchObject({ name: 'EavError', code: 'invalid_value' });
			expect(rows(state, 'SELECT title, props_json FROM page')).toEqual([{ title: '', props_json: '{}' }]);
			for (const t of ['p_text', 'p_num', 'p_ref', 'p_date', 'value_count']) expect(rows(state, `SELECT * FROM ${t}`)).toEqual([]);
			// Unknown property, unknown page, read-only property.
			await expect(apply(db, [{ op: 'setProp', page: 'p1', prop: 'zzz', value: 'x' }])).rejects.toMatchObject({ code: 'unknown_property' });
			await expect(apply(db, [{ op: 'setProp', page: 'ghost', prop: 'title', value: 'x' }])).rejects.toMatchObject({ code: 'unknown_page' });
			await defineProperty(db, { id: 'made', name: 'Made', type: 'created_time', config: {} });
			await expect(apply(db, [{ op: 'setProp', page: 'p1', prop: 'made', value: '2026-01-01' }])).rejects.toMatchObject({ code: 'read_only' });
			// A property created in a rolled-back batch does not exist afterwards.
			await expect(
				apply(db, [
					{ op: 'createProperty', property: { id: 'tmp', name: 'Tmp', type: 'text', config: {} } },
					{ op: 'setProp', page: 'p1', prop: 'tmp', value: 'ok' },
					{ op: 'setProp', page: 'p1', prop: 'status', value: 'nope' }
				])
			).rejects.toBeInstanceOf(EavError);
			expect((await loadRegistry(db)).get('tmp')).toBeUndefined();
			// Trashed pages refuse writes.
			rows(state, "UPDATE page SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'p1'");
			await expect(apply(db, [{ op: 'setProp', page: 'p1', prop: 'title', value: 'x' }])).rejects.toMatchObject({ code: 'page_deleted' });
		});
	});

	test('created/edited columns are never written as EAV', async () => {
		await inWorkspace(async (state, db) => {
			await seedPage(db, 'p1', 1);
			for (const type of ['created_time', 'created_by', 'last_edited_time', 'last_edited_by'] as const)
				await defineProperty(db, { id: type, name: type, type, config: {} });
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'title', value: 'x' }]);
			for (const t of ['p_num', 'p_ref', 'p_date']) expect(rows(state, `SELECT * FROM ${t}`)).toEqual([]);
		});
	});

	test('writeInitialValues writes every value in one go and rejects bad ones', async () => {
		await inWorkspace(async (state, db) => {
			await defineProperty(db, STATUS);
			await defineProperty(db, { id: 'due', name: 'Due', type: 'date', config: { includeTime: false } });
			await seedPage(db, 'p1', 1);
			const out = await db.$transaction((tx) =>
				writeInitialValues(tx, 'p1', { title: 'Hello', status: 'todo', due: { start: '2026-03-01', end: '2026-03-04' }, ghost: null }, ctx).catch((e: unknown) => e)
			);
			expect(out).toBeInstanceOf(EavError);
			await seedPage(db, 'p2', 2);
			const changes = await db.$transaction((tx) =>
				writeInitialValues(tx, 'p2', { title: 'Hello', status: 'todo', due: { start: '2026-03-01', end: '2026-03-04' } }, ctx)
			);
			expect(changes.map((c) => c.prop).sort()).toEqual(['due', 'status', 'title']);
			expect(rows(state, 'SELECT prop, v, v_end, page FROM p_date')).toEqual([{ prop: 2, v: Date.UTC(2026, 2, 1), v_end: Date.UTC(2026, 2, 4), page: 2 }]);
			expect((await readValues(db, ['p2'])).get('p2')).toEqual({ title: 'Hello', status: 'todo', due: { start: '2026-03-01', end: '2026-03-04' } });
			expect(rows<{ title: string }>(state, "SELECT title FROM page WHERE id = 'p2'")[0].title).toBe('Hello');
		});
	});
});

describe('counts', () => {
	test('stay exact across updates, clears, deletes and purges; selectivity reads them', async () => {
		await inWorkspace(async (state, db) => {
			await defineProperty(db, STATUS);
			await defineProperty(db, { id: 'done', name: 'Done', type: 'checkbox', config: {} });
			await defineProperty(db, { id: 'rel', name: 'Rel', type: 'relation', config: { limit: 'many' } });
			for (let i = 1; i <= 6; i++) await seedPage(db, `p${i}`, i);
			const counts = () => Object.fromEntries(rows<{ prop: number; v: string; n: number }>(state, 'SELECT prop, v, n FROM value_count').map((r) => [`${r.prop}:${r.v}`, r.n]));
			await apply(db, [
				...['p1', 'p2', 'p3', 'p4'].map((p, i) => ({ op: 'setProp' as const, page: p, prop: 'status', value: i < 3 ? 'todo' : 'done' })),
				{ op: 'setProp', page: 'p1', prop: 'done', value: true },
				{ op: 'setProp', page: 'p2', prop: 'done', value: false },
				{ op: 'setProp', page: 'p1', prop: 'title', value: 'one' },
				{ op: 'setProp', page: 'p2', prop: 'title', value: 'two' },
				{ op: 'setProp', page: 'p5', prop: 'rel', value: ['p1', 'p2'] },
				{ op: 'setProp', page: 'p6', prop: 'rel', value: ['p1'] }
			]);
			// status = prop 1, done = 2, rel = 3, title = 0.
			expect(counts()).toEqual({ '0:': 2, '1:': 4, '1:todo': 3, '1:done': 1, '2:': 2, '2:1': 1, '2:0': 1, '3:': 3, '3:1': 2, '3:2': 1 });
			// Update, clear, remove.
			await apply(db, [
				{ op: 'setProp', page: 'p1', prop: 'status', value: 'done' },
				{ op: 'setProp', page: 'p2', prop: 'status', value: null },
				{ op: 'setProp', page: 'p1', prop: 'title', value: 'uno' },
				{ op: 'removeOption', page: 'p5', prop: 'rel', option: 'p1' }
			]);
			expect(counts()).toEqual({ '0:': 2, '1:': 3, '1:todo': 1, '1:done': 2, '2:': 2, '2:1': 1, '2:0': 1, '3:': 2, '3:1': 1, '3:2': 1 });
			expect(await selectivity(db, 'status', 'is', 'done')).toBe(2);
			expect(await selectivity(db, 'status', 'is', 'todo')).toBe(1);
			expect(await selectivity(db, 'status', 'is', 'zzz')).toBe(0);
			expect(await selectivity(db, 'status', 'is_not_empty')).toBe(3);
			expect(await selectivity(db, 'done', 'is', true)).toBe(1);
			expect(await selectivity(db, 'rel', 'contains', 'p1')).toBe(1);
			expect(await selectivity(db, 'rel', 'contains', 'p2')).toBe(1);
			expect(await selectivity(db, 'title', 'is', 'UNO')).toBe(1);
			expect(await selectivity(db, 'title', 'starts_with', 'u')).toBe(1);
			expect(await selectivity(db, 'title', 'is', 'nope')).toBe(0);
			expect(await selectivity(db, 'status', 'is_empty')).toBe(6 - 3);

			// Purging a page removes its rows and counts, and the relation rows pointing at it.
			await db.$transaction((tx) => purgePageEav(tx, 'p2', ctx));
			expect(rows(state, 'SELECT * FROM p_ref WHERE page = 2')).toEqual([]);
			expect(rows(state, "SELECT * FROM p_ref WHERE prop = 3 AND v = '2'")).toEqual([]);
			expect((await readValues(db, ['p5'])).get('p5')).toEqual({});
			expect(counts()).toEqual({ '0:': 1, '1:': 3, '1:done': 2, '1:todo': 1, '2:': 1, '2:1': 1, '3:': 1, '3:1': 1 });
		});
	});
});

describe('definitions', () => {
	test('property registry: create, update, soft delete, title built-in', async () => {
		await inWorkspace(async (state, db) => {
			let reg = await loadEavRegistry(db);
			expect(reg.all().map((d) => d.id)).toEqual(['title']);
			const created = await defineProperty(db, STATUS);
			expect(created[0]).toMatchObject({ kind: 'createProperty', prop: 'status', old: null });
			await defineProperty(db, { id: 'st', name: 'Status flow', type: 'status', config: { options: [], groups: [] } });
			// Default status config is applied to an empty one.
			expect(JSON.stringify((await loadRegistry(db)).get('st'))).toContain('Not started');
			expect(rows(state, 'SELECT id, num FROM property ORDER BY num')).toEqual([{ id: 'status', num: 1 }, { id: 'st', num: 2 }]);
			await expect(defineProperty(db, STATUS)).rejects.toMatchObject({ code: 'exists' });
			await expect(defineProperty(db, { id: 'title', name: 'T', type: 'text', config: {} })).rejects.toMatchObject({ code: 'exists' });
			await expect(defineProperty(db, { id: 'bad', name: 'Bad', type: 'select', config: { options: [{ id: 'x', name: 'X', color: 'gray' }, { id: 'x', name: 'Y', color: 'gray' }] } })).rejects.toMatchObject({ code: 'invalid_config' });
			await expect(defineProperty(db, { id: 'ru', name: 'R', type: 'rollup', config: { relationProp: 'status', targetProp: 'title', fn: 'count_all', resultType: 'number' } })).rejects.toMatchObject({ code: 'invalid_config' });

			// Rename.
			const upd = await apply(db, [{ op: 'updateProperty', id: 'status', name: 'Stage' }]);
			expect(upd[0]).toMatchObject({ old: { name: 'Status' }, new: { name: 'Stage' } });
			expect(await apply(db, [{ op: 'updateProperty', id: 'status', name: 'Stage' }])).toEqual([]);
			// Title can be renamed (seeded lazily) but never deleted.
			await apply(db, [{ op: 'updateProperty', id: 'title', name: 'Name' }]);
			expect((await loadRegistry(db)).get('title')?.name).toBe('Name');
			await expect(apply(db, [{ op: 'deleteProperty', id: 'title' }])).rejects.toMatchObject({ code: 'title_reserved' });

			// Soft delete keeps the rows, hides the property from the registry and from readValues.
			await seedPage(db, 'p1', 1);
			await apply(db, [{ op: 'setProp', page: 'p1', prop: 'status', value: 'todo' }]);
			const del = await apply(db, [{ op: 'deleteProperty', id: 'status' }]);
			expect(del[0]).toMatchObject({ kind: 'deleteProperty', new: null });
			expect(rows(state, "SELECT deleted_at, deleted_by FROM property WHERE id = 'status'")).toEqual([{ deleted_at: new Date(ctx.now).toISOString(), deleted_by: 'u1' }]);
			expect((await loadRegistry(db)).get('status')).toBeUndefined();
			expect(rows(state, 'SELECT * FROM p_ref')).toHaveLength(1);
			expect((await readValues(db, ['p1'])).get('p1')).toEqual({});
			await expect(apply(db, [{ op: 'setProp', page: 'p1', prop: 'status', value: 'todo' }])).rejects.toMatchObject({ code: 'unknown_property' });
			// Numbers are never reused.
			await defineProperty(db, { id: 'after', name: 'After', type: 'text', config: {} });
			expect(rows(state, "SELECT num FROM property WHERE id = 'after'")).toEqual([{ num: 3 }]);
			reg = await loadEavRegistry(db);
			expect(reg.all().map((d) => d.id)).toEqual(['title', 'st', 'after']);
		});
	});

	test('collections, members and views', async () => {
		await inWorkspace(async (state, db) => {
			await defineProperty(db, STATUS);
			await seedPage(db, 'db1', 1);
			await seedPage(db, 'r1', 2);
			await seedPage(db, 'r2', 3);
			const filter = { and: [{ prop: 'status', op: 'is' as const, value: 'todo' }] };
			const created = await apply(db, [{ op: 'createCollection', id: 'c1', pageId: 'db1', sourceAst: filter, shownProps: ['title', 'status'], defaults: { status: 'todo' } }]);
			expect(created[0]).toMatchObject({ kind: 'createCollection', page: 'db1', prop: 'c1' });
			expect(rows(state, "SELECT is_database FROM page WHERE id = 'db1'")).toEqual([{ is_database: 1 }]);
			await expect(apply(db, [{ op: 'createCollection', id: 'c2', pageId: 'db1' }])).rejects.toMatchObject({ code: 'exists' });
			await expect(apply(db, [{ op: 'createCollection', id: 'c3', pageId: 'r1', sourceAst: { and: [{ prop: 'nope', op: 'is', value: 'x' }] } }])).rejects.toMatchObject({ code: 'invalid_query' });
			await expect(apply(db, [{ op: 'createCollection', id: 'c3', pageId: 'r1', defaults: { status: 'bogus' } }])).rejects.toMatchObject({ code: 'invalid_value' });
			await expect(apply(db, [{ op: 'createCollection', id: 'c3', pageId: 'r1', shownProps: ['ghost'] }])).rejects.toMatchObject({ code: 'unknown_property' });

			const upd = await apply(db, [{ op: 'updateCollection', id: 'c1', sourceAst: null, shownProps: ['title'] }]);
			expect(upd[0]).toMatchObject({ old: { sourceAst: filter }, new: { sourceAst: null, shownProps: ['title'], defaults: { status: 'todo' } } });

			// Members
			await apply(db, [
				{ op: 'addMember', collection: 'c1', page: 'r1', rank: '11' },
				{ op: 'addMember', collection: 'c1', page: 'r2', rank: '13' }
			]);
			const mv = await apply(db, [{ op: 'moveMember', collection: 'c1', page: 'r2', rank: '089' }]);
			expect(mv[0]).toMatchObject({ kind: 'moveMember', page: 'r2', prop: 'c1', old: '13', new: '089' });
			expect(rows(state, 'SELECT page_id FROM collection_member ORDER BY rank')).toEqual([{ page_id: 'r2' }, { page_id: 'r1' }]);
			await expect(apply(db, [{ op: 'moveMember', collection: 'c1', page: 'db1', rank: '12' }])).rejects.toMatchObject({ code: 'not_member' });
			await expect(apply(db, [{ op: 'addMember', collection: 'c1', page: 'r1', rank: 'bad rank!' }])).rejects.toMatchObject({ code: 'invalid_rank' });
			await apply(db, [{ op: 'removeMember', collection: 'c1', page: 'r1' }]);
			expect(rows(state, 'SELECT page_id FROM collection_member')).toEqual([{ page_id: 'r2' }]);

			// Views
			const v1 = await apply(db, [{ op: 'createView', id: 'v1', collectionId: 'c1', type: 'board', name: 'Board', filter, groupBy: { prop: 'status' }, sorts: [{ prop: 'title', dir: 'asc' }], columns: { columns: [{ prop: 'title' }], options: {} }, rank: '11' }]);
			expect(v1[0]).toMatchObject({ kind: 'createView', page: 'db1', prop: 'v1' });
			await expect(apply(db, [{ op: 'createView', id: 'v2', collectionId: 'c1', type: 'table', name: 'Bad', filter: { and: [{ prop: 'status', op: 'gt', value: 3 }] }, rank: '12' }])).rejects.toMatchObject({ code: 'invalid_query' });
			await expect(apply(db, [{ op: 'createView', id: 'v2', collectionId: 'c1', type: 'table', name: 'Bad', groupBy: { prop: 'title' }, rank: '12' }])).rejects.toMatchObject({ code: 'invalid_query' });
			await expect(apply(db, [{ op: 'createView', id: 'v2', collectionId: 'ghost', type: 'table', name: 'Bad', rank: '12' }])).rejects.toMatchObject({ code: 'unknown_collection' });
			await expect(apply(db, [{ op: 'createView', id: 'v2', collectionId: 'c1', type: 'table', name: 'Cols', columns: { columns: [{ prop: 'ghost' }], options: {} }, rank: '12' }])).rejects.toMatchObject({ code: 'unknown_property' });
			await apply(db, [{ op: 'createView', id: 'v2', collectionId: 'c1', type: 'table', name: 'Table', rank: '089' }]);
			await apply(db, [{ op: 'updateView', id: 'v2', name: 'All', sorts: [{ prop: 'status', dir: 'desc' }], groupBy: null }]);
			await apply(db, [{ op: 'moveView', id: 'v2', rank: '13' }]);
			const { readViews, readCollection } = await import('../../../src/server/objects/workspace/eav');
			expect((await readViews(db, 'c1')).map((v) => [v.id, v.rank, v.name])).toEqual([['v1', '11', 'Board'], ['v2', '13', 'All']]);
			const full = await readCollection(db, 'c1');
			expect(full?.collection).toEqual({ id: 'c1', pageId: 'db1', sourceAst: null, shownProps: ['title'], defaults: { status: 'todo' } });
			expect(full?.views[0]).toMatchObject({ id: 'v1', type: 'board', groupBy: { prop: 'status' }, columns: { columns: [{ prop: 'title' }], options: {} } });
			expect(full?.views[1].filter).toEqual({ and: [] });

			await apply(db, [{ op: 'deleteView', id: 'v2' }]);
			expect((await readViews(db, 'c1')).map((v) => v.id)).toEqual(['v1']);
			await expect(apply(db, [{ op: 'deleteView', id: 'v2' }])).rejects.toMatchObject({ code: 'unknown_view' });

			// Deleting the collection tombstones it and its views; its page can host a new one.
			await apply(db, [{ op: 'deleteCollection', id: 'c1' }]);
			expect(await readCollection(db, 'c1')).toBeNull();
			expect(await readViews(db, 'c1')).toEqual([]);
			expect(rows(state, "SELECT is_database FROM page WHERE id = 'db1'")).toEqual([{ is_database: 0 }]);
			await apply(db, [{ op: 'createCollection', id: 'c9', pageId: 'db1' }]);
			expect(rows(state, 'SELECT id FROM collection')).toEqual([{ id: 'c9' }]);
		});
	});
});

describe('defaultsForView', () => {
	test('derives values that satisfy the view filter, checked with the oracle', async () => {
		await inWorkspace(async (state, db) => {
			await defineProperty(db, STATUS);
			await defineProperty(db, TAGS);
			await defineProperty(db, { id: 'n', name: 'N', type: 'number', config: { format: 'number' } });
			await defineProperty(db, { id: 'done', name: 'Done', type: 'checkbox', config: {} });
			await defineProperty(db, { id: 'due', name: 'Due', type: 'date', config: { includeTime: false } });
			await defineProperty(db, { id: 'owner', name: 'Owner', type: 'person', config: {} });
			await seedPage(db, 'db1', 1);
			await seedPage(db, 'parent', 2);
			const cases = [
				{ and: [{ prop: 'status', op: 'is', value: 'doing' }] },
				{ and: [{ prop: 'status', op: 'is_not', value: 'todo' }] },
				{ and: [{ prop: 'tags', op: 'contains', value: 'b' }, { prop: 'title', op: 'starts_with', value: 'Sprint' }] },
				{ and: [{ prop: 'n', op: 'gt', value: 5 }, { prop: 'n', op: 'lt', value: 7 }] },
				{ and: [{ prop: 'n', op: 'gte', value: 10 }] },
				{ and: [{ prop: 'done', op: 'is', value: false }] },
				{ and: [{ prop: 'due', op: 'on_or_after', value: { kind: 'exact', date: '2026-03-01' } }] },
				{ and: [{ prop: 'due', op: 'before', value: { kind: 'exact', date: '2026-03-01' } }] },
				{ and: [{ prop: 'due', op: 'within', value: { kind: 'named', range: 'next_week' } }] },
				{ and: [{ prop: 'due', op: 'is', value: { kind: 'relative', unit: 'week', offset: 0 } }] },
				{ and: [{ prop: 'owner', op: 'is_me' }] },
				{ and: [{ prop: 'owner', op: 'is_empty' }, { prop: 'status', op: 'is', value: 'done' }] },
				{ or: [{ prop: 'status', op: 'is', value: 'done' }, { prop: 'tags', op: 'contains', value: 'a' }] },
				{ and: [{ or: [{ prop: 'n', op: 'eq', value: 3 }, { prop: 'n', op: 'eq', value: 4 }] }, { prop: 'title', op: 'contains', value: 'x' }] },
				{ and: [{ prop: '$parent', op: 'is', value: 'parent' }, { prop: 'status', op: 'is', value: 'todo' }] }
			] as const;
			await apply(db, [{ op: 'createCollection', id: 'c1', pageId: 'db1', sourceAst: { and: [{ prop: 'tags', op: 'is_not_empty' }] }, defaults: { status: 'todo', n: 1 } }]);
			const registry = await loadRegistry(db);
			const now = Date.UTC(2026, 1, 10);
			const ranks = evenRanks(cases.length);
			for (const [i, filter] of cases.entries()) {
				await apply(db, [{ op: 'createView', id: `v${i}`, collectionId: 'c1', type: 'table', name: `v${i}`, filter: filter as never, rank: ranks[i] }]);
				const d = await defaultsForView(db, `v${i}`, { meId: 'me', now });
				expect(d, JSON.stringify(filter)).not.toBeNull();
				const evalCtx = { registry, now, meId: 'me' };
				const values = { ...d!.values, ...(d!.parentId ? { $parent: [d!.parentId] } : {}) };
				expect(evaluate(filter as never, values, evalCtx), `view filter ${JSON.stringify(filter)} -> ${JSON.stringify(d)}`).toBe(true);
				expect(d!.satisfies).toBe(true);
				// The collection's membership filter holds too.
				expect(Array.isArray(d!.values.tags) && d!.values.tags.length > 0, `membership: ${JSON.stringify(d)}`).toBe(true);
				// Every derived value passes the registry's own validation, so create can take it.
				await seedPage(db, `row${i}`, 100 + i);
				await db.$transaction((tx) => writeInitialValues(tx, `row${i}`, d!.values, ctx));
			}
			// Defaults survive where the filter does not contradict them; the parent defaults to the page.
			const plain = await defaultsForView(db, 'v0');
			expect(plain!.values.n).toBe(1);
			expect(plain!.parentId).toBe('db1');
			expect((await defaultsForView(db, `v${cases.length - 1}`))!.parentId).toBe('parent');
			expect(await defaultsForView(db, 'ghost')).toBeNull();
		});
	});
});
