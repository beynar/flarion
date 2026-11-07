/**
 * Page ops of the mutation path (the Sync core owns these; value and definition ops are the Databases
 * track's, in `eav/`): `create`, `move`, `setPage`, `trash`, `restore`. Each runs inside `apply`'s
 * transaction and returns the {@link ChangeRecord}s that become `change` rows.
 *
 * `trash` and `restore` are basic: the whole subtree is stamped with one `deleted_at` and `trash_root`
 * (docs/PLAN.md "Deleting a subtree"); P3 adds the Trash screen's listing, purge and teamspace restore.
 */
import type { CreateOp, MoveOp, Op } from '../../../lib/shared/ops';
import { isRank } from '../../../lib/shared/sort-keys';
import type { WorkspaceTx } from '../../db/workspace.client';
import type { AccessLevel } from '../../db/workspace.schema';
import { invalid, WorkspaceError } from './errors';
import { writeInitialValues, type ChangeRecord } from './eav';
import { isoTime, LIVE_SUBTREE_CTE, rawAll, rawRun, SUBTREE_CTE } from './util';

export interface PageOpEnv {
	actorId: string;
	now: number;
	/** The next dense page number; never reused. */
	allocateNum(): Promise<number>;
	/** Called before an op changes the children of `parentId` (null: the root level), to track `$hasChildren`. */
	noteParent(parentId: string | null): Promise<void>;
}

export type PageOp = Extract<Op, { op: 'create' | 'move' | 'setPage' | 'trash' | 'restore' }>;
export const PAGE_OP_NAMES: ReadonlySet<string> = new Set(['create', 'move', 'setPage', 'trash', 'restore']);
export const isPageOp = (op: Op): op is PageOp => PAGE_OP_NAMES.has(op.op);

interface PageRow {
	id: string;
	num: number;
	parentId: string | null;
	rank: string;
	teamspaceId: string | null;
	icon: string | null;
	cover: string | null;
	isDatabase: boolean;
	deletedAt: Date | null;
	trashRoot: string | null;
}

const PAGE_SELECT = {
	id: true,
	num: true,
	parentId: true,
	rank: true,
	teamspaceId: true,
	icon: true,
	cover: true,
	isDatabase: true,
	deletedAt: true,
	trashRoot: true
} as const;

async function loadPage(tx: WorkspaceTx, id: string): Promise<PageRow | null> {
	return (await tx.page.findUnique({ where: { id }, select: PAGE_SELECT })) as PageRow | null;
}

async function livePage(tx: WorkspaceTx, id: string, path: string): Promise<PageRow> {
	const page = await loadPage(tx, id);
	if (!page || page.deletedAt) throw invalid(path, 'not_found', `Page "${id}" does not exist`);
	return page;
}

/**
 * A governed update that matches no row the actor may change does nothing, silently: so writes that matter
 * ask first. (A governed `create` throws on its own.)
 */
async function assertCan(tx: WorkspaceTx, id: string, level: AccessLevel, what: string): Promise<void> {
	const can = (await (tx.page as unknown as { can(a: AccessLevel, w: { id: string }): Promise<boolean> }).can(level, { id })) as boolean;
	if (!can) throw new WorkspaceError('FORBIDDEN', `You do not have access to ${what}`);
}

async function assertTeamspace(tx: WorkspaceTx, id: string | null, path: string): Promise<void> {
	if (id === null) return;
	// Raw: whether the teamspace exists is not the caller's to read (a guest cannot list teamspaces).
	const ts = (await rawAll<{ deleted_at: string | null }>(tx, 'SELECT deleted_at FROM teamspace WHERE id = ?', id))[0];
	if (!ts || ts.deleted_at) throw invalid(path, 'not_found', `Teamspace "${id}" does not exist`);
}

/** Whether `ancestor` is `id` itself or one of its ancestors. */
async function isSelfOrAncestor(tx: WorkspaceTx, ancestor: string, id: string): Promise<boolean> {
	const rows = await rawAll<{ hit: number }>(
		tx,
		`WITH RECURSIVE anc(id) AS (
			SELECT ?
			UNION ALL
			SELECT p.parent_id FROM page p JOIN anc ON p.id = anc.id WHERE p.parent_id IS NOT NULL
		) SELECT 1 AS hit FROM anc WHERE id = ? LIMIT 1`,
		id,
		ancestor
	);
	return rows.length > 0;
}

