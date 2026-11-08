/**
 * Typed writes: replace one property's EAV rows for a page, keep `page.props_json` (and `page.title`)
 * and the per-value counts in step, and report old/new values. Everything goes through the caller's
 * transaction handle; there is no I/O besides its queries.
 */
import { applyValueOp, type ValueOp } from '../../../../lib/shared/ops';
import {
	CodecError,
	TITLE_PROP_ID,
	encodeValue,
	isReadOnlyProperty,
	normalizeValue,
	storageTable,
	validateValue,
	type EavRow,
	type EavTable,
	type PropValue,
	type PropertyDef,
	type TypedConfig
} from '../../../../lib/shared/property-types';
import { issue } from '../../../../lib/shared/result';
import type { Values } from '../../../../lib/shared/protocol';
import type { WorkspaceDb } from '../../../db/workspace.client';
import { forgetAiPages } from './ai';
import { CountDelta } from './counts';
import { EavError, throwIssues } from './errors';
import type { EavOpContext, ChangeRecord } from './index';
import { loadEavRegistry, type EavRegistry } from './registry';
import { EAV_TABLES } from './layout';
import { MAX_PARAMS, all, chunks, iso, qmarks, run } from './sql';

export interface PageRef {
	id: string;
	num: number;
	title: string;
	props: Record<string, PropValue | null>;
	deleted: boolean;
}

export async function loadPage(db: WorkspaceDb, id: string): Promise<PageRef | undefined> {
	const [row] = await all<{ id: string; num: number; title: string; props_json: string; deleted_at: string | null }>(
		db,
		'SELECT id, num, title, props_json, deleted_at FROM page WHERE id = ?',
		id
	);
	if (!row) return undefined;
	let props: Record<string, PropValue | null> = {};
	try {
		props = JSON.parse(row.props_json) as typeof props;
	} catch {
		/* corrupt props_json reads as empty; the next write rebuilds the touched keys */
	}
	return { id: row.id, num: row.num, title: row.title, props, deleted: row.deleted_at !== null };
}

/** Page ids to `page.num` (relation targets), any page state. */
export async function pageNums(db: WorkspaceDb, ids: readonly string[]): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	for (const part of chunks([...new Set(ids)], MAX_PARAMS)) {
		const rows = await all<{ id: string; num: number }>(db, `SELECT id, num FROM page WHERE id IN (${qmarks(part.length)})`, ...part);
		for (const r of rows) out.set(r.id, r.num);
	}
	return out;
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface StoredRow {
	v: string | number;
	v_end?: number | null;
}

/** Replaces the rows of (`prop`, `page`) in `table` with `rows`, touching only what differs. */
async function replaceRows(
	db: WorkspaceDb,
	table: EavTable,
	prop: number,
	page: number,
	rows: readonly EavRow[],
	counts: CountDelta
): Promise<void> {
	const isDate = table === 'p_date';
	const old = await all<StoredRow>(db, `SELECT v${isDate ? ', v_end' : ''} FROM ${table} WHERE page = ? AND prop = ?`, page, prop);
	const oldByKey = new Map(old.map((r) => [String(r.v), r]));
	const newByKey = new Map(rows.map((r) => [String(r.v), r]));

	const gone = old.filter((r) => !newByKey.has(String(r.v)));
	const fresh = rows.filter((r) => !oldByKey.has(String(r.v)));

	if (gone.length > 0 && gone.length === old.length) {
		await run(db, `DELETE FROM ${table} WHERE page = ? AND prop = ?`, page, prop);
	} else {
		for (const part of chunks(gone, MAX_PARAMS - 2))
			await run(
				db,
				`DELETE FROM ${table} WHERE prop = ? AND page = ? AND v IN (${qmarks(part.length)})`,
				prop,
				page,
				...part.map((r) => bindV(table, r.v))
			);
	}
	for (const r of gone) counts.add(prop, table, r.v, -1);

	const width = isDate ? 5 : 4;
	for (const part of chunks(fresh, Math.floor(MAX_PARAMS / width))) {
		const cols = isDate ? '(prop, v, v_end, page, computed)' : '(prop, v, page, computed)';
		await run(
			db,
			`INSERT INTO ${table} ${cols} VALUES ${part.map(() => `(${qmarks(width)})`).join(',')}`,
			...part.flatMap((r) =>
				isDate
					? [prop, r.v, r.v_end ?? null, page, r.computed ? 1 : 0]
					: [prop, bindV(table, r.v), page, r.computed ? 1 : 0]
			)
		);
	}
	for (const r of fresh) counts.add(prop, table, r.v, 1);

	if (isDate) {
		for (const r of rows) {
			const was = oldByKey.get(String(r.v));
			if (was && (was.v_end ?? null) !== (r.v_end ?? null))
				await run(db, 'UPDATE p_date SET v_end = ?, computed = ? WHERE prop = ? AND v = ? AND page = ?', r.v_end ?? null, r.computed ? 1 : 0, prop, r.v, page);
		}
	}
}

