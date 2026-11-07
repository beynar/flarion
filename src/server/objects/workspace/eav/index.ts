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

/** Load (and cache per transaction/object) the workspace property registry. */
export async function loadRegistry(_db: WorkspaceDb): Promise<PropertyRegistry> {
	throw new Error('eav.loadRegistry not implemented');
}

/** Drop any cached registry (call after a definition op commits or on rollback). */
export function invalidateRegistry(): void {}

/**
 * Apply one EAV op inside the caller's transaction: typed EAV rows, `page.props_json` (and `page.title`
 * for the title property), per-value counts, registry/collection/view rows. Throws on invalid input.
 */
export async function applyEavOp(_tx: WorkspaceTx, _op: EavOp, _ctx: EavOpContext): Promise<ChangeRecord[]> {
	throw new Error('eav.applyEavOp not implemented');
}

/** Initialise EAV values for a newly created page (create op `values`), inside the same transaction. */
export async function writeInitialValues(
	_tx: WorkspaceTx,
	_pageId: string,
	_values: Values,
	_ctx: EavOpContext
): Promise<ChangeRecord[]> {
	throw new Error('eav.writeInitialValues not implemented');
}

/** Read display values (from `props_json`) for pages. */
export async function readValues(_db: WorkspaceDb, _pageIds: string[]): Promise<Map<string, Values>> {
	throw new Error('eav.readValues not implemented');
}
