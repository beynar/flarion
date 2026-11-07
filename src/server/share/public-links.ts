/**
 * Public share links (docs/PLAN.md "Share links in two stores"): the Workspace DO holds the `public` grant
 * (the authority), D1 `publicShare` holds the route `token -> workspace, page` so an anonymous visitor can
 * find the right DO. Two stores, one rule of order:
 *
 * - create: DO grant first (it mints the token), then the D1 route. A failure after the grant revokes it
 *   again; a route therefore never exists without a grant.
 * - revoke: D1 `revokedAt` first (the link dies at once), then the DO grant. A failure between the two leaves
 *   `doRevokedAt` unset: the nightly reconcile finishes it.
 * - reconcile: live routes whose DO grant is gone are revoked; revoked routes whose DO grant lives are
 *   revoked there.
 */
import { ORPCError } from '@orpc/server';
import { createDirectoryClient, globalClient } from '../db/global.client';
import type { Actor } from '../auth/session';
import { workspaceShare, systemActor, type DoGrant, type AccessLevel, type ShareActor } from './do-rpc';

/** Public links are read-only: an anonymous visitor has no account to comment or edit with. */
export const PUBLIC_LINK_LEVELS: readonly AccessLevel[] = ['read'];

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
export const isShareToken = (value: string) => TOKEN.test(value);

export interface PublicRoute {
	id: string;
	token: string;
	workspaceId: string;
	pageId: string;
	createdBy: string;
	grantId: string | null;
}

const toGrant = (route: PublicRoute, level: AccessLevel = 'read'): DoGrant => ({
	id: route.grantId ?? route.id,
	pageId: route.pageId,
	subjectKind: 'public',
	subjectId: null,
	level,
	token: route.token,
	createdBy: route.createdBy
});

/** The live route of a page, if it has one. */
export async function livePublicRoute(env: Pick<Env, 'DB'>, workspaceId: string, pageId: string): Promise<PublicRoute | null> {
	return (await createDirectoryClient(env.DB).publicShare.findFirst({ where: { workspaceId, pageId, revokedAt: null } })) as PublicRoute | null;
}

export async function liveRouteByGrant(env: Pick<Env, 'DB'>, workspaceId: string, grantId: string): Promise<PublicRoute | null> {
	return (await createDirectoryClient(env.DB).publicShare.findFirst({ where: { workspaceId, grantId, revokedAt: null } })) as PublicRoute | null;
}

/** Creates (or returns) the public link of a page. The caller already proved `full` on the page. */
export async function createPublicLink(
	env: Pick<Env, 'DB' | 'WORKSPACE'>,
	actor: Actor,
	input: { pageId: string; level: AccessLevel }
): Promise<DoGrant> {
	if (!PUBLIC_LINK_LEVELS.includes(input.level)) {
		throw new ORPCError('BAD_REQUEST', { message: 'A public link can only give view access' });
	}
	const existing = await livePublicRoute(env, actor.workspaceId, input.pageId);
	if (existing) return toGrant(existing, input.level);

	const rpc = workspaceShare(env, actor.workspaceId);
	// 1. The DO grant mints the token.
	const grant = await rpc.setGrant(actor, { pageId: input.pageId, subjectKind: 'public', subjectId: null, level: input.level });
	if (!grant.token) throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'The public link could not be created' });
	// 2. Then the D1 route.
	try {
		await createDirectoryClient(env.DB).publicShare.create({
			data: {
				id: crypto.randomUUID(),
				token: grant.token,
				workspaceId: actor.workspaceId,
				pageId: input.pageId,
				createdBy: actor.userId,
				createdAt: new Date(),
				grantId: grant.id
			}
		});
	} catch (error) {
		// No route: the grant would be unreachable. Take it back (best effort; an orphan grant is harmless
		// because only a D1 route lets a visitor find the workspace).
		await rpc.revokeGrant(actor, grant.id).catch((revokeError) => {
			console.error('[share] could not take back the public grant after a failed route insert:', String(revokeError));
		});
		throw error;
	}
	return grant;
}

const isGone = (error: unknown) => /not.?found/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));

