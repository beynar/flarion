/**
 * The oRPC (v1) contract. Pure schemas: the router implementations live in `private/` and `public/`,
 * the client is `createORPCClient<ContractRouterClient<typeof contract>>`.
 *
 * - `contract`: the private API at `/rpc`, session cookie. The workspace a call acts on comes from the
 *   `x-workspace-id` header (`WORKSPACE_HEADER`), the client build from `x-app-version`
 *   (`APP_VERSION_HEADER`); a call from an outdated build fails with `APP_OUTDATED` (HTTP 426), and
 *   rejected mutations fail with `VALIDATION_FAILED` carrying the issues. Procedures that write
 *   return the commit's `{ seq }` (see protocol.ts for how the client waits for it).
 * - `publicContract`: the REST API at `/v1`, bearer token, Notion-shaped (see public-api.ts). Each
 *   procedure's `meta.scope` is the token scope it requires. Writes accept `Idempotency-Key`.
 *
 * Schemas are Standard Schema (Valibot). Nothing here is `any`.
 */
import { eventIterator, oc } from '@orpc/contract';
import * as v from 'valibot';
import { viewDefSchema } from '../../lib/shared/definitions';
import { mutationBatchSchema, seqSchema } from '../../lib/shared/ops';
import {
	blockAppendBodySchema,
	blockChildrenQuerySchema,
	blockParamsSchema,
	commentCreateBodySchema,
	commentListQuerySchema,
	commentSchema,
	databaseParamsSchema,
	databaseQueryBodySchema,
	idempotencyHeaders,
	listOf,
	pageCreateBodySchema,
	pageParamsSchema,
	pageUpdateBodySchema,
	paginationQuerySchema,
	publicBlockSchema,
	publicDatabaseSchema,
	publicPageSchema,
	publicUserSchema,
	searchBodySchema,
	searchResultItemSchema,
	userParamsSchema,
	type PublicMeta
} from '../../lib/shared/public-api';
import { idSchema, propertyDefSchema } from '../../lib/shared/property-types';
import { pageRowSchema } from '../../lib/shared/protocol';
import {
	aiAskEventSchema,
	aiAskInputSchema,
	aiRegenerateInputSchema,
	aiWriteEventSchema,
	aiWriteInputSchema,
	apiTokenSchema,
	assignableRoleSchema,
	collectionCreateSchema,
	collectionQueryInputSchema,
	collectionUpdateSchema,
	collectionWithViewsSchema,
	emptySchema,
	fileBeginInputSchema,
	fileBeginResultSchema,
	fileCompleteInputSchema,
	fileIdSchema,
	fileInfoSchema,
	grantRevokeSchema,
	grantSchema,
	grantSetSchema,
	historyListInputSchema,
	historyListResultSchema,
	historyRestoreInputSchema,
	inviteSchema,
	isoSchema,
	issueSchema,
	meSchema,
	memberAddSchema,
	memberMoveSchema,
	memberRemoveSchema,
	memberSchema,
	pageCreateSchema,
	pageDuplicateSchema,
	pageIdSchema,
	pageMoveSchema,
	pageRefSchema,
	propertyUpdateSchema,
	queryPageSchema,
	quickFindInputSchema,
	quickFindResultSchema,
	searchInputSchema,
	searchResultSchema,
	teamspaceCreateSchema,
	teamspaceMemberSchema,
	teamspaceSchema,
	teamspaceUpdateSchema,
	tokenCreateInputSchema,
	tokenCreateResultSchema,
	trashListInputSchema,
	trashListResultSchema,
	viewCreateSchema,
	viewMoveSchema,
	viewUpdateSchema,
	workspaceCreateSchema,
	workspaceSchema,
	workspaceUpdateSchema
} from '../../lib/shared/schemas';

// ───────────────────────────── private API ─────────────────────────────

const priv = oc.errors({
	/** The client build is older than the server's minimum: reload. */
	APP_OUTDATED: { status: 426, message: 'This version of the app is outdated. Reload to continue.' },
	/** One or more ops or inputs failed validation against the registry. */
	VALIDATION_FAILED: {
		status: 422,
		message: 'Validation failed',
		data: v.object({ issues: v.array(issueSchema) })
	}
});

const idOnly = (key: string) => v.object({ [key]: idSchema });

