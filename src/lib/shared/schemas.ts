/**
 * Entity and payload schemas of the private RPC contract (`src/server/rpc/contract.ts`): workspaces,
 * members, teamspaces, grants, history, search, AI streams, files and API tokens. Pure Valibot, no
 * transforms, so every schema converts to JSON Schema.
 */
import * as v from 'valibot';
import { collectionDefSchema, rankSchema, viewDefSchema } from './definitions.js';
import { filterGroupSchema, querySpecSchema } from './filter-ast.js';
import { idSchema } from './property-types.js';
import { accessLevelSchema, valuesSchema, viewRowSchema } from './protocol.js';

export const isoSchema = v.pipe(v.string(), v.maxLength(40));
export const nonNegativeInt = v.pipe(v.number(), v.integer(), v.minValue(0));
export const cursorSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
export const pageLimitSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100));
export const emptySchema = v.object({});

// ───────────────────────────── workspaces ─────────────────────────────

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export const workspaceRoleSchema = v.picklist(WORKSPACE_ROLES);
/** Roles an invite or a role change may assign (not `owner`: ownership is transferred explicitly). */
export const assignableRoleSchema = v.picklist(['admin', 'member', 'guest']);

export const workspaceSchema = v.object({
	id: idSchema,
	name: v.string(),
	slug: v.string(),
	icon: v.nullable(v.string()),
	/** The caller's role in it. */
	role: workspaceRoleSchema,
	createdAt: isoSchema
});
export type Workspace = v.InferOutput<typeof workspaceSchema>;

const slugSchema = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Lowercase letters, digits and dashes'));
const wsName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));

export const workspaceCreateSchema = v.object({
	name: wsName,
	slug: v.optional(slugSchema),
	icon: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(512))))
});
export const workspaceUpdateSchema = v.object({
	name: v.optional(wsName),
	slug: v.optional(slugSchema),
	icon: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(512))))
});

export const memberSchema = v.object({
	userId: idSchema,
	name: v.string(),
	email: v.string(),
	image: v.nullable(v.string()),
	role: workspaceRoleSchema,
	joinedAt: isoSchema
});
export type Member = v.InferOutput<typeof memberSchema>;

export const inviteSchema = v.object({
	id: idSchema,
	email: v.string(),
	role: assignableRoleSchema,
	createdBy: idSchema,
	expiresAt: isoSchema,
	acceptedAt: v.nullable(isoSchema)
});
export type Invite = v.InferOutput<typeof inviteSchema>;

export const TEAMSPACE_PRIVACY = ['open', 'closed', 'private'] as const;
export const teamspaceSchema = v.object({
	id: idSchema,
	name: v.string(),
	icon: v.nullable(v.string()),
	description: v.string(),
	privacy: v.picklist(TEAMSPACE_PRIVACY),
	defaultLevel: accessLevelSchema,
	createdBy: idSchema,
	/** The caller's role in it; null when not a member. */
	myRole: v.nullable(v.picklist(['owner', 'member']))
});
export type Teamspace = v.InferOutput<typeof teamspaceSchema>;

/** An archived teamspace its owner may restore: what Settings lists (a teamspace is not in Trash). */
export const archivedTeamspaceSchema = v.object({
	id: idSchema,
	name: v.string(),
	icon: v.nullable(v.string()),
	archivedAt: isoSchema,
	/** Pages the archive took along (pages trashed earlier stay in Trash and are not counted). */
	pageCount: nonNegativeInt
});
export type ArchivedTeamspace = v.InferOutput<typeof archivedTeamspaceSchema>;

