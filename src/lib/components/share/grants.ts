/** Pure rules of the share dialog: how grants become rows, what is inherited, the public link, invite suggestions. */
import type { AccessLevel } from '#lib/shared/protocol.ts';
import type { Grant, Member, Teamspace } from '#lib/shared/schemas.ts';
import { levelRank } from '#lib/components/teamspaces/levels.ts';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isEmail = (s: string): boolean => EMAIL_RE.test(s.trim());

/** `${origin}/share/${token}`: the address of a published page. */
export const publicLink = (origin: string, token: string): string => `${origin.replace(/\/$/, '')}/share/${encodeURIComponent(token)}`;

/** A grant that comes from an ancestor page (the server marks it, and its `pageId` differs from the page's). */
export const isInherited = (grant: Grant, pageId: string): boolean => !!grant.inherited || grant.pageId !== pageId || !!grant.fromPageId;

export interface GrantRow {
	key: string;
	grant: Grant;
	kind: 'user' | 'pending' | 'teamspace';
	name: string;
	email: string | null;
	level: AccessLevel;
	inherited: boolean;
	/** The ancestor page the grant comes from, when inherited. */
	fromPageId: string | null;
}

export interface GrantContext {
	pageId: string;
	members: readonly Member[];
	teamspaces: readonly Teamspace[];
}

/**
 * The person, group and invite rows of the grant list: direct grants first, strongest first, then
 * inherited ones. Workspace and public grants are not rows: they have their own sections.
 */
export function grantRows(grants: readonly Grant[], ctx: GrantContext): GrantRow[] {
	const rows: GrantRow[] = [];
	for (const grant of grants) {
		if (grant.subjectKind === 'workspace' || grant.subjectKind === 'public') continue;
		const inherited = isInherited(grant, ctx.pageId);
		const base = { key: grant.id, grant, level: grant.level, inherited, fromPageId: inherited ? (grant.fromPageId ?? grant.pageId) : null };
		if (grant.subjectKind === 'teamspace') {
			const ts = ctx.teamspaces.find((t) => t.id === grant.subjectId);
			rows.push({ ...base, kind: 'teamspace', name: ts?.name ?? 'A teamspace', email: null });
		} else if (grant.pending || !grant.subjectId) {
			rows.push({ ...base, kind: 'pending', name: grant.email ?? 'Invited guest', email: grant.email ?? null });
		} else {
			const m = ctx.members.find((x) => x.userId === grant.subjectId);
			rows.push({ ...base, kind: 'user', name: m?.name ?? grant.email ?? 'Someone', email: m?.email ?? grant.email ?? null });
		}
	}
	return rows.sort(
		(a, b) => Number(a.inherited) - Number(b.inherited) || levelRank(b.level) - levelRank(a.level) || a.name.localeCompare(b.name)
	);
}

/** The workspace-wide grant that applies to the page, direct first. */
export function workspaceGrant(grants: readonly Grant[], pageId: string): Grant | undefined {
	return pick(grants.filter((g) => g.subjectKind === 'workspace'), pageId);
}

/** The live public link of the page (own or inherited). */
export function publicGrant(grants: readonly Grant[], pageId: string): Grant | undefined {
	return pick(grants.filter((g) => g.subjectKind === 'public'), pageId);
}

function pick(list: Grant[], pageId: string): Grant | undefined {
	return list.find((g) => !isInherited(g, pageId)) ?? list[0];
}

/** The line about the page's teamspace: everyone in it holds the teamspace's default level. */
export function teamspaceAccess(
	page: { teamspaceId: string | null },
	teamspaces: readonly Teamspace[]
): { teamspace: Teamspace; level: AccessLevel } | null {
	if (!page.teamspaceId) return null;
	const teamspace = teamspaces.find((t) => t.id === page.teamspaceId);
	return teamspace ? { teamspace, level: teamspace.defaultLevel } : null;
}

export type Suggestion =
	| { kind: 'user'; id: string; name: string; email: string }
	| { kind: 'teamspace'; id: string; name: string; icon: string | null }
	| { kind: 'email'; email: string };

/**
 * What the invite box offers for `query`: workspace members and teamspaces not already holding a direct
 * grant, and, for something that looks like an email nobody matches, a guest invite.
 */
export function inviteSuggestions(query: string, ctx: GrantContext & { grants: readonly Grant[]; selfId: string; /** People who already hold full access (the page's creator). */ excludeIds?: readonly string[] }, limit = 6): Suggestion[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const taken = new Set(ctx.grants.filter((g) => !isInherited(g, ctx.pageId)).map((g) => `${g.subjectKind}:${g.subjectId ?? g.email}`));
	const out: Suggestion[] = [];
	for (const m of ctx.members) {
		if (m.userId === ctx.selfId || ctx.excludeIds?.includes(m.userId) || taken.has(`user:${m.userId}`)) continue;
		if (m.name.toLowerCase().includes(q) || m.email.toLowerCase().startsWith(q)) out.push({ kind: 'user', id: m.userId, name: m.name, email: m.email });
	}
	for (const t of ctx.teamspaces) {
		if (taken.has(`teamspace:${t.id}`)) continue;
		if (t.name.toLowerCase().includes(q)) out.push({ kind: 'teamspace', id: t.id, name: t.name, icon: t.icon });
	}
	const email = query.trim();
	const known = ctx.members.some((m) => m.email.toLowerCase() === email.toLowerCase()) || taken.has(`user:${email}`);
	if (isEmail(email) && !known) out.push({ kind: 'email', email });
	return out.slice(0, limit);
}

/** A friendly line for a failed RPC; "not implemented yet" gets its own wording. */
export function shareErrorMessage(error: unknown): string {
	const e = error as { code?: string; message?: string; status?: number };
	if (e?.code === 'NOT_IMPLEMENTED' || e?.status === 501) return 'Sharing is not available yet on this server.';
	if (e?.code === 'FORBIDDEN' || e?.status === 403) return 'You need full access to this page to change who can see it.';
	if (e?.code === 'UNAUTHORIZED') return 'Sign in again to share this page.';
	return e?.message || 'Something went wrong. Try again.';
}
