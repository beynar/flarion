/**
 * Shared oRPC (v1) implementer of the public API (`/v1`), the counterpart of `rpc/private/base.ts`.
 *
 * `authenticated` runs before every procedure:
 *   1. the bearer token (`auth/api-tokens.ts`): unknown, malformed, revoked and expired ones are all `UNAUTHORIZED`;
 *   2. the per-token rate limit (`RL_API`, keyed by the token id): `RATE_LIMITED` (429);
 *   3. the scope the procedure declares in its meta: a token without it is `FORBIDDEN`. An empty scope list holds no
 *      scope, so it grants nothing;
 *   4. the actor: the token's user in the token's workspace, with the role they hold there *now* (a removed member's
 *      tokens stop working), and the Workspace DO stub. Every rule about what that user may read or write is the
 *      Workspace DO's, exactly as for the app: a token never sees more than its user, and a scope only narrows.
 *
 * The scope is enforced here, at the boundary, and not by the viborm policy: the policy's actor has no scope facts
 * and each endpoint sends only the ops its scope names.
 */
import { implement, ORPCError } from '@orpc/server';
import { publicContract } from '../contract';
import { authenticateToken, bearerOf } from '../../auth/api-tokens';
import { resolveMembership, type Actor } from '../../auth/session';
import { createDirectoryClient } from '../../db/global.client';
import { ensureDevSchema } from '../../db/dev-migrate';
import type { WorkspaceDO } from '../../objects/workspace/workspace-do';
import type { TokenScope } from '../../../lib/shared/schemas';
import { mapWorkspaceError } from '../private/workspace-errors';

/** What the route knows about the request while it runs, filled in by `authenticated` for the metrics. */
export interface ApiTrace {
	tokenId?: string;
	workspaceId?: string;
}

export interface PublicContext {
	request: Request;
	env: Env;
	ctx: Pick<ExecutionContext, 'waitUntil'>;
	trace: ApiTrace;
}

export interface ApiAuth {
	tokenId: string;
	scopes: readonly TokenScope[];
	actor: Actor;
	workspace: DurableObjectStub<WorkspaceDO>;
}

export const pub = implement(publicContract).$context<PublicContext>();

/** Requests per minute are `RL_API`'s (wrangler.jsonc); a failing limiter must not take the API down. */
async function withinRateLimit(env: Env, tokenId: string): Promise<boolean> {
	try {
		return (await env.RL_API.limit({ key: `token:${tokenId}` })).success;
	} catch (error) {
		console.error('[api] rate limiter failed:', error instanceof Error ? error.message : error);
		return true;
	}
}

export const authenticated = pub.middleware(async ({ context, next, procedure }) => {
	await ensureDevSchema(context.env);
	const token = await authenticateToken(context.env, bearerOf(context.request), { defer: (work) => context.ctx.waitUntil(work) });
	if (!token.ok) throw new ORPCError('UNAUTHORIZED', { message: 'Missing, invalid or expired token' });
	context.trace.tokenId = token.id;
	context.trace.workspaceId = token.workspaceId;

	if (!(await withinRateLimit(context.env, token.id))) throw new ORPCError('RATE_LIMITED', { status: 429, message: 'Too many requests. Slow down and retry in a minute.' });

	const scope = procedure['~orpc'].meta.scope;
	if (!scope || !token.scopes.includes(scope)) {
		throw new ORPCError('FORBIDDEN', { message: scope ? `This token lacks the "${scope}" scope` : 'This endpoint has no scope' });
	}

	const [role, user] = await Promise.all([
		resolveMembership(context.env, token.userId, token.workspaceId),
		createDirectoryClient(context.env.DB).user.findFirst({ where: { id: token.userId }, select: { name: true } })
	]);
	// The user (or their membership) is gone: the token is dead, whatever its row says.
	if (!role || !user) throw new ORPCError('UNAUTHORIZED', { message: 'Missing, invalid or expired token' });

	const actor: Actor = { userId: token.userId, sessionId: `token:${token.id}`, workspaceId: token.workspaceId, role, name: user.name };
	const workspace = context.env.WORKSPACE.getByName(token.workspaceId) as unknown as DurableObjectStub<WorkspaceDO>;
	try {
		return await next({ context: { auth: { tokenId: token.id, scopes: token.scopes, actor, workspace } satisfies ApiAuth } });
	} catch (error) {
		// Errors the Workspace DO throws arrive encoded in the message: turn them into the API's errors.
		throw mapWorkspaceError(error);
	}
});