const tsText = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));
export const teamspaceCreateSchema = v.object({
	name: tsText,
	icon: v.optional(v.nullable(v.string())),
	description: v.optional(v.pipe(v.string(), v.maxLength(1000))),
	privacy: v.picklist(TEAMSPACE_PRIVACY),
	defaultLevel: accessLevelSchema
});
export const teamspaceUpdateSchema = v.object({
	id: idSchema,
	name: v.optional(tsText),
	icon: v.optional(v.nullable(v.string())),
	description: v.optional(v.pipe(v.string(), v.maxLength(1000))),
	privacy: v.optional(v.picklist(TEAMSPACE_PRIVACY)),
	defaultLevel: v.optional(accessLevelSchema)
});
export const teamspaceMemberSchema = v.object({
	teamspaceId: idSchema,
	userId: idSchema,
	role: v.picklist(['owner', 'member']),
	/** Sidebar order of the teamspace for this user. */
	rank: rankSchema
});
export type TeamspaceMember = v.InferOutput<typeof teamspaceMemberSchema>;

// ───────────────────────────── pages ─────────────────────────────

/** What creating or duplicating a page returns. `num` is the dense integer used by bitmaps. */
export const pageRefSchema = v.object({ id: idSchema, num: nonNegativeInt, seq: nonNegativeInt });
export type PageRef = v.InferOutput<typeof pageRefSchema>;

export const pageIdSchema = v.object({ id: idSchema });

export const pageCreateSchema = v.object({
	/** Chosen by the client for optimistic UI; generated when absent. */
	id: v.optional(idSchema),
	/** Required unless `viewId` is given: then the view's default parent (a `$parent is X` filter's X, else the database's page). */
	parentId: v.optional(v.nullable(idSchema)),
	/** Appended after the last sibling when absent. */
	rank: v.optional(rankSchema),
	teamspaceId: v.optional(v.nullable(idSchema)),
	icon: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(512)))),
	cover: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2048)))),
	isDatabase: v.optional(v.boolean()),
	values: v.optional(valuesSchema),
	/** Seeds the body from this page's content. */
	templateId: v.optional(idSchema),
	/**
	 * A row created from a database view: the server derives the values (and the parent, when `parentId` is absent)
	 * that satisfy the collection's and the view's filters and `localFilter` (a `database_view` block's), starting
	 * from the collection's defaults. `values` override what it derives.
	 */
	viewId: v.optional(idSchema),
	localFilter: v.optional(filterGroupSchema)
});
export type PageCreate = v.InferOutput<typeof pageCreateSchema>;

export const pageMoveSchema = v.object({
	id: idSchema,
	parentId: v.nullable(idSchema),
	rank: rankSchema,
	teamspaceId: v.optional(v.nullable(idSchema))
});
export type PageMove = v.InferOutput<typeof pageMoveSchema>;

export const pageDuplicateSchema = v.object({
	id: idSchema,
	parentId: v.optional(v.nullable(idSchema)),
	includeSubpages: v.optional(v.boolean())
});

export const trashEntrySchema = v.object({
	id: idSchema,
	title: v.string(),
	icon: v.nullable(v.string()),
	deletedAt: isoSchema,
	deletedBy: v.nullable(idSchema),
	/** Number of pages trashed with it (itself included). */
	pageCount: nonNegativeInt,
	parentId: v.nullable(idSchema)
});
export const trashListInputSchema = v.object({
	q: v.optional(v.pipe(v.string(), v.maxLength(200))),
	sort: v.optional(v.picklist(['deleted_desc', 'deleted_asc', 'title'])),
	cursor: v.optional(cursorSchema),
	limit: v.optional(pageLimitSchema)
});
export const trashListResultSchema = v.object({ items: v.array(trashEntrySchema), nextCursor: v.nullable(cursorSchema) });

export const historyEntrySchema = v.object({
	id: idSchema,
	createdAt: isoSchema,
	authorIds: v.array(idSchema),
	/** Size of the stored snapshot, bytes. */
	size: nonNegativeInt,
	/** One line about it: "12 blocks". Filled by the page room (optional: older callers never sent it). */
	summary: v.optional(v.string()),
	/** Visible blocks in the version. */
	blocks: v.optional(nonNegativeInt),
	/** The local date of the version's half-day slot, `YYYY-MM-DD`, and which half. */
	date: v.optional(v.string()),
	slot: v.optional(v.picklist(['am', 'pm'])),
	/** Authors left out of `authorIds` to keep the stored metadata small. */
	moreAuthors: v.optional(nonNegativeInt)
});
export type HistoryEntry = v.InferOutput<typeof historyEntrySchema>;
export const historyListInputSchema = v.object({
	pageId: idSchema,
	cursor: v.optional(cursorSchema),
	limit: v.optional(pageLimitSchema)
});
export const historyListResultSchema = v.object({ items: v.array(historyEntrySchema), nextCursor: v.nullable(cursorSchema) });
export const historyRestoreInputSchema = v.object({ pageId: idSchema, versionId: idSchema });