const workspaceRouter = {
	/** Workspaces the caller belongs to (no workspace header needed). */
	list: priv.output(v.array(workspaceSchema)),
	create: priv.input(workspaceCreateSchema).output(workspaceSchema),
	get: priv.output(workspaceSchema),
	/** Name, slug, icon. */
	settings: priv.input(workspaceUpdateSchema).output(workspaceSchema),
	/** Soft-deletes the workspace; it is purged after 30 days. Owner only. */
	delete: priv
		.input(v.object({ confirmName: v.string() }))
		.output(v.object({ purgeAfter: isoSchema })),
	members: {
		list: priv.output(v.array(memberSchema)),
		setRole: priv.input(v.object({ userId: idSchema, role: v.picklist(['admin', 'member', 'guest']) })).output(emptySchema),
		remove: priv.input(idOnly('userId')).output(emptySchema)
	},
	invites: {
		create: priv.input(v.object({ email: v.pipe(v.string(), v.trim(), v.email()), role: assignableRoleSchema })).output(inviteSchema),
		list: priv.output(v.array(inviteSchema)),
		revoke: priv.input(idOnly('id')).output(emptySchema),
		/** Accepts an invite by its emailed token (workspace header not needed). */
		accept: priv.input(v.object({ token: v.pipe(v.string(), v.minLength(10), v.maxLength(256)) })).output(workspaceSchema)
	},
	teamspaces: {
		list: priv.output(v.array(teamspaceSchema)),
		create: priv.input(teamspaceCreateSchema).output(teamspaceSchema),
		update: priv.input(teamspaceUpdateSchema).output(teamspaceSchema),
		/** Tombstones the teamspace and all its pages with one shared timestamp. */
		archive: priv.input(idOnly('id')).output(seqSchema),
		members: {
			list: priv.input(idOnly('teamspaceId')).output(v.array(teamspaceMemberSchema)),
			add: priv
				.input(v.object({ teamspaceId: idSchema, userId: idSchema, role: v.optional(v.picklist(['owner', 'member'])) }))
				.output(teamspaceMemberSchema),
			setRole: priv
				.input(v.object({ teamspaceId: idSchema, userId: idSchema, role: v.picklist(['owner', 'member']) }))
				.output(teamspaceMemberSchema),
			remove: priv.input(v.object({ teamspaceId: idSchema, userId: idSchema })).output(emptySchema)
		}
	}
};

const pageRouter = {
	/** One-shot read of a page's header and properties. */
	get: priv.input(pageIdSchema).output(pageRowSchema),
	create: priv.input(pageCreateSchema).output(pageRefSchema),
	move: priv.input(pageMoveSchema).output(seqSchema),
	duplicate: priv.input(pageDuplicateSchema).output(pageRefSchema),
	trash: priv.input(pageIdSchema).output(seqSchema),
	restore: priv.input(pageIdSchema).output(seqSchema),
	/** Deletes a trashed page forever, ahead of the 30-day purge. */
	purge: priv.input(pageIdSchema).output(emptySchema),
	trashList: priv.input(trashListInputSchema).output(trashListResultSchema),
	history: {
		list: priv.input(historyListInputSchema).output(historyListResultSchema),
		restore: priv.input(historyRestoreInputSchema).output(seqSchema)
	},
	grants: {
		list: priv.input(pageIdSchema).output(v.array(grantSchema)),
		set: priv.input(grantSetSchema).output(grantSchema),
		revoke: priv.input(grantRevokeSchema).output(seqSchema)
	}
};

const propertyRouter = {
	list: priv.output(v.array(propertyDefSchema)),
	create: priv.input(v.object({ property: propertyDefSchema })).output(seqSchema),
	update: priv.input(propertyUpdateSchema).output(seqSchema),
	delete: priv.input(idOnly('id')).output(seqSchema)
};

const collectionRouter = {
	get: priv.input(idOnly('id')).output(collectionWithViewsSchema),
	create: priv.input(collectionCreateSchema).output(v.object({ id: idSchema, seq: seqSchema.entries.seq })),
	update: priv.input(collectionUpdateSchema).output(seqSchema),
	delete: priv.input(idOnly('id')).output(seqSchema),
	members: {
		add: priv.input(memberAddSchema).output(seqSchema),
		remove: priv.input(memberRemoveSchema).output(seqSchema),
		move: priv.input(memberMoveSchema).output(seqSchema)
	},
	/** One-shot, cursor-paginated read; live reads use a `view` subscription on the socket. */
	query: priv.input(collectionQueryInputSchema).output(queryPageSchema)
};

