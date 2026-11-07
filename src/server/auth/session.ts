/**
 * Session + membership resolution seam (owned by the Accounts track; signatures are the contract every
 * other track's middleware codes against).
 *
 * - `resolveSession`: better-auth with the cookie cache, so most requests never read D1. Recovery
 *   sessions (restricted to registering a passkey) never resolve: they are not usable for the app.
 * - `resolveMembership`: the Workspace DO's cached mirror first (`getMemberRole`), then D1.
 */
import { getAuth } from './auth';
import { workspaceIdentity } from './workspace-rpc';
import { createDirectoryClient } from '../db/global.client';
import { ensureDevSchema } from '../db/dev-migrate';

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

export async function resolveSession(request: Request, env: Env): Promise<SessionInfo | null> {
	let result;
	try {
		await ensureDevSchema(env);
		result = await getAuth(env).api.getSession({ headers: request.headers });
	} catch (error) {
		// D1 unavailable or a malformed cookie: treated as signed out (the cookie cache still serves
		// most requests while D1 is down).
		console.error('[auth] session lookup failed:', error instanceof Error ? error.message : error);
		return null;
	}
	if (!result) return null;
	if ((result.session as { restricted?: boolean }).restricted) return null;
	return {
		userId: result.user.id,
		sessionId: result.session.id,
		name: result.user.name,
		email: result.user.email,
		emailVerified: result.user.emailVerified,
		image: result.user.image ?? null
	};
}

const ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member', 'guest'];
const isRole = (value: unknown): value is WorkspaceRole => ROLES.includes(value as WorkspaceRole);

/** The caller's role in a workspace, or null when they are not a member of a live workspace. */
export async function resolveMembership(env: Env, userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
	try {
		const cached = await workspaceIdentity(env, workspaceId).getMemberRole(userId);
		if (isRole(cached)) return cached;
	} catch (error) {
		// The mirror is a cache: fall back to the source of truth.
		console.warn('[auth] workspace membership mirror unavailable:', error instanceof Error ? error.message : error);
	}
	return resolveMembershipFromD1(env, userId, workspaceId);
}

export async function resolveMembershipFromD1(env: Pick<Env, 'DB'>, userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
	const db = createDirectoryClient(env.DB);
	// `softDelete()` hides tombstones: a deleted workspace or a removed membership resolves to null.
	const [workspace, membership] = await Promise.all([
		db.workspace.findFirst({ where: { id: workspaceId }, select: { id: true } }),
		db.membership.findFirst({ where: { workspaceId, userId }, select: { role: true } })
	]);
	if (!workspace || !membership) return null;
	return isRole(membership.role) ? membership.role : null;
}
