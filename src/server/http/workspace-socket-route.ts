/**
 * `/ws/:workspaceId`: checks, in order, that the request is a WebSocket upgrade, that `Origin` is
 * allowed (browsers send cookies on any WebSocket dial), that there is a session and that its user is a
 * member of the workspace (`resolveSession` + `resolveMembership`); then forwards to the Workspace
 * Durable Object named by the workspace id, with the actor and the client build in headers the object
 * trusts (they are always overwritten here).
 *
 * Test seam: when `ENVIRONMENT` is `test` or `development`, `x-flarion-dev-actor: <userId>` stands in
 * for the session and the membership (optionally `x-flarion-dev-role` and `x-flarion-dev-name`). It is
 * ignored everywhere else.
 */
import { APP_VERSION_HEADER, APP_VERSION_PARAM } from '../../lib/shared/protocol';
import { resolveMembershipFromD1, resolveSession, type Actor, type WorkspaceRole } from '../auth/session';
import { ACTOR_HEADER, encodeActorHeader } from '../objects/workspace/socket';
import type { Env, RouteHandler } from './types';

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Dev/test only stand-in for a session. */
export const DEV_ACTOR_HEADER = 'x-flarion-dev-actor';
export const DEV_ROLE_HEADER = 'x-flarion-dev-role';
export const DEV_NAME_HEADER = 'x-flarion-dev-name';

/** Origins allowed to open a workspace socket: `APP_ORIGIN`, which may hold a comma-separated list. */
export function allowedOrigins(env: Pick<Env, 'APP_ORIGIN'>): string[] {
	return String(env.APP_ORIGIN)
		.split(',')
		.map((o) => o.trim())
		.filter(Boolean);
}

function isLocalEnvironment(env: Pick<Env, 'ENVIRONMENT'>): boolean {
	const name = String(env.ENVIRONMENT);
	return name === 'test' || name === 'development';
}

export function isOriginAllowed(request: Request, env: Pick<Env, 'APP_ORIGIN' | 'ENVIRONMENT'>): boolean {
	const origin = request.headers.get('Origin');
	// Browsers always send Origin on a WebSocket dial. Scripts and tests may not, outside production.
	if (origin === null) return isLocalEnvironment(env);
	return allowedOrigins(env).includes(origin);
}

const ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member', 'guest'];

/** The dev/test seam: an actor from `x-flarion-dev-actor`, only in local environments. */
export function devActor(request: Request, env: Pick<Env, 'ENVIRONMENT'>, workspaceId: string): Actor | null {
	if (!isLocalEnvironment(env)) return null;
	const userId = request.headers.get(DEV_ACTOR_HEADER)?.trim();
	if (!userId) return null;
	const role = request.headers.get(DEV_ROLE_HEADER)?.trim() as WorkspaceRole | undefined;
	return {
		userId,
		sessionId: `dev-${userId}`,
		workspaceId,
		role: role && ROLES.includes(role) ? role : 'member',
		name: request.headers.get(DEV_NAME_HEADER)?.trim() || userId
	};
}

/**
 * The actor of an upgrade: the session's user and its role in the workspace, or null (with the status to
 * answer) when there is none.
 *
 * `role` is left out unless the dev seam gives one: the Workspace DO, which the upgrade goes to anyway, reads it from its member
 * mirror (`WorkspaceDO.fetch`), so a dial no longer makes a Durable Object call of its own before the real one. The route asks
 * D1 only when the object says the mirror does not know the user (see `handleWorkspaceSocket`).
 */
export async function authenticateUpgrade(
	request: Request,
	env: Env,
	workspaceId: string
): Promise<{ actor: Omit<Actor, 'role'> & { role?: WorkspaceRole } } | { status: 401 | 403 }> {
	const dev = devActor(request, env, workspaceId);
	if (dev) return { actor: dev };
	const session = await resolveSession(request, env);
	if (!session) return { status: 401 };
	return { actor: { userId: session.userId, sessionId: session.sessionId, workspaceId, name: session.name } };
}

export const handleWorkspaceSocket: RouteHandler = async (request, env) => {
	const match = /^\/ws\/([^/]+)\/?$/.exec(new URL(request.url).pathname);
	if (!match) return new Response('Not found', { status: 404 });
	const workspaceId = decodeURIComponent(match[1]);
	if (!WORKSPACE_ID.test(workspaceId)) return new Response('Invalid workspace id', { status: 400 });

	if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
		return new Response('Expected a WebSocket upgrade', { status: 426, headers: { Upgrade: 'websocket' } });
	}
	if (!isOriginAllowed(request, env)) return new Response('Origin not allowed', { status: 403 });
	const auth = await authenticateUpgrade(request, env, workspaceId);
	if ('status' in auth) return new Response(auth.status === 401 ? 'Unauthorized' : 'Forbidden', { status: auth.status });

	// Rebuild the headers so a client can never smuggle its own actor header through. Browsers cannot set
	// headers on a WebSocket, so the build also travels in the `v` query parameter.
	const url = new URL(request.url);
	const headers = new Headers(request.headers);
	headers.delete(DEV_ACTOR_HEADER);
	headers.delete(DEV_ROLE_HEADER);
	headers.delete(DEV_NAME_HEADER);
	const version = headers.get(APP_VERSION_HEADER) ?? url.searchParams.get(APP_VERSION_PARAM);
	if (version) headers.set(APP_VERSION_HEADER, version);
	const forward = (actor: typeof auth.actor) => {
		headers.set(ACTOR_HEADER, encodeActorHeader(actor));
		return env.WORKSPACE.getByName(workspaceId).fetch(new Request(request, { headers }));
	};
	const first = await forward(auth.actor);
	// The object's mirror of the members has not seen this user (an invite accepted a moment ago): D1 is the source of truth.
	if (first.status !== 403 || first.webSocket || auth.actor.role) return first;
	const role = await resolveMembershipFromD1(env, auth.actor.userId, workspaceId);
	if (!role) return first;
	return forward({ ...auth.actor, role });
};
