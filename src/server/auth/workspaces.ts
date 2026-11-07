/**
 * Workspace directory logic behind `rpc/private/{me,workspace}.ts`: D1 is the source of truth; every
 * change the Workspace DO must learn about is written with an outbox row in the same D1 batch (see
 * `outbox.ts`) and delivered right after.
 */
import { ORPCError } from '@orpc/server';
import { createDirectoryClient, type DirectoryClient } from '../db/global.client';
import { INVITE_TTL_DAYS, hashInviteToken, isInviteUsable, lookupInvite, newInviteToken } from './invites';
import { inviteMail, sendMail } from '../mail';
import { drainOutbox, outboxInsert, runOutbox } from './outbox';
import type { SessionInfo, WorkspaceRole } from './session';

type Services = { env: Env; ctx: Pick<ExecutionContext, 'waitUntil'> };

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const iso = (date: Date) => date.toISOString();

export interface WorkspaceDto {
	id: string;
	name: string;
	slug: string;
	icon: string | null;
	role: WorkspaceRole;
	createdAt: string;
}

interface WorkspaceRow {
	id: string;
	name: string;
	slug: string;
	icon: string | null;
	createdAt: Date;
}

const dto = (row: WorkspaceRow, role: WorkspaceRole): WorkspaceDto => ({
	id: row.id,
	name: row.name,
	slug: row.slug,
	icon: row.icon,
	role,
	createdAt: iso(row.createdAt)
});

export function slugify(name: string): string {
	const base = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 30)
		.replace(/-+$/g, '');
	return base.length >= 3 ? base : `${base || 'workspace'}-ws`.slice(0, 30);
}

const isUniqueViolation = (error: unknown) =>
	error instanceof Error && /unique|constraint/i.test(`${error.name} ${error.message} ${(error as { code?: string }).code ?? ''}`);

/** Delivers the outbox rows right away; whatever fails is retried by a later drain. */
async function deliver(services: Services, ids: string[]): Promise<void> {
	for (const id of ids) await runOutbox(services.env, id);
	services.ctx.waitUntil(drainOutbox(services.env).catch(() => undefined));
}

export async function listWorkspaces(env: Env, userId: string): Promise<WorkspaceDto[]> {
	const db = createDirectoryClient(env.DB);
	const memberships = await db.membership.findMany({
		where: { userId },
		include: { workspace: true },
		orderBy: { joinedAt: 'asc' }
	});
	const workspaces: WorkspaceDto[] = [];
	for (const membership of memberships) {
		if (membership.workspace) workspaces.push(dto(membership.workspace, membership.role as WorkspaceRole));
	}
	return workspaces;
}

export async function getWorkspace(env: Env, workspaceId: string, role: WorkspaceRole): Promise<WorkspaceDto> {
	const row = await createDirectoryClient(env.DB).workspace.findFirst({ where: { id: workspaceId } });
	if (!row) throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
	return dto(row, role);
}

export async function createWorkspace(
	services: Services,
	session: SessionInfo,
	input: { name: string; slug?: string; icon?: string | null }
): Promise<WorkspaceDto> {
	const { env } = services;
	const db = createDirectoryClient(env.DB, session.userId);
	const explicit = input.slug !== undefined;
	const now = new Date();
	const id = crypto.randomUUID();

	for (let attempt = 0; attempt < 6; attempt++) {
		const base = input.slug ?? slugify(input.name);
		const slug = attempt === 0 ? base : `${base.slice(0, 33)}-${crypto.randomUUID().slice(0, 4)}`;
		if (!SLUG.test(slug)) throw new ORPCError('BAD_REQUEST', { message: 'Invalid workspace address' });
		if (await db.workspace.findFirst({ where: { slug }, select: { id: true } })) {
			if (explicit) throw new ORPCError('CONFLICT', { message: 'That workspace address is taken' });
			continue;
		}
		const outbox = outboxInsert(db, id, {
			kind: 'init',
			payload: { workspaceId: id, name: input.name, ownerId: session.userId, ownerName: session.name }
		});
		try {
			await db.$transaction([
				db.workspace.create({ data: { id, name: input.name, slug, icon: input.icon ?? null, createdAt: now } }),
				db.membership.create({
					data: { id: crypto.randomUUID(), workspaceId: id, userId: session.userId, role: 'owner', joinedAt: now }
				}),
				outbox.operation
			]);
		} catch (error) {
			if (isUniqueViolation(error) && !explicit) continue;
			if (isUniqueViolation(error)) throw new ORPCError('CONFLICT', { message: 'That workspace address is taken' });
			throw error;
		}
		await deliver(services, [outbox.id]);
		return dto({ id, name: input.name, slug, icon: input.icon ?? null, createdAt: now }, 'owner');
	}
	throw new ORPCError('CONFLICT', { message: 'Could not find a free workspace address' });
}