export async function applyPageOp(tx: WorkspaceTx, op: PageOp, env: PageOpEnv): Promise<ChangeRecord[]> {
	switch (op.op) {
		case 'create':
			return createPage(tx, op, env);
		case 'move':
			return movePage(tx, op, env);
		case 'setPage':
			return setPage(tx, op, env);
		case 'trash':
			return trashPage(tx, op.page, env);
		case 'restore':
			return restorePage(tx, op.page, env);
	}
}

async function createPage(tx: WorkspaceTx, op: CreateOp, env: PageOpEnv): Promise<ChangeRecord[]> {
	if (await loadPage(tx, op.id)) throw invalid('/id', 'exists', `Page "${op.id}" already exists`);
	if (!isRank(op.rank)) throw invalid('/rank', 'bad_rank', 'Not a valid rank key');
	let teamspaceId: string | null = op.teamspaceId ?? null;
	if (op.parentId !== null) {
		const parent = await livePage(tx, op.parentId, '/parentId');
		// The teamspace is copied down the subtree: a child cannot live elsewhere than its parent.
		if (op.teamspaceId !== undefined && op.teamspaceId !== parent.teamspaceId) {
			throw invalid('/teamspaceId', 'teamspace_mismatch', 'A subpage belongs to its parent\'s teamspace');
		}
		teamspaceId = parent.teamspaceId;
	}
	await assertTeamspace(tx, teamspaceId, '/teamspaceId');
	await env.noteParent(op.parentId);

	const num = await env.allocateNum();
	// A raw INSERT: viborm's governed `create` also asks to READ the teamspace the row references, which a guest
	// (or a member shared one page of a private teamspace) cannot. Placement was checked by `authorizeOp`
	// (`create` in authorize.ts: the policy's `pageCreate` rule), before this runs.
	const stamp = isoTime(env.now);
	await rawRun(
		tx,
		`INSERT INTO page (id, num, parent_id, rank, teamspace_id, title, icon, cover, is_database, created_by, created_at, updated_by, updated_at, props_json)
		 VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, '{}')`,
		op.id,
		num,
		op.parentId,
		op.rank,
		teamspaceId,
		op.icon ?? null,
		op.cover ?? null,
		op.isDatabase ? 1 : 0,
		env.actorId,
		stamp,
		env.actorId,
		stamp
	);
	const records: ChangeRecord[] = [
		{
			kind: 'create',
			page: op.id,
			prop: null,
			old: null,
			new: {
				num,
				parentId: op.parentId,
				rank: op.rank,
				teamspaceId,
				icon: op.icon ?? null,
				cover: op.cover ?? null,
				isDatabase: op.isDatabase ?? false
			}
		}
	];
	if (op.values && Object.keys(op.values).length > 0) {
		records.push(...(await writeInitialValues(tx, op.id, op.values, { actorId: env.actorId, now: env.now })));
	}
	return records;
}

async function movePage(tx: WorkspaceTx, op: MoveOp, env: PageOpEnv): Promise<ChangeRecord[]> {
	const page = await livePage(tx, op.page, '/page');
	if (!isRank(op.rank)) throw invalid('/rank', 'bad_rank', 'Not a valid rank key');
	let teamspaceId = page.teamspaceId;
	if (op.parentId !== null) {
		const parent = await livePage(tx, op.parentId, '/parentId');
		if (await isSelfOrAncestor(tx, op.page, op.parentId)) {
			throw invalid('/parentId', 'cycle', 'A page cannot move into its own subtree');
		}
		if (op.teamspaceId !== undefined && op.teamspaceId !== parent.teamspaceId) {
			throw invalid('/teamspaceId', 'teamspace_mismatch', 'A subpage belongs to its parent\'s teamspace');
		}
		teamspaceId = parent.teamspaceId;
	} else if (op.teamspaceId !== undefined) {
		teamspaceId = op.teamspaceId;
	}
	await assertTeamspace(tx, teamspaceId, '/teamspaceId');
	await env.noteParent(page.parentId);
	await env.noteParent(op.parentId);

	// A raw UPDATE, like the INSERT of `createPage`: viborm's governed update would also ask to read the new
	// parent and teamspace rows. `authorizeOp` already asked what the policy asks: `update` on the page for a
	// reorder, `full` to change its parent or teamspace, `update` on the destination page, or a place to add
	// pages (a teamspace the mover edits in, their own Private section; admins anywhere).
	await rawRun(
		tx,
		'UPDATE page SET parent_id = ?, rank = ?, teamspace_id = ?, updated_by = ?, updated_at = ? WHERE id = ?',
		op.parentId,
		op.rank,
		teamspaceId,
		env.actorId,
		isoTime(env.now),
		page.id
	);
	if (teamspaceId !== page.teamspaceId) {
		// Rewrite the teamspace across the whole subtree (tombstones included, so a restore stays consistent).
		await rawRun(
			tx,
			`${SUBTREE_CTE} UPDATE page SET teamspace_id = ? WHERE id IN (SELECT id FROM sub) AND id <> ?`,
			page.id,
			teamspaceId,
			page.id
		);
	}
	return [
		{
			kind: 'move',
			page: page.id,
			prop: null,
			old: { parentId: page.parentId, rank: page.rank, teamspaceId: page.teamspaceId },
			new: { parentId: op.parentId, rank: op.rank, teamspaceId }
		}
	];
}

