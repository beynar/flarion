/**
 * Teamspaces and their members, in the Workspace DO. P1 behaviour: any non-guest member may create one
 * and manage any (the creator becomes its owner); P2 puts the viborm policy in front (owners manage,
 * privacy hides private ones). Writes run through `runCommit`, so each appends a change row and the
 * archive of a teamspace tombstones its pages with one shared timestamp.
 */
import type { Teamspace, TeamspaceMember } from '../../../lib/shared/schemas';
import { rankAfter } from '../../../lib/shared/sort-keys';
import type { WorkspaceDb, WorkspaceTx } from '../../db/workspace.client';
import type { Actor } from '../../auth/session';
import type { ChangeRecord } from './eav';
import { invalid, notFound, WorkspaceError } from './errors';
import { isoTime, rawRun } from './util';

type Privacy = Teamspace['privacy'];
type Level = Teamspace['defaultLevel'];

interface TeamspaceRow {
	id: string;
	name: string;
	icon: string | null;
	description: string | null;
	privacy: string;
	defaultLevel: string;
	createdBy: string;
	deletedAt: Date | null;
}

const toTeamspace = (row: TeamspaceRow, myRole: Teamspace['myRole']): Teamspace => ({
	id: row.id,
	name: row.name,
	icon: row.icon,
	description: row.description ?? '',
	privacy: row.privacy as Privacy,
	defaultLevel: row.defaultLevel as Level,
	createdBy: row.createdBy,
	myRole
});

async function myRoles(db: WorkspaceDb, userId: string): Promise<Map<string, 'owner' | 'member'>> {
	const rows = await db.teamspaceMember.findMany({ where: { userId } });
	return new Map(rows.map((r) => [r.teamspaceId, r.role as 'owner' | 'member']));
}

const canSee = (row: TeamspaceRow, actor: Actor, role: unknown): boolean =>
	!!role || (row.privacy !== 'private' && actor.role !== 'guest');

export async function listTeamspaces(db: WorkspaceDb, actor: Actor): Promise<Teamspace[]> {
	const [rows, roles] = await Promise.all([
		db.teamspace.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } }),
		myRoles(db, actor.userId)
	]);
	return rows
		.filter((r) => canSee(r, actor, roles.get(r.id)))
		.map((r) => toTeamspace(r, roles.get(r.id) ?? null));
}

async function liveTeamspace(db: WorkspaceDb, id: string): Promise<TeamspaceRow> {
	const row = await db.teamspace.findUnique({ where: { id } });
	if (!row || row.deletedAt) throw notFound(`Teamspace "${id}"`);
	return row;
}

export async function readTeamspace(db: WorkspaceDb, actor: Actor, id: string): Promise<Teamspace> {
	const row = await liveTeamspace(db, id);
	const roles = await myRoles(db, actor.userId);
	if (!canSee(row, actor, roles.get(id))) throw notFound(`Teamspace "${id}"`);
	return toTeamspace(row, roles.get(id) ?? null);
}

export function assertNotGuest(actor: Actor, what: string): void {
	if (actor.role === 'guest') throw new WorkspaceError('FORBIDDEN', `Guests cannot ${what}`);
}

export async function nextMemberRank(db: WorkspaceDb, userId: string): Promise<string> {
	const last = await db.teamspaceMember.findFirst({
		where: { userId, rank: { not: '' } },
		orderBy: { rank: 'desc' },
		select: { rank: true }
	});
	return rankAfter(last?.rank ?? null);
}

export interface TeamspaceInput {
	id?: string;
	name: string;
	icon?: string | null;
	description?: string;
	privacy: Privacy;
	defaultLevel: Level;
}

/** Inserts a teamspace with `ownerId` as its owner. Used by `createTeamspace` and by `init`. */
export async function insertTeamspace(
	tx: WorkspaceTx,
	ownerId: string,
	input: TeamspaceInput
): Promise<{ id: string; records: ChangeRecord[] }> {
	const id = input.id ?? crypto.randomUUID();
	await tx.teamspace.create({
		data: {
			id,
			name: input.name,
			icon: input.icon ?? null,
			description: input.description ?? '',
			privacy: input.privacy,
			defaultLevel: input.defaultLevel,
			createdBy: ownerId
		}
	});
	await tx.teamspaceMember.create({
		data: { teamspaceId: id, userId: ownerId, role: 'owner', rank: await nextMemberRank(tx, ownerId) }
	});
	return {
		id,
		records: [{ kind: 'teamspace.create', page: null, prop: id, old: null, new: { name: input.name, privacy: input.privacy } }]
	};
}

export async function updateTeamspaceRecords(
	tx: WorkspaceTx,
	patch: Partial<TeamspaceInput> & { id: string }
): Promise<ChangeRecord[]> {
	const row = await liveTeamspace(tx, patch.id);
	const data: Record<string, unknown> = {};
	if (patch.name !== undefined) data.name = patch.name;
	if (patch.icon !== undefined) data.icon = patch.icon;
	if (patch.description !== undefined) data.description = patch.description;
	if (patch.privacy !== undefined) data.privacy = patch.privacy;
	if (patch.defaultLevel !== undefined) data.defaultLevel = patch.defaultLevel;
	if (Object.keys(data).length > 0) await tx.teamspace.update({ where: { id: row.id }, data });
	return [{ kind: 'teamspace.update', page: null, prop: row.id, old: null, new: data }];
}