/** `p_ref.v` is a TEXT column (option ids, user ids, file ids and relation targets' `num` as text). */
const bindV = (table: EavTable, v: string | number): string | number => (table === 'p_ref' ? String(v) : v);

export interface ValueWrite {
	def: PropertyDef;
	/** The new, validated and normalized value. */
	next: PropValue | null;
}

/**
 * Applies already-validated writes to one page: EAV rows, counts, `props_json`, `page.title`, and the
 * page's `updated_*` columns (unless `touch` is false). Returns one record per property that changed.
 */
export async function writeValues(
	db: WorkspaceDb,
	page: PageRef,
	registry: EavRegistry,
	writes: readonly ValueWrite[],
	ctx: EavOpContext,
	touch = true
): Promise<ChangeRecord[]> {
	const targets: string[] = [];
	for (const w of writes) if (w.def.type === 'relation' && w.next !== null) targets.push(...(Array.isArray(w.next) ? w.next : [String(w.next)]));
	const nums = targets.length ? await pageNums(db, targets) : new Map<string, number>();
	const codec = { pageNum: (id: string) => nums.get(id) };

	const counts = new CountDelta();
	const changes: ChangeRecord[] = [];
	let title: string | undefined;
	for (const { def, next } of writes) {
		const prop = registry.num(def.id);
		if (prop === undefined) throw new EavError('unknown_property', `Unknown property "${def.id}"`);
		const old = page.props[def.id] ?? null;
		if (deepEqual(old, next)) continue;
		let rows: EavRow[];
		try {
			rows = encodeValue(def, next, codec);
		} catch (e) {
			if (e instanceof CodecError) throwIssues('invalid_value', [issue('', 'invalid_value', e.message)], `/${def.id}`);
			throw e;
		}
		// A property stores in one table; clearing needs it too, so ask the codec's type for it.
		const table = rows[0]?.table ?? tableOfEmpty(def);
		if (table) await replaceRows(db, table, prop, page.num, rows, counts);
		if (next === null) delete page.props[def.id];
		else page.props[def.id] = next;
		if (def.id === TITLE_PROP_ID) title = typeof next === 'string' ? next : '';
		changes.push({ kind: 'setProp', page: page.id, prop: def.id, old, new: next });
	}
	if (changes.length === 0) return changes;
	await counts.flush(db);
	const set = ['props_json = ?'];
	const params: unknown[] = [JSON.stringify(page.props)];
	if (title !== undefined) {
		set.push('title = ?');
		params.push(title);
		page.title = title;
	}
	if (touch) {
		set.push('updated_at = ?', 'updated_by = ?');
		params.push(iso(ctx.now), ctx.actorId);
	}
	await run(db, `UPDATE page SET ${set.join(', ')} WHERE id = ?`, ...params, page.id);
	return changes;
}

function tableOfEmpty(def: PropertyDef): EavTable | undefined {
	const t = storageTable(def as TypedConfig);
	return t === 'page' ? undefined : t;
}

/** Validates a client write against its definition and the current value; returns the normalized value. */
export function checkWrite(
	def: PropertyDef,
	current: PropValue | null,
	input: { kind: 'set'; value: unknown } | { kind: 'value-op'; op: ValueOp }
): PropValue | null {
	if (isReadOnlyProperty(def)) throwIssues('read_only', [issue('', 'read_only', `${def.type} properties cannot be written`)], '/prop');
	if (def.type === 'relation' && def.config.reverseOf)
		throwIssues('read_only', [issue('', 'read_only', 'The reverse side of a two-way relation is computed: edit the relation')], '/prop');
	let next: PropValue | null;
	if (input.kind === 'value-op') {
		const r = applyValueOp(def, current, input.op);
		if (!r.ok) throwIssues('invalid_value', r.issues, input.op.op === 'setProp' ? '/value' : '/option');
		next = r.value;
	} else {
		const checked = validateValue(def, input.value);
		if (!checked.ok) throwIssues('invalid_value', checked.issues, '/value');
		next = normalizeValue(def, checked.value);
	}
	if (def.type === 'relation' && def.config.limit === 'one' && Array.isArray(next) && next.length > 1)
		throwIssues('invalid_value', [issue('', 'too_many', 'This relation holds at most one page')], '/value');
	return next;
}

/** `setProp`, `addOption` and `removeOption`. */
export async function applyValueOpTx(db: WorkspaceDb, op: ValueOp, ctx: EavOpContext): Promise<ChangeRecord[]> {
	const registry = await loadEavRegistry(db);
	const def = registry.get(op.prop);
	if (!def) throwIssues('unknown_property', [issue('/prop', 'unknown_property', `Unknown property "${op.prop}"`)]);
	const page = await loadPage(db, op.page);
	if (!page) throw new EavError('unknown_page', `Unknown page "${op.page}"`, [issue('/page', 'unknown_page', `Unknown page "${op.page}"`)]);
	if (page.deleted) throw new EavError('page_deleted', `Page "${op.page}" is in the trash`, [issue('/page', 'page_deleted', 'The page is in the trash')]);
	const current = page.props[op.prop] ?? null;
	const next = checkWrite(def, current, { kind: 'value-op', op });
	return writeValues(db, page, registry, [{ def: def, next }], ctx);
}

