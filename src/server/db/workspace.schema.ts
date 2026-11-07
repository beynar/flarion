/**
 * Workspace Durable Object schema (viborm), DRAFT from the P0 policy spike. It follows the plan's
 * "Data model" section table by table; P1 owns the final shape, migrations and indexes.
 *
 * Deviations from the plan's SQL, all deliberate for this draft:
 * - The `p_*` EAV tables use a composite primary key `(prop, v, page)` but viborm cannot emit
 *   `WITHOUT ROWID`; P1 either adds the tables with a hand-written migration step or accepts the rowid
 *   B-tree. `prop` is `property.num` and `page` is `page.num` (dense integers), without foreign keys: the
 *   EAV tables are written on every property edit and the dense numbers are never reused.
 * - The FTS5 `search` table is not a viborm model: it is created and queried with raw SQL (and must be
 *   excluded from viborm's managed `tables`, see {@link WORKSPACE_TABLES}).
 * - Soft-deletable models (`page`, `property`, `teamspace`, `grant`) carry a nullable `deletedAt`.
 *
 * Column names are the plan's snake_case so the raw-SQL query engine and these models agree.
 */
import { s } from 'viborm';

/** Levels a grant or a teamspace default can carry, lowest first. Mirrors the policy's `levels`. */
export const ACCESS_LEVELS = ['read', 'comment', 'update', 'full'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const TEAMSPACE_PRIVACY = ['open', 'closed', 'private'] as const;
export const GRANT_SUBJECT_KINDS = ['user', 'workspace', 'teamspace', 'public'] as const;
export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export const PROPERTY_TYPES = [
	'title',
	'text',
	'number',
	'select',
	'multiSelect',
	'status',
	'date',
	'person',
	'files',
	'checkbox',
	'url',
	'email',
	'phone',
	'relation',
	'rollup',
	'formula',
	'createdTime',
	'createdBy',
	'lastEditedTime',
	'lastEditedBy'
] as const;
export const VIEW_TYPES = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'] as const;

// ----- pages -----

export const page = s
	.model({
		id: s.string().id(),
		/** Dense integer, assigned once and never reused: bitmaps and posting lists stay valid. */
		num: s.int().unique(),
		parentId: s.string().nullable().map('parent_id'),
		parent: s
			.toOne(() => page)
			.fields('parentId')
			.references('id')
			.onDelete('restrict'),
		children: s.toMany(() => page),
		/** viborm/ordering key among siblings. */
		rank: s.string(),
		/** Null = the creator's Private section. Copied down the subtree. */
		teamspaceId: s.string().nullable().map('teamspace_id'),
		teamspace: s
			.toOne(() => teamspace)
			.fields('teamspaceId')
			.references('id')
			.onDelete('restrict'),
		title: s.string().default(''),
		icon: s.string().nullable(),
		cover: s.string().nullable(),
		isDatabase: s.boolean().default(false).map('is_database'),
		createdById: s.string().map('created_by'),
		createdAt: s.dateTime().now().map('created_at'),
		updatedById: s.string().nullable().map('updated_by'),
		updatedAt: s.dateTime().nullable().map('updated_at'),
		deletedAt: s.dateTime().nullable().map('deleted_at'),
		deletedById: s.string().nullable().map('deleted_by'),
		/** Root of the soft-deleted subtree this page was trashed with. */
		trashRoot: s.string().nullable().map('trash_root'),
		/** Readable copy of all property values, written in the same transaction as the EAV rows. */
		propsJson: s.json().default({}).map('props_json'),
		grants: s.toMany(() => grant),
		collection: s.toOne(() => collection)
	})
	.map('page')
	.index(['parentId', 'rank'])
	.index(['teamspaceId'])
	.index(['deletedAt']);

/** Property registry, shared by the whole workspace. */
export const property = s
	.model({
		id: s.string().id(),
		num: s.int().unique(),
		name: s.string(),
		type: s.string(),
		configJson: s.json().default({}).map('config_json'),
		deletedAt: s.dateTime().nullable().map('deleted_at')
	})
	.map('property');

// ----- typed EAV (clustered by property) -----

export const pText = s
	.model({
		prop: s.int(),
		/** Normalized sort key. */
		v: s.string(),
		page: s.int(),
		computed: s.boolean().default(false)
	})
	.id(['prop', 'v', 'page'])
	.index(['page', 'prop'])
	.map('p_text');

export const pNum = s
	.model({
		prop: s.int(),
		v: s.number(),
		page: s.int(),
		computed: s.boolean().default(false)
	})
	.id(['prop', 'v', 'page'])
	.index(['page', 'prop'])
	.map('p_num');

export const pDate = s
	.model({
		prop: s.int(),
		v: s.string(),
		vEnd: s.string().nullable().map('v_end'),
		page: s.int(),
		computed: s.boolean().default(false)
	})
	.id(['prop', 'v', 'page'])
	.index(['page', 'prop'])
	.map('p_date');

/** Options, people, relations and files. */
export const pRef = s
	.model({
		prop: s.int(),
		v: s.string(),
		page: s.int(),
		computed: s.boolean().default(false)
	})
	.id(['prop', 'v', 'page'])
	.index(['page', 'prop'])
	.map('p_ref');

// ----- databases -----

export const collection = s
	.model({
		id: s.string().id(),
		pageId: s.string().unique().map('page_id'),
		page: s.toOne(() => page).fields('pageId').references('id').onDelete('cascade'),
		sourceAst: s.json().nullable().map('source_ast'),
		shownProps: s.json().default([]).map('shown_props'),
		defaultsJson: s.json().default({}).map('defaults_json'),
		members: s.toMany(() => collectionMember),
		views: s.toMany(() => view)
	})
	.map('collection');

/** Hand-picked rows with a manual order. */
export const collectionMember = s
	.model({
		collectionId: s.string().map('collection_id'),
		collection: s.toOne(() => collection).fields('collectionId').references('id').onDelete('cascade'),
		pageId: s.string().map('page_id'),
		rank: s.string()
	})
	.id(['collectionId', 'pageId'])
	.map('collection_member');

export const view = s
	.model({
		id: s.string().id(),
		collectionId: s.string().map('collection_id'),
		collection: s.toOne(() => collection).fields('collectionId').references('id').onDelete('cascade'),
		type: s.string(),
		name: s.string(),
		filterAst: s.json().nullable().map('filter_ast'),
		sorts: s.json().default([]),
		groupBy: s.string().nullable().map('group_by'),
		columnsJson: s.json().default([]).map('columns_json'),
		rank: s.string()
	})
	.map('view');

// ----- teamspaces and access -----

export const teamspace = s
	.model({
		id: s.string().id(),
		name: s.string(),
		icon: s.string().nullable(),
		description: s.string().nullable(),
		/** open | closed | private */
		privacy: s.string().default('open'),
		/** Level every member gets on the teamspace's pages. */
		defaultLevel: s.string().default('update').map('default_level'),
		createdBy: s.string().map('created_by'),
		deletedAt: s.dateTime().nullable().map('deleted_at'),
		members: s.toMany(() => teamspaceMember),
		pages: s.toMany(() => page),
		grants: s.toMany(() => grant)
	})
	.map('teamspace');

export const teamspaceMember = s
	.model({
		teamspaceId: s.string().map('teamspace_id'),
		teamspace: s.toOne(() => teamspace).fields('teamspaceId').references('id').onDelete('cascade'),
		userId: s.string().map('user_id'),
		/** owner | member */
		role: s.string().default('member'),
		/** Sidebar order. */
		rank: s.string().default('')
	})
	.id(['teamspaceId', 'userId'])
	.index(['userId'])
	.map('teamspace_member');

/** Explicit share of a page (and, through inheritance, its subtree). */
export const grant = s
	.model({
		id: s.string().id(),
		pageId: s.string().map('page_id'),
		page: s.toOne(() => page).fields('pageId').references('id').onDelete('cascade'),
		/** user | workspace | teamspace | public */
		subjectKind: s.string().map('subject_kind'),
		subjectId: s.string().nullable().map('subject_id'),
		/**
		 * Set (to `subjectId`) when `subjectKind` is `teamspace`. A real foreign key, because viborm policies
		 * traverse relations, not polymorphic ids: `subjectId` itself is a user id or a teamspace id.
		 */
		teamspaceId: s.string().nullable().map('teamspace_id'),
		teamspace: s.toOne(() => teamspace).fields('teamspaceId').references('id').onDelete('cascade'),
		/**
		 * Derived from the three columns above on write: `user:<id>`, `teamspace:<id>`, `workspace`,
		 * `public:<token>`. The policy matches it against the actor's `subjects` in ONE flat condition
		 * instead of an OR over the four kinds (see policy.ts).
		 */
		subjectKey: s.string().map('subject_key'),
		/** read | comment | update | full */
		level: s.string(),
		/** Public link token. */
		token: s.string().nullable(),
		createdBy: s.string().map('created_by'),
		deletedAt: s.dateTime().nullable().map('deleted_at')
	})
	.index(['pageId'])
	.index(['subjectKind', 'subjectId'])
	.map('grant');

/** Mirror of the D1 membership, so the object can answer without a D1 round trip. */
export const member = s
	.model({
		userId: s.string().id().map('user_id'),
		role: s.string()
	})
	.map('member');

// ----- sync and derived data -----

export const change = s
	.model({
		seq: s.int().id().increment(),
		ts: s.dateTime().now(),
		actor: s.string(),
		kind: s.string(),
		page: s.int().nullable(),
		prop: s.int().nullable(),
		oldJson: s.json().nullable().map('old_json'),
		newJson: s.json().nullable().map('new_json')
	})
	.map('change');

export const link = s
	.model({
		fromPage: s.int().map('from_page'),
		toPage: s.int().map('to_page'),
		kind: s.string()
	})
	.id(['fromPage', 'toPage', 'kind'])
	.index(['toPage'])
	.map('link');

/** Pages with live edytor sockets. */
export const openRoom = s
	.model({
		pageId: s.string().id().map('page_id'),
		openedAt: s.dateTime().now().map('opened_at')
	})
	.map('open_room');

export const workspaceSchema = {
	page,
	property,
	pText,
	pNum,
	pDate,
	pRef,
	collection,
	collectionMember,
	view,
	teamspace,
	teamspaceMember,
	grant,
	member,
	change,
	link,
	openRoom
};

/**
 * The tables viborm manages in a Workspace DO. Pass this as `tables` to the migration client so the raw
 * FTS5 `search` table (and its shadow tables) and the platform's `_cf_*` tables are left alone.
 */
export const WORKSPACE_TABLES = [
	'page',
	'property',
	'p_text',
	'p_num',
	'p_date',
	'p_ref',
	'collection',
	'collection_member',
	'view',
	'teamspace',
	'teamspace_member',
	'grant',
	'member',
	'change',
	'link',
	'open_room'
] as const;
