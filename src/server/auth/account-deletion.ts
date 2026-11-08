/**
 * Account deletion and ownership transfer (docs/PLAN.md "Security rules": "Account deletion: removes memberships and
 * passkeys, and shows the user as 'Deleted user' in history and attribution").
 *
 * - **Refused while the person owns a workspace.** The owner must transfer ownership (`transferOwnership`) or delete the
 *   workspace first; the error (`CONFLICT`, `data.code` `OWNS_WORKSPACES`) lists the workspaces.
 * - **What goes**: every membership (tombstoned in D1, and each Workspace DO told through the outbox, so access ends in
 *   them too), every passkey, session and linked account, every API token (revoked), the guest grants they held, and
 *   pending verification rows for their email.
 * - **What stays, anonymised.** The `user` row keeps its id, because pages, history and comments name people by id, but
 *   its name becomes "Deleted user", its email a unique unroutable address, and it has no passkey, so nobody can sign in
 *   as it. Everything that shows a person by id therefore shows "Deleted user" (the public API says so too).
 * - The email is free again: the same address can sign up as a new person.
 */
import { ORPCError } from '@orpc/server';
import { createDirectoryClient } from '../db/global.client';
import { deliver, type Services } from './workspaces';
import { outboxInsert } from './outbox';
import type { SessionInfo, WorkspaceRole } from './session';
import { revokeGuestGrants } from '../share/guests';

export const DELETED_USER_NAME = 'Deleted user';
/** `.invalid` never resolves (RFC 2606): mail to a deleted account goes nowhere. */
export const deletedEmail = (userId: string): string => `deleted-${userId}@deleted.invalid`;

export interface OwnedWorkspace {
	id: string;
	name: string;
}

/** The live workspaces `userId` owns. */
export async function ownedWorkspaces(env: Pick<Env, 'DB'>, userId: string): Promise<OwnedWorkspace[]> {
	const db = createDirectoryClient(env.DB);
	const memberships = await db.membership.findMany({ where: { userId, role: 'owner' }, select: { workspaceId: true } });
	if (memberships.length === 0) return [];
	const workspaces = await db.workspace.findMany({ where: { id: { in: memberships.map((m) => m.workspaceId) } }, select: { id: true, name: true } });
	return workspaces.map((w) => ({ id: w.id, name: w.name }));
}

export async function deleteAccount(services: Services, session: SessionInfo, confirmEmail: string): Promise<void> {
	const { env } = services;
	const db = createDirectoryClient(env.DB, session.userId);
	const user = await db.user.findFirst({ where: { id: session.userId }, select: { id: true, email: true, name: true } });
	if (!user) throw new ORPCError('NOT_FOUND', { message: 'Account not found' });
	if (user.email.toLowerCase() !== confirmEmail.trim().toLowerCase()) throw new ORPCError('BAD_REQUEST', { message: 'The email does not match your account' });

	const owned = await ownedWorkspaces(env, user.id);
	if (owned.length > 0) {
		throw new ORPCError('CONFLICT', {
			message: `You own ${owned.map((w) => `"${w.name}"`).join(', ')}. Transfer ownership or delete ${owned.length === 1 ? 'it' : 'them'} first.`,
			data: { code: 'OWNS_WORKSPACES', workspaces: owned }
		});
	}

	const memberships = await db.membership.findMany({ where: { userId: user.id }, select: { workspaceId: true, role: true } });
	const now = new Date();
	const outboxes = memberships.map((m) => outboxInsert(db, m.workspaceId, { kind: 'syncMember', payload: { userId: user.id, role: null } }, now));
	await db.$transaction([
		db.membership.deleteMany({ where: { userId: user.id } }),
		db.passkey.deleteMany({ where: { userId: user.id } }),
		db.session.deleteMany({ where: { userId: user.id } }),
		db.account.deleteMany({ where: { userId: user.id } }),
		db.verification.deleteMany({ where: { identifier: user.email } }),
		db.apiToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } }),
		db.user.update({
			where: { id: user.id },
			data: { name: DELETED_USER_NAME, email: deletedEmail(user.id), emailVerified: false, image: null, notifyMentions: false, updatedAt: now }
		}),
		...outboxes.map((outbox) => outbox.operation)
	]);
	await deliver(services, outboxes.map((outbox) => outbox.id));
	// Pages shared with them as a guest: the grants are the Workspace DO's; the nightly reconcile retries failures.
	for (const membership of memberships) {
		if (membership.role === 'guest') await revokeGuestGrants(env, membership.workspaceId, user.id, user.id).catch((error) => console.warn('[account] guest grants:', String(error)));
	}
}

/**
 * Hands a workspace to another member: they become its owner, the caller becomes an admin. Owner only; the new owner
 * must be a current member and not a guest (a guest cannot hold a workspace).
 */
export async function transferOwnership(
	services: Services,
	actor: { userId: string; role: WorkspaceRole; workspaceId: string },
	toUserId: string
): Promise<void> {
	if (actor.role !== 'owner') throw new ORPCError('FORBIDDEN', { message: 'Only the owner can transfer a workspace' });
	if (toUserId === actor.userId) throw new ORPCError('BAD_REQUEST', { message: 'You already own this workspace' });
	const db = createDirectoryClient(services.env.DB, actor.userId);
	const target = await db.membership.findFirst({ where: { workspaceId: actor.workspaceId, userId: toUserId }, include: { user: { select: { name: true } } } });
	if (!target) throw new ORPCError('NOT_FOUND', { message: 'That person is not a member of this workspace' });
	if (target.role === 'guest') throw new ORPCError('BAD_REQUEST', { message: 'A guest cannot own a workspace. Make them a member first.' });
	const me = await db.user.findFirst({ where: { id: actor.userId }, select: { name: true } });
	const toTarget = outboxInsert(db, actor.workspaceId, { kind: 'syncMember', payload: { userId: toUserId, role: 'owner', name: target.user?.name } });
	const toMe = outboxInsert(db, actor.workspaceId, { kind: 'syncMember', payload: { userId: actor.userId, role: 'admin', name: me?.name } });
	await db.$transaction([
		db.membership.updateMany({ where: { workspaceId: actor.workspaceId, userId: toUserId }, data: { role: 'owner' } }),
		db.membership.updateMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, data: { role: 'admin' } }),
		toTarget.operation,
		toMe.operation
	]);
	await deliver(services, [toTarget.id, toMe.id]);
}

/**
 * Refuses a deleted account. Its session cookie may still verify for a few minutes (better-auth's cookie cache), and the
 * `user` row stays; the actions that would give such a session something new (a workspace, an invitation) look at the row.
 */
export async function assertAccountActive(env: Pick<Env, 'DB'>, userId: string): Promise<void> {
	const user = await createDirectoryClient(env.DB).user.findFirst({ where: { id: userId }, select: { email: true } });
	if (!user || user.email === deletedEmail(userId)) throw new ORPCError('UNAUTHORIZED', { message: 'This account was deleted' });
}