export const GRANT_SUBJECTS = ['user', 'workspace', 'teamspace', 'public'] as const;
export const grantSchema = v.object({
	id: idSchema,
	pageId: idSchema,
	subjectKind: v.picklist(GRANT_SUBJECTS),
	/** User id, teamspace id; null for `workspace` and `public`. */
	subjectId: v.nullable(idSchema),
	level: accessLevelSchema,
	/** The share token of a `public` grant. */
	token: v.nullable(v.string()),
	createdBy: idSchema,
	/** Set on grants that come from an ancestor page (`fromPageId` says which); absent on direct grants. */
	inherited: v.optional(v.boolean()),
	fromPageId: v.optional(idSchema),
	/** A guest invite waiting for acceptance: `subjectId` is null and `email` says who it is for. */
	pending: v.optional(v.boolean()),
	email: v.optional(v.string())
});
export type Grant = v.InferOutput<typeof grantSchema>;
export const grantSetSchema = v.object({
	pageId: idSchema,
	subjectKind: v.picklist(GRANT_SUBJECTS),
	subjectId: v.nullable(idSchema),
	level: accessLevelSchema,
	/**
	 * Share with a person by email (use `subjectKind: 'user'` and a null `subjectId`): a workspace member or
	 * known user gets the grant at once; anybody else gets a guest invite with a pending grant.
	 */
	email: v.optional(v.pipe(v.string(), v.trim(), v.email()))
});
export const grantRevokeSchema = v.object({ grantId: idSchema });

// ───────────────────────────── collections and views ─────────────────────────────

export const collectionWithViewsSchema = v.object({ collection: collectionDefSchema, views: v.array(viewDefSchema) });

export const collectionCreateSchema = v.object({
	id: v.optional(idSchema),
	pageId: idSchema,
	sourceAst: v.optional(collectionDefSchema.entries.sourceAst),
	shownProps: v.optional(collectionDefSchema.entries.shownProps),
	defaults: v.optional(collectionDefSchema.entries.defaults)
});
export const collectionUpdateSchema = v.object({
	id: idSchema,
	sourceAst: v.optional(collectionDefSchema.entries.sourceAst),
	shownProps: v.optional(collectionDefSchema.entries.shownProps),
	defaults: v.optional(collectionDefSchema.entries.defaults)
});
export const memberAddSchema = v.object({ collectionId: idSchema, pageId: idSchema, rank: v.optional(rankSchema) });
export const memberRemoveSchema = v.object({ collectionId: idSchema, pageId: idSchema });
export const memberMoveSchema = v.object({ collectionId: idSchema, pageId: idSchema, rank: rankSchema });

/** A one-shot read of a view: rows ordered as the view orders them, then a cursor. */
export const collectionQueryInputSchema = v.object({
	collectionId: idSchema,
	viewId: v.optional(idSchema),
	/** Extra spec ANDed with (filter) or replacing (sorts, groupBy) the view's. */
	spec: v.optional(querySpecSchema),
	props: v.optional(v.pipe(v.array(idSchema), v.maxLength(200))),
	cursor: v.optional(cursorSchema),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)))
});
export const queryPageSchema = v.object({
	rows: v.array(viewRowSchema),
	total: nonNegativeInt,
	nextCursor: v.nullable(cursorSchema),
	seq: nonNegativeInt
});
export type QueryPage = v.InferOutput<typeof queryPageSchema>;