/** Revokes a link: D1 first, then the DO. The caller already proved `full` on the page. */
export async function revokePublicLink(env: Pick<Env, 'DB' | 'WORKSPACE'>, actor: Actor, route: PublicRoute): Promise<{ seq: number }> {
	const db = createDirectoryClient(env.DB);
	// 1. The route dies now: `resolveShare` stops answering for this token.
	const result = await db.publicShare.updateMany({ where: { id: route.id, revokedAt: null }, data: { revokedAt: new Date() } });
	if (result.count === 0) return { seq: 0 }; // somebody else revoked it first
	// 2. Then the DO grant. Failing here is fine for the visitor (the link is already dead): reconcile retries.
	try {
		const answer = route.grantId ? await workspaceShare(env, actor.workspaceId).revokeGrant(actor, route.grantId) : null;
		await db.publicShare.updateMany({ where: { id: route.id }, data: { doRevokedAt: new Date() } });
		return { seq: (answer && typeof answer === 'object' && answer.seq) || 0 };
	} catch (error) {
		if (isGone(error)) {
			await db.publicShare.updateMany({ where: { id: route.id }, data: { doRevokedAt: new Date() } });
			return { seq: 0 };
		}
		console.error(`[share] revoked the route of ${route.pageId} but not its DO grant yet (reconcile retries):`, String(error));
		return { seq: 0 };
	}
}

export interface ResolvedShare {
	workspaceId: string;
	pageId: string;
	level: AccessLevel;
}

/**
 * What a share token opens: the D1 route, then the DO's grant for the token. Null when the token is
 * unknown, revoked, the workspace is in the trash, or the two stores disagree (the DO is the authority).
 */
export async function resolveShare(env: Pick<Env, 'DB' | 'WORKSPACE'>, token: string): Promise<ResolvedShare | null> {
	if (!isShareToken(token)) return null;
	const db = createDirectoryClient(env.DB);
	const route = await db.publicShare.findFirst({ where: { token, revokedAt: null } });
	if (!route) return null;
	// `softDelete()` hides a workspace in the trash.
	if (!(await db.workspace.findFirst({ where: { id: route.workspaceId }, select: { id: true } }))) return null;
	let grant: Awaited<ReturnType<ReturnType<typeof workspaceShare>['grantByToken']>>;
	try {
		grant = await workspaceShare(env, route.workspaceId).grantByToken(token);
	} catch (error) {
		console.error('[share] grantByToken failed:', String(error));
		return null;
	}
	if (!grant || grant.pageId !== route.pageId) return null;
	return { workspaceId: route.workspaceId, pageId: route.pageId, level: grant.level };
}

export interface ReconcileResult {
	checked: number;
	routesRevoked: number;
	grantsRevoked: number;
	failed: number;
}

/**
 * Nightly: makes D1 routes and DO grants agree. A live route whose grant is gone is revoked; a revoked route
 * whose grant is still live (a crash between the two revoke steps) loses its grant.
 */
export async function reconcilePublicShares(env: Pick<Env, 'DB' | 'WORKSPACE'>, limit = 500): Promise<ReconcileResult> {
	const db = globalClient(env.DB);
	const result: ReconcileResult = { checked: 0, routesRevoked: 0, grantsRevoked: 0, failed: 0 };

	const live = await db.publicShare.findMany({ where: { revokedAt: null }, take: limit });
	for (const route of live) {
		result.checked++;
		try {
			const grant = await workspaceShare(env, route.workspaceId).grantByToken(route.token);
			if (grant && grant.pageId === route.pageId) continue;
			const now = new Date();
			await db.publicShare.updateMany({ where: { id: route.id, revokedAt: null }, data: { revokedAt: now, doRevokedAt: now } });
			result.routesRevoked++;
		} catch (error) {
			result.failed++;
			console.error(`[reconcile] public route ${route.id} check failed:`, String(error));
		}
	}

	const dangling = await db.publicShare.findMany({ where: { revokedAt: { not: null }, doRevokedAt: null }, take: limit });
	for (const route of dangling) {
		result.checked++;
		try {
			const rpc = workspaceShare(env, route.workspaceId);
			const grant = await rpc.grantByToken(route.token);
			if (grant) {
				const grantId = route.grantId ?? grant.id;
				if (grantId) await rpc.revokeGrant(systemActor(route.workspaceId, route.createdBy) as ShareActor, grantId);
				result.grantsRevoked++;
			}
			await db.publicShare.updateMany({ where: { id: route.id }, data: { doRevokedAt: new Date() } });
		} catch (error) {
			if (isGone(error)) {
				await db.publicShare.updateMany({ where: { id: route.id }, data: { doRevokedAt: new Date() } });
				continue;
			}
			result.failed++;
			console.error(`[reconcile] public route ${route.id} revoke failed:`, String(error));
		}
	}
	return result;
}
