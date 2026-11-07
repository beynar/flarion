/**
 * Relation rows for the engine. A relation is stored on the holder page: `p_ref(prop, v = target num, page =
 * holder num)`. Reading it from the target side (the reverse side of a two-way relation) is a range scan of
 * `p_ref` on `(prop, v)`; nothing is mirrored. Tombstoned pages are skipped on both ends by the callers (a
 * relation to a deleted page reads as gone, see `eav/relations.ts`).
 */
import { chunks, qmarks } from '../objects/workspace/eav/sql';
import { FULL_LOAD_AT, IN_CHUNK, type Ctx } from './context';

/** `p_ref` predicate (over `v`) true when the target page is live: a point lookup per row through `page.num`. */
export const LIVE_TARGET_SQL = 'EXISTS (SELECT 1 FROM page WHERE page.num = CAST(v AS INTEGER) AND page.deleted_at IS NULL)';

export interface RelationRow {
	holder: number;
	target: number;
}

/** The relation rows of `prop` held by `holders`. */
export async function rowsOfHolders(ctx: Ctx, prop: number, holders: readonly number[]): Promise<RelationRow[]> {
	if (holders.length > FULL_LOAD_AT) {
		const want = new Set(holders);
		const rows = await ctx.q<{ page: number; v: string }>('SELECT page, v FROM p_ref WHERE prop = ?', prop);
		return rows.filter((r) => want.has(r.page)).map((r) => ({ holder: r.page, target: Number(r.v) }));
	}
	const out: RelationRow[] = [];
	for (const part of chunks(holders, IN_CHUNK)) {
		const rows = await ctx.q<{ page: number; v: string }>(`SELECT page, v FROM p_ref WHERE prop = ? AND page IN (${qmarks(part.length)})`, prop, ...part);
		for (const r of rows) out.push({ holder: r.page, target: Number(r.v) });
	}
	return out;
}

/** The relation rows of `prop` that point at `targets`: the reverse range scan. */
export async function rowsOfTargets(ctx: Ctx, prop: number, targets: readonly number[]): Promise<RelationRow[]> {
	if (targets.length > FULL_LOAD_AT) {
		const want = new Set(targets);
		const rows = await ctx.q<{ page: number; v: string }>('SELECT page, v FROM p_ref WHERE prop = ?', prop);
		return rows.filter((r) => want.has(Number(r.v))).map((r) => ({ holder: r.page, target: Number(r.v) }));
	}
	const out: RelationRow[] = [];
	for (const part of chunks(targets, IN_CHUNK)) {
		const rows = await ctx.q<{ page: number; v: string }>(`SELECT page, v FROM p_ref WHERE prop = ? AND v IN (${qmarks(part.length)})`, prop, ...part.map(String));
		for (const r of rows) out.push({ holder: r.page, target: Number(r.v) });
	}
	return out;
}
