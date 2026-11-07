/**
 * Definition ops: the property registry, collections, hand-picked members and views. Rows are written
 * with raw SQL through the caller's transaction (JSON columns serialized here); every AST goes through
 * `validateQuerySpec`; soft delete stamps `deleted_at`/`deleted_by` (EAV rows and `props_json` are kept).
 */
import * as v from 'valibot';
import { viewColumnsSchema, type CollectionDef, type ViewDef } from '../../../../lib/shared/definitions';
import { validateQuerySpec, type QuerySpec } from '../../../../lib/shared/filter-ast';
import type { Op } from '../../../../lib/shared/ops';
import {
	TITLE_PROP_ID,
	defaultStatusConfig,
	isReadOnlyProperty,
	parsePropertyConfig,
	storageTable,
	validateValue,
	type PropertyDef,
	type PropertyRegistry
} from '../../../../lib/shared/property-types';
import { issue, type Issue, type Result } from '../../../../lib/shared/result';
import { isRank } from '../../../../lib/shared/sort-keys';
import type { WorkspaceDb } from '../../../db/workspace.client';
import { throwIssues } from './errors';
import type { ChangeRecord, EavOpContext } from './index';
import { EAV_TABLES } from './layout';
import {
	collectionDefOf,
	loadCollectionRow,
	loadViewRow,
	viewDefOf
} from './read';
import {
	TITLE_NUM,
	invalidateRegistry,
	loadEavRegistry,
	nextPropertyNum,
	type EavRegistry
} from './registry';
import { all, iso, qmarks, run } from './sql';
import { loadPage, writeValues } from './values';

type OpOf<K extends Op['op']> = Extract<Op, { op: K }>;

const exists = async (db: WorkspaceDb, table: string, id: string): Promise<boolean> =>
	(await all(db, `SELECT 1 FROM ${table} WHERE id = ?`, id)).length > 0;

function fail(code: string, path: string, message: string): never {
	return throwIssues(code, [issue(path, code, message)]);
}

/** Checks a query spec; issue paths are re-rooted at `prefix` (the `/filter` segment is dropped for bare filters). */
function checkSpec(spec: QuerySpec, registry: PropertyRegistry, prefix: string, bareFilter = false): void {
	const r: Result<QuerySpec> = validateQuerySpec(spec, registry);
	if (r.ok) return;
	const issues: Issue[] = r.issues.map((i) => ({ ...i, path: bareFilter ? i.path.replace(/^\/filter/, '') : i.path }));
	throwIssues('invalid_query', issues, prefix);
}

function checkShownAndDefaults(
	registry: PropertyRegistry,
	shownProps: readonly string[] | undefined,
	defaults: CollectionDef['defaults'] | undefined
): void {
	shownProps?.forEach((id, i) => {
		if (!registry.get(id)) fail('unknown_property', `/shownProps/${i}`, `Unknown property "${id}"`);
	});
	for (const [id, value] of Object.entries(defaults ?? {})) {
		const def = registry.get(id);
		if (!def) fail('unknown_property', `/defaults/${id}`, `Unknown property "${id}"`);
		else if (isReadOnlyProperty(def)) fail('read_only', `/defaults/${id}`, `${def.type} properties cannot be written`);
		else {
			const r = validateValue(def, value);
			if (!r.ok) throwIssues('invalid_value', r.issues, `/defaults/${id}`);
		}
	}
}

// ───────────────────────────── properties ─────────────────────────────

export async function createProperty(db: WorkspaceDb, op: OpOf<'createProperty'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	void ctx;
	const input = op.property;
	const registry = await loadEavRegistry(db);
	if (input.id === TITLE_PROP_ID || (await exists(db, 'property', input.id)))
		fail('exists', '/property/id', `Property "${input.id}" already exists`);
	if (input.type === 'title') fail('title_reserved', '/property/type', 'The workspace has exactly one title property');
	const parsed = parsePropertyConfig(input.type, input.config);
	if (!parsed.ok) return throwIssues('invalid_config', parsed.issues, '/property');
	let config: Record<string, unknown> = parsed.value as Record<string, unknown>;
	if (input.type === 'status' && !(config.options as unknown[]).length && !(config.groups as unknown[]).length)
		config = defaultStatusConfig() as unknown as Record<string, unknown>;
	await checkConfigRefs(db, registry, input.type, config, '/property/config');

	const def = { id: input.id, name: input.name, type: input.type, config } as PropertyDef;
	const num = await nextPropertyNum(db);
	await run(db, 'INSERT INTO property (id, num, name, type, config_json) VALUES (?,?,?,?,?)', def.id, num, def.name, def.type, JSON.stringify(config));
	invalidateRegistry();
	return [{ kind: 'createProperty', page: null, prop: def.id, old: null, new: def }];
}