export async function updateWorkspace(
	services: Services,
	workspaceId: string,
	role: WorkspaceRole,
	input: { name?: string; slug?: string; icon?: string | null }
): Promise<WorkspaceDto> {
	const { env } = services;
	if (role !== 'owner' && role !== 'admin') throw new ORPCError('FORBIDDEN', { message: 'Only owners and admins can change workspace settings' });
	const db = createDirectoryClient(env.DB);
	const data: { name?: string; slug?: string; icon?: string | null } = {};
	if (input.name !== undefined) data.name = input.name;
	if (input.icon !== undefined) data.icon = input.icon;
	if (input.slug !== undefined) {
		if (!SLUG.test(input.slug)) throw new ORPCError('BAD_REQUEST', { message: 'Invalid workspace address' });
		const taken = await db.workspace.findFirst({ where: { slug: input.slug, NOT: { id: workspaceId } }, select: { id: true } });
		if (taken) throw new ORPCError('CONFLICT', { message: 'That workspace address is taken' });
		data.slug = input.slug;
	}
	if (Object.keys(data).length > 0) {
		// A rename also goes to the Workspace DO (which keeps the name in its meta), through the outbox.
		const outbox = data.name !== undefined ? outboxInsert(db, workspaceId, { kind: 'rename', payload: { name: data.name } }) : null;
		try {
			const update = db.workspace.updateMany({ where: { id: workspaceId }, data });
			if (outbox) {
				const [result] = await db.$transaction([update, outbox.operation]);
				if (result.count === 0) throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
				await deliver(services, [outbox.id]);
			} else {
				const result = await update;
				if (result.count === 0) throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
			}
		} catch (error) {
			if (isUniqueViolation(error)) throw new ORPCError('CONFLICT', { message: 'That workspace address is taken' });
			throw error;
		}
	}
	return getWorkspace(env, workspaceId, role);
}

const PURGE_AFTER_DAYS = 30;

/** Soft-deletes the workspace (owner only) and has every member's DO mirror dropped, which blocks sign-in to it. */
export async function deleteWorkspace(
	services: Services,
	actor: { userId: string; role: WorkspaceRole; workspaceId: string },
	confirmName: string
): Promise<{ purgeAfter: string }> {
	if (actor.role !== 'owner') throw new ORPCError('FORBIDDEN', { message: 'Only the owner can delete a workspace' });
	const { env } = services;
	const db = createDirectoryClient(env.DB, actor.userId);
	const workspace = await db.workspace.findFirst({ where: { id: actor.workspaceId } });
	if (!workspace) throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
	if (workspace.name.trim() !== confirmName.trim()) throw new ORPCError('BAD_REQUEST', { message: 'The name does not match' });
	const members = await db.membership.findMany({ where: { workspaceId: workspace.id }, select: { userId: true } });
	const outboxes = members.map((member) => outboxInsert(db, workspace.id, { kind: 'syncMember', payload: { userId: member.userId, role: null } }));
	await db.$transaction([db.workspace.delete({ where: { id: workspace.id } }), ...outboxes.map((outbox) => outbox.operation)]);
	await deliver(services, outboxes.map((outbox) => outbox.id));
	return { purgeAfter: iso(new Date(Date.now() + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000)) };
}

// ───────────────────────────── members ─────────────────────────────

export async function listMembers(env: Env, workspaceId: string) {
	const members = await createDirectoryClient(env.DB).membership.findMany({
		where: { workspaceId },
		include: { user: true },
		orderBy: { joinedAt: 'asc' }
	});
	return members.flatMap((member) =>
		member.user
			? [
					{
						userId: member.userId,
						name: member.user.name,
						email: member.user.email,
						image: member.user.image,
						role: member.role as WorkspaceRole,
						joinedAt: iso(member.joinedAt)
					}
				]
			: []
	);
}

async function memberOrThrow(db: DirectoryClient, workspaceId: string, userId: string) {
	const membership = await db.membership.findFirst({ where: { workspaceId, userId }, include: { user: { select: { name: true } } } });
	if (!membership) throw new ORPCError('NOT_FOUND', { message: 'That person is not a member of this workspace' });
	return membership;
}

