/**
 * EAV seam between the Sync core (mutation path) and the Databases track (typed EAV, property
 * registry, typed writes with props_json, per-value counts). Owner: Databases. Signatures are fixed;
 * Sync core calls them inside its `apply()` transaction and turns the returned records into `change`
 * rows and subscription diffs.
 */
import type { Op, ValueOp } from '../../../../lib/shared/ops';
import type { PropertyRegistry } from '../../../../lib/shared/property-types';
import type { Values } from '../../../../lib/shared/protocol';
import type { WorkspaceDb, WorkspaceTx } from '../../../db/workspace.client';
import {
	addMember,
	createCollection,
	createProperty,
	createView,
	deleteCollection,
	deleteProperty,
	deleteView,
	moveMember,
	moveView,
	removeMember,
	updateCollection,
	updateProperty,
	updateView
} from './definitions';
import { afterWriteImpl } from './propagate';
import { recomputeNowFormulasImpl } from './now';
import { decorateValues } from './relations';
import { loadEavRegistry, invalidateRegistry as invalidate } from './registry';
import { MAX_PARAMS, all, chunks, qmarks } from './sql';
import { applyValueOpTx, writeInitialValuesTx } from './values';


/** Ops the EAV module applies: value ops plus property/collection/view definition ops. */
export type EavOp = Extract<
	Op,
	{
		op:
			| ValueOp['op']
			| 'createProperty'
			| 'updateProperty'
			| 'deleteProperty'
			| 'createCollection'
			| 'updateCollection'
			| 'deleteCollection'
			| 'addMember'
			| 'removeMember'
			| 'moveMember'
			| 'createView'
			| 'updateView'
			| 'moveView'
			| 'deleteView';
	}
>;

export const EAV_OP_NAMES: ReadonlySet<string> = new Set<EavOp['op']>([
	'setProp',
	'addOption',
	'removeOption',
	'createProperty',
	'updateProperty',
	'deleteProperty',
	'createCollection',
	'updateCollection',
	'deleteCollection',
	'addMember',
	'removeMember',
	'moveMember',
	'createView',
	'updateView',
	'moveView',
	'deleteView'
]);

export const isEavOp = (op: Op): op is EavOp => EAV_OP_NAMES.has(op.op);

export interface EavOpContext {
	actorId: string;
	now: number;
}

/** One logical change, appended by the Sync core as a `change` row (old/new are JSON-serializable). */
export interface ChangeRecord {
	kind: string;
	/** Page id, when the change is about a page. */
	page: string | null;
	/** Property id (or collection/view id for definition changes). */
	prop: string | null;
	old: unknown;
	new: unknown;
}

/**
 * Load (and cache per transaction/object) the workspace property registry: the live rows of `property`
 * plus the built-in title. The cache is keyed by the db handle and dropped by {@link invalidateRegistry}.
 */
export async function loadRegistry(db: WorkspaceDb): Promise<PropertyRegistry> {
	return loadEavRegistry(db);
}

/** Drop any cached registry (call after a definition op commits or on rollback). */
export function invalidateRegistry(): void {
	invalidate();
}

/**
 * Apply one EAV op inside the caller's transaction: typed EAV rows, `page.props_json` (and `page.title`
 * for the title property), per-value counts, registry/collection/view rows. Throws {@link EavError} on
 * invalid input; the caller rolls the transaction back (and calls `invalidateRegistry()`).
 */
export async function applyEavOp(tx: WorkspaceTx, op: EavOp, ctx: EavOpContext): Promise<ChangeRecord[]> {
	switch (op.op) {
		case 'setProp':
		case 'addOption':
		case 'removeOption':
			return applyValueOpTx(tx, op, ctx);
		case 'createProperty':
			return createProperty(tx, op, ctx);
		case 'updateProperty':
			return updateProperty(tx, op, ctx);
		case 'deleteProperty':
			return deleteProperty(tx, op, ctx);
		case 'createCollection':
			return createCollection(tx, op, ctx);
		case 'updateCollection':
			return updateCollection(tx, op, ctx);
		case 'deleteCollection':
			return deleteCollection(tx, op, ctx);
		case 'addMember':
			return addMember(tx, op, ctx);
		case 'removeMember':
			return removeMember(tx, op, ctx);
		case 'moveMember':
			return moveMember(tx, op, ctx);
		case 'createView':
			return createView(tx, op, ctx);
		case 'updateView':
			return updateView(tx, op, ctx);
		case 'moveView':
			return moveView(tx, op, ctx);
		case 'deleteView':
			return deleteView(tx, op, ctx);
	}
}

