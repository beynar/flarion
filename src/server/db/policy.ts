/**
 * Workspace access policy (viborm/permissions), final for P2. The plan's rules ("Permissions"), in
 * viborm 1.14.0's real vocabulary and shaped to fit Durable Object SQLite's statement limits
 * (docs/spikes/p0-policy-limits.md, "P2 final numbers"):
 *
 * - four levels (`read`, `comment`, `update`, `full`), the level is DATA on grants and teamspaces;
 * - workspace owners and admins hold every action on every page (`actor.admin`);
 * - teamspace access comes from actor facts (`actorFacts()`), no join: members get the teamspace's
 *   default level, teamspace owners `full`;
 * - the Private section (`teamspaceId` null) belongs to its creator: the whole branch below a root page
 *   the creator made there, whoever adds the subpages;
 * - grants (user, teamspace, workspace for non-guests, public token) are inherited through the tree;
 * - `create` (placement), `fields` (`parentId` and `teamspaceId` need `full`), and the teamspace,
 *   teamspace-member and grant models;
 * - the bookkeeping models (EAV tables, registry, change log...) are open to every actor: they are
 *   reached only by the Workspace DO's own code, which asserts the page-level right first
 *   (`objects/workspace/authorize.ts`).
 *
 * Vocabulary used (viborm 1.14.0):
 * - `{ actor: "path" }` in a value position is the actor's field, bound as one parameter;
 * - `{ actor: { path: value } }` in a filter is a condition on the actor alone, folded per call;
 * - a relation whose value is an action name is the target's predicate for that action;
 * - `parent: { recurse: { depth: false }, self: true, some: ... }` walks the ancestors in one
 *   `WITH RECURSIVE` inside the statement, the row itself included;
 * - `$exists: { model: where }` is a row-independent check that does not repeat per row;
 * - `$if: { control: 'actor', path, exists: true }` guards an alternative that reads an optional actor value
 *   (`userId`, `shareToken`): since 1.14.0 an unguarded read of a missing value closes the WHOLE permission, so
 *   a public-link visitor (no `userId`) would read nothing at all;
 * - a model with an action other than create/read/update/delete declares its `actions` graph.
 */
import { v, type InferOutput } from 'viborm/validation';
import { permissions, type Rule } from 'viborm/permissions';
import { ACCESS_LEVELS, GRANT_SUBJECT_KINDS, WORKSPACE_ROLES } from './workspace.schema';

/** Facts about the caller, supplied by the Worker per request. Never read from the database by the policy. */
export const actorSchema = v.object({
	userId: v.optional(v.string()),
	/** Workspace owner or admin: full access to every page. */
	admin: v.boolean(),
	guest: v.boolean(),
	/** Public-link token presented by an anonymous visitor. */
	shareToken: v.optional(v.string()),
	/**
	 * Share keys this actor matches (see {@link grantSubjectKey}): `user:<id>`, `workspace` (not for
	 * guests), `public:<token>` and `teamspace:<id>` for every teamspace the actor belongs to. Used by
	 * {@link policy} and {@link joinedPolicy}; the plan's sketch reads the three scalar facts above.
	 */
	subjects: v.array(v.string()),
	/** Teamspaces in which the actor holds at least the level (owners hold every level). Used by {@link policy}. */
	teamspaces: v.object({
		read: v.array(v.string()),
		comment: v.array(v.string()),
		update: v.array(v.string()),
		full: v.array(v.string())
	})
});

export type Actor = InferOutput<typeof actorSchema>;

/** The `subjectKey` stored on a grant. */
export function grantSubjectKey(kind: (typeof GRANT_SUBJECT_KINDS)[number], subjectId?: string | null, token?: string | null): string {
	switch (kind) {
		case 'user':
			return `user:${subjectId}`;
		case 'teamspace':
			return `teamspace:${subjectId}`;
		case 'public':
			return `public:${token}`;
		case 'workspace':
			return 'workspace';
	}
}

export interface ActorInput {
	userId?: string;
	/** From the D1 membership. `anonymous`: a visitor with no account. */
	role: (typeof WORKSPACE_ROLES)[number] | 'anonymous';
	shareToken?: string;
	/** The actor's rows of `teamspace_member`. */
	memberships: readonly { teamspaceId: string; role: string }[];
	/** Default level of every teamspace the actor is a member of. */
	teamspaces: readonly { id: string; defaultLevel: string }[];
}

