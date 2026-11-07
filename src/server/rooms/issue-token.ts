/**
 * `page.roomToken`: mint a room token for the calling actor. The access is decided here, once, from
 * the workspace role (members write, guests read) through the same seam the room's `authorize` uses
 * on every dial (`resolveRoomAccess`, which P2 turns into a Workspace DO permission check).
 */
import { resolveRoomAccess, roomAccessForRole } from './access';
import { mintRoomToken, type RoomAccess } from './token';

export interface RoomTokenActor {
	userId: string;
	workspaceId: string;
	role: 'owner' | 'admin' | 'member' | 'guest';
}

export async function issueRoomToken(
	env: Env,
	actor: RoomTokenActor,
	pageId: string,
	/** The access the caller holds on the page (`page.roomToken` asked the Workspace DO); else resolved here. */
	access?: RoomAccess
): Promise<{ token: string; expiresAt: number; access: RoomAccess }> {
	const claims = {
		userId: actor.userId,
		workspaceId: actor.workspaceId,
		pageId,
		access: access ?? roomAccessForRole(actor.role)
	};
	const resolved = access ? { access } : await resolveRoomAccess(env, claims);
	if (!resolved) throw new Error('no access to this page');
	const { token, expiresAt } = await mintRoomToken(env, { ...claims, access: resolved.access });
	return { token, expiresAt, access: resolved.access };
}