const viewRouter = {
	list: priv.input(idOnly('collectionId')).output(v.array(viewDefSchema)),
	create: priv.input(viewCreateSchema).output(v.object({ id: idSchema, seq: seqSchema.entries.seq })),
	update: priv.input(viewUpdateSchema).output(seqSchema),
	move: priv.input(viewMoveSchema).output(seqSchema),
	delete: priv.input(idOnly('id')).output(seqSchema)
};

const searchRouter = {
	query: priv.input(searchInputSchema).output(searchResultSchema),
	/** Command-palette results: title prefixes, recent pages, then full text. */
	quick: priv.input(quickFindInputSchema).output(quickFindResultSchema),
	/** Records that the caller opened a page (feeds "recent"). */
	visit: priv.input(pageIdSchema).output(emptySchema)
};

const aiRouter = {
	/** Streams the draft that lands in the editor as a shared suggestion. */
	write: priv.input(aiWriteInputSchema).output(eventIterator(aiWriteEventSchema)),
	/** Streams an answer drawn from pages the caller may read. */
	ask: priv.input(aiAskInputSchema).output(eventIterator(aiAskEventSchema)),
	/** Re-runs an AI property on a page. */
	regenerate: priv.input(aiRegenerateInputSchema).output(seqSchema)
};

const filesRouter = {
	begin: priv.input(fileBeginInputSchema).output(fileBeginResultSchema),
	/** Finishes an upload (and a multipart one's parts). */
	complete: priv.input(fileCompleteInputSchema).output(fileInfoSchema),
	abort: priv.input(fileIdSchema).output(emptySchema),
	get: priv.input(fileIdSchema).output(fileInfoSchema)
};

const tokensRouter = {
	list: priv.output(v.array(apiTokenSchema)),
	create: priv.input(tokenCreateInputSchema).output(tokenCreateResultSchema),
	revoke: priv.input(idOnly('id')).output(emptySchema)
};

export const contract = {
	/** The signed-in user and their workspaces. */
	me: priv.output(meSchema),
	workspace: workspaceRouter,
	page: pageRouter,
	property: propertyRouter,
	collection: collectionRouter,
	view: viewRouter,
	/** The write path: a batch of ops, validated, applied in one transaction. */
	mutate: priv.input(mutationBatchSchema).output(seqSchema),
	search: searchRouter,
	ai: aiRouter,
	files: filesRouter,
	tokens: tokensRouter
};

// ───────────────────────────── public API (/v1) ─────────────────────────────

const pub = oc.$meta<PublicMeta>({}).errors({
	UNAUTHORIZED: { status: 401, message: 'Missing, invalid or expired token' },
	FORBIDDEN: { status: 403, message: 'The token lacks the scope or access this needs' },
	NOT_FOUND: { status: 404, message: 'Not found' },
	/** The same `Idempotency-Key` was used with a different request. */
	IDEMPOTENCY_CONFLICT: { status: 409, message: 'Idempotency-Key reused with a different request' },
	VALIDATION_FAILED: {
		status: 422,
		message: 'Validation failed',
		data: v.object({ issues: v.array(issueSchema) })
	},
	RATE_LIMITED: { status: 429, message: 'Too many requests' }
});

/** Detailed input of a write: optional `Idempotency-Key` header, optional path params, JSON body. */
const writeBody = <B extends v.GenericSchema>(body: B) =>
	v.object({ headers: v.optional(idempotencyHeaders), body });
const writeBodyAt = <P extends v.GenericSchema, B extends v.GenericSchema>(params: P, body: B) =>
	v.object({ params, headers: v.optional(idempotencyHeaders), body });
const writeAt = <P extends v.GenericSchema>(params: P) => v.object({ params, headers: v.optional(idempotencyHeaders) });