/**
 * The actor facts of one request. Pure: the Workspace DO reads `teamspace_member`/`teamspace` once per
 * actor (cached with the visibility set, recomputed when a membership changes) and calls this.
 */
export function actorFacts(input: ActorInput): Actor {
	const guest = input.role === 'guest' || input.role === 'anonymous';
	const subjects: string[] = [];
	if (input.userId) subjects.push(grantSubjectKey('user', input.userId));
	if (!guest) subjects.push('workspace');
	if (input.shareToken) subjects.push(grantSubjectKey('public', null, input.shareToken));
	const defaults = new Map(input.teamspaces.map((t) => [t.id, t.defaultLevel]));
	const teamspaces = { read: [] as string[], comment: [] as string[], update: [] as string[], full: [] as string[] };
	// Guests see only what is shared with them directly: they hold no teamspace, whatever rows say.
	for (const membership of guest ? [] : input.memberships) {
		subjects.push(grantSubjectKey('teamspace', membership.teamspaceId));
		const held = membership.role === 'owner' ? 'full' : (defaults.get(membership.teamspaceId) ?? 'read');
		const rank = ACCESS_LEVELS.indexOf(held as never);
		ACCESS_LEVELS.forEach((level, i) => {
			if (i <= rank) teamspaces[level].push(membership.teamspaceId);
		});
	}
	return {
		userId: input.userId,
		admin: input.role === 'owner' || input.role === 'admin',
		guest,
		shareToken: input.shareToken,
		subjects,
		teamspaces
	};
}

/** Guards an alternative that reads an optional actor value (see the vocabulary above). */
const withUser = { $if: { control: 'actor', path: 'userId', exists: true } } as const;
const withShareToken = { $if: { control: 'actor', path: 'shareToken', exists: true } } as const;

const isMember = { ...withUser, members: { some: { userId: { actor: 'userId' } } } } as const;
const isOwner = { ...withUser, members: { some: { userId: { actor: 'userId' }, role: 'owner' } } } as const;

/**
 * Who holds a share, at a level matched by `levelMatch` (an equality in the plan's sketch, an `in` list
 * in the compact policy).
 */
const sharedWith = (levelMatch: string | { in: readonly string[] }) =>
	({
		grants: {
			some: {
				level: levelMatch,
				deletedAt: null,
				OR: [
					{ ...withUser, subjectKind: 'user', subjectId: { actor: 'userId' } },
					{ subjectKind: 'workspace', actor: { guest: false } },
					{ subjectKind: 'teamspace', teamspace: { is: isMember } },
					{ ...withShareToken, subjectKind: 'public', token: { actor: 'shareToken' } }
				]
			}
		}
	}) as const;

const ancestorsOrSelf = (rule: unknown) => ({ parent: { recurse: { depth: false }, self: true, some: rule } });

// ----- the plan's sketch, as written -----

/** Members get their teamspace's default level (`teamspaceId` is copied onto every page of a subtree). */
const viaTeamspace = (level: string) => ({ teamspace: { is: { defaultLevel: level, ...isMember } } }) as const;

const sketchAccess = (level: string) => ({
	OR: [
		{ actor: { admin: true } },
		viaTeamspace(level),
		// Private section: no teamspace, created by the caller.
		{ ...withUser, teamspaceId: null, createdById: { actor: 'userId' } },
		ancestorsOrSelf(sharedWith(level))
	]
});

/** The plan's placement rule, as written (for {@link sketchPolicy}). */
const sketchCreate = {
	OR: [
		{ parent: 'update' },
		{ parentId: null, teamspace: { is: isMember } },
		{ ...withUser, parentId: null, teamspaceId: null, createdById: { actor: 'userId' } }
	]
} as const;

/**
 * A page lives where its parent lives: the same teamspace, or no teamspace when the parent has none. `$row` +
 * `up: 1` reads the new row's own `teamspaceId` from inside the `parent` subquery (viborm 1.12.1's spelling, the
 * form the viborm maintainers tested). `{ parent: 'update' }` alone says nothing about `teamspaceId`: a guest
 * could create under a page they edit with `teamspaceId: null`, a member with another teamspace they read.
 */
