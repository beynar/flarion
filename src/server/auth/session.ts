/**
 * Session + membership resolution seam (owned by the Accounts track from P1).
 * P1 replaces the bodies with better-auth (cookie cache, D1) and the D1 membership lookup
 * (cached in the Workspace DO). Signatures are the contract other tracks code against.
 */
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';

export interface SessionInfo {
	userId: string;
	sessionId: string;
	name: string;
	email: string;
	emailVerified: boolean;
	image?: string | null;
}

/** The actor every Workspace DO call runs as (docs/PLAN.md "Sessions and identity"). */
export interface Actor {
	userId: string;
	sessionId: string;
	workspaceId: string;
	role: WorkspaceRole;
	name: string;
}

export async function resolveSession(_request: Request, _env: Env): Promise<SessionInfo | null> {
	return null;
}

export async function resolveMembership(
	_env: Env,
	_userId: string,
	_workspaceId: string
): Promise<WorkspaceRole | null> {
	return null;
}