export const publicContract = {
	pages: {
		create: pub
			.route({
				method: 'POST',
				path: '/pages',
				inputStructure: 'detailed',
				successStatus: 201,
				operationId: 'createPage',
				summary: 'Create a page',
				tags: ['Pages']
			})
			.meta({ scope: 'page.create' })
			.input(writeBody(pageCreateBodySchema))
			.output(publicPageSchema),
		retrieve: pub
			.route({ method: 'GET', path: '/pages/{page_id}', operationId: 'retrievePage', summary: 'Retrieve a page', tags: ['Pages'] })
			.meta({ scope: 'page.read' })
			.input(pageParamsSchema)
			.output(publicPageSchema),
		update: pub
			.route({
				method: 'PATCH',
				path: '/pages/{page_id}',
				inputStructure: 'detailed',
				operationId: 'updatePage',
				summary: 'Update the properties, icon or cover of a page',
				tags: ['Pages']
			})
			.meta({ scope: 'page.update' })
			.input(writeBodyAt(pageParamsSchema, pageUpdateBodySchema))
			.output(publicPageSchema),
		trash: pub
			.route({
				method: 'POST',
				path: '/pages/{page_id}/trash',
				inputStructure: 'detailed',
				operationId: 'trashPage',
				summary: 'Move a page and its subpages to the trash',
				tags: ['Pages']
			})
			.meta({ scope: 'page.trash' })
			.input(writeAt(pageParamsSchema))
			.output(publicPageSchema),
		restore: pub
			.route({
				method: 'POST',
				path: '/pages/{page_id}/restore',
				inputStructure: 'detailed',
				operationId: 'restorePage',
				summary: 'Restore a page from the trash',
				tags: ['Pages']
			})
			.meta({ scope: 'page.trash' })
			.input(writeAt(pageParamsSchema))
			.output(publicPageSchema)
	},
	blocks: {
		children: {
			list: pub
				.route({
					method: 'GET',
					path: '/blocks/{block_id}/children',
					operationId: 'listBlockChildren',
					summary: 'List the child blocks of a page or block',
					tags: ['Blocks']
				})
				.meta({ scope: 'block.read' })
				.input(blockChildrenQuerySchema)
				.output(listOf(publicBlockSchema)),
			append: pub
				.route({
					method: 'PATCH',
					path: '/blocks/{block_id}/children',
					inputStructure: 'detailed',
					operationId: 'appendBlockChildren',
					summary: 'Append child blocks to a page or block',
					tags: ['Blocks']
				})
				.meta({ scope: 'block.write' })
				.input(writeBodyAt(blockParamsSchema, blockAppendBodySchema))
				.output(listOf(publicBlockSchema))
		}
	},
	databases: {
		retrieve: pub
			.route({
				method: 'GET',
				path: '/databases/{database_id}',
				operationId: 'retrieveDatabase',
				summary: 'Retrieve a database and its properties',
				tags: ['Databases']
			})
			.meta({ scope: 'database.read' })
			.input(databaseParamsSchema)
			.output(publicDatabaseSchema),
		query: pub
			.route({
				method: 'POST',
				path: '/databases/{database_id}/query',
				successStatus: 200,
				operationId: 'queryDatabase',
				summary: 'Query a database with the app\'s filter AST',
				tags: ['Databases']
			})
			.meta({ scope: 'database.read' })
			.input(v.object({ ...databaseParamsSchema.entries, ...databaseQueryBodySchema.entries }))
			.output(listOf(publicPageSchema))
	},
	search: pub
		.route({ method: 'POST', path: '/search', successStatus: 200, operationId: 'search', summary: 'Search pages and databases by title and content', tags: ['Search'] })
		.meta({ scope: 'search' })
		.input(searchBodySchema)
		.output(listOf(searchResultItemSchema)),
	comments: {
		list: pub
			.route({ method: 'GET', path: '/comments', operationId: 'listComments', summary: 'List the comments on a page or block', tags: ['Comments'] })
			.meta({ scope: 'comment.read' })
			.input(commentListQuerySchema)
			.output(listOf(commentSchema)),
		create: pub
			.route({
				method: 'POST',
				path: '/comments',
				inputStructure: 'detailed',
				successStatus: 201,
				operationId: 'createComment',
				summary: 'Create a comment on a page or block, or reply to a discussion',
				tags: ['Comments']
			})
			.meta({ scope: 'comment.write' })
			.input(writeBody(commentCreateBodySchema))
			.output(commentSchema)
	},
	users: {
		list: pub
			.route({ method: 'GET', path: '/users', operationId: 'listUsers', summary: 'List the members of the workspace', tags: ['Users'] })
			.meta({ scope: 'user.read' })
			.input(paginationQuerySchema)
			.output(listOf(publicUserSchema)),
		me: pub
			.route({ method: 'GET', path: '/users/me', operationId: 'retrieveBotUser', summary: 'Retrieve the user the token acts as', tags: ['Users'] })
			.meta({ scope: 'user.read' })
			.output(publicUserSchema),
		retrieve: pub
			.route({ method: 'GET', path: '/users/{user_id}', operationId: 'retrieveUser', summary: 'Retrieve a user', tags: ['Users'] })
			.meta({ scope: 'user.read' })
			.input(userParamsSchema)
			.output(publicUserSchema)
	}
};

export type Contract = typeof contract;
export type PublicContract = typeof publicContract;
