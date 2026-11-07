/**
 * Sorting and windows. Order is the sort specs in turn (empty values last, or first with `nulls`), then
 * the page's rank, then its id: a total order, so a window is well defined.
 *
 * Two strategies, chosen from the number of pages to order (`n`) and the window end (`w = offset + limit`):
 * - walk: when the first sort key lives in one clustered index (`p_text`, `p_num`, `p_date`), read that
 *   property's index in order (keyset batches over `(v, page)`), keep the pages in the result set, and stop
 *   once `w` of them are collected and the tie group is complete. Ties are then broken in memory.
 * - heap: otherwise load the sort columns of every page in the result set and keep the best `w` with a
 *   bounded heap (a full sort when `w >= n`).
 * Select, status and multi-select sort by option order, not by option id, so they take the heap path.
 */
import type { SortSpec } from '../../lib/shared/filter-ast';
import { parseIsoDate } from '../../lib/shared/dates';
import type { PropertyDef } from '../../lib/shared/property-types';
import { compareOptionalKeys, compareText, type SortKey } from '../../lib/shared/sort-keys';
import { totalCountOf } from '../objects/workspace/eav/counts';
import type { EavRegistry } from '../objects/workspace/eav/registry';
import type { Ctx } from './context';
import type { RowRef, SortTuple, Window } from './types';

export type EavSortTable = 'p_text' | 'p_num' | 'p_date';

export interface SortCol {
	spec: SortSpec;
	load(ctx: Ctx, nums: readonly number[]): Promise<Map<number, SortKey>>;
	/** The index that serves this key in order, when there is one. */
	walk: { table: EavSortTable; prop: number } | null;
}

const NONE = async (): Promise<Map<number, SortKey>> => new Map();

function eavValues(table: EavSortTable, prop: number): SortCol['load'] {
	return async (ctx, nums) => {
		const rows = await ctx.byNums<{ page: number; v: string | number }>(nums, { select: 'page, v', from: table, numCol: 'page', where: 'prop = ?', params: [prop] });
		return new Map(rows.map((r) => [r.page, r.v]));
	};
}

/** Option order: select and status sort by the option's position, unknown options after all others. */
function optionIndex(prop: number, options: readonly { id: string }[], multi: boolean): SortCol['load'] {
	const order = new Map(options.map((o, i) => [o.id, i]));
	return async (ctx, nums) => {
		const rows = await ctx.byNums<{ page: number; v: string }>(nums, { select: 'page, v', from: 'p_ref', numCol: 'page', where: 'prop = ?', params: [prop] });
		const out = new Map<number, number>();
		for (const r of rows) {
			const i = order.get(r.v) ?? options.length;
			const prev = out.get(r.page);
			if (prev === undefined || (multi && i < prev)) out.set(r.page, i);
		}
		return out;
	};
}

function pageTime(expr: string): SortCol['load'] {
	return async (ctx, nums) => {
		const rows = await ctx.byNums<{ num: number; t: string | null }>(nums, { select: `num, ${expr} AS t`, from: 'page', numCol: 'num' });
		const out = new Map<number, number>();
		for (const r of rows) {
			const p = r.t ? parseIsoDate(r.t) : null;
			if (p) out.set(r.num, p.ms);
		}
		return out;
	};
}

function columnOf(registry: EavRegistry, spec: SortSpec): SortCol {
	const def: PropertyDef | undefined = registry.get(spec.prop);
	const prop = registry.num(spec.prop);
	const none: SortCol = { spec, load: NONE, walk: null };
	if (!def || prop === undefined) return none;
	const eav = (table: EavSortTable): SortCol => ({ spec, load: eavValues(table, prop), walk: { table, prop } });
	switch (def.type) {
		case 'title':
		case 'text':
		case 'url':
		case 'email':
		case 'phone':
		case 'ai':
			return eav('p_text');
		case 'number':
		case 'unique_id':
		case 'checkbox':
			return eav('p_num');
		case 'date':
			return eav('p_date');
		case 'formula':
		case 'rollup':
			return eav(def.config.resultType === 'text' ? 'p_text' : def.config.resultType === 'date' ? 'p_date' : 'p_num');
		case 'select':
		case 'status':
			return { spec, load: optionIndex(prop, def.config.options, false), walk: null };
		case 'multi_select':
			return { spec, load: optionIndex(prop, def.config.options, true), walk: null };
		case 'created_time':
			return { spec, load: pageTime('created_at'), walk: null };
		case 'last_edited_time':
			return { spec, load: pageTime('COALESCE(updated_at, created_at)'), walk: null };
		default:
			return none;
	}
}

