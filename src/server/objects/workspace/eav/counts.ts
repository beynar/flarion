/**
 * Per-value counts for the query planner (`value_count(prop, v, n)`).
 *
 * Design
 * - One row per (property, distinct value) with the number of EAV rows holding it, kept on every EAV
 *   write in the same transaction (`CountDelta`), so it is exact for the rows in the EAV tables. Rows of
 *   trashed pages stay in the EAV tables (restore is lossless), so they stay counted: counts are an upper
 *   bound of the live matches, which is all an ordering heuristic needs.
 * - `v` is `String(eavValue)` (numbers, dates as epoch ms and relation targets share one TEXT column).
 *   The reserved key {@link TOTAL_KEY} (`''`) is the property's total row count; no EAV value is ever `''`.
 * - `p_text` has only the total: folded text is near-unique, so per-value rows would double every title
 *   write for nothing. `selectivity()` probes the index for those (bounded) instead.
 */
import { textSortKey } from '../../../../lib/shared/sort-keys';
import {
	storageTable,
	type EavTable,
	type FilterOp,
	type PropertyDef
} from '../../../../lib/shared/property-types';
import type { WorkspaceDb } from '../../../db/workspace.client';
import { loadEavRegistry } from './registry';
import { MAX_PARAMS, all, chunks, qmarks, run } from './sql';

export const TOTAL_KEY = '';

/** Tables whose values are counted one by one. */
export const COUNTED_TABLES: ReadonlySet<EavTable> = new Set(['p_num', 'p_date', 'p_ref']);

/** Accumulates +/- row counts during one write, then applies them with one upsert per chunk. */
export class CountDelta {
	readonly #deltas = new Map<number, Map<string, number>>();

	add(prop: number, table: EavTable, v: string | number, d: number): void {
		this.#bump(prop, TOTAL_KEY, d);
		if (COUNTED_TABLES.has(table)) this.#bump(prop, String(v), d);
	}

	#bump(prop: number, key: string, d: number): void {
		const m = this.#deltas.get(prop) ?? this.#deltas.set(prop, new Map()).get(prop)!;
		m.set(key, (m.get(key) ?? 0) + d);
	}

	get empty(): boolean {
		return this.#deltas.size === 0;
	}

	async flush(db: WorkspaceDb): Promise<void> {
		const ups: [number, string, number][] = [];
		for (const [prop, m] of this.#deltas)
			for (const [key, d] of m) {
				if (d === 0) continue;
				ups.push([prop, key, d]);
			}
		// One upsert per chunk that reports the counts it left: the rows that fell to zero or below are deleted by a second statement, which
		// most writes (a value moves to a value that already has rows) never need.
		const gone: [number, string][] = [];
		for (const part of chunks(ups, Math.floor(MAX_PARAMS / 3))) {
			const left = await all<{ prop: number; v: string; n: number }>(
				db,
				`INSERT INTO value_count (prop, v, n) VALUES ${part.map(() => '(?,?,?)').join(',')} ` +
					'ON CONFLICT (prop, v) DO UPDATE SET n = n + excluded.n RETURNING prop, v, n',
				...part.flat()
			);
			for (const row of left) if (row.n <= 0) gone.push([row.prop, row.v]);
		}
		const downs = new Map<number, string[]>();
		for (const [prop, key] of gone) (downs.get(prop) ?? downs.set(prop, []).get(prop)!).push(key);
		for (const [prop, keys] of downs)
			for (const part of chunks(keys, MAX_PARAMS - 1))
				await run(db, `DELETE FROM value_count WHERE prop = ? AND n <= 0 AND v IN (${qmarks(part.length)})`, prop, ...part);
		this.#deltas.clear();
	}
}

/** Rows of `prop` holding exactly `v` (`String(value)`), or `0`. */
export async function valueCountOf(db: WorkspaceDb, prop: number, v: string | number): Promise<number> {
	const [row] = await all<{ n: number }>(db, 'SELECT n FROM value_count WHERE prop = ? AND v = ?', prop, String(v));
	return row?.n ?? 0;
}

