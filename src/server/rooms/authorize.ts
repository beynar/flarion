/**
 * edytor `authorize` for page rooms, built from a token already verified by the route.
 */
import { requestedReplica, type AuthorizeDocumentSocket } from 'edytor/cloudflare';
import { resolveRoomAccess } from './access';
import type { RoomTokenPayload, VerifyRoomTokenResult } from './token';

export interface RoomAuthorizeOptions {
	env: Env;
	/** Result of `verifyRoomToken` on the dial's `token` parameter. */
	verified: VerifyRoomTokenResult;
	/** Optional `workspace` query hint the client sends; when present it must match the token. */
	workspaceHint?: string | null;
}

/**
 * - Unknown, forged, malformed or mismatching credentials: `null` (close 4403, terminal).
 * - A genuine but expired token: `{ expired: true }` (close 4401, the provider refreshes `params`).
 * - Otherwise the identity, expiring when the token does.
 */
export function createRoomAuthorize({ env, verified, workspaceHint }: RoomAuthorizeOptions): AuthorizeDocumentSocket {
	return async (request, documentId) => {
		if (!verified.ok) return verified.reason === 'expired' ? { expired: true } : null;
		const claims: RoomTokenPayload = verified.claims;
		if (claims.pageId !== documentId) return null;
		if (workspaceHint && workspaceHint !== claims.workspaceId) return null;
		const resolved = await resolveRoomAccess(env, claims);
		if (!resolved) return null;
		return {
			userId: claims.userId,
			replica: requestedReplica(request),
			access: resolved.access,
			expiresAt: claims.exp * 1000
		};
	};
}