const sameTeamspaceAsParent = {
	OR: [
		{ teamspaceId: null, parent: { is: { teamspaceId: null } } },
		{ parent: { is: { teamspaceId: { $row: 'teamspaceId', up: 1 } } } }
	]
} as const;

/**
 * Where a page may be created: under a page the caller can edit, in that page's teamspace; at the root of a
 * teamspace where the caller can edit (admins: any), or at the root of the caller's own Private section (not for
 * guests). Tighter than the plan's sketch on one point: a teamspace member needs the teamspace's `update` level,
 * not just membership, so a read-only member cannot add pages.
 */
const pageCreate = {
	OR: [
		{ AND: [{ parent: 'update' }, sameTeamspaceAsParent] },
		{ parentId: null, actor: { admin: true } },
		{ parentId: null, teamspaceId: { in: { actor: 'teamspaces.update' } } },
		{ ...withUser, parentId: null, teamspaceId: null, createdById: { actor: 'userId' }, actor: { guest: false } }
	]
} as const;

const supportingModels = {
	teamspace: {
		// `full` is an action of its own (1.14.0 wants it in a graph); `update` and `full` both let the owner read.
		actions: { read: [], update: ['read'], full: ['read'], create: [] },
		// Open and closed teamspaces are listed to every non-guest; private ones to their members only.
		read: { OR: [{ AND: [{ privacy: { in: ['open', 'closed'] } }, { actor: { guest: false } }] }, isMember] },
		'update, full': isOwner,
		create: { actor: { guest: false } }
	},
	teamspaceMember: {
		// `leave` is the action a delete asks for; it implies nothing (as a custom action did before 1.14.0).
		actions: { read: [], create: [], update: ['read'], leave: [] },
		read: { teamspace: 'read' },
		// Owners (and workspace admins) add anyone; a non-guest joins an open teamspace on their own, as a member.
		create: {
			OR: [
				{ teamspace: 'update' },
				{
					AND: [
						{ actor: { guest: false } },
						{ ...withUser, userId: { actor: 'userId' } },
						{ role: 'member' },
						{ teamspace: { is: { privacy: 'open' } } }
					]
				}
			]
		},
		update: { teamspace: 'update' },
		// Removing a member needs `update` on the teamspace; anyone may remove themselves (leave).
		leave: { OR: [{ teamspace: 'update' }, { ...withUser, userId: { actor: 'userId' } }] },
		operations: { delete: 'leave' }
	},
	grant: {
		read: { page: 'read' },
		'create, update': { page: 'full' },
		operations: { delete: 'update' }
	}
} as const;

/**
 * Models no actor reads or writes directly: the property registry, the typed EAV tables, collections
 * and views, the change log, mutation ids, links and open rooms are written by the Workspace DO's own
 * code, after it asserted the page-level right (`authorizeOp`). They are open under `$as` so one
 * governed transaction can hold a whole commit. `member` (the D1 mirror) is readable, never writable.
 */
const bookkeeping = { read: true, create: true, update: true, delete: true } as const;
const bookkeepingModels = {
	property: bookkeeping,
	pText: bookkeeping,
	pNum: bookkeeping,
	pDate: bookkeeping,
	pRef: bookkeeping,
	valueCount: bookkeeping,
	collection: bookkeeping,
	collectionMember: bookkeeping,
	view: bookkeeping,
	change: bookkeeping,
	mutation: bookkeeping,
	meta: bookkeeping,
	link: bookkeeping,
	openRoom: bookkeeping,
	member: { read: true }
} as const;

/**
 * The plan's policy sketch, translated literally. Every level carries its own rule body and viborm ORs
 * the bodies of every level at or above the asked one, so `read` repeats the body four times. Kept for
 * the spike's measurements only (see docs/spikes/p0-policy-limits.md): it exceeds SQLite's expression
 * depth on a move and sits at 97 of 100 bound values on `can` with four actions.
 */
