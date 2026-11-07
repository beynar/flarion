/**
 * The Workspace Durable Object methods the sharing code calls (owned by the Sync core track). Everything in
 * `src/server/share` goes through here, so a signature change is one edit.
 *
 * - `pageAccess(actor, pageId)`: the actor's level on the page (`read|comment|update|full`), or null.
 * - `listGrants(actor, pageId)`: direct grants of the page, plus the inherited ones when the DO exposes them.
 * - `setGrant(actor, input)`: creates or updates a grant; a `public` grant mints and returns a `token`.
 * - `revokeGrant(actor, grantId)`: deletes a grant. Only `full` on the page may set or revoke (DO-enforced).
 * - `grantByToken(token)`: the live public grant behind a share token, or null.
 */
import type { Actor, WorkspaceRole } from '../auth/session';

export type AccessLevel = 'read' | 'comment' | 'update' | 'full';
export const LEVEL_RANK: Record<AccessLevel, number> = { read: 1, comment: 2, update: 3, full: 4 };

export interface DoGrant {
	id: string;
	pageId: string;
	subjectKind: 'user' | 'workspace' | 'teamspace' | 'public';
	subjectId: string | null;
	level: AccessLevel;
	token: string | null;
	createdBy: string;
	inherited?: boolean;
	fromPageId?: string;
}

export interface GrantInput {
	pageId: string;
	subjectKind: DoGrant['subjectKind'];
	subjectId: string | null;
	level: AccessLevel;
}

/** What the DO methods accept as `actor`: a signed-in member, or an anonymous visitor holding a share token. */
export type ShareActor = Actor | AnonymousActor;

export interface AnonymousActor {
	workspaceId: string;
	sessionId: string;
	role: WorkspaceRole;
	name: string;
	guest: true;
	shareToken: string;
	userId?: undefined;
}

/** The actor of a public-link visitor: a `shareToken`, no `userId`, `guest: true`. Matches public links and nothing else. */
export function anonymousActor(workspaceId: string, shareToken: string): AnonymousActor {
	return { workspaceId, sessionId: '', role: 'guest', name: 'Visitor', guest: true, shareToken };
}

export interface WorkspaceShareRpc {
	pageAccess(actor: ShareActor, pageId: string): Promise<AccessLevel | { level: AccessLevel | null } | null>;
	listGrants(actor: ShareActor, pageId: string): Promise<DoGrant[]>;
	setGrant(actor: ShareActor, input: GrantInput): Promise<DoGrant>;
	revokeGrant(actor: ShareActor, grantId: string): Promise<{ seq?: number } | void | null>;
	grantByToken(token: string): Promise<{ id?: string; pageId: string; level: AccessLevel } | null>;
	getPage(actor: ShareActor, pageId: string): Promise<{ title?: string; icon?: string | null; parentId?: string | null }>;
}

export function workspaceShare(env: Pick<Env, 'WORKSPACE'>, workspaceId: string): WorkspaceShareRpc {
	return env.WORKSPACE.getByName(workspaceId) as unknown as WorkspaceShareRpc;
}

/** Normalizes the shapes `pageAccess` may answer with. */
export function levelOf(result: Awaited<ReturnType<WorkspaceShareRpc['pageAccess']>>): AccessLevel | null {
	if (!result) return null;
	return typeof result === 'string' ? result : (result.level ?? null);
}

/** The actor the system acts as when it applies a grant an authorized person asked for earlier (pending guest grants, reconcile). */
export function systemActor(workspaceId: string, onBehalfOf: string): Actor {
	return { userId: onBehalfOf, sessionId: 'system', workspaceId, role: 'admin', name: 'Flarion' };
}
