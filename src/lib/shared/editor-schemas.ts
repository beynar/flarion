/**
 * Schemas of the Editor and files track's procedures that the P0 contract did not name: reading and undoing a
 * history version, moving blocks between pages. Kept beside `schemas.ts` (not inside it) so the tracks that edit
 * that file never conflict with these; `src/server/rpc/contract.ts` imports them.
 */
import * as v from 'valibot';
import { idSchema } from './property-types';
import { isoSchema, nonNegativeInt } from './schemas';

/** One version's body, as the history preview reads it (`edytor`'s `JSONDoc`: `{ children: JSONBlock[] }`). */
export const historyReadResultSchema = v.object({
	id: idSchema,
	createdAt: isoSchema,
	doc: v.looseObject({ children: v.array(v.looseObject({ type: v.string() })) })
});

export const historyUndoResultSchema = v.object({ status: v.picklist(['applied', 'noop']) });

/** Blocks leaving page `from` for page `to` (edytor's cross-document move: export, import, commit). */
export const moveBlocksInputSchema = v.object({
	from: idSchema,
	to: idSchema,
	/** Ids of the blocks of `from` to move (their subtrees go with them). */
	ids: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))), v.minLength(1), v.maxLength(500)),
	/** Where they land among `to`'s top-level blocks (default: the end). */
	index: v.optional(nonNegativeInt)
});
export const moveBlocksResultSchema = v.object({
	moveId: v.string(),
	/** Each moved block's id in the destination (a block whose id the destination held is renamed). */
	ids: v.record(v.string(), v.string())
});
