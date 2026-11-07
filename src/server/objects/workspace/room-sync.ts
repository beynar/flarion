/**
 * Access changes reach open rooms (docs/PLAN.md "Permissions": "Access changes reach open rooms").
 *
 * After a grant change, a move or a membership change the Workspace DO walks the affected subtree, keeps
 * only the pages listed in `open_room`, asks each Page DO who is connected and, for every connected
 * member whose room access changed, calls `setAccess(userId, access)`: `read` downgrades the socket in
 * place, `none` closes it for good, any other level makes it redial and re-authorize. Rooms are handled
 * in batches, so one grant on a big subtree does not open thousands of calls at once.
 *
 * Users that hold no membership (public-link visitors, ids this object does not know) are not evaluated
 * here: their sockets are told to refresh (`closeUser` with 4401), and `authorize` decides on the redial
 * (`rooms/access.ts`).
 */
import { roomName } from '../../rooms/names';
import type { AccessLevel } from '../../db/workspace.schema';
import { roomAccessOf, type AccessActor, type AccessService, type CommitAccess, type PageDelta } from './access';
import { chunks, MAX_PARAMS } from './util';

/** Rooms handled concurrently. */
export const ROOM_BATCH = 16;
/** edytor's close code that makes a provider refresh its token and redial. */
const REFRESH = 4401;

/** The Page DO surface the sync uses (`PageDO` implements it). */
export interface RoomStub {
	roomUsers(): Promise<string[]>;
	setAccess(userId: string, access: 'read' | 'comment' | 'write' | 'none'): Promise<unknown>;
	closeUser(userId: string, code?: number, reason?: string): Promise<unknown>;
}

export interface RoomSyncDeps {
	sql: SqlStorage;
	workspaceId: string;
	access: AccessService;
	room(pageId: string): RoomStub;
	/** The per-actor deltas of the commit, captured before they were cleared. */
	changes: readonly { actor: AccessActor; delta: ReadonlyMap<number, PageDelta> }[];
}

export interface RoomSyncResult {
	rooms: number;
	setAccess: number;
	closed: number;
	refreshed: number;
}

/** Open rooms inside the subtrees of `roots`, on pages of `teamspaces`, or every open room. */
export function affectedRooms(sql: SqlStorage, scope: Pick<CommitAccess, 'roots' | 'teamspaces' | 'everything'>): string[] {
	if (scope.everything) return sql.exec<{ page_id: string }>('SELECT page_id FROM open_room').toArray().map((r) => r.page_id);
	const out = new Set<string>();
	const roots = new Set(scope.roots);
	for (const ts of scope.teamspaces) {
		// Members' access also flows through shares made to the teamspace.
		for (const r of sql.exec<{ page_id: string }>('SELECT page_id FROM "grant" WHERE teamspace_id = ? AND deleted_at IS NULL', ts).toArray()) {
			roots.add(r.page_id);
		}
		for (const r of sql
			.exec<{ page_id: string }>('SELECT o.page_id AS page_id FROM open_room o JOIN page p ON p.id = o.page_id WHERE p.teamspace_id = ?', ts)
			.toArray())
			out.add(r.page_id);
	}
	for (const root of roots) {
		for (const r of sql
			.exec<{ page_id: string }>(
				`WITH RECURSIVE sub(id) AS (SELECT id FROM page WHERE id = ? UNION ALL SELECT p.id FROM page p JOIN sub ON p.parent_id = sub.id)
				 SELECT o.page_id AS page_id FROM open_room o JOIN sub ON sub.id = o.page_id`,
				root
			)
			.toArray())
			out.add(r.page_id);
	}
	return [...out];
}

export async function syncRooms(deps: RoomSyncDeps, scope: Pick<CommitAccess, 'roots' | 'teamspaces' | 'everything'>): Promise<RoomSyncResult> {
	const result: RoomSyncResult = { rooms: 0, setAccess: 0, closed: 0, refreshed: 0 };
	const pageIds = affectedRooms(deps.sql, scope);
	if (pageIds.length === 0) return result;
	result.rooms = pageIds.length;

	const nums = new Map<string, number>();
	for (const part of chunks(pageIds, MAX_PARAMS)) {
		const marks = part.map(() => '?').join(',');
		for (const r of deps.sql.exec<{ id: string; num: number }>(`SELECT id, num FROM page WHERE id IN (${marks})`, ...part).toArray()) {
			nums.set(r.id, r.num);
		}
	}
	const deltaOf = new Map<string, ReadonlyMap<number, PageDelta>>();
	for (const c of deps.changes) if (c.actor.userId) deltaOf.set(c.actor.userId, c.delta);

	for (const batch of chunks(pageIds, ROOM_BATCH)) {
		await Promise.all(
			batch.map(async (pageId) => {
				const stub = deps.room(pageId);
				let users: string[];
				try {
					users = await stub.roomUsers();
				} catch (error) {
					console.warn(`[workspace] room ${pageId}: could not list users`, String(error));
					return;
				}
				const num = nums.get(pageId);
				for (const userId of users) {
					try {
						await syncUser(deps, stub, userId, pageId, num, deltaOf.get(userId), result);
					} catch (error) {
						// Best effort: a failing room must not stop the others. The token expires in 10 minutes anyway.
						console.warn(`[workspace] room ${pageId}: access sync failed for ${userId}`, String(error));
					}
				}
			})
		);
	}
	return result;
}

async function syncUser(
	deps: RoomSyncDeps,
	stub: RoomStub,
	userId: string,
	pageId: string,
	num: number | undefined,
	delta: ReadonlyMap<number, PageDelta> | undefined,
	result: RoomSyncResult
): Promise<void> {
	const { access } = deps;
	const role = access.memberRole(userId);
	if (!role) {
		// Not a (current) member: removed users lose the room, visitors re-authorize.
		const row = deps.sql.exec<{ removed_at: string | null }>('SELECT removed_at FROM member WHERE user_id = ?', userId).toArray()[0];
		if (row) {
			await stub.setAccess(userId, 'none');
			result.closed++;
		} else {
			await stub.closeUser(userId, REFRESH, 'access changed');
			result.refreshed++;
		}
		return;
	}
	const actor: AccessActor = { userId, role };
	// A cached actor's delta is authoritative (no entry for the page: nothing changed for them); an actor
	// computed just now has no "before", so their room access is simply set once.
	const known = access.cached(actor);
	await access.ensure(actor);
	const levels = access.view(actor);
	const now: AccessLevel | null = num !== undefined && levels.has(num) ? levels.level(num) : null;
	if (now === null) {
		await stub.setAccess(userId, 'none');
		result.closed++;
		return;
	}
	if (known && num !== undefined) {
		const d = (delta ?? levels.delta).get(num);
		if (!d) return;
		const before = d.before < 0 ? null : (['read', 'comment', 'update', 'full'] as const)[d.before]!;
		// Only a change of the room access matters: `comment` redials every socket, so never repeat it for nothing.
		if (before !== null && roomAccessOf(before) === roomAccessOf(now)) return;
	}
	await stub.setAccess(userId, roomAccessOf(now));
	result.setAccess++;
}