/** Initial values of a newly created page (`create.values`), in one props_json write. */
export async function writeInitialValuesTx(
	db: WorkspaceDb,
	pageId: string,
	values: Values,
	ctx: EavOpContext
): Promise<ChangeRecord[]> {
	const registry = await loadEavRegistry(db);
	const page = await loadPage(db, pageId);
	if (!page) throw new EavError('unknown_page', `Unknown page "${pageId}"`, [issue('/id', 'unknown_page', `Unknown page "${pageId}"`)]);
	const writes: ValueWrite[] = [];
	for (const [propId, value] of Object.entries(values)) {
		const def = registry.get(propId);
		if (!def) throwIssues('unknown_property', [issue(`/values/${propId}`, 'unknown_property', `Unknown property "${propId}"`)]);
		let next: PropValue | null;
		try {
			next = checkWrite(def, page.props[propId] ?? null, { kind: 'set', value });
		} catch (e) {
			if (e instanceof EavError) throwIssues(e.code, e.issues.map((i) => ({ ...i, path: '' })), `/values/${propId}`);
			throw e;
		}
		writes.push({ def: def, next });
	}
	// The creating op already set created/updated columns.
	return writeValues(db, page, registry, writes, ctx, false);
}

/**
 * Writes a computed value (rollup, formula, AI): same replace-and-count path with `computed = 1` rows,
 * for the P2 engine. Not a client op.
 */
export async function writeComputedValue(
	db: WorkspaceDb,
	pageId: string,
	propId: string,
	value: PropValue | null,
	ctx: EavOpContext
): Promise<ChangeRecord[]> {
	const registry = await loadEavRegistry(db);
	const def = registry.get(propId);
	if (!def || (def.type !== 'rollup' && def.type !== 'formula' && def.type !== 'ai'))
		throw new EavError('not_computed', `"${propId}" is not a computed property`);
	const page = await loadPage(db, pageId);
	if (!page) throw new EavError('unknown_page', `Unknown page "${pageId}"`);
	const checked = validateValue(def, value);
	if (!checked.ok) throwIssues('invalid_value', checked.issues, '/value');
	return writeValues(db, page, registry, [{ def, next: normalizeValue(def, checked.ok ? checked.value : null) }], ctx, false);
}

/** Pages (ids) whose `prop` row points at `targetPageId`: the reverse side of a relation, a range scan. */
export async function reverseRelation(db: WorkspaceDb, propId: string, targetPageId: string): Promise<string[]> {
	const registry = await loadEavRegistry(db);
	const prop = registry.num(propId);
	if (prop === undefined) return [];
	const [target] = await all<{ num: number }>(db, 'SELECT num FROM page WHERE id = ?', targetPageId);
	if (!target) return [];
	const rows = await all<{ id: string }>(
		db,
		'SELECT page.id AS id FROM p_ref JOIN page ON page.num = p_ref.page WHERE p_ref.prop = ? AND p_ref.v = ? ORDER BY page.num',
		prop,
		String(target.num)
	);
	return rows.map((r) => r.id);
}

/**
 * Removes every trace of a page from the EAV side (for the purge): its rows and their counts, relation
 * rows of other pages that point at it (and the matching `props_json` entries), and its collection
 * memberships. Call inside the purge transaction, before deleting the `page` row.
 */
export async function purgePageEav(db: WorkspaceDb, pageId: string, ctx: EavOpContext): Promise<ChangeRecord[]> {
	const [page] = await all<{ num: number }>(db, 'SELECT num FROM page WHERE id = ?', pageId);
	if (!page) return [];
	const registry = await loadEavRegistry(db);
	const changes: ChangeRecord[] = [];
	// Relations pointing at the page, via the reverse scan.
	for (const def of registry.all()) {
		if (def.type !== 'relation') continue;
		for (const holder of await reverseRelation(db, def.id, pageId)) {
			const holderPage = await loadPage(db, holder);
			if (!holderPage) continue;
			const current = holderPage.props[def.id];
			if (!Array.isArray(current)) continue;
			const next = current.filter((x) => x !== pageId);
			changes.push(
				...(await writeValues(db, holderPage, registry, [{ def, next: next.length ? next : null }], ctx, false))
			);
		}
	}
	// Its own rows.
	const counts = new CountDelta();
	for (const table of EAV_TABLES) {
		const rows = await all<{ prop: number; v: string | number }>(db, `SELECT prop, v FROM ${table} WHERE page = ?`, page.num);
		for (const r of rows) counts.add(r.prop, table, r.v, -1);
		if (rows.length) await run(db, `DELETE FROM ${table} WHERE page = ?`, page.num);
	}
	await counts.flush(db);
	await run(db, 'DELETE FROM collection_member WHERE page_id = ?', pageId);
	await forgetAiPages(db, pageId);
	return changes;
}