async function setPage(
	tx: WorkspaceTx,
	op: Extract<Op, { op: 'setPage' }>,
	env: PageOpEnv
): Promise<ChangeRecord[]> {
	const page = await livePage(tx, op.page, '/page');
	await assertCan(tx, page.id, 'update', 'edit this page');
	const data: { icon?: string | null; cover?: string | null } = {};
	const before: Record<string, unknown> = {};
	const after: Record<string, unknown> = {};
	if (op.icon !== undefined && op.icon !== page.icon) {
		data.icon = op.icon;
		before.icon = page.icon;
		after.icon = op.icon;
	}
	if (op.cover !== undefined && op.cover !== page.cover) {
		data.cover = op.cover;
		before.cover = page.cover;
		after.cover = op.cover;
	}
	if (Object.keys(data).length === 0) return [];
	await tx.page.update({
		where: { id: page.id },
		data: { ...data, updatedById: env.actorId, updatedAt: new Date(env.now) }
	});
	return [{ kind: 'setPage', page: page.id, prop: null, old: before, new: after }];
}

async function trashPage(tx: WorkspaceTx, id: string, env: PageOpEnv): Promise<ChangeRecord[]> {
	const page = await loadPage(tx, id);
	if (!page) throw invalid('/page', 'not_found', `Page "${id}" does not exist`);
	if (page.deletedAt) return []; // already in the trash: idempotent
	await env.noteParent(page.parentId);
	const stamp = isoTime(env.now);
	await rawRun(
		tx,
		`${LIVE_SUBTREE_CTE} UPDATE page SET deleted_at = ?, deleted_by = ?, trash_root = ? WHERE id IN (SELECT id FROM sub)`,
		page.id,
		stamp,
		env.actorId,
		page.id
	);
	const count = await rawAll<{ n: number }>(tx, 'SELECT COUNT(*) AS n FROM page WHERE trash_root = ?', page.id);
	return [
		{
			kind: 'trash',
			page: page.id,
			prop: null,
			old: { parentId: page.parentId, rank: page.rank, teamspaceId: page.teamspaceId },
			new: { deletedAt: stamp, pageCount: count[0]?.n ?? 1 }
		}
	];
}

async function restorePage(tx: WorkspaceTx, id: string, env: PageOpEnv): Promise<ChangeRecord[]> {
	const page = await loadPage(tx, id);
	if (!page) throw invalid('/page', 'not_found', `Page "${id}" does not exist`);
	if (!page.deletedAt) return []; // already live: idempotent
	if (page.trashRoot !== page.id) {
		throw invalid('/page', 'not_trash_root', 'Only the page that was moved to the trash can be restored');
	}
	let parentId = page.parentId;
	if (parentId) {
		const parent = await loadPage(tx, parentId);
		if (!parent || parent.deletedAt) parentId = null; // the parent is still in the trash: restore to the root
	}
	await env.noteParent(parentId);
	await tx.page.updateMany({
		where: { trashRoot: page.id },
		data: { deletedAt: null, deletedById: null, trashRoot: null }
	});
	if (parentId !== page.parentId) {
		await tx.page.update({ where: { id: page.id }, data: { parentId } });
	}
	await tx.page.update({ where: { id: page.id }, data: { updatedById: env.actorId, updatedAt: new Date(env.now) } });
	return [
		{
			kind: 'restore',
			page: page.id,
			prop: null,
			old: null,
			new: { parentId, rank: page.rank, teamspaceId: page.teamspaceId }
		}
	];
}

/** Everything under (and including) `id`, from live state: used after the commit to expand subtree changes. */
export async function subtreeIds(db: WorkspaceTx, id: string): Promise<string[]> {
	return (await rawAll<{ id: string }>(db, `${SUBTREE_CTE} SELECT id FROM sub`, id)).map((r) => r.id);
}