/** References inside a config: relation target collection, rollup source properties. */
async function checkConfigRefs(
	db: WorkspaceDb,
	registry: EavRegistry,
	type: string,
	config: Record<string, unknown>,
	base: string
): Promise<void> {
	if (type === 'relation' && typeof config.collectionId === 'string' && !(await loadCollectionRow(db, config.collectionId)))
		fail('unknown_collection', `${base}/collectionId`, `Unknown collection "${config.collectionId}"`);
	if (type === 'rollup') {
		const rel = registry.get(config.relationProp as string);
		if (!rel || rel.type !== 'relation') fail('invalid_config', `${base}/relationProp`, 'A rollup needs a relation property');
		if (!registry.get(config.targetProp as string)) fail('unknown_property', `${base}/targetProp`, `Unknown property "${config.targetProp as string}"`);
	}
}

const optionIds = (def: PropertyDef): Set<string> =>
	def.type === 'select' || def.type === 'multi_select' || def.type === 'status'
		? new Set(def.config.options.map((o) => o.id))
		: new Set();

export async function updateProperty(db: WorkspaceDb, op: OpOf<'updateProperty'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	const registry = await loadEavRegistry(db);
	const old = registry.get(op.id);
	if (!old) return fail('unknown_property', '/id', `Unknown property "${op.id}"`);
	const isTitle = op.id === TITLE_PROP_ID;
	if (isTitle && op.config && Object.keys(op.config).length) fail('title_reserved', '/config', 'The title has no config');

	let config = old.config as Record<string, unknown>;
	if (op.config && !isTitle) {
		const parsed = parsePropertyConfig(old.type, op.config);
		if (!parsed.ok) return throwIssues('invalid_config', parsed.issues);
		config = parsed.value as Record<string, unknown>;
		await checkConfigRefs(db, registry, old.type, config, '/config');
	}
	const next = { ...old, name: op.name ?? old.name, config } as PropertyDef;
	if (JSON.stringify(next) === JSON.stringify(old)) return [];

	if (isTitle) {
		await run(
			db,
			"INSERT INTO property (id, num, name, type, config_json) VALUES ('title', ?, ?, 'title', '{}') ON CONFLICT (id) DO UPDATE SET name = excluded.name",
			TITLE_NUM,
			next.name
		);
	} else {
		await run(db, 'UPDATE property SET name = ?, config_json = ? WHERE id = ?', next.name, JSON.stringify(config), op.id);
	}
	invalidateRegistry();
	const changes: ChangeRecord[] = [{ kind: 'updateProperty', page: null, prop: op.id, old, new: next }];

	const num = registry.num(op.id)!;
	if (storageTable(old) !== storageTable(next)) {
		// A computed result type moved to another table: the old rows are meaningless, the engine recomputes.
		await dropPropertyRows(db, num, op.id);
	} else if (op.config) {
		const kept = optionIds(next);
		const removed = [...optionIds(old)].filter((id) => !kept.has(id));
		if (removed.length) changes.push(...(await stripOptions(db, next, num, removed, ctx)));
	}
	return changes;
}

/** Removes deleted options from every page that holds them (`props_json` and rows, counts included). */
async function stripOptions(db: WorkspaceDb, def: PropertyDef, num: number, removed: string[], ctx: EavOpContext): Promise<ChangeRecord[]> {
	const registry = await loadEavRegistry(db);
	const changes: ChangeRecord[] = [];
	const holders = await all<{ id: string }>(
		db,
		`SELECT DISTINCT page.id AS id FROM p_ref JOIN page ON page.num = p_ref.page WHERE p_ref.prop = ? AND p_ref.v IN (${qmarks(removed.length)})`,
		num,
		...removed
	);
	for (const h of holders) {
		const page = await loadPage(db, h.id);
		if (!page) continue;
		const current = page.props[def.id];
		const list = Array.isArray(current) ? current : typeof current === 'string' ? [current] : [];
		const left = list.filter((x) => !removed.includes(x));
		const value = def.type === 'multi_select' ? (left.length ? left : null) : (left[0] ?? null);
		changes.push(...(await writeValues(db, page, registry, [{ def, next: value }], ctx, false)));
	}
	return changes;
}