export const viewCreateSchema = v.object({
	id: v.optional(idSchema),
	collectionId: idSchema,
	type: viewDefSchema.entries.type,
	name: viewDefSchema.entries.name,
	filter: v.optional(viewDefSchema.entries.filter),
	sorts: v.optional(viewDefSchema.entries.sorts),
	groupBy: v.optional(viewDefSchema.entries.groupBy),
	columns: v.optional(viewDefSchema.entries.columns),
	rank: v.optional(rankSchema)
});
export const viewUpdateSchema = v.object({
	id: idSchema,
	type: v.optional(viewDefSchema.entries.type),
	name: v.optional(viewDefSchema.entries.name),
	filter: v.optional(viewDefSchema.entries.filter),
	sorts: v.optional(viewDefSchema.entries.sorts),
	groupBy: v.optional(viewDefSchema.entries.groupBy),
	columns: v.optional(viewDefSchema.entries.columns)
});
export const viewMoveSchema = v.object({ id: idSchema, rank: rankSchema });

export const propertyUpdateSchema = v.object({
	id: idSchema,
	name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100))),
	/** The whole new config, checked against the property's type. */
	config: v.optional(v.record(v.string(), v.unknown()))
});

// ───────────────────────────── search ─────────────────────────────

export const searchInputSchema = v.object({
	q: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
	createdBy: v.optional(idSchema),
	editedAfter: v.optional(isoSchema),
	editedBefore: v.optional(isoSchema),
	/** Restrict to this page and its descendants. */
	under: v.optional(idSchema),
	sort: v.optional(v.picklist(['relevance', 'edited_desc', 'edited_asc'])),
	cursor: v.optional(cursorSchema),
	limit: v.optional(pageLimitSchema)
});
export const searchHitSchema = v.object({
	id: idSchema,
	title: v.string(),
	icon: v.nullable(v.string()),
	/** Highlighted excerpt (`<mark>` around matches, HTML-escaped). */
	snippet: v.string(),
	field: v.picklist(['title', 'property', 'body']),
	updatedAt: isoSchema,
	/** The path of ancestor titles, root first. */
	path: v.array(v.string())
});
export const searchResultSchema = v.object({ hits: v.array(searchHitSchema), nextCursor: v.nullable(cursorSchema) });
export const quickFindInputSchema = v.object({
	q: v.pipe(v.string(), v.trim(), v.maxLength(200)),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30)))
});
export const quickFindResultSchema = v.object({
	/** Title-prefix matches first, then recently visited, then full-text hits. */
	items: v.array(
		v.object({
			id: idSchema,
			title: v.string(),
			icon: v.nullable(v.string()),
			source: v.picklist(['title', 'recent', 'text'])
		})
	)
});

// ───────────────────────────── AI ─────────────────────────────

export const AI_WRITE_ACTIONS = ['continue', 'summarize', 'improve', 'fix_spelling', 'translate', 'change_tone', 'explain', 'custom'] as const;
export const aiWriteInputSchema = v.object({
	action: v.picklist(AI_WRITE_ACTIONS),
	pageId: idSchema,
	/** The selected text (or the text before the caret for `continue`), sent as quoted data. */
	text: v.pipe(v.string(), v.maxLength(60_000)),
	language: v.optional(v.pipe(v.string(), v.maxLength(40))),
	tone: v.optional(v.picklist(['professional', 'casual', 'straightforward', 'confident', 'friendly'])),
	prompt: v.optional(v.pipe(v.string(), v.maxLength(2000)))
});
export const aiWriteEventSchema = v.variant('type', [
	v.object({ type: v.literal('delta'), text: v.string() }),
	v.object({ type: v.literal('done'), inputTokens: v.optional(nonNegativeInt), outputTokens: v.optional(nonNegativeInt) })
]);
export type AiWriteEvent = v.InferOutput<typeof aiWriteEventSchema>;