/** Tombstones the teamspace and all its pages with one shared timestamp, exactly like a subtree. */
export async function archiveTeamspaceRecords(tx: WorkspaceTx, id: string, actorId: string, now: number): Promise<ChangeRecord[]> {
	const row = await liveTeamspace(tx, id);
	const stamp = isoTime(now);
	await tx.teamspace.update({ where: { id: row.id }, data: { deletedAt: new Date(now) } });
	const pages = await rawRun(
		tx,
		'UPDATE page SET deleted_at = ?, deleted_by = ? WHERE teamspace_id = ? AND deleted_at IS NULL',
		stamp,
		actorId,
		id
	);
	return [{ kind: 'archiveTeamspace', page: null, prop: id, old: null, new: { deletedAt: stamp, pages } }];
}

// ───────────────────────── members ─────────────────────────

const toMember = (r: { teamspaceId: string; userId: string; role: string; rank: string }): TeamspaceMember => ({
	teamspaceId: r.teamspaceId,
	userId: r.userId,
	role: r.role as 'owner' | 'member',
	rank: r.rank
});

export async function listTeamspaceMembers(db: WorkspaceDb, actor: Actor, teamspaceId: string): Promise<TeamspaceMember[]> {
	await readTeamspace(db, actor, teamspaceId);
	const rows = await db.teamspaceMember.findMany({ where: { teamspaceId }, orderBy: { userId: 'asc' } });
	return rows.map(toMember);
}

async function assertWorkspaceMember(tx: WorkspaceTx, userId: string): Promise<void> {
	const m = await tx.member.findUnique({ where: { userId } });
	if (!m || m.removedAt) throw invalid('/userId', 'not_a_member', `User "${userId}" is not a member of this workspace`);
}

async function ownerCount(tx: WorkspaceTx, teamspaceId: string): Promise<number> {
	return tx.teamspaceMember.count({ where: { teamspaceId, role: 'owner' } });
}

export async function addTeamspaceMemberRecords(
	tx: WorkspaceTx,
	input: { teamspaceId: string; userId: string; role?: 'owner' | 'member' }
): Promise<{ member: TeamspaceMember; records: ChangeRecord[] }> {
	await liveTeamspace(tx, input.teamspaceId);
	await assertWorkspaceMember(tx, input.userId);
	const existing = await tx.teamspaceMember.findUnique({
		where: { teamspaceId_userId: { teamspaceId: input.teamspaceId, userId: input.userId } }
	});
	const role = input.role ?? existing?.role ?? 'member';
	let row;
	if (existing) {
		row = await tx.teamspaceMember.update({
			where: { teamspaceId_userId: { teamspaceId: input.teamspaceId, userId: input.userId } },
			data: { role }
		});
	} else {
		row = await tx.teamspaceMember.create({
			data: { teamspaceId: input.teamspaceId, userId: input.userId, role, rank: await nextMemberRank(tx, input.userId) }
		});
	}
	return {
		member: toMember(row),
		records: [{ kind: 'teamspace.member', page: null, prop: input.teamspaceId, old: null, new: { userId: input.userId, role } }]
	};
}

export async function setTeamspaceMemberRoleRecords(
	tx: WorkspaceTx,
	input: { teamspaceId: string; userId: string; role: 'owner' | 'member' }
): Promise<{ member: TeamspaceMember; records: ChangeRecord[] }> {
	await liveTeamspace(tx, input.teamspaceId);
	const key = { teamspaceId_userId: { teamspaceId: input.teamspaceId, userId: input.userId } };
	const existing = await tx.teamspaceMember.findUnique({ where: key });
	if (!existing) throw notFound(`Member "${input.userId}"`);
	if (existing.role === 'owner' && input.role !== 'owner' && (await ownerCount(tx, input.teamspaceId)) <= 1) {
		throw new WorkspaceError('CONFLICT', 'A teamspace needs at least one owner');
	}
	const row = await tx.teamspaceMember.update({ where: key, data: { role: input.role } });
	return {
		member: toMember(row),
		records: [{ kind: 'teamspace.member', page: null, prop: input.teamspaceId, old: { role: existing.role }, new: { userId: input.userId, role: input.role } }]
	};
}

export async function removeTeamspaceMemberRecords(
	tx: WorkspaceTx,
	input: { teamspaceId: string; userId: string }
): Promise<ChangeRecord[]> {
	await liveTeamspace(tx, input.teamspaceId);
	const key = { teamspaceId_userId: { teamspaceId: input.teamspaceId, userId: input.userId } };
	const existing = await tx.teamspaceMember.findUnique({ where: key });
	if (!existing) return [];
	if (existing.role === 'owner' && (await ownerCount(tx, input.teamspaceId)) <= 1) {
		throw new WorkspaceError('CONFLICT', 'A teamspace needs at least one owner');
	}
	await tx.teamspaceMember.delete({ where: key });
	return [{ kind: 'teamspace.member', page: null, prop: input.teamspaceId, old: { userId: input.userId, role: existing.role }, new: null }];
}