/** Deletes every EAV row and count of a property and strips it from `props_json`. */
async function dropPropertyRows(db: WorkspaceDb, num: number, id: string): Promise<void> {
	for (const table of EAV_TABLES) await run(db, `DELETE FROM ${table} WHERE prop = ?`, num);
	await run(db, 'DELETE FROM value_count WHERE prop = ?', num);
	const holders = await all<{ id: string; props_json: string }>(db, 'SELECT id, props_json FROM page WHERE json_type(props_json, ?) IS NOT NULL', `$."${id}"`);
	for (const h of holders) {
		const props = JSON.parse(h.props_json) as Record<string, unknown>;
		delete props[id];
		await run(db, 'UPDATE page SET props_json = ? WHERE id = ?', JSON.stringify(props), h.id);
	}
}

export async function deleteProperty(db: WorkspaceDb, op: OpOf<'deleteProperty'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	if (op.id === TITLE_PROP_ID) fail('title_reserved', '/id', 'The title property cannot be deleted');
	const registry = await loadEavRegistry(db);
	const old = registry.get(op.id);
	if (!old) return fail('unknown_property', '/id', `Unknown property "${op.id}"`);
	await run(db, 'UPDATE property SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL', iso(ctx.now), ctx.actorId, op.id);
	invalidateRegistry();
	return [{ kind: 'deleteProperty', page: null, prop: op.id, old, new: null }];
}

// ───────────────────────────── collections ─────────────────────────────

export async function createCollection(db: WorkspaceDb, op: OpOf<'createCollection'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	void ctx;
	const registry = await loadEavRegistry(db);
	if (await exists(db, 'collection', op.id)) fail('exists', '/id', `Collection "${op.id}" already exists`);
	const page = await loadPage(db, op.pageId);
	if (!page) fail('unknown_page', '/pageId', `Unknown page "${op.pageId}"`);
	if (page!.deleted) fail('page_deleted', '/pageId', 'The page is in the trash');
	const [live] = await all<{ id: string }>(db, 'SELECT id FROM collection WHERE page_id = ? AND deleted_at IS NULL', op.pageId);
	if (live) fail('exists', '/pageId', `Page "${op.pageId}" already holds collection "${live.id}"`);
	if (op.sourceAst) checkSpec({ filter: op.sourceAst }, registry, '/sourceAst', true);
	checkShownAndDefaults(registry, op.shownProps, op.defaults);

	// page_id is unique across tombstones: a deleted collection of this page gives way.
	const stale = await all<{ id: string }>(db, 'SELECT id FROM collection WHERE page_id = ?', op.pageId);
	for (const s of stale) {
		await run(db, 'DELETE FROM view WHERE collection_id = ?', s.id);
		await run(db, 'DELETE FROM collection_member WHERE collection_id = ?', s.id);
		await run(db, 'DELETE FROM collection WHERE id = ?', s.id);
	}
	const def: CollectionDef = {
		id: op.id,
		pageId: op.pageId,
		sourceAst: op.sourceAst ?? null,
		shownProps: op.shownProps ?? [],
		defaults: op.defaults ?? {}
	};
	await run(
		db,
		'INSERT INTO collection (id, page_id, source_ast, shown_props, defaults_json) VALUES (?,?,?,?,?)',
		def.id,
		def.pageId,
		def.sourceAst ? JSON.stringify(def.sourceAst) : null,
		JSON.stringify(def.shownProps),
		JSON.stringify(def.defaults)
	);
	await run(db, 'UPDATE page SET is_database = 1 WHERE id = ?', op.pageId);
	return [{ kind: 'createCollection', page: def.pageId, prop: def.id, old: null, new: def }];
}

export async function updateCollection(db: WorkspaceDb, op: OpOf<'updateCollection'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	void ctx;
	const row = await loadCollectionRow(db, op.id);
	if (!row) return fail('unknown_collection', '/id', `Unknown collection "${op.id}"`);
	const registry = await loadEavRegistry(db);
	const old = collectionDefOf(row);
	if (op.sourceAst) checkSpec({ filter: op.sourceAst }, registry, '/sourceAst', true);
	checkShownAndDefaults(registry, op.shownProps, op.defaults);
	const next: CollectionDef = {
		...old,
		sourceAst: op.sourceAst !== undefined ? op.sourceAst : old.sourceAst,
		shownProps: op.shownProps ?? old.shownProps,
		defaults: op.defaults ?? old.defaults
	};
	if (JSON.stringify(next) === JSON.stringify(old)) return [];
	await run(
		db,
		'UPDATE collection SET source_ast = ?, shown_props = ?, defaults_json = ? WHERE id = ?',
		next.sourceAst ? JSON.stringify(next.sourceAst) : null,
		JSON.stringify(next.shownProps),
		JSON.stringify(next.defaults),
		op.id
	);
	return [{ kind: 'updateCollection', page: old.pageId, prop: old.id, old, new: next }];
}