export const compileSorts = (registry: EavRegistry, sorts: readonly SortSpec[] | undefined): SortCol[] => (sorts ?? []).map((s) => columnOf(registry, s));

export function tupleComparator(sorts: readonly SortSpec[]): (a: SortTuple, b: SortTuple) => number {
	return (a, b) => {
		for (let i = 0; i < sorts.length; i++) {
			const s = sorts[i];
			const c = compareOptionalKeys(a.keys[i], b.keys[i], s.dir, s.nulls ?? 'last');
			if (c !== 0) return c;
		}
		return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : compareText(a.id, b.id);
	};
}

/** The sort tuples (keys, rank, id) of `nums`, for the given columns. */
export async function loadTuples(ctx: Ctx, nums: readonly number[], cols: readonly SortCol[]): Promise<SortTuple[]> {
	if (nums.length === 0) return [];
	const meta = await ctx.byNums<{ num: number; id: string; rank: string }>(nums, { select: 'num, id, rank', from: 'page', numCol: 'num' });
	const byNum = new Map(meta.map((m) => [m.num, m]));
	const keyMaps: Map<number, SortKey>[] = [];
	for (const col of cols) keyMaps.push(await col.load(ctx, nums));
	const out: SortTuple[] = [];
	for (const n of nums) {
		const m = byNum.get(n);
		if (!m) continue;
		out.push({ num: n, id: m.id, rank: ctx.rankOverride?.get(n) ?? m.rank, keys: keyMaps.map((km) => km.get(n) ?? null) });
	}
	return out;
}

/** The `k` smallest items under `cmp`, ascending, in O(n log k) with a bounded max-heap. */
export function selectTop<T>(items: readonly T[], k: number, cmp: (a: T, b: T) => number): T[] {
	if (k >= items.length) return [...items].sort(cmp);
	if (k <= 0) return [];
	const heap: T[] = [];
	const up = (i: number): void => {
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (cmp(heap[i], heap[p]) <= 0) break;
			[heap[i], heap[p]] = [heap[p], heap[i]];
			i = p;
		}
	};
	const down = (i: number): void => {
		for (;;) {
			const l = 2 * i + 1;
			const r = l + 1;
			let m = i;
			if (l < heap.length && cmp(heap[l], heap[m]) > 0) m = l;
			if (r < heap.length && cmp(heap[r], heap[m]) > 0) m = r;
			if (m === i) return;
			[heap[i], heap[m]] = [heap[m], heap[i]];
			i = m;
		}
	};
	for (const item of items) {
		if (heap.length < k) {
			heap.push(item);
			up(heap.length - 1);
		} else if (cmp(item, heap[0]) < 0) {
			heap[0] = item;
			down(0);
		}
	}
	return heap.sort(cmp);
}

export type SortStrategy = 'none' | 'walk' | 'heap' | 'sort';

const WALK_BATCH_MIN = 200;
const WALK_BATCH_MAX = 2000;

interface WalkInput {
	ctx: Ctx;
	set: ReadonlySet<number>;
	cols: readonly SortCol[];
	first: SortCol & { walk: NonNullable<SortCol['walk']> };
	w: number;
}

