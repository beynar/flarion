/**
 * Where a room's access is decided. P0 trusts the verified token's `access`; P2 replaces the body of
 * {@link resolveRoomAccess} with a Workspace DO call (`page.can(["read", "comment", "update"], { id })`,
 * docs/PLAN.md "Permissions") so a revoked grant stops working before the token expires.
 */
import type { RoomClaims, RoomAccess } from './token';

export interface ResolvedRoomAccess {
	access: RoomAccess;
}

/**
 * The access `claims.userId` currently has on `claims.pageId` in `claims.workspaceId`, or `null` to
 * refuse the dial (edytor closes the socket 4403, terminal).
 *
 * P2 seam: ask `env.WORKSPACE.getByName(claims.workspaceId)` and intersect the answer with
 * `claims.access` (a token can only narrow, never widen, what the workspace says).
 */
export async function resolveRoomAccess(_env: Env, claims: RoomClaims): Promise<ResolvedRoomAccess | null> {
	return { access: claims.access };
}
