/**
 * Authorization of the ops of a batch, inside the commit's governed transaction (`db.$as(actor)`).
 *
 * viborm enforces the policy on every governed model call: `tx.page.create` (placement), `tx.page.update`
 * (levels, and `full` for `parentId`/`teamspaceId`), `tx.grant.*` and the teamspace models. What it cannot
 * see is raw SQL and the open bookkeeping models (EAV tables, registry, collections, views): the ops that
 * write through them assert the page-level right first, here.
 *
 * A page the actor cannot read does not exist for them: the op fails with the same `not_found` issue as a
 * page that is not there, so ids cannot be probed.
 */
import type { Op } from '../../../lib/shared/ops';
import type { AccessLevel } from '../../db/workspace.schema';
import type { GovernedTx } from './access';
import { invalid, WorkspaceError } from './errors';
import { rawAll } from './util';

export interface OpAuthorizer {
	/** Authorizes one op against the transaction as it stands (earlier ops of the batch applied). */
	check(tx: GovernedTx, op: Op): Promise<void>;
}

type Levels = Record<AccessLevel, boolean>;

const forbidden = (what: string) => new WorkspaceError('FORBIDDEN', `You do not have access to ${what}`);

export interface AuthorizerOptions {
	role: 'owner' | 'admin' | 'member' | 'guest' | 'anonymous';
	userId?: string;
	/** Teamspaces where the actor holds `update` (the policy's own `teamspaces.update` fact). */
	updatableTeamspaces: readonly string[];
}

