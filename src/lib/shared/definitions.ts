/**
 * Definitions of collections and views, as stored in the `collection` and `view` tables and as
 * carried by definition ops and API responses.
 */
import * as v from 'valibot';
import { filterGroupSchema, groupBySpecSchema, sortsSchema } from './filter-ast.js';
import { idSchema, nameSchema, propValueSchema } from './property-types.js';
import { MAX_RANK_LENGTH } from './sort-keys.js';

export const VIEW_TYPES = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

/** A sibling or list rank (see sort-keys.ts). Format-checked by the server with `isRank`. */
export const rankSchema = v.pipe(v.string(), v.minLength(2), v.maxLength(MAX_RANK_LENGTH), v.regex(/^\d+$/));

export const viewColumnSchema = v.object({
	prop: idSchema,
	width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(40), v.maxValue(1200))),
	hidden: v.optional(v.boolean())
});
export type ViewColumn = v.InferOutput<typeof viewColumnSchema>;

export const viewOptionsSchema = v.object({
	/** Table: keep the first column visible while scrolling sideways. */
	frozenFirstColumn: v.optional(v.boolean()),
	/** Table: wrap long cell text. */
	wrapCells: v.optional(v.boolean()),
	cardSize: v.optional(v.picklist(['small', 'medium', 'large'])),
	/** Gallery and board cards: a files property for the cover; absent means the first image of the page. */
	coverProp: v.optional(v.nullable(idSchema)),
	/** Calendar and timeline: the date property, and for timeline an optional second one for the end. */
	dateProp: v.optional(v.nullable(idSchema)),
	endDateProp: v.optional(v.nullable(idSchema)),
	showPageIcon: v.optional(v.boolean())
});
export type ViewOptions = v.InferOutput<typeof viewOptionsSchema>;

/** The content of `view.columns_json`. */
export const viewColumnsSchema = v.object({
	columns: v.pipe(v.array(viewColumnSchema), v.maxLength(200)),
	options: v.optional(viewOptionsSchema, {})
});
export type ViewColumns = v.InferOutput<typeof viewColumnsSchema>;

export const viewDefSchema = v.object({
	id: idSchema,
	collectionId: idSchema,
	type: v.picklist(VIEW_TYPES),
	name: nameSchema,
	filter: filterGroupSchema,
	sorts: sortsSchema,
	groupBy: v.nullable(groupBySpecSchema),
	columns: viewColumnsSchema,
	rank: rankSchema
});
export type ViewDef = v.InferOutput<typeof viewDefSchema>;

export const collectionDefaultsSchema = v.record(idSchema, v.nullable(propValueSchema));
export type CollectionDefaults = v.InferOutput<typeof collectionDefaultsSchema>;

export const collectionDefSchema = v.object({
	id: idSchema,
	/** The page that holds the database (and the default parent of new rows). */
	pageId: idSchema,
	/** Membership: pages matching this filter belong to the collection. Null: only hand-picked members. */
	sourceAst: v.nullable(filterGroupSchema),
	/** Properties the collection shows, in order. */
	shownProps: v.pipe(v.array(idSchema), v.maxLength(200)),
	/** Values a new row starts with, beyond those implied by a view's filter. */
	defaults: collectionDefaultsSchema
});
export type CollectionDef = v.InferOutput<typeof collectionDefSchema>;

export const DEFAULT_VIEW_COLUMNS: ViewColumns = { columns: [], options: {} };
