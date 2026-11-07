/**
 * `/ws/:workspaceId`: checks, in order, that the request is a WebSocket upgrade, that `Origin` is
 * allowed (browsers send cookies on any WebSocket dial), and that there is a session; then forwards
 * to the Workspace Durable Object named by the workspace id.
 */
import { ACTOR_HEADER, encodeActorHeader, type SocketActor } from '../objects/workspace/socket';
import type { Env, RouteHandler } from './types';

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Dev/test only stand-in for a session until P1 auth exists. */
export const DEV_ACTOR_HEADER = 'x-flarion-dev-actor';

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

/**
 * Session seam. P1 replaces the body with a better-auth session lookup plus a workspace membership
 * check, and returns the actor stored in the socket attachment. Until then only `test` and
 * `development` accept a dev header, `x-flarion-dev-actor: <userId>`.
 */
export async function authenticateUpgrade(
	request: Request,
	env: Pick<Env, 'ENVIRONMENT'>
): Promise<SocketActor | null> {
	if (!isLocalEnvironment(env)) return null;
	const userId = request.headers.get(DEV_ACTOR_HEADER)?.trim();
	return userId ? { userId } : null;
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
	const actor = await authenticateUpgrade(request, env);
	if (!actor) return new Response('Unauthorized', { status: 401 });

	// Rebuild the headers so a client can never smuggle its own actor header through.
	const headers = new Headers(request.headers);
	headers.delete(DEV_ACTOR_HEADER);
	headers.set(ACTOR_HEADER, encodeActorHeader(actor));
	return env.WORKSPACE.getByName(workspaceId).fetch(new Request(request, { headers }));
};