export async function setMemberRole(
	services: Services,
	actor: { userId: string; role: WorkspaceRole; workspaceId: string },
	input: { userId: string; role: 'admin' | 'member' | 'guest' }
): Promise<void> {
	if (actor.role !== 'owner' && actor.role !== 'admin') throw new ORPCError('FORBIDDEN', { message: 'Only owners and admins can change roles' });
	const db = createDirectoryClient(services.env.DB, actor.userId);
	const target = await memberOrThrow(db, actor.workspaceId, input.userId);
	if (target.role === 'owner') throw new ORPCError('FORBIDDEN', { message: "The owner's role cannot be changed" });
	if (actor.role === 'admin' && (target.role === 'admin' || input.role === 'admin')) {
		throw new ORPCError('FORBIDDEN', { message: 'Only the owner can manage admins' });
	}
	const outbox = outboxInsert(db, actor.workspaceId, {
		kind: 'syncMember',
		payload: { userId: input.userId, role: input.role, name: target.user?.name }
	});
	await db.$transaction([
		db.membership.updateMany({ where: { workspaceId: actor.workspaceId, userId: input.userId }, data: { role: input.role } }),
		outbox.operation
	]);
	await deliver(services, [outbox.id]);
}

export async function removeMember(
	services: Services,
	actor: { userId: string; role: WorkspaceRole; workspaceId: string },
	userId: string
): Promise<void> {
	const db = createDirectoryClient(services.env.DB, actor.userId);
	const target = await memberOrThrow(db, actor.workspaceId, userId);
	const self = userId === actor.userId;
	if (target.role === 'owner') throw new ORPCError('FORBIDDEN', { message: 'The owner cannot be removed' });
	if (!self) {
		if (actor.role !== 'owner' && actor.role !== 'admin') throw new ORPCError('FORBIDDEN', { message: 'Only owners and admins can remove members' });
		if (actor.role === 'admin' && target.role === 'admin') throw new ORPCError('FORBIDDEN', { message: 'Only the owner can remove admins' });
	}
	const outbox = outboxInsert(db, actor.workspaceId, { kind: 'syncMember', payload: { userId, role: null } });
	await db.$transaction([db.membership.deleteMany({ where: { workspaceId: actor.workspaceId, userId } }), outbox.operation]);
	await deliver(services, [outbox.id]);
}

// ───────────────────────────── invites ─────────────────────────────

const MAX_PENDING_INVITES = 100;

interface InviteRow {
	id: string;
	email: string;
	role: string;
	createdBy: string;
	expiresAt: Date;
	acceptedAt: Date | null;
}

const inviteDto = (row: InviteRow) => ({
	id: row.id,
	email: row.email,
	role: row.role as 'admin' | 'member' | 'guest',
	createdBy: row.createdBy,
	expiresAt: iso(row.expiresAt),
	acceptedAt: row.acceptedAt ? iso(row.acceptedAt) : null
});

