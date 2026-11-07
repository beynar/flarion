/**
 * Schemas of the public REST API (`/v1`), following Notion's API shape: `object` discriminators,
 * `results / next_cursor / has_more` lists, `start_cursor / page_size` pagination, typed property
 * values (`{ type: 'select', select: {...} }`), snake_case fields.
 *
 * Differences from Notion, on purpose: rich text is plain strings with optional marks, properties
 * are keyed by property id, and the database filter is the same AST as the UI's
 * ({@link filterGroupSchema}), not Notion's per-type filter objects.
 * No lazy schemas, and the only transform is the string-to-number coercion of a query-string
 * `page_size`: everything converts to JSON Schema for the OpenAPI document.
 */
import * as v from 'valibot';
import { dateValueSchema } from './dates.js';
import { filterGroupSchema, sortsSchema } from './filter-ast.js';
import { PROPERTY_TYPES, SELECT_COLORS, idSchema } from './property-types.js';
import { isoSchema, nonNegativeInt, tokenScopeSchema } from './schemas.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_RETENTION_HOURS = 24;

// ───────────────────────────── lists and pagination ─────────────────────────────

const pageSizeValue = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100));
/** `page_size` in a body (number) or a query string (digits). */
const pageSizeQueryValue = v.pipe(
	v.union([v.number(), v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number))]),
	v.integer(),
	v.minValue(1),
	v.maxValue(100)
);
const cursorValue = v.pipe(v.string(), v.minLength(1), v.maxLength(512));

/** Body pagination (POST endpoints). */
export const paginationBodySchema = v.object({
	start_cursor: v.optional(cursorValue),
	page_size: v.optional(pageSizeValue)
});
/** Query-string pagination (GET endpoints). */
export const paginationQuerySchema = v.object({
	start_cursor: v.optional(cursorValue),
	page_size: v.optional(pageSizeQueryValue)
});

export const listOf = <S extends v.GenericSchema>(item: S) =>
	v.object({
		object: v.literal('list'),
		results: v.array(item),
		next_cursor: v.nullable(cursorValue),
		has_more: v.boolean()
	});

/** The write-endpoint wrapper: path params, the idempotency header and the body. */
export const idempotencyHeaders = v.object({
	[IDEMPOTENCY_HEADER]: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(255)))
});

// ───────────────────────────── users ─────────────────────────────

export const userRefSchema = v.object({ object: v.literal('user'), id: idSchema });
export const publicUserSchema = v.object({
	object: v.literal('user'),
	id: idSchema,
	type: v.picklist(['person', 'bot']),
	name: v.nullable(v.string()),
	avatar_url: v.nullable(v.string()),
	person: v.optional(v.object({ email: v.string() }))
});
export type PublicUser = v.InferOutput<typeof publicUserSchema>;

// ───────────────────────────── rich content ─────────────────────────────

/** A run of text with its marks (bold, link, ...), the shape of an edytor text segment. */
export const richTextSchema = v.object({
	text: v.string(),
	marks: v.optional(v.record(v.string(), v.unknown()))
});
export type RichText = v.InferOutput<typeof richTextSchema>;

const inlineBlockSchema = v.object({
	type: v.string(),
	id: v.optional(v.string()),
	data: v.optional(v.record(v.string(), v.unknown()))
});
export const inlineContentSchema = v.union([richTextSchema, inlineBlockSchema]);

// ───────────────────────────── icons and covers ─────────────────────────────

export const iconSchema = v.nullable(
	v.variant('type', [
		v.object({ type: v.literal('emoji'), emoji: v.string() }),
		v.object({ type: v.literal('external'), external: v.object({ url: v.string() }) })
	])
);
export const coverSchema = v.nullable(v.object({ type: v.literal('external'), external: v.object({ url: v.string() }) }));

// ───────────────────────────── property values ─────────────────────────────

const optionOut = v.object({ id: idSchema, name: v.string(), color: v.picklist(SELECT_COLORS) });
const optionIn = v.object({ id: idSchema });
const refOut = v.object({ id: idSchema });