export async function deleteCollection(db: WorkspaceDb, op: OpOf<'deleteCollection'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	const row = await loadCollectionRow(db, op.id);
	if (!row) return fail('unknown_collection', '/id', `Unknown collection "${op.id}"`);
	const stamp = [iso(ctx.now), ctx.actorId];
	await run(db, 'UPDATE collection SET deleted_at = ?, deleted_by = ? WHERE id = ?', ...stamp, op.id);
	await run(db, 'UPDATE view SET deleted_at = ?, deleted_by = ? WHERE collection_id = ? AND deleted_at IS NULL', ...stamp, op.id);
	await run(db, 'UPDATE page SET is_database = 0 WHERE id = ?', row.page_id);
	return [{ kind: 'deleteCollection', page: row.page_id, prop: row.id, old: collectionDefOf(row), new: null }];
}

// ───────────────────────────── members ─────────────────────────────

function checkRank(rank: string, path = '/rank'): void {
	if (!isRank(rank)) fail('invalid_rank', path, 'Not a valid rank key');
}

export async function addMember(db: WorkspaceDb, op: OpOf<'addMember'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	void ctx;
	checkRank(op.rank);
	if (!(await loadCollectionRow(db, op.collection))) fail('unknown_collection', '/collection', `Unknown collection "${op.collection}"`);
	if (!(await exists(db, 'page', op.page))) fail('unknown_page', '/page', `Unknown page "${op.page}"`);
	const [was] = await all<{ rank: string }>(db, 'SELECT rank FROM collection_member WHERE collection_id = ? AND page_id = ?', op.collection, op.page);
	if (was?.rank === op.rank) return [];
	await run(
		db,
		'INSERT INTO collection_member (collection_id, page_id, rank) VALUES (?,?,?) ON CONFLICT (collection_id, page_id) DO UPDATE SET rank = excluded.rank',
		op.collection,
		op.page,
		op.rank
	);
	return [{ kind: 'addMember', page: op.page, prop: op.collection, old: was?.rank ?? null, new: op.rank }];
}

export async function removeMember(db: WorkspaceDb, op: OpOf<'removeMember'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	void ctx;
	const [was] = await all<{ rank: string }>(db, 'SELECT rank FROM collection_member WHERE collection_id = ? AND page_id = ?', op.collection, op.page);
	if (!was) return [];
	await run(db, 'DELETE FROM collection_member WHERE collection_id = ? AND page_id = ?', op.collection, op.page);
	return [{ kind: 'removeMember', page: op.page, prop: op.collection, old: was.rank, new: null }];
}

export async function moveMember(db: WorkspaceDb, op: OpOf<'moveMember'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	void ctx;
	checkRank(op.rank);
	const [was] = await all<{ rank: string }>(db, 'SELECT rank FROM collection_member WHERE collection_id = ? AND page_id = ?', op.collection, op.page);
	if (!was) return fail('not_member', '/page', `Page "${op.page}" is not a member of "${op.collection}"`);
	if (was.rank === op.rank) return [];
	await run(db, 'UPDATE collection_member SET rank = ? WHERE collection_id = ? AND page_id = ?', op.rank, op.collection, op.page);
	return [{ kind: 'moveMember', page: op.page, prop: op.collection, old: was.rank, new: op.rank }];
}

// ───────────────────────────── views ─────────────────────────────

function checkColumns(registry: PropertyRegistry, columns: ViewDef['columns']): void {
	columns.columns.forEach((c, i) => {
		if (!registry.get(c.prop)) fail('unknown_property', `/columns/columns/${i}/prop`, `Unknown property "${c.prop}"`);
	});
	const o = columns.options;
	for (const key of ['coverProp', 'dateProp', 'endDateProp'] as const) {
		const id = o[key];
		if (id && !registry.get(id)) fail('unknown_property', `/columns/options/${key}`, `Unknown property "${id}"`);
	}
}

const viewParams = (d: ViewDef): unknown[] => [
	d.type,
	d.name,
	JSON.stringify(d.filter),
	JSON.stringify(d.sorts),
	d.groupBy ? JSON.stringify(d.groupBy) : null,
	JSON.stringify(d.columns),
	d.rank
];

