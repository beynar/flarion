/**
 * Guests: pending page grants carried by guest invites, and the ledger of the DO grants given to guests
 * (`guestGrant`) so converting a guest to a member, or removing them, takes every grant away with them.
 * The Workspace DO lists grants per page only, hence the ledger.
 *
 * Every function here is best effort per row and idempotent: a failure leaves the row for the nightly
 * `reconcileGuests`.
 */
import { createDirectoryClient, globalClient } from '../db/global.client';
import { workspaceShare, systemActor, type AccessLevel, type ShareActor } from './do-rpc';

const isUniqueViolation = (error: unknown) =>
	error instanceof Error && /unique|constraint/i.test(`${error.name} ${error.message} ${(error as { code?: string }).code ?? ''}`);
const isGone = (error: unknown) => /not.?found/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));

/** Remembers a DO grant given to a guest. Idempotent (the DO may answer the same grant id again). */
export async function recordGuestGrant(
	env: Pick<Env, 'DB'>,
	row: { workspaceId: string; userId: string; pageId: string; grantId: string; createdBy: string }
): Promise<void> {
	try {
		await globalClient(env.DB).guestGrant.create({ data: { id: crypto.randomUUID(), createdAt: new Date(), ...row } });
	} catch (error) {
		if (!isUniqueViolation(error)) throw error;
	}
}

/**
 * Applies the pending page grants of an accepted guest invite to the new member, through the DO, as the
 * person who asked for them (their `full` access was checked when they asked). Returns how many applied.
 */
export async function applyPendingGrants(
	env: Pick<Env, 'DB' | 'WORKSPACE'>,
	input: { inviteId: string; userId: string; guest: boolean }
): Promise<number> {
	const db = globalClient(env.DB);
	const pending = await db.pendingGrant.findMany({ where: { inviteId: input.inviteId, appliedAt: null } });
	let applied = 0;
	for (const row of pending) {
		try {
			const rpc = workspaceShare(env, row.workspaceId);
			const grant = await rpc.setGrant(systemActor(row.workspaceId, row.createdBy) as ShareActor, {
				pageId: row.pageId,
				subjectKind: 'user',
				subjectId: input.userId,
				level: row.level as AccessLevel
			});
			if (input.guest) {
				await recordGuestGrant(env, { workspaceId: row.workspaceId, userId: input.userId, pageId: row.pageId, grantId: grant.id, createdBy: row.createdBy });
			}
			await db.pendingGrant.deleteMany({ where: { id: row.id } });
			applied++;
		} catch (error) {
			// The page may be gone or the DO unavailable: the row stays for the nightly retry.
			console.error(`[guests] could not apply pending grant ${row.id}:`, String(error));
		}
	}
	return applied;
}

/** Revokes every DO grant the ledger holds for a user. Returns how many were revoked. */
export async function revokeGuestGrants(env: Pick<Env, 'DB' | 'WORKSPACE'>, workspaceId: string, userId: string, byUserId: string): Promise<number> {
	const db = globalClient(env.DB);
	const rows = await db.guestGrant.findMany({ where: { workspaceId, userId } });
	let revoked = 0;
	for (const row of rows) {
		try {
			await workspaceShare(env, workspaceId).revokeGrant(systemActor(workspaceId, byUserId) as ShareActor, row.grantId);
		} catch (error) {
			if (!isGone(error)) {
				console.error(`[guests] could not revoke grant ${row.grantId} of ${userId}:`, String(error));
				continue;
			}
		}
		await db.guestGrant.deleteMany({ where: { id: row.id } });
		revoked++;
	}
	return revoked;
}

export interface GuestReconcileResult {
	pendingApplied: number;
	grantsRevoked: number;
}

/**
 * Nightly: applies pending grants of invites that were accepted while the DO was unavailable, and revokes the
 * grants of guests who are no longer guests (converted or removed) when the inline revoke failed.
 */
export async function reconcileGuests(env: Pick<Env, 'DB' | 'WORKSPACE'>, limit = 500): Promise<GuestReconcileResult> {
	const db = createDirectoryClient(env.DB);
	const result: GuestReconcileResult = { pendingApplied: 0, grantsRevoked: 0 };

	const stuck = await globalClient(env.DB).pendingGrant.findMany({
		where: { appliedAt: null, invite: { is: { acceptedAt: { not: null } } } },
		include: { invite: { select: { id: true, email: true, role: true, workspaceId: true } } },
		take: limit
	});
	const seen = new Set<string>();
	for (const row of stuck) {
		if (!row.invite || seen.has(row.invite.id)) continue;
		seen.add(row.invite.id);
		const user = await db.user.findFirst({ where: { email: row.invite.email }, select: { id: true } });
		if (!user) continue;
		const membership = await db.membership.findFirst({ where: { workspaceId: row.invite.workspaceId, userId: user.id }, select: { role: true } });
		if (!membership) continue; // removed since: the grant must not come back
		result.pendingApplied += await applyPendingGrants(env, { inviteId: row.invite.id, userId: user.id, guest: membership.role === 'guest' });
	}

	const ledger = await globalClient(env.DB).guestGrant.findMany({ take: limit });
	const checked = new Set<string>();
	for (const row of ledger) {
		const key = `${row.workspaceId}:${row.userId}`;
		if (checked.has(key)) continue;
		checked.add(key);
		const membership = await db.membership.findFirst({ where: { workspaceId: row.workspaceId, userId: row.userId }, select: { role: true } });
		if (membership?.role === 'guest') continue;
		result.grantsRevoked += await revokeGuestGrants(env, row.workspaceId, row.userId, row.createdBy);
	}
	return result;
}
