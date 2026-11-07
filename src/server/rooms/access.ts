/**
 * Where a room's access is decided: the Workspace DO's `pageAccess` (docs/PLAN.md "Permissions"), asked on
 * every dial, so a revoked grant stops working before the 10-minute token expires. A token can only
 * narrow what the workspace says, never widen it.
 */
import type { AccessLevel } from '../db/workspace.schema';
import type { RoomClaims, RoomAccess } from './token';

export interface ResolvedRoomAccess {
	access: RoomAccess;
}

/** The edytor room access of a page level: `full`/`update` write, `comment` comment, `read` read. */
export function roomAccessForLevel(level: AccessLevel): RoomAccess {
	return level === 'full' || level === 'update' ? 'write' : level === 'comment' ? 'comment' : 'read';
}

const RANK: Record<RoomAccess, number> = { read: 0, comment: 1, write: 2 };

/** What the Workspace DO is asked (`WorkspaceDO.pageAccess`, with a user id and no role: the member mirror decides). */
interface PageAccessApi {
	pageAccess(actor: { userId: string }, pageId: string): Promise<AccessLevel | null>;
}

/**
 * The access `claims.userId` currently has on `claims.pageId` in `claims.workspaceId`, or `null` to
 * refuse the dial (edytor closes the socket 4403, terminal). Fails closed: if the workspace cannot be
 * asked, nobody gets in.
 */
export async function resolveRoomAccess(env: Env, claims: RoomClaims): Promise<ResolvedRoomAccess | null> {
	let level: AccessLevel | null;
	try {
		const workspace = env.WORKSPACE.getByName(claims.workspaceId) as unknown as PageAccessApi;
		level = await workspace.pageAccess({ userId: claims.userId }, claims.pageId);
	} catch (error) {
		console.warn(`[rooms] access check failed for ${claims.workspaceId}:${claims.pageId}`, error instanceof Error ? error.message : error);
		return null;
	}
	if (!level) return null;
	const granted = roomAccessForLevel(level);
	return { access: RANK[claims.access] <= RANK[granted] ? claims.access : granted };
}

/** What the workspace role of a caller allows in a page room: the default a token asks for before the page's own permissions narrow it. */
export function roomAccessForRole(role: 'owner' | 'admin' | 'member' | 'guest'): RoomAccess {
	return role === 'guest' ? 'read' : 'write';
}