export async function createView(db: WorkspaceDb, op: OpOf<'createView'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	void ctx;
	checkRank(op.rank);
	const registry = await loadEavRegistry(db);
	if (await exists(db, 'view', op.id)) fail('exists', '/id', `View "${op.id}" already exists`);
	const col = await loadCollectionRow(db, op.collectionId);
	if (!col) fail('unknown_collection', '/collectionId', `Unknown collection "${op.collectionId}"`);
	const spec: QuerySpec = {
		...(op.filter ? { filter: op.filter } : {}),
		...(op.sorts ? { sorts: op.sorts } : {}),
		...(op.groupBy ? { groupBy: op.groupBy } : {})
	};
	checkSpec(spec, registry, '');
	const columns = v.parse(viewColumnsSchema, op.columns ?? { columns: [] });
	checkColumns(registry, columns);
	const def: ViewDef = {
		id: op.id,
		collectionId: op.collectionId,
		type: op.type,
		name: op.name,
		filter: op.filter ?? { and: [] },
		sorts: op.sorts ?? [],
		groupBy: op.groupBy ?? null,
		columns,
		rank: op.rank
	};
	await run(
		db,
		'INSERT INTO view (id, collection_id, type, name, filter_ast, sorts, group_by, columns_json, rank) VALUES (?,?,?,?,?,?,?,?,?)',
		def.id,
		def.collectionId,
		...viewParams(def)
	);
	return [{ kind: 'createView', page: col!.page_id, prop: def.id, old: null, new: def }];
}

export async function updateView(db: WorkspaceDb, op: OpOf<'updateView'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	void ctx;
	const row = await loadViewRow(db, op.id);
	if (!row) return fail('unknown_view', '/id', `Unknown view "${op.id}"`);
	const registry = await loadEavRegistry(db);
	const old = viewDefOf(row);
	const spec: QuerySpec = {
		...(op.filter ? { filter: op.filter } : {}),
		...(op.sorts ? { sorts: op.sorts } : {}),
		...(op.groupBy ? { groupBy: op.groupBy } : {})
	};
	checkSpec(spec, registry, '');
	const columns = op.columns ? v.parse(viewColumnsSchema, op.columns) : old.columns;
	if (op.columns) checkColumns(registry, columns);
	const next: ViewDef = {
		...old,
		type: op.type ?? old.type,
		name: op.name ?? old.name,
		filter: op.filter ?? old.filter,
		sorts: op.sorts ?? old.sorts,
		groupBy: op.groupBy !== undefined ? op.groupBy : old.groupBy,
		columns
	};
	if (JSON.stringify(next) === JSON.stringify(old)) return [];
	await run(
		db,
		'UPDATE view SET type = ?, name = ?, filter_ast = ?, sorts = ?, group_by = ?, columns_json = ?, rank = ? WHERE id = ?',
		...viewParams(next),
		op.id
	);
	return [{ kind: 'updateView', page: await collectionPage(db, old.collectionId), prop: old.id, old, new: next }];
}

export async function moveView(db: WorkspaceDb, op: OpOf<'moveView'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	void ctx;
	checkRank(op.rank);
	const row = await loadViewRow(db, op.id);
	if (!row) return fail('unknown_view', '/id', `Unknown view "${op.id}"`);
	if (row.rank === op.rank) return [];
	await run(db, 'UPDATE view SET rank = ? WHERE id = ?', op.rank, op.id);
	const old = viewDefOf(row);
	return [{ kind: 'moveView', page: await collectionPage(db, old.collectionId), prop: old.id, old, new: { ...old, rank: op.rank } }];
}

export async function deleteView(db: WorkspaceDb, op: OpOf<'deleteView'>, ctx: EavOpContext): Promise<ChangeRecord[]> {
	const row = await loadViewRow(db, op.id);
	if (!row) return fail('unknown_view', '/id', `Unknown view "${op.id}"`);
	await run(db, 'UPDATE view SET deleted_at = ?, deleted_by = ? WHERE id = ?', iso(ctx.now), ctx.actorId, op.id);
	const old = viewDefOf(row);
	return [{ kind: 'deleteView', page: await collectionPage(db, old.collectionId), prop: old.id, old, new: null }];
}

async function collectionPage(db: WorkspaceDb, collectionId: string): Promise<string | null> {
	const [row] = await all<{ page_id: string }>(db, 'SELECT page_id FROM collection WHERE id = ?', collectionId);
	return row?.page_id ?? null;
}
