/**
 * The permission matrix's reference model: the plan's rules ("Permissions") in plain TypeScript, written
 * without looking at the viborm policy or the Workspace DO. It answers one question, `levelOf`: the highest
 * of the four levels an actor holds on a page, or -1.
 *
 *   - owners and admins hold full access to every page
 *   - a teamspace member holds the teamspace's default level on its pages, an owner full (never a guest)
 *   - a Private root (no teamspace) belongs to its creator, and everything below it
 *   - a grant on the page or an ancestor reaches the page at the grant's level: to a user, to a teamspace
 *     (its members), to the whole workspace (never guests or visitors), or to a public token
 *   - the highest level wins; a revoked grant counts for nothing; a trashed page is not visible
 */
export const LEVELS = ['read', 'comment', 'update', 'full'] as const;
export type Level = (typeof LEVELS)[number];
export type Role = 'owner' | 'admin' | 'member' | 'guest';

export interface MUser {
	id: string;
	role: Role;
}
export interface MTeamspace {
	id: string;
	privacy: 'open' | 'closed' | 'private';
	level: Level;
	/** user id -> role */
	members: Map<string, 'owner' | 'member'>;
}
export interface MPage {
	id: string;
	num: number;
	parent: string | null;
	teamspace: string | null;
	createdBy: string;
	deleted: boolean;
	/** The root of the trashed subtree this page went with. */
	trashRoot: string | null;
}
export type MGrant =
	| { id: string; page: string; kind: 'user'; subject: string; level: Level; token: null; revoked: boolean }
	| { id: string; page: string; kind: 'teamspace'; subject: string; level: Level; token: null; revoked: boolean }
	| { id: string; page: string; kind: 'workspace'; subject: null; level: Level; token: null; revoked: boolean }
	| { id: string; page: string; kind: 'public'; subject: null; level: Level; token: string; revoked: boolean };

export interface Model {
	users: Map<string, MUser>;
	teamspaces: Map<string, MTeamspace>;
	pages: Map<string, MPage>;
	grants: MGrant[];
}

/** Who asks: a member (by id) or an anonymous visitor, with or without a share token. */
export type Asker = { kind: 'user'; id: string } | { kind: 'anonymous'; token?: string };

const rank = (level: Level) => LEVELS.indexOf(level);

export function levelOf(model: Model, asker: Asker, pageId: string): number {
	const page = model.pages.get(pageId);
	if (!page || page.deleted) return -1;
	const user = asker.kind === 'user' ? model.users.get(asker.id) : undefined;
	if (asker.kind === 'user' && !user) return -1; // not a member of the workspace
	if (user && (user.role === 'owner' || user.role === 'admin')) return 3;
	const guest = !user || user.role === 'guest';
	const userId = user?.id;
	const token = asker.kind === 'anonymous' ? asker.token : undefined;
	let best = -1;

	// Teamspace: members get the default level, owners everything; guests belong to no teamspace.
	const memberOf = (teamspaceId: string) => (!guest && userId ? model.teamspaces.get(teamspaceId)?.members.get(userId) : undefined);
	if (page.teamspace) {
		const ts = model.teamspaces.get(page.teamspace);
		const m = memberOf(page.teamspace);
		if (ts && m) best = Math.max(best, m === 'owner' ? 3 : rank(ts.level));
	}

	// The page and every ancestor: grants and Private ownership.
	for (let at: MPage | undefined = page; at; at = at.parent ? model.pages.get(at.parent) : undefined) {
		// The root of a Private section the asker made owns the whole branch under it.
		if (at.parent === null && at.teamspace === null && userId && at.createdBy === userId) best = 3;
		for (const g of model.grants) {
			if (g.page !== at.id || g.revoked) continue;
			const holds =
				(g.kind === 'user' && userId === g.subject) ||
				(g.kind === 'workspace' && !guest) ||
				(g.kind === 'teamspace' && memberOf(g.subject) !== undefined) ||
				(g.kind === 'public' && token !== undefined && token === g.token);
			if (holds) best = Math.max(best, rank(g.level));
		}
	}
	return best;
}

/** Pages (nums) an asker can read. */
export function visibleSet(model: Model, asker: Asker): Set<number> {
	const out = new Set<number>();
	for (const page of model.pages.values()) if (levelOf(model, asker, page.id) >= 0) out.add(page.num);
	return out;
}

/** The ids of `root` and everything below it. */
export function subtreeOf(model: Model, root: string): string[] {
	const out = [root];
	for (let i = 0; i < out.length; i++) {
		for (const p of model.pages.values()) if (p.parent === out[i]) out.push(p.id);
	}
	return out;
}