export const sketchPolicy = permissions({
	actor: actorSchema,
	models: {
		page: {
			// The plan's global `levels`, spelled as the per-model ladder 1.14.0 asks for: a rule on a higher level
			// also grants every level below it.
			actions: { read: [], comment: ['read'], update: ['comment'], full: ['update'], create: [] },
			operations: { delete: 'full' },
			'read, comment, update': sketchAccess,
			full: (level) => ({ OR: [sketchAccess(level), { teamspace: { is: isOwner } }] }),
			create: sketchCreate,
			fields: { parentId: { write: 'full' }, teamspaceId: { write: 'full' } }
		},
		...supportingModels
	}
});

// ----- the compact policies -----

const levelsFrom = (action: string) => ACCESS_LEVELS.slice(ACCESS_LEVELS.indexOf(action as never));

/**
 * The root of a Private section the caller made (a root page, no teamspace, created by the caller). Met on
 * the way up from any page, it gives the whole branch to its creator; a subpage someone else adds to it
 * is not "theirs" (it owns nothing for its author).
 */
const privateOf = { ...withUser, parentId: null, teamspaceId: null, createdById: { actor: 'userId' } } as const;

/** A share on the page or an ancestor, matched in ONE flat condition against the actor's share keys. */
const sharedWithActor = (levels: readonly string[]) =>
	({ grants: { some: { level: { in: levels }, deletedAt: null, subjectKey: { in: { actor: 'subjects' } } } } }) as const;

const compactActions = { read: [], comment: [], update: [], full: [], create: [] } as const;

/**
 * Compact rules, shared by {@link joinedPolicy} and {@link policy}. Two changes against the sketch:
 *
 * 1. The level is DATA, not a copy of the rule. A share or teamspace default holds `action` when its
 *    level is `action` or higher (`level in [..]`), and the actions declare no implications between
 *    themselves, so viborm does not OR four copies of the body for `read` (a declared graph implies only what
 *    it lists: since 1.14.0 not even "update grants read"; `read`'s own body already covers every level).
 * 2. The OR over the four share kinds is one flat `subjectKey in actor.subjects`; the Worker puts
 *    `workspace`, `user:<id>`, `public:<token>` and `teamspace:<id>` into `subjects` per request.
 *
 * Teamspace owners hold every action.
 */
function compact(viaTeamspace: (action: string) => Rule) {
	return (action: string): Rule => ({
		OR: [
			{ actor: { admin: true } },
			viaTeamspace(action),
			// Shares on the page or an ancestor, or a Private page of the caller's on the way up
			// (no teamspace, created by the caller): both through ONE walk over the ancestors.
			ancestorsOrSelf({ OR: [sharedWithActor(levelsFrom(action)), privateOf] })
		]
	});
}

/** Teamspace access through rows: the teamspace's default level and the caller's membership. */
const viaTeamspaceRows = (action: string): Rule => ({
	teamspace: { is: { OR: [{ defaultLevel: { in: levelsFrom(action) }, ...isMember }, isOwner] } }
});

/** Teamspace access through actor facts: `page.teamspaceId in actor.teamspaces[action]`. No join. */
const viaTeamspaceFacts = (action: string): Rule => ({ teamspaceId: { in: { actor: `teamspaces.${action}` } } });

const governed = (access: (action: string) => Rule) => ({
	page: {
		actions: compactActions,
		operations: { delete: 'full' as const },
		'read, comment, update, full': access,
		create: pageCreate,
		fields: { parentId: { write: 'full' }, teamspaceId: { write: 'full' } } as const
	},
	...supportingModels,
	...bookkeepingModels
});

/**
 * Compact rules that still read the teamspace default level and membership from rows. Fits the limits
 * (a move takes 77 of 100 bound values), but with less headroom than {@link policy}. The fallback if
 * the Worker cannot supply `actor.teamspaces`.
 */
export const joinedPolicy = permissions({
	actor: actorSchema,
	models: governed(compact(viaTeamspaceRows))
});

/**
 * The workspace policy. Compact rules (see {@link compact}) with teamspace access taken from actor
 * facts, so a page's access is its own columns, one `WITH RECURSIVE` over its ancestors' shares and no
 * other join: 9 bound values for a read, 49 for a move (docs/spikes/p0-policy-limits.md).
 */
export const policy = permissions({
	actor: actorSchema,
	models: governed(compact(viaTeamspaceFacts))
});
