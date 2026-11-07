/**
 * Relation reads. Two rules sit on top of `props_json` and the `p_ref` rows:
 *
 * - A relation to a tombstone reads as if the target were gone: the dead ids are dropped from the list, and a
 *   relation left with no live target reads `null` (a to-one relation to a deleted page: "Deleted page"). The
 *   rows and `props_json` keep the id, so a restore is lossless.
 * - The reverse side of a two-way relation is a synthetic property (`<id>:reverse`) computed by a range scan of
 *   `p_ref` on `(prop, v)`: the live pages whose relation points at the page, by `page.num`. Nothing is stored.
 */
import type { Values } from '../../../../lib/shared/protocol';
import type { WorkspaceDb } from '../../../db/workspace.client';
import type { EavRegistry } from './registry';
import { MAX_PARAMS, all, chunks, qmarks } from './sql';

export interface ValueRow {
	id: string;
	num: number;
	values: Values;
}

/** The ids among `ids` of pages that exist and are not in the trash. */
export async function liveIds(db: WorkspaceDb, ids: Iterable<string>): Promise<Set<string>> {
	const out = new Set<string>();
	for (const part of chunks([...new Set(ids)], MAX_PARAMS))
		for (const r of await all<{ id: string }>(db, `SELECT id FROM page WHERE id IN (${qmarks(part.length)}) AND deleted_at IS NULL`, ...part)) out.add(r.id);
	return out;
}

/**
 * Applies the two rules to the display values of `rows` in place: tombstoned relation targets disappear, and the
 * synthetic reverse properties are filled in (only those in `want` when given).
 */
export async function decorateValues(db: WorkspaceDb, registry: EavRegistry, rows: readonly ValueRow[], want?: ReadonlySet<string> | null): Promise<void> {
	if (rows.length === 0) return;
	const relations = registry.all().filter((d) => d.type === 'relation');
	const forward = relations.filter((d) => d.type === 'relation' && !d.config.reverseOf);
	const reverse = relations.filter((d) => d.type === 'relation' && d.config.reverseOf);

	const targets = new Set<string>();
	for (const row of rows)
		for (const def of forward) {
			const v = row.values[def.id];
			if (Array.isArray(v)) for (const id of v) targets.add(id);
		}
	if (targets.size) {
		const live = await liveIds(db, targets);
		for (const row of rows)
			for (const def of forward) {
				const v = row.values[def.id];
				if (!Array.isArray(v) || v.every((id) => live.has(id))) continue;
				const kept = v.filter((id) => live.has(id));
				row.values[def.id] = kept.length ? kept : null;
			}
	}

	for (const def of reverse) {
		if (def.type !== 'relation' || !def.config.reverseOf || (want && !want.has(def.id))) continue;
		const prop = registry.num(def.config.reverseOf);
		if (prop === undefined) continue;
		const byTarget = new Map<number, string[]>();
		for (const part of chunks(rows, MAX_PARAMS - 1)) {
			const found = await all<{ target: string; id: string }>(
				db,
				`SELECT r.v AS target, page.id AS id FROM p_ref r JOIN page ON page.num = r.page
				 WHERE r.prop = ? AND r.v IN (${qmarks(part.length)}) AND page.deleted_at IS NULL ORDER BY page.num`,
				prop,
				...part.map((r) => String(r.num))
			);
			for (const f of found) (byTarget.get(Number(f.target)) ?? byTarget.set(Number(f.target), []).get(Number(f.target))!).push(f.id);
		}
		for (const row of rows) {
			const ids = byTarget.get(row.num);
			if (ids?.length) row.values[def.id] = ids;
		}
	}
}