/** A property value as read. */
export const propertyValueSchema = v.variant('type', [
	v.object({ type: v.literal('title'), title: v.nullable(v.string()) }),
	v.object({ type: v.literal('text'), text: v.nullable(v.string()) }),
	v.object({ type: v.literal('url'), url: v.nullable(v.string()) }),
	v.object({ type: v.literal('email'), email: v.nullable(v.string()) }),
	v.object({ type: v.literal('phone'), phone: v.nullable(v.string()) }),
	v.object({ type: v.literal('number'), number: v.nullable(v.number()) }),
	v.object({ type: v.literal('select'), select: v.nullable(optionOut) }),
	v.object({ type: v.literal('status'), status: v.nullable(optionOut) }),
	v.object({ type: v.literal('multi_select'), multi_select: v.array(optionOut) }),
	v.object({ type: v.literal('date'), date: v.nullable(dateValueSchema) }),
	v.object({ type: v.literal('person'), person: v.array(refOut) }),
	v.object({ type: v.literal('checkbox'), checkbox: v.nullable(v.boolean()) }),
	v.object({ type: v.literal('files'), files: v.array(refOut) }),
	v.object({ type: v.literal('relation'), relation: v.array(refOut) }),
	v.object({
		type: v.literal('rollup'),
		rollup: v.nullable(v.union([v.string(), v.number(), v.boolean(), dateValueSchema]))
	}),
	v.object({
		type: v.literal('formula'),
		formula: v.nullable(v.union([v.string(), v.number(), v.boolean(), dateValueSchema]))
	}),
	v.object({ type: v.literal('created_time'), created_time: isoSchema }),
	v.object({ type: v.literal('created_by'), created_by: refOut }),
	v.object({ type: v.literal('last_edited_time'), last_edited_time: isoSchema }),
	v.object({ type: v.literal('last_edited_by'), last_edited_by: refOut }),
	v.object({
		type: v.literal('unique_id'),
		unique_id: v.object({ prefix: v.nullable(v.string()), number: nonNegativeInt })
	}),
	v.object({ type: v.literal('ai'), ai: v.nullable(v.string()) })
]);
export type PublicPropertyValue = v.InferOutput<typeof propertyValueSchema>;

/** A property value as written: writable types only, options and references by id. Null clears. */
export const propertyInputSchema = v.variant('type', [
	v.object({ type: v.literal('title'), title: v.nullable(v.pipe(v.string(), v.maxLength(2000))) }),
	v.object({ type: v.literal('text'), text: v.nullable(v.pipe(v.string(), v.maxLength(20_000))) }),
	v.object({ type: v.literal('url'), url: v.nullable(v.pipe(v.string(), v.maxLength(2048))) }),
	v.object({ type: v.literal('email'), email: v.nullable(v.pipe(v.string(), v.maxLength(320))) }),
	v.object({ type: v.literal('phone'), phone: v.nullable(v.pipe(v.string(), v.maxLength(64))) }),
	v.object({ type: v.literal('number'), number: v.nullable(v.pipe(v.number(), v.finite())) }),
	v.object({ type: v.literal('select'), select: v.nullable(optionIn) }),
	v.object({ type: v.literal('status'), status: v.nullable(optionIn) }),
	v.object({ type: v.literal('multi_select'), multi_select: v.pipe(v.array(optionIn), v.maxLength(100)) }),
	v.object({ type: v.literal('date'), date: v.nullable(dateValueSchema) }),
	v.object({ type: v.literal('person'), person: v.pipe(v.array(refOut), v.maxLength(100)) }),
	v.object({ type: v.literal('checkbox'), checkbox: v.nullable(v.boolean()) }),
	v.object({ type: v.literal('relation'), relation: v.pipe(v.array(refOut), v.maxLength(500)) })
]);
export type PublicPropertyInput = v.InferOutput<typeof propertyInputSchema>;

/** Property values keyed by property id. */
export const propertiesInputSchema = v.record(idSchema, propertyInputSchema);
export const propertiesSchema = v.record(idSchema, propertyValueSchema);

// ───────────────────────────── blocks ─────────────────────────────

export const publicBlockSchema = v.object({
	object: v.literal('block'),
	id: idSchema,
	/** The block kind: `paragraph`, `heading1`, `image`, `database_view`, ... as edytor names them. */
	type: v.string(),
	has_children: v.boolean(),
	data: v.record(v.string(), v.unknown()),
	content: v.array(inlineContentSchema),
	created_time: v.optional(isoSchema),
	last_edited_time: v.optional(isoSchema)
});
export type PublicBlock = v.InferOutput<typeof publicBlockSchema>;

// Blocks nest to three levels on input, written out so the schema stays convertible to JSON Schema.
const blockLeaf = {
	type: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
	data: v.optional(v.record(v.string(), v.unknown())),
	content: v.optional(v.pipe(v.array(inlineContentSchema), v.maxLength(1000)))
};
const blockInput3 = v.object(blockLeaf);
const blockInput2 = v.object({ ...blockLeaf, children: v.optional(v.pipe(v.array(blockInput3), v.maxLength(100))) });
export const blockInputSchema: v.GenericSchema<BlockInput> = v.object({
	...blockLeaf,
	children: v.optional(v.pipe(v.array(blockInput2), v.maxLength(100)))
});
export interface BlockInput {
	type: string;
	data?: Record<string, unknown>;
	content?: v.InferOutput<typeof inlineContentSchema>[];
	children?: BlockInput[];
}

export const blockParamsSchema = v.object({ block_id: idSchema });
export const blockChildrenQuerySchema = v.object({ block_id: idSchema, ...paginationQuerySchema.entries });
export const blockAppendBodySchema = v.object({
	children: v.pipe(v.array(blockInputSchema), v.minLength(1), v.maxLength(100)),
	/** Insert after this child; appended at the end when absent. */
	after: v.optional(idSchema)
});

