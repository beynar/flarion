/**
 * Shared oRPC v1 implementer for the private API (`/rpc`). Every router file implements its slice of
 * `contract` with `os.<router>.<procedure>.use(...).handler(...)` and `router.ts` assembles them.
 *
 * - `requireSession`: the caller has a better-auth session (401 otherwise).
 * - `requireWorkspace`: the call names a workspace (`x-workspace-id`), the caller is a member, and the
 *   context gains `actor` and `workspace` (the WorkspaceDO stub). All rules are enforced inside the DO.
 */
import { implement, ORPCError } from '@orpc/server';
import { WORKSPACE_HEADER } from '../../../lib/shared/protocol';
import { contract } from '../contract';
import { resolveMembership, resolveSession, type Actor, type SessionInfo, type WorkspaceRole } from '../../auth/session';
import type { WorkspaceDO } from '../../objects/workspace/workspace-do';
import { mapWorkspaceError } from './workspace-errors';

export interface RpcContext {
	request: Request;
	env: Env;
	ctx: Pick<ExecutionContext, 'waitUntil'>;
}

export interface SessionContext extends RpcContext {
	session: SessionInfo;
}

export interface WorkspaceContext extends SessionContext {
	actor: Actor;
	workspace: DurableObjectStub<WorkspaceDO>;
}

export const os = implement(contract).$context<RpcContext>();

export const requireSession = os.middleware(async ({ context, next }) => {
	const session = await resolveSession(context.request, context.env);
	if (!session) throw new ORPCError('UNAUTHORIZED');
	return next({ context: { session } });
});

export const requireWorkspace = os.middleware(async ({ context, next }) => {
	const session = (context as Partial<SessionContext>).session ?? (await resolveSession(context.request, context.env));
	if (!session) throw new ORPCError('UNAUTHORIZED');
	const workspaceId = context.request.headers.get(WORKSPACE_HEADER);
	if (!workspaceId) throw new ORPCError('BAD_REQUEST', { message: `Missing ${WORKSPACE_HEADER}` });
	const role = await resolveMembership(context.env, session.userId, workspaceId);
	if (!role) throw new ORPCError('FORBIDDEN');
	const actor: Actor = {
		userId: session.userId,
		sessionId: session.sessionId,
		workspaceId,
		role,
		name: session.name
	};
	const workspace = context.env.WORKSPACE.getByName(workspaceId) as unknown as DurableObjectStub<WorkspaceDO>;
	try {
		return await next({ context: { session, actor, workspace } });
	} catch (error) {
		// Errors the Workspace DO throws arrive encoded in the message: turn them into the contract's errors.
		throw mapWorkspaceError(error);
	}
});

/** The message the Workspace DO answers with when the mirror has no live member for the caller (`WorkspaceDO.apply`). */
const NOT_A_MEMBER = /not a member of this workspace/i;

/**
 * Like `requireWorkspace`, for the hot calls (`mutate`): the caller's role is not read first (a Durable Object call of its
 * own, queued behind the commits it would then wait for again, and a second hop on every write). The call carries no role and
 * the Workspace DO, which enforces every rule anyway, resolves it from its member mirror. Only when the mirror has not seen
 * the member yet (an invite accepted a moment ago) does the Worker ask D1, the source of truth, and send the call again with
 * that role: the same answer `requireWorkspace` gives, one hop later, in the rare case.
 */
export const requireWorkspaceInObject = os.middleware(async ({ context, next }) => {
	const session = (context as Partial<SessionContext>).session ?? (await resolveSession(context.request, context.env));
	if (!session) throw new ORPCError('UNAUTHORIZED');
	const workspaceId = context.request.headers.get(WORKSPACE_HEADER);
	if (!workspaceId) throw new ORPCError('BAD_REQUEST', { message: `Missing ${WORKSPACE_HEADER}` });
	const workspace = context.env.WORKSPACE.getByName(workspaceId) as unknown as DurableObjectStub<WorkspaceDO>;
	const actorWith = (role: WorkspaceRole | undefined): Actor => ({ userId: session.userId, sessionId: session.sessionId, workspaceId, role: role as WorkspaceRole, name: session.name });
	try {
		return await next({ context: { session, actor: actorWith(undefined), workspace } });
	} catch (error) {
		const mapped = mapWorkspaceError(error);
		if (!(mapped instanceof ORPCError) || mapped.code !== 'FORBIDDEN' || !NOT_A_MEMBER.test(mapped.message)) throw mapped;
		const role = await resolveMembership(context.env, session.userId, workspaceId);
		if (!role) throw new ORPCError('FORBIDDEN');
		try {
			return await next({ context: { session, actor: actorWith(role), workspace } });
		} catch (retried) {
			throw mapWorkspaceError(retried);
		}
	}
});

export const notImplemented = (what: string): never => {
	throw new ORPCError('NOT_IMPLEMENTED', { message: `${what} is not implemented yet` });
};