export function createAuthorizer(options: AuthorizerOptions): OpAuthorizer {
	const admin = options.role === 'owner' || options.role === 'admin';
	const guest = options.role === 'guest' || options.role === 'anonymous';
	/** Levels per page, valid until the batch changes the tree. */
	let cache = new Map<string, Levels>();

	async function levels(tx: GovernedTx, id: string, path: string): Promise<Levels> {
		const hit = cache.get(id);
		if (hit) return hit;
		const got = (await tx.page.can(['read', 'comment', 'update', 'full'], { id })) as Levels;
		if (!got.read) throw invalid(path, 'not_found', `Page "${id}" does not exist`);
		cache.set(id, got);
		return got;
	}

	async function need(tx: GovernedTx, id: string, level: AccessLevel, path: string, what: string): Promise<void> {
		const got = await levels(tx, id, path);
		if (!got[level]) throw forbidden(what);
	}

	/** The page a collection or a view belongs to (null: unknown, the op fails on its own). */
	async function pageOfCollection(tx: GovernedTx, collectionId: string): Promise<string | null> {
		const rows = await rawAll<{ page_id: string }>(tx, 'SELECT page_id FROM collection WHERE id = ?', collectionId);
		return rows[0]?.page_id ?? null;
	}
	async function pageOfView(tx: GovernedTx, viewId: string): Promise<string | null> {
		const rows = await rawAll<{ page_id: string }>(
			tx,
			'SELECT c.page_id AS page_id FROM view v JOIN collection c ON c.id = v.collection_id WHERE v.id = ?',
			viewId
		);
		return rows[0]?.page_id ?? null;
	}

	async function check(tx: GovernedTx, op: Op): Promise<void> {
		switch (op.op) {
			case 'create': {
				// Placement: the policy's `pageCreate` rule (db/policy.ts), asked here because the row is inserted
				// raw (see `createPage`): under a page the caller can edit, at the root of a teamspace where they
				// can edit (admins: any), or at the root of their own Private section (not for guests).
				if (op.parentId !== null) {
					// A parent in the trash is "not there" for the op itself to report, whatever the caller may do with it.
					const parent = (await rawAll<{ deleted_at: string | null }>(tx, 'SELECT deleted_at FROM page WHERE id = ?', op.parentId))[0];
					if (parent?.deleted_at) return;
					await need(tx, op.parentId, 'update', '/parentId', 'add pages inside this page');
				} else {
					const teamspaceId = op.teamspaceId ?? null;
					const allowed =
						admin ||
						(teamspaceId !== null && options.updatableTeamspaces.includes(teamspaceId)) ||
						(teamspaceId === null && !guest && !!options.userId);
					if (!allowed) throw forbidden(teamspaceId === null ? 'create pages here' : 'add pages to this teamspace');
				}
				cache = new Map();
				return;
			}
			case 'move': {
				const rows = await rawAll<{ parent_id: string | null; teamspace_id: string | null; created_by: string }>(
					tx,
					'SELECT parent_id, teamspace_id, created_by FROM page WHERE id = ?',
					op.page
				);
				const from = rows[0];
				if (!from) return; // the op reports the missing page itself
				const got = await levels(tx, op.page, '/page');
				const reparents = op.parentId !== from.parent_id || (op.teamspaceId !== undefined && op.teamspaceId !== from.teamspace_id);
				// Reordering among the same siblings needs to edit the page; changing parent or teamspace needs `full`.
				if (!got[reparents ? 'full' : 'update']) throw forbidden(reparents ? 'move this page' : 'edit this page');
				if (op.parentId !== null && op.parentId !== from.parent_id) {
					await need(tx, op.parentId, 'update', '/parentId', 'add pages inside the destination');
				}
				if (op.parentId === null && reparents && !admin) {
					const teamspaceId = op.teamspaceId !== undefined ? op.teamspaceId : from.teamspace_id;
					if (teamspaceId === null) {
						// Into a Private section: only a page the caller made, and never for guests.
						if (guest || from.created_by !== options.userId) throw forbidden('the Private section');
					} else if (!options.updatableTeamspaces.includes(teamspaceId)) {
						throw forbidden('that teamspace');
					}
				}
				cache = new Map();
				return;
			}
			case 'trash':
			case 'restore': {
				const exists = await rawAll<{ n: number }>(tx, 'SELECT 1 AS n FROM page WHERE id = ?', op.page);
				if (exists.length === 0) return;
				await need(tx, op.page, 'full', '/page', op.op === 'trash' ? 'delete this page' : 'restore this page');
				cache = new Map();
				return;
			}
			case 'setPage':
				// `tx.page.update` is governed (`update`); nothing to add.
				return;
			case 'setProp':
			case 'addOption':
			case 'removeOption': {
				const exists = await rawAll<{ n: number }>(tx, 'SELECT 1 AS n FROM page WHERE id = ?', op.page);
				if (exists.length === 0) return;
				await need(tx, op.page, 'update', '/page', 'edit this page');
				return;
			}
			case 'createProperty':
			case 'updateProperty':
			case 'deleteProperty':
				// The property registry is shared by the whole workspace: members and admins, never guests.
				if (guest) throw forbidden('edit properties');
				return;
			case 'createCollection':
				await need(tx, op.pageId, 'update', '/pageId', 'edit this database');
				return;
			case 'updateCollection':
			case 'deleteCollection': {
				const page = await pageOfCollection(tx, op.id);
				if (page) await need(tx, page, 'update', '/id', 'edit this database');
				return;
			}
			case 'addMember':
			case 'removeMember':
			case 'moveMember': {
				const page = await pageOfCollection(tx, op.collection);
				if (page) await need(tx, page, 'update', '/collection', 'edit this database');
				// Adding a page to a database needs to see it.
				if (op.op === 'addMember') await levels(tx, op.page, '/page');
				return;
			}
			case 'createView': {
				const page = await pageOfCollection(tx, op.collectionId);
				if (page) await need(tx, page, 'update', '/collectionId', 'edit this database');
				return;
			}
			case 'updateView':
			case 'moveView':
			case 'deleteView': {
				const page = await pageOfView(tx, op.id);
				if (page) await need(tx, page, 'update', '/id', 'edit this database');
				return;
			}
		}
	}

	return { check };
}