// ───────────────────────────── pages ─────────────────────────────

export const parentSchema = v.variant('type', [
	v.object({ type: v.literal('page_id'), page_id: idSchema }),
	v.object({ type: v.literal('database_id'), database_id: idSchema }),
	v.object({ type: v.literal('workspace'), workspace: v.literal(true) })
]);
export type PublicParent = v.InferOutput<typeof parentSchema>;

export const publicPageSchema = v.object({
	object: v.literal('page'),
	id: idSchema,
	created_time: isoSchema,
	last_edited_time: isoSchema,
	created_by: v.nullable(userRefSchema),
	last_edited_by: v.nullable(userRefSchema),
	parent: parentSchema,
	in_trash: v.boolean(),
	icon: iconSchema,
	cover: coverSchema,
	properties: propertiesSchema,
	url: v.string()
});
export type PublicPage = v.InferOutput<typeof publicPageSchema>;

export const pageParamsSchema = v.object({ page_id: idSchema });

export const pageCreateBodySchema = v.object({
	parent: v.variant('type', [
		v.object({ type: v.literal('page_id'), page_id: idSchema }),
		v.object({ type: v.literal('database_id'), database_id: idSchema }),
		v.object({ type: v.literal('workspace'), workspace: v.literal(true) })
	]),
	properties: v.optional(propertiesInputSchema),
	icon: v.optional(iconSchema),
	cover: v.optional(coverSchema),
	/** Initial body, appended as for `PATCH /blocks/{id}/children`. */
	children: v.optional(v.pipe(v.array(blockInputSchema), v.maxLength(100)))
});
export const pageUpdateBodySchema = v.object({
	properties: v.optional(propertiesInputSchema),
	icon: v.optional(iconSchema),
	cover: v.optional(coverSchema)
});

// ───────────────────────────── databases ─────────────────────────────

export const publicDatabaseSchema = v.object({
	object: v.literal('database'),
	id: idSchema,
	title: v.string(),
	icon: iconSchema,
	parent: parentSchema,
	created_time: isoSchema,
	last_edited_time: isoSchema,
	in_trash: v.boolean(),
	properties: v.record(
		idSchema,
		v.object({
			id: idSchema,
			name: v.string(),
			type: v.picklist(PROPERTY_TYPES),
			/** The type's config (options of a select, target of a relation, ...). */
			config: v.record(v.string(), v.unknown())
		})
	),
	views: v.array(v.object({ id: idSchema, name: v.string(), type: v.string() }))
});
export type PublicDatabase = v.InferOutput<typeof publicDatabaseSchema>;

export const databaseParamsSchema = v.object({ database_id: idSchema });

export const databaseQueryBodySchema = v.object({
	/** The same filter AST as the app's views. */
	filter: v.optional(filterGroupSchema),
	sorts: v.optional(sortsSchema),
	/** Use this view's filter, sorts and grouping as the base. */
	view_id: v.optional(idSchema),
	...paginationBodySchema.entries
});

// ───────────────────────────── search ─────────────────────────────

export const searchBodySchema = v.object({
	query: v.optional(v.pipe(v.string(), v.maxLength(500))),
	filter: v.optional(v.object({ property: v.literal('object'), value: v.picklist(['page', 'database']) })),
	sort: v.optional(
		v.object({ direction: v.picklist(['ascending', 'descending']), timestamp: v.literal('last_edited_time') })
	),
	...paginationBodySchema.entries
});
export const searchResultItemSchema = v.union([publicPageSchema, publicDatabaseSchema]);

// ───────────────────────────── comments ─────────────────────────────

export const commentSchema = v.object({
	object: v.literal('comment'),
	id: idSchema,
	parent: v.variant('type', [
		v.object({ type: v.literal('page_id'), page_id: idSchema }),
		v.object({ type: v.literal('block_id'), block_id: idSchema })
	]),
	discussion_id: idSchema,
	created_time: isoSchema,
	created_by: userRefSchema,
	rich_text: v.array(richTextSchema)
});
export type PublicComment = v.InferOutput<typeof commentSchema>;

export const commentListQuerySchema = v.object({ block_id: idSchema, ...paginationQuerySchema.entries });
export const commentCreateBodySchema = v.object({
	/** Start a discussion on a page or a block, or reply in an existing one. */
	parent: v.optional(
		v.variant('type', [
			v.object({ type: v.literal('page_id'), page_id: idSchema }),
			v.object({ type: v.literal('block_id'), block_id: idSchema })
		])
	),
	discussion_id: v.optional(idSchema),
	rich_text: v.pipe(v.array(richTextSchema), v.minLength(1), v.maxLength(100))
});

// ───────────────────────────── users ─────────────────────────────

export const userParamsSchema = v.object({ user_id: idSchema });

// ───────────────────────────── meta ─────────────────────────────

/** Scopes a public procedure requires; the router middleware reads it from the procedure meta. */
export type PublicMeta = { scope?: v.InferOutput<typeof tokenScopeSchema> };
