/**
 * Logic behind the `page.grants.*` handlers (the Sync core's `page.ts` only wires them). The Workspace DO
 * decides and enforces access; this layer adds what lives in D1: guest invites and memberships, the public
 * link route, and the guest ledger.
 *
 * - `set` handles `user`, `teamspace`, `workspace`, `public` and a person by email (member, known user, or
 *   a new guest invite).
 * - Only callers with `full` on the page set or revoke, and guests never share: the DO enforces the first
 *   (its errors map to FORBIDDEN in `requireWorkspace`), this layer checks it up front so nothing in D1 is
 *   touched for a caller who may not.
 */
import { ORPCError } from '@orpc/server';
import type { Grant } from '../../lib/shared/schemas';
import { createDirectoryClient, globalClient } from '../db/global.client';
import type { Actor, SessionInfo } from '../auth/session';
import { createInvite, deliver, limitInvites, requireVerifiedInviter, type Services } from '../auth/workspaces';
import { outboxInsert } from '../auth/outbox';
import { pageSharedMail, sendMail } from '../mail';
import { levelOf, workspaceShare, type AccessLevel, type DoGrant, type WorkspaceShareRpc } from './do-rpc';
import { recordGuestGrant } from './guests';
import { createPublicLink, liveRouteByGrant, revokePublicLink } from './public-links';

export interface GrantSetInput {
	pageId: string;
	subjectKind: 'user' | 'workspace' | 'teamspace' | 'public';
	subjectId: string | null;
	level: AccessLevel;
	email?: string;
}

const dto = (grant: DoGrant): Grant => ({
	id: grant.id,
	pageId: grant.pageId,
	subjectKind: grant.subjectKind,
	subjectId: grant.subjectId ?? null,
	level: grant.level,
	token: grant.token ?? null,
	createdBy: grant.createdBy,
	...(grant.inherited ? { inherited: true, ...(grant.fromPageId ? { fromPageId: grant.fromPageId } : {}) } : {})
});

function forbidGuest(actor: Actor): void {
	if (actor.role === 'guest') throw new ORPCError('FORBIDDEN', { message: 'Guests cannot share pages' });
}

/** The caller must hold `full` on the page; a page they cannot see is NOT_FOUND. */
async function requireFull(rpc: WorkspaceShareRpc, actor: Actor, pageId: string): Promise<void> {
	const level = levelOf(await rpc.pageAccess(actor, pageId));
	if (!level) throw new ORPCError('NOT_FOUND', { message: 'Page not found' });
	if (level !== 'full') throw new ORPCError('FORBIDDEN', { message: 'Only people with full access can share this page' });
}

const MAX_ANCESTORS = 20;

/**
 * Grants of the ancestors, marked `inherited` with the page they come from. The DO lists direct grants only,
 * so this walks up the tree; it stops at the first ancestor the caller cannot read (their access then comes
 * from somewhere else, and the ancestors above are not theirs to see).
 */
async function inheritedGrants(rpc: WorkspaceShareRpc, actor: Actor, pageId: string): Promise<Grant[]> {
	const out: Grant[] = [];
	try {
		let current = (await rpc.getPage(actor, pageId)).parentId ?? null;
		for (let depth = 0; current && depth < MAX_ANCESTORS; depth++) {
			const ancestor: string = current;
			for (const grant of await rpc.listGrants(actor, ancestor)) {
				out.push({ ...dto(grant), inherited: true, fromPageId: grant.fromPageId ?? ancestor });
			}
			current = (await rpc.getPage(actor, ancestor)).parentId ?? null;
		}
	} catch {
		// an ancestor the caller cannot see ends the walk
	}
	return out;
}

export async function listPageGrants(services: Services, actor: Actor, pageId: string): Promise<Grant[]> {
	const { env } = services;
	const rpc = workspaceShare(env, actor.workspaceId);
	const grants = (await rpc.listGrants(actor, pageId)).map(dto);
	grants.push(...(await inheritedGrants(rpc, actor, pageId)));
	// Guest invites that carry this page show as pending grants, to people who can manage the page.
	if (actor.role !== 'guest' && levelOf(await rpc.pageAccess(actor, pageId)) === 'full') {
		const pending = await globalClient(env.DB).pendingGrant.findMany({
			where: { workspaceId: actor.workspaceId, pageId, appliedAt: null },
			include: { invite: { select: { email: true, acceptedAt: true } } }
		});
		for (const row of pending) {
			if (!row.invite || row.invite.acceptedAt) continue;
			grants.push({
				id: row.id,
				pageId,
				subjectKind: 'user',
				subjectId: null,
				level: row.level as AccessLevel,
				token: null,
				createdBy: row.createdBy,
				pending: true,
				email: row.invite.email
			});
		}
	}
	return grants;
}