export async function createInvite(
	services: Services,
	actor: { userId: string; name: string; role: WorkspaceRole; workspaceId: string },
	session: SessionInfo,
	input: { email: string; role: 'admin' | 'member' | 'guest' }
) {
	const { env } = services;
	if (actor.role !== 'owner' && actor.role !== 'admin') throw new ORPCError('FORBIDDEN', { message: 'Only owners and admins can invite people' });
	const email = input.email.trim().toLowerCase();
	const db = createDirectoryClient(env.DB, actor.userId);
	// The cookie cache can lag a fresh verification by a few minutes: only a "not verified" answer is re-checked.
	const verified =
		session.emailVerified || (await db.user.findFirst({ where: { id: session.userId }, select: { emailVerified: true } }))?.emailVerified === true;
	if (!verified) throw new ORPCError('FORBIDDEN', { message: 'Verify your email before inviting others' });

	const limited = await env.RL_AUTH.limit({ key: `invite:${actor.userId}` }).catch(() => ({ success: true }));
	if (!limited.success) throw new ORPCError('TOO_MANY_REQUESTS', { message: 'Too many invitations. Try again in a minute.' });

	const [workspace, existingUser, pending] = await Promise.all([
		db.workspace.findFirst({ where: { id: actor.workspaceId }, select: { name: true } }),
		db.user.findFirst({ where: { email }, select: { id: true } }),
		db.invite.count({ where: { workspaceId: actor.workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } } })
	]);
	if (!workspace) throw new ORPCError('NOT_FOUND', { message: 'Workspace not found' });
	if (existingUser && (await db.membership.findFirst({ where: { workspaceId: actor.workspaceId, userId: existingUser.id }, select: { id: true } }))) {
		throw new ORPCError('CONFLICT', { message: 'That person is already a member' });
	}
	if (pending >= MAX_PENDING_INVITES) throw new ORPCError('BAD_REQUEST', { message: 'Too many pending invitations. Revoke some first.' });

	const token = newInviteToken();
	const id = crypto.randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
	await db.$transaction([
		// A re-invite replaces the earlier pending one: only the newest link works.
		db.invite.deleteMany({ where: { workspaceId: actor.workspaceId, email, acceptedAt: null } }),
		db.invite.create({
			data: {
				id,
				workspaceId: actor.workspaceId,
				email,
				role: input.role,
				tokenHash: await hashInviteToken(token),
				createdBy: actor.userId,
				createdAt: now,
				expiresAt
			}
		})
	]);
	try {
		await sendMail(env, {
			to: email,
			...inviteMail({
				inviterName: actor.name,
				workspaceName: workspace.name,
				url: `${env.APP_ORIGIN}/invite/${token}`,
				expiresInDays: INVITE_TTL_DAYS
			})
		});
	} catch (error) {
		console.error('[invite] mail failed:', error instanceof Error ? error.message : error);
		await db.invite.deleteMany({ where: { id } });
		throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'The invitation email could not be sent. Try again.' });
	}
	return inviteDto({ id, email, role: input.role, createdBy: actor.userId, expiresAt, acceptedAt: null });
}

export async function listInvites(env: Env, workspaceId: string, role: WorkspaceRole) {
	if (role !== 'owner' && role !== 'admin') throw new ORPCError('FORBIDDEN', { message: 'Only owners and admins can see invitations' });
	const rows = await createDirectoryClient(env.DB).invite.findMany({
		where: { workspaceId },
		orderBy: { createdAt: 'desc' },
		take: 200
	});
	return rows.map(inviteDto);
}

export async function revokeInvite(env: Env, workspaceId: string, role: WorkspaceRole, id: string): Promise<void> {
	if (role !== 'owner' && role !== 'admin') throw new ORPCError('FORBIDDEN', { message: 'Only owners and admins can revoke invitations' });
	const result = await createDirectoryClient(env.DB).invite.deleteMany({ where: { id, workspaceId, acceptedAt: null } });
	if (result.count === 0) throw new ORPCError('NOT_FOUND', { message: 'Invitation not found' });
}

/**
 * Accepting an invite: the signed-in user's email must be the invited one. The membership, the invite's
 * `acceptedAt` and the outbox row go in one D1 batch; a second accept of the same link finds it used.
 */
export async function acceptInvite(services: Services, session: SessionInfo, token: string): Promise<WorkspaceDto> {
	const { env } = services;
	const invite = await lookupInvite(env, token);
	if (!invite || !isInviteUsable(invite)) throw new ORPCError('NOT_FOUND', { message: 'This invitation is no longer valid' });
	if (invite.email.toLowerCase() !== session.email.toLowerCase()) {
		throw new ORPCError('FORBIDDEN', { message: `This invitation was sent to another email address than ${session.email}` });
	}
	const db = createDirectoryClient(env.DB, session.userId);
	const workspace = await db.workspace.findFirst({ where: { id: invite.workspaceId } });
	if (!workspace) throw new ORPCError('NOT_FOUND', { message: 'This workspace no longer exists' });

	const existing = await db.membership.findFirst({ where: { workspaceId: invite.workspaceId, userId: session.userId } });
	const now = new Date();
	if (existing) {
		await db.invite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: now } });
		return dto(workspace, existing.role as WorkspaceRole);
	}
	const outbox = outboxInsert(db, invite.workspaceId, {
		kind: 'syncMember',
		payload: { userId: session.userId, role: invite.role as WorkspaceRole, name: session.name }
	});
	await db.$transaction([
		db.membership.create({
			data: { id: crypto.randomUUID(), workspaceId: invite.workspaceId, userId: session.userId, role: invite.role, joinedAt: now }
		}),
		db.invite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: now } }),
		// Following the emailed link proves the mailbox.
		db.user.updateMany({ where: { id: session.userId, emailVerified: false }, data: { emailVerified: true, updatedAt: now } }),
		outbox.operation
	]);
	await deliver(services, [outbox.id]);
	return dto(workspace, invite.role as WorkspaceRole);
}
