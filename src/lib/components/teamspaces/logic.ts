/** Pure rules of the teamspace screens (kept out of the components so they can be unit tested). */
import type { Member, Teamspace, TeamspaceMember } from '#lib/shared/schemas.ts';

export type JoinAction = 'member' | 'join' | 'request' | 'invite-only';

/**
 * What the browse list offers for a teamspace: open ones are joined in one click, closed ones are
 * joined by invitation (there is no request RPC, so the UI asks the owners), private ones are only
 * ever listed to their members (the server hides them from everybody else).
 */
export function joinAction(ts: Pick<Teamspace, 'privacy' | 'myRole'>): JoinAction {
	if (ts.myRole !== null) return 'member';
	if (ts.privacy === 'open') return 'join';
	if (ts.privacy === 'closed') return 'request';
	return 'invite-only';
}

/** Mine first (as the sidebar orders them), then the ones I can browse, by name. */
export function splitTeamspaces(list: readonly Teamspace[], mine: readonly Teamspace[]): { mine: Teamspace[]; browse: Teamspace[] } {
	const ids = new Set(mine.map((t) => t.id));
	const browse = list.filter((t) => !ids.has(t.id) && t.myRole === null && t.privacy !== 'private').sort((a, b) => a.name.localeCompare(b.name));
	return { mine: [...mine], browse };
}

/** Owners manage a teamspace; workspace admins hold full access everywhere. */
export const canManageTeamspace = (ts: Pick<Teamspace, 'myRole'>, isAdmin: boolean): boolean => ts.myRole === 'owner' || isAdmin;

export function isLastOwner(members: readonly TeamspaceMember[], userId: string): boolean {
	const owners = members.filter((m) => m.role === 'owner');
	return owners.length === 1 && owners[0].userId === userId;
}

/** Workspace members who are not in the teamspace yet and match `query` (name or email), guests excluded. */
export function memberCandidates(workspaceMembers: readonly Member[], inTeamspace: readonly TeamspaceMember[], query: string, limit = 8): Member[] {
	const taken = new Set(inTeamspace.map((m) => m.userId));
	const q = query.trim().toLowerCase();
	return workspaceMembers
		.filter((m) => !taken.has(m.userId) && m.role !== 'guest')
		.filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().startsWith(q))
		.slice(0, limit);
}

/** Owners first, then by name. */
export function sortTeamspaceMembers(members: readonly TeamspaceMember[], names: ReadonlyMap<string, string>): TeamspaceMember[] {
	return [...members].sort(
		(a, b) => Number(b.role === 'owner') - Number(a.role === 'owner') || (names.get(a.userId) ?? a.userId).localeCompare(names.get(b.userId) ?? b.userId)
	);
}