/** The pages of `set` in order up to (at least) `w` of them, walking the first key's index. Ties unordered. */
async function walkGroups({ ctx, set, first, w }: WalkInput): Promise<number[][]> {
	const { table, prop } = first.walk;
	const asc = first.spec.dir === 'asc';
	const nullsFirst = (first.spec.nulls ?? 'last') === 'first';
	const groups: number[][] = [];
	let count = 0;
	const push = (g: number[]): void => {
		if (g.length === 0) return;
		groups.push(g);
		count += g.length;
	};

	const seen = new Set<number>();
	const nullGroup = async (): Promise<number[]> => {
		// Pages with no row for the key: the ones the index walk never meets. Computed by probing or scanning.
		if (nullsFirst) {
			const total = await totalCountOf(ctx.db, prop);
			let has: Set<number>;
			if (set.size * 2 <= total) {
				ctx.counters.probes++;
				const rows = await ctx.byNums<{ page: number }>([...set], { select: 'page', from: table, numCol: 'page', where: 'prop = ?', params: [prop] });
				has = new Set(rows.map((r) => r.page));
			} else {
				ctx.counters.scans++;
				has = new Set((await ctx.q<{ page: number }>(`SELECT page FROM ${table} WHERE prop = ?`, prop)).map((r) => r.page));
			}
			return [...set].filter((n) => !has.has(n));
		}
		return [...set].filter((n) => !seen.has(n));
	};

	if (nullsFirst) push(await nullGroup());
	const batch = Math.min(WALK_BATCH_MAX, Math.max(WALK_BATCH_MIN, w * 2));
	const [dir, op] = asc ? ['ASC', '>'] : ['DESC', '<'];
	let cursor: [string | number, number] | null = null;
	let current: number[] = [];
	let currentV: string | number | undefined;
	let exhausted = false;
	while (count < w) {
		ctx.counters.scans++;
		const rows: { v: string | number; page: number }[] = await ctx.q(
			`SELECT v, page FROM ${table} WHERE prop = ?${cursor ? ` AND (v, page) ${op} (?, ?)` : ''} ORDER BY v ${dir}, page ${dir} LIMIT ${batch}`,
			prop,
			...(cursor ?? [])
		);
		for (const r of rows) {
			if (!set.has(r.page)) continue;
			seen.add(r.page);
			if (currentV !== undefined && r.v !== currentV) {
				push(current);
				current = [];
			}
			currentV = r.v;
			current.push(r.page);
		}
		if (rows.length < batch) {
			exhausted = true;
			break;
		}
		const last = rows[rows.length - 1];
		cursor = [last.v, last.page];
	}
	// A group is complete once the walk moved past its value or ran out of rows; the last one is only
	// needed when the rows ran out before `w` pages were collected.
	if (exhausted) {
		push(current);
		if (!nullsFirst && count < w) push(await nullGroup());
	}
	return groups;
}

export interface WindowResult {
	rows: RowRef[];
	strategy: SortStrategy;
}

/** The window of `set` under the sort columns, plus the strategy used. */
export async function sortWindow(ctx: Ctx, set: ReadonlySet<number>, cols: readonly SortCol[], win: Window): Promise<WindowResult> {
	const n = set.size;
	const offset = win.offset ?? 0;
	const limit = win.limit ?? Number.POSITIVE_INFINITY;
	if (n === 0 || limit <= 0) return { rows: [], strategy: 'none' };
	const w = offset + limit;
	const specs = cols.map((c) => c.spec);
	const cmp = tupleComparator(specs);

	const first = cols[0];
	if (first?.walk && Number.isFinite(w) && w < n && n > 64) {
		const total = await totalCountOf(ctx.db, first.walk.prop);
		const density = n / Math.max(1, await ctx.bound());
		if (Math.min(total, w / Math.max(density, 1e-9)) < n) {
			const groups = await walkGroups({ ctx, set, cols, first: first as WalkInput['first'], w });
			const members = groups.flat();
			const tuples = new Map((await loadTuples(ctx, members, cols.slice(1))).map((t) => [t.num, t]));
			const restCmp = tupleComparator(specs.slice(1));
			const ordered: number[] = [];
			for (const g of groups) {
				const items = g.map((x) => tuples.get(x)).filter((t): t is SortTuple => t !== undefined);
				if (items.length > 1) items.sort(restCmp);
				for (const t of items) ordered.push(t.num);
			}
			const slice = ordered.slice(offset, offset + (Number.isFinite(limit) ? limit : ordered.length));
			return { rows: slice.map((num) => ({ num, id: (tuples.get(num) as SortTuple).id })), strategy: 'walk' };
		}
	}

	const tuples = await loadTuples(ctx, [...set], cols);
	const top = selectTop(tuples, w, cmp);
	const slice = top.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
	return { rows: slice.map((t) => ({ num: t.num, id: t.id })), strategy: w < tuples.length ? 'heap' : 'sort' };
}