export const aiAskInputSchema = v.object({
	question: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
	threadId: v.optional(idSchema),
	/** Limits retrieval to this page and its descendants. */
	under: v.optional(idSchema)
});
export const aiAskEventSchema = v.variant('type', [
	v.object({ type: v.literal('delta'), text: v.string() }),
	/**
	 * Pages the answer draws on, all visible to the caller (`snippet`: the start of the cited passage, HTML-escaped
	 * plain text). Sent once, after the last `delta`; empty when nothing readable was relevant.
	 */
	v.object({ type: v.literal('sources'), pages: v.array(v.object({ id: idSchema, title: v.string(), snippet: v.optional(v.string()) })) }),
	v.object({ type: v.literal('done'), threadId: idSchema })
]);
export type AiAskEvent = v.InferOutput<typeof aiAskEventSchema>;
export const aiRegenerateInputSchema = v.object({ pageId: idSchema, propId: idSchema });

/** Where each AI property of a page stands: `pending` (a change waits for the model), `stale` (the last attempt failed, the old value shows). */
export const aiMarkersInputSchema = v.object({ pageId: idSchema });
export const aiMarkersOutputSchema = v.array(v.object({ propId: idSchema, pending: v.boolean(), stale: v.boolean() }));

// ───────────────────────────── files ─────────────────────────────

export const fileBeginInputSchema = v.object({
	pageId: idSchema,
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
	size: nonNegativeInt,
	type: v.pipe(v.string(), v.maxLength(255))
});
export const fileBeginResultSchema = v.object({
	fileId: idSchema,
	/** `PUT` the body here (single request), or to the `/parts` endpoints when `multipart`. */
	uploadUrl: v.string(),
	multipart: v.boolean(),
	partSize: v.optional(nonNegativeInt)
});
export const fileCompleteInputSchema = v.object({
	fileId: idSchema,
	parts: v.optional(v.array(v.object({ partNumber: v.pipe(v.number(), v.integer(), v.minValue(1)), etag: v.string() })))
});
export const fileInfoSchema = v.object({
	id: idSchema,
	pageId: idSchema,
	name: v.string(),
	size: nonNegativeInt,
	type: v.string(),
	/** Short-lived URL on the files host. */
	url: v.string()
});
export const fileIdSchema = v.object({ fileId: idSchema });

/** A page's lock as its room holds it: who locked it, when (ms), or `locked: false`. */
export const pageLockSchema = v.object({
	locked: v.boolean(),
	lockedBy: v.nullable(v.string()),
	lockedAt: v.nullable(v.number()),
	/** Whether the caller edits the page despite the lock (full access). */
	bypass: v.boolean()
});
export type PageLock = v.InferOutput<typeof pageLockSchema>;

// ───────────────────────────── tokens ─────────────────────────────

export const TOKEN_SCOPES = [
	'page.read',
	'page.create',
	'page.update',
	'page.trash',
	'block.read',
	'block.write',
	'database.read',
	'search',
	'comment.read',
	'comment.write',
	'user.read'
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const tokenScopeSchema = v.picklist(TOKEN_SCOPES);

export const apiTokenSchema = v.object({
	id: idSchema,
	name: v.string(),
	scopes: v.array(tokenScopeSchema),
	createdAt: isoSchema,
	expiresAt: v.nullable(isoSchema),
	lastUsedAt: v.nullable(isoSchema),
	revokedAt: v.nullable(isoSchema)
});
export type ApiToken = v.InferOutput<typeof apiTokenSchema>;
export const tokenCreateInputSchema = v.object({
	name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
	/** An empty list grants nothing. */
	scopes: v.pipe(v.array(tokenScopeSchema), v.maxLength(TOKEN_SCOPES.length)),
	expiresAt: v.optional(v.nullable(isoSchema))
});
export const tokenCreateResultSchema = v.object({
	/** The secret, shown once. */
	token: v.string(),
	info: apiTokenSchema
});

// ───────────────────────────── session ─────────────────────────────

export const meSchema = v.object({
	id: idSchema,
	name: v.string(),
	email: v.string(),
	emailVerified: v.boolean(),
	image: v.nullable(v.string()),
	workspaces: v.array(workspaceSchema)
});
export type Me = v.InferOutput<typeof meSchema>;

/** A value-level issue list, carried by validation errors. */
export const issueSchema = v.object({ path: v.string(), code: v.string(), message: v.string() });
