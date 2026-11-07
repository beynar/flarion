/**
 * The custom block kinds, declared once. The client plugin spreads {@link customKindRows} into its
 * `blocks` definitions (adding snippets), and the Page DO passes {@link roomSemantics} as the
 * room's `semantics`, so every replica reads the same roles. Imports only edytor's Worker-safe
 * `edytor/crdt/edytor` entry (the same one the room uses), so this file is safe on both sides.
 *
 * Kinds
 * - `database_view`: a void block rendering a live view of any collection.
 *   `data: { collectionId, viewId, localFilter }`. All three are `atomic`, so two people changing
 *   the filter (or switching the collection) at once never merge into a value neither wrote.
 * - `breadcrumb`: a void block showing the page's ancestors, read from the workspace store.
 * - `date_mention`: an inline atom (`inlineBlocks`), `data: DateValue`. Inline atoms need no role.
 *
 * KINDS_VERSION is bumped whenever a kind is added or its roles, data shape or semantics change.
 * The client sends it in `hello` (and in edytor room params); a room refuses a client that is behind.
 */
import { defaultSemantics, mergeSemantics, semanticsOf } from 'edytor/crdt/edytor';
import * as v from 'valibot';
import { dateValueSchema, type DateValue } from '../dates.js';
import { filterGroupSchema, type FilterGroup } from '../filter-ast.js';
import { idSchema } from '../property-types.js';

export const KINDS_VERSION = 1;

export const BLOCK_KIND = {
	databaseView: 'database_view',
	breadcrumb: 'breadcrumb'
} as const;
export const INLINE_KIND = {
	dateMention: 'date_mention'
} as const;

export type BlockKindName = (typeof BLOCK_KIND)[keyof typeof BLOCK_KIND];
export type InlineKindName = (typeof INLINE_KIND)[keyof typeof INLINE_KIND];

// ───────────────────────────── data ─────────────────────────────

export const databaseViewDataSchema = v.object({
	collectionId: idSchema,
	/** The view to show; null shows the collection's first view. */
	viewId: v.nullable(idSchema),
	/** An extra filter ANDed with the view's, local to this block; null for none. */
	localFilter: v.nullable(filterGroupSchema)
});
export type DatabaseViewData = { collectionId: string; viewId: string | null; localFilter: FilterGroup | null };

export const breadcrumbDataSchema = v.object({});
export type BreadcrumbData = Record<string, never>;

export const dateMentionDataSchema = dateValueSchema;
export type DateMentionData = DateValue;

export const blockDataSchemas = {
	[BLOCK_KIND.databaseView]: databaseViewDataSchema,
	[BLOCK_KIND.breadcrumb]: breadcrumbDataSchema
} as const;
export const inlineDataSchemas = {
	[INLINE_KIND.dateMention]: dateMentionDataSchema
} as const;

/** The data of a freshly inserted block of each kind. */
export const defaultBlockData = {
	[BLOCK_KIND.databaseView]: (collectionId: string): DatabaseViewData => ({
		collectionId,
		viewId: null,
		localFilter: null
	}),
	[BLOCK_KIND.breadcrumb]: (): BreadcrumbData => ({})
} as const;

// ───────────────────────────── roles ─────────────────────────────

/**
 * Each block kind's structural row, the fields of edytor's `BlockDefinition` a document adopts:
 * both are voids that render no text of their own. Spread a row into the kind's definition on the
 * client; it is also the input of `semanticsOf`.
 */
export const customKindRows = {
	[BLOCK_KIND.databaseView]: {
		void: true,
		rendersContent: false,
		atomic: ['collectionId', 'viewId', 'localFilter']
	},
	[BLOCK_KIND.breadcrumb]: {
		void: true,
		rendersContent: false
	}
} as const satisfies Record<BlockKindName, { void: true; rendersContent: false; atomic?: readonly string[] }>;

/** The custom kinds as document semantics (roles, content-less kinds). */
export const customSemantics = semanticsOf(customKindRows);

/** What a Page DO room (or a headless document) is created with: edytor's defaults plus the custom kinds. */
export const roomSemantics = mergeSemantics(defaultSemantics, customSemantics);

// ───────────────────────────── version checks ─────────────────────────────

/**
 * `ok` when the versions match; `reload` when the client is behind (it may send blocks the room
 * would misread: close it with the protocol's reload code); `ahead` when the client is newer than
 * the room (a deploy is rolling out: the room may keep serving it, unknown kinds degrade to
 * plain blocks).
 */
export function checkKindsVersion(
	client: number | null | undefined,
	room: number = KINDS_VERSION
): 'ok' | 'reload' | 'ahead' {
	if (typeof client !== 'number' || !Number.isInteger(client)) return 'reload';
	if (client === room) return 'ok';
	return client < room ? 'reload' : 'ahead';
}
