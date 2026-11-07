/**
 * Cookie authentication for the `/files` routes that act as a signed-in member (uploads, and downloads that
 * have no signed URL yet). A signed download needs none of this: its URL carries the authority.
 */
import { resolveMembership, resolveSession, type Actor } from '../auth/session';
import { isValidRoomId } from '../rooms/names';
import { decodeWorkspaceError } from '../objects/workspace/errors';
import type { WorkspaceDO } from '../objects/workspace/workspace-do';

export interface FileCaller {
	actor: Actor;
	workspace: DurableObjectStub<WorkspaceDO>;
}

/** `APP_ORIGIN` may list several origins (app plus previews): the first one is the canonical one. */
export const appOrigins = (env: Pick<Env, 'APP_ORIGIN'>): string[] =>
	String(env.APP_ORIGIN)
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);

/** A state-changing file request must come from the app itself (cookies ride on any cross-site request). */
export function isAppOrigin(request: Request, env: Pick<Env, 'APP_ORIGIN'>): boolean {
	const origin = request.headers.get('origin');
	if (!origin || !appOrigins(env).includes(origin)) return false;
	const site = request.headers.get('sec-fetch-site');
	return !site || site === 'same-origin';
}

const json = (status: number, message: string) =>
	Response.json({ message }, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

/** The signed-in member of workspace `workspaceId` making `request`, or the refusal response. */
export async function authenticateFileCaller(
	request: Request,
	env: Env,
	workspaceId: string | null
): Promise<FileCaller | Response> {
	if (!workspaceId || !isValidRoomId(workspaceId)) return json(400, 'Missing or invalid workspace');
	const session = await resolveSession(request, env);
	if (!session) return json(401, 'Sign in to continue');
	const role = await resolveMembership(env, session.userId, workspaceId);
	if (!role) return json(403, 'Not a member of this workspace');
	const actor: Actor = { userId: session.userId, sessionId: session.sessionId, workspaceId, role, name: session.name };
	return { actor, workspace: env.WORKSPACE.getByName(workspaceId) as unknown as DurableObjectStub<WorkspaceDO> };
}

/** Turns an error from a Workspace DO call into an HTTP response (the DO encodes its error codes in the message). */
export function workspaceErrorResponse(error: unknown): Response {
	const decoded = decodeWorkspaceError(error);
	if (!decoded) {
		console.error('[files] error:', error instanceof Error ? (error.stack ?? error.message) : String(error));
		return json(500, 'Something went wrong');
	}
	const status = { NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, BAD_REQUEST: 400, VALIDATION_FAILED: 422, APP_OUTDATED: 426 }[decoded.code];
	return json(status, decoded.message);
}