/** Total EAV rows of `prop` (one per page for single values, one per member for multi-values). */
export const totalCountOf = (db: WorkspaceDb, prop: number): Promise<number> => valueCountOf(db, prop, TOTAL_KEY);

const PROBE_CAP = 1000;

async function probe(db: WorkspaceDb, sql: string, ...params: unknown[]): Promise<number> {
	const [row] = await all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM (${sql} LIMIT ${PROBE_CAP})`, ...params);
	return row?.n ?? 0;
}

/** Upper bound of the number of pages (`page.num` is dense and never reused). */
async function pageBound(db: WorkspaceDb): Promise<number> {
	const [row] = await all<{ m: number }>(db, 'SELECT COALESCE(MAX(num), 0) AS m FROM page');
	return row?.m ?? 0;
}

const isRange = (op: FilterOp) =>
	op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte' || op === 'before' || op === 'after' || op === 'on_or_before' || op === 'on_or_after' || op === 'within';

/**
 * Estimated number of pages matching `op value` on a property, for the planner's selectivity ordering
 * (smaller first). Exact for equality on counted values, an index probe capped at 1000 for text
 * equality and prefix, a fraction of the total otherwise. `value` is the filter operand: a string
 * (option id, user id, page id of a relation target, text), number, boolean, or a date operand (ranges and
 * relative dates fall back to the heuristic). Unknown properties estimate as the whole workspace.
 */
export async function selectivity(
	db: WorkspaceDb,
	propId: string,
	op: FilterOp,
	value?: unknown
): Promise<number> {
	const registry = await loadEavRegistry(db);
	const def: PropertyDef | undefined = registry.get(propId);
	const num = registry.num(propId);
	if (!def || num === undefined) return pageBound(db);
	const table = storageTable(def);
	if (table === 'page') return pageBound(db);

	const total = await totalCountOf(db, num);
	if (op === 'is_not_empty') return total;
	const bound = await pageBound(db);
	if (op === 'is_empty') return Math.max(0, bound - total);

	const exact = async (): Promise<number | undefined> => {
		if (value === undefined || value === null) return undefined;
		switch (table) {
			case 'p_text': {
				if (typeof value !== 'string') return undefined;
				if (op === 'starts_with') {
					const k = textSortKey(value);
					return probe(db, 'SELECT 1 FROM p_text WHERE prop = ? AND v >= ? AND v < ?', num, k, k + '￿');
				}
				if (op === 'is' || op === 'is_not')
					return probe(db, 'SELECT 1 FROM p_text WHERE prop = ? AND v = ?', num, textSortKey(value));
				return undefined;
			}
			case 'p_num':
				if (typeof value === 'boolean') return valueCountOf(db, num, value ? 1 : 0);
				return typeof value === 'number' ? valueCountOf(db, num, value) : undefined;
			case 'p_date':
				return undefined;
			case 'p_ref': {
				if (typeof value !== 'string') return undefined;
				if (def.type === 'relation') {
					const [t] = await all<{ num: number }>(db, 'SELECT num FROM page WHERE id = ?', value);
					return t ? valueCountOf(db, num, t.num) : 0;
				}
				return valueCountOf(db, num, value);
			}
		}
	};

	switch (op) {
		case 'is':
		case 'eq':
		case 'contains':
		case 'starts_with': {
			const n = await exact();
			if (n !== undefined) return n;
			return Math.ceil(total / (op === 'contains' && table === 'p_text' ? 3 : 10));
		}
		case 'is_not':
		case 'neq':
		case 'not_contains': {
			const n = await exact();
			return Math.max(0, bound - (n ?? 0));
		}
		default:
			if (isRange(op)) return Math.ceil(total / 3);
			return Math.ceil(total / 2);
	}
}