/** Initialise EAV values for a newly created page (create op `values`), inside the same transaction. */
export function writeInitialValues(
	tx: WorkspaceTx,
	pageId: string,
	values: Values,
	ctx: EavOpContext
): Promise<ChangeRecord[]> {
	return writeInitialValuesTx(tx, pageId, values, ctx);
}

/**
 * Read display values (from `props_json`, live properties only) for pages. Unknown pages are absent. Relations
 * to tombstones read as gone (the dead ids are dropped; a relation left with no live target is `null`, a to-one
 * relation to a deleted page: "Deleted page"), and a two-way relation's synthetic reverse property is filled in
 * by a range scan of `p_ref` on `(prop, v)`.
 */
export async function readValues(db: WorkspaceDb, pageIds: string[]): Promise<Map<string, Values>> {
	const out = new Map<string, Values>();
	if (pageIds.length === 0) return out;
	const registry = await loadEavRegistry(db);
	const rows: { id: string; num: number; values: Values }[] = [];
	for (const part of chunks([...new Set(pageIds)], MAX_PARAMS)) {
		const found = await all<{ id: string; num: number; props_json: string }>(
			db,
			`SELECT id, num, props_json FROM page WHERE id IN (${qmarks(part.length)})`,
			...part
		);
		for (const r of found) {
			let props: Values = {};
			try {
				props = JSON.parse(r.props_json) as Values;
			} catch {
				/* reads as empty */
			}
			const live: Values = {};
			for (const [k, val] of Object.entries(props)) if (registry.get(k)) live[k] = val;
			rows.push({ id: r.id, num: r.num, values: live });
		}
	}
	await decorateValues(db, registry, rows);
	for (const r of rows) out.set(r.id, r.values);
	return out;
}

export { EavError, isEavError } from './errors';
export { TITLE_NUM, loadEavRegistry, primeRegistry, type EavRegistry } from './registry';
export { selectivity, valueCountOf, totalCountOf } from './counts';
export { defaultsForView, defaultsForCollection, deriveDefaults, type ViewDefaults } from './defaults';
export { ensureEavLayout } from './layout';
export { usesNow } from './now';
export { decorateValues, liveIds } from './relations';
export { ensureDependencyTable } from './dependency';
export { reverseRelation, purgePageEav, writeComputedValue } from './values';
export {
	readProperties,
	readCollection,
	readViews,
	readCollectionOfPage,
	readMembers
} from './read';

// ───────────────────────────── P3 seams (owner: Databases) ─────────────────────────────

/**
 * Called by the Sync core inside `apply()`'s transaction after all ops of a batch ran, with every
 * record they produced. Recomputes rollups and formulas of the pages that depend on the written properties and
 * returns the extra records, so they flow through the same live loop (`seq`, subscriptions, search).
 *
 * Algorithm (`propagate.ts`): each record marks (property, page) pairs dirty through the `dependency` graph (the
 * same page for formulas; the pages the reverse relation scan leads to for rollups), then the computed
 * properties are visited by topological rank: recompute the dirty pages, write computed rows where the value
 * changed, and mark the dependents of the pages that changed. A chain settles in one pass and an unchanged value
 * stops it. Handled records: `setProp` (relation edits included, with the former targets), `create`, `trash` and
 * `restore` (rollups skip tombstones), `updateProperty` (option renames). Definition ops compute their own
 * property when they run. AI-property invalidation markers are not part of this phase.
 */
export async function afterWrite(tx: WorkspaceTx, records: ChangeRecord[], ctx: EavOpContext): Promise<ChangeRecord[]> {
	return afterWriteImpl(tx, records, ctx);
}

/**
 * Called hourly by the Workspace DO alarm (Sync core) outside any open transaction: recompute
 * formulas that read `now()` (and what depends on them) on the live pages, in one transaction, and return the
 * change records to publish.
 */
export async function recomputeNowFormulas(db: WorkspaceDb, ctx: EavOpContext): Promise<ChangeRecord[]> {
	return recomputeNowFormulasImpl(db, ctx);
}