export async function setPageGrant(services: Services, actor: Actor, session: SessionInfo, input: GrantSetInput): Promise<Grant> {
	const { env } = services;
	forbidGuest(actor);
	const rpc = workspaceShare(env, actor.workspaceId);
	await requireFull(rpc, actor, input.pageId);

	if (input.email) return shareWithEmail(services, actor, session, rpc, { ...input, email: input.email });

	switch (input.subjectKind) {
		case 'public':
			return dto(await createPublicLink(env, actor, { pageId: input.pageId, level: input.level }));
		case 'workspace':
			return dto(await rpc.setGrant(actor, { pageId: input.pageId, subjectKind: 'workspace', subjectId: null, level: input.level }));
		case 'teamspace':
			if (!input.subjectId) throw new ORPCError('BAD_REQUEST', { message: 'A teamspace grant needs a teamspace' });
			return dto(await rpc.setGrant(actor, { pageId: input.pageId, subjectKind: 'teamspace', subjectId: input.subjectId, level: input.level }));
		case 'user': {
			if (!input.subjectId) throw new ORPCError('BAD_REQUEST', { message: 'Pick a person, or share by email' });
			const membership = await createDirectoryClient(env.DB).membership.findFirst({
				where: { workspaceId: actor.workspaceId, userId: input.subjectId },
				select: { role: true }
			});
			if (!membership) throw new ORPCError('BAD_REQUEST', { message: 'That person is not in this workspace: share with their email instead' });
			return dto(await grantToUser(env, rpc, actor, input, input.subjectId, membership.role === 'guest'));
		}
	}
}

async function grantToUser(
	env: Env,
	rpc: WorkspaceShareRpc,
	actor: Actor,
	input: { pageId: string; level: AccessLevel },
	userId: string,
	guest: boolean
): Promise<DoGrant> {
	const grant = await rpc.setGrant(actor, { pageId: input.pageId, subjectKind: 'user', subjectId: userId, level: input.level });
	if (guest) await recordGuestGrant(env, { workspaceId: actor.workspaceId, userId, pageId: input.pageId, grantId: grant.id, createdBy: actor.userId });
	return grant;
}

/**
 * A person by email. A workspace member just gets the grant. A known user who is not a member becomes a
 * guest membership (D1 + outbox `syncMember`), then gets the DO grant and a mail. Anybody else gets a guest
 * invite whose grant is pending until they accept.
 */
async function shareWithEmail(
	services: Services,
	actor: Actor,
	session: SessionInfo,
	rpc: WorkspaceShareRpc,
	input: GrantSetInput & { email: string }
): Promise<Grant> {
	const { env } = services;
	const email = input.email.trim().toLowerCase();
	const db = createDirectoryClient(env.DB, actor.userId);
	await requireVerifiedInviter(env, session);

	const [workspace, user] = await Promise.all([
		db.workspace.findFirst({ where: { id: actor.workspaceId }, select: { name: true, slug: true } }),
		db.user.findFirst({ where: { email }, select: { id: true, name: true } })
	]);
	if (!workspace) throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
	const page = await rpc.getPage(actor, input.pageId);
	const title = page.title ?? '';

	if (!user) {
		const invite = await createInvite(services, actor, session, { email, role: 'guest' }, { pageId: input.pageId, level: input.level, title });
		return {
			id: invite.pendingGrantId ?? crypto.randomUUID(),
			pageId: input.pageId,
			subjectKind: 'user',
			subjectId: null,
			level: input.level,
			token: null,
			createdBy: actor.userId,
			pending: true,
			email
		};
	}

	await limitInvites(env, actor.userId);
	const membership = await db.membership.findFirst({ where: { workspaceId: actor.workspaceId, userId: user.id }, select: { role: true } });
	let added = false;
	if (!membership) {
		const outbox = outboxInsert(db, actor.workspaceId, { kind: 'syncMember', payload: { userId: user.id, role: 'guest', name: user.name } });
		await db.$transaction([
			db.membership.create({ data: { id: crypto.randomUUID(), workspaceId: actor.workspaceId, userId: user.id, role: 'guest', joinedAt: new Date() } }),
			outbox.operation
		]);
		if (!(await deliver(services, [outbox.id]))) {
			throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Could not add the guest right now. Try again in a moment.' });
		}
		added = true;
	}
	const grant = await grantToUser(env, rpc, actor, input, user.id, !membership || membership.role === 'guest');
	if (added) {
		try {
			await sendMail(env, {
				to: email,
				...pageSharedMail({
					inviterName: actor.name,
					workspaceName: workspace.name,
					pageTitle: title,
					level: input.level,
					url: `${env.APP_ORIGIN}/${workspace.slug}/${input.pageId}`
				})
			});
		} catch (error) {
			console.error('[share] mail to the new guest failed:', error instanceof Error ? error.message : error);
		}
	}
	return dto(grant);
}

export async function revokePageGrant(services: Services, actor: Actor, grantId: string): Promise<{ seq: number }> {
	const { env } = services;
	forbidGuest(actor);
	const rpc = workspaceShare(env, actor.workspaceId);

	// A public link: D1 route first, then the DO grant.
	const route = await liveRouteByGrant(env, actor.workspaceId, grantId);
	if (route) {
		await requireFull(rpc, actor, route.pageId);
		return revokePublicLink(env, actor, route);
	}
	// A pending guest grant only exists in D1.
	const db = globalClient(env.DB);
	const pending = await db.pendingGrant.findFirst({ where: { id: grantId, workspaceId: actor.workspaceId, appliedAt: null } });
	if (pending) {
		await requireFull(rpc, actor, pending.pageId);
		await db.pendingGrant.deleteMany({ where: { id: grantId } });
		return { seq: 0 };
	}
	const answer = await rpc.revokeGrant(actor, grantId);
	await db.guestGrant.deleteMany({ where: { grantId } });
	return { seq: (answer && typeof answer === 'object' && answer.seq) || 0 };
}
