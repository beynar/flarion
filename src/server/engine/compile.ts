/**
 * The filter compiler. A (normalized) filter AST becomes a plan: a tree of AND/OR groups whose leaves are
 * conditions, each bound to one indexed access path (a {@link Source}) and annotated with
 * - `posEst`: rows of the positive source, from the per-value counts (`selectivity`, `valueCountOf`) or a
 *   bounded index probe;
 * - `est`: the estimated number of pages the condition keeps (the complement for negative operators);
 * - `scanCost`: rows a full scan of the source reads, against which the executor weighs a probe.
 * Children of a group are ordered by `est`, smallest first, so an AND narrows its candidate set as early as
 * possible and later conditions are probed instead of scanned.
 */
import {
	type Condition,
	type FilterGroup,
	type FilterNode,
	type FilterValue,
	isGroup,
	normalizeFilter,
	resolveField
} from '../../lib/shared/filter-ast';
import { operandInterval, rangeInterval, type DateCtx, type DateOperand, type DateRangeOperand, type Interval } from '../../lib/shared/dates';
import type { FilterOp, PropertyDef } from '../../lib/shared/property-types';
import { foldText, textSortKey } from '../../lib/shared/sort-keys';
import type { WorkspaceDb } from '../db/workspace.client';
import { totalCountOf, valueCountOf, selectivity } from '../objects/workspace/eav/counts';
import { loadEavRegistry, type EavRegistry } from '../objects/workspace/eav/registry';
import { all } from '../objects/workspace/eav/sql';
import { chunks, qmarks } from '../objects/workspace/eav/sql';
import type { Ctx } from './context';
import { IN_CHUNK } from './context';
import { LIVE_TARGET_SQL } from './relations';
import { EXACT_NEEDLE_UNITS, eavSource, pageSource, type Frag, type Source, type Verify } from './sources';

export interface ConstNode {
	kind: 'const';
	value: boolean;
}
export interface LeafNode {
	kind: 'leaf';
	prop: string;
	op: FilterOp;
	value?: FilterValue;
	source: Source;
	/** The condition keeps the pages the source does NOT return (within the candidates). */
	negate: boolean;
	posEst: number;
	scanCost: number;
	est: number;
	/** A readable access path, for `explainQuery`. */
	path: string;
}
export interface GroupNode {
	kind: 'group';
	op: 'and' | 'or';
	children: PlanNode[];
	est: number;
}
export type PlanNode = ConstNode | LeafNode | GroupNode;

export interface CompileOptions {
	me?: string;
	now: number;
	weekStartsOn?: 0 | 1;
	/** Estimate selectivities from the counts (default). Off, leaves are always probed: for one-page checks. */
	estimate?: boolean;
}

const TRUE: ConstNode = { kind: 'const', value: true };
const FALSE: ConstNode = { kind: 'const', value: false };

export class CompileEnv {
	#bound: number | undefined;
	readonly dctx: DateCtx;
	readonly estimate: boolean;
	readonly me: string | undefined;

	constructor(
		readonly db: WorkspaceDb,
		readonly registry: EavRegistry,
		opts: CompileOptions
	) {
		this.dctx = { now: opts.now, weekStartsOn: opts.weekStartsOn ?? 1 };
		this.estimate = opts.estimate !== false;
		this.me = opts.me;
	}

	/** Upper bound of the number of pages (`page.num` is dense and never reused). */
	async bound(): Promise<number> {
		if (this.#bound === undefined) {
			const [r] = await all<{ m: number }>(this.db, 'SELECT COALESCE(MAX(num), 0) AS m FROM page');
			this.#bound = r?.m ?? 0;
		}
		return this.#bound;
	}

	/** Runs `fn` only when estimating; otherwise returns the fallback. */
	async est(fn: () => Promise<number>, fallback: number): Promise<number> {
		return this.estimate ? fn() : fallback;
	}
}

const NO_ESTIMATE = Number.POSITIVE_INFINITY;
const PROBE_CAP = 1000;

// ───────────────────────────── tree ─────────────────────────────

export async function compileFilter(env: CompileEnv, filter: FilterNode | null | undefined): Promise<PlanNode> {
	return compileNode(env, normalizeFilter(filter));
}

async function compileNode(env: CompileEnv, node: FilterNode): Promise<PlanNode> {
	if (!isGroup(node)) return compileCondition(env, node);
	const op = 'and' in node ? 'and' : 'or';
	const kids = 'and' in node ? node.and : node.or;
	const bound = await env.bound();
	const out: PlanNode[] = [];
	for (const k of kids) {
		const c = await compileNode(env, k);
		if (c.kind === 'const') {
			if (op === 'and' && !c.value) return FALSE;
			if (op === 'or' && c.value) return TRUE;
			continue;
		}
		out.push(c);
	}
	if (out.length === 0) return op === 'and' ? TRUE : FALSE;
	if (out.length === 1) return out[0];
	const est = (n: PlanNode): number => (n.kind === 'const' ? (n.value ? bound : 0) : n.est);
	if (env.estimate) out.sort((a, b) => est(a) - est(b));
	const total = op === 'and' ? Math.min(...out.map(est)) : Math.min(bound, out.reduce((s, n) => s + est(n), 0));
	return { kind: 'group', op, children: out, est: total };
}

// ───────────────────────────── leaves ─────────────────────────────

async function leaf(
	env: CompileEnv,
	c: Condition,
	source: Source,
	negate: boolean,
	posEst: number,
	scanCost: number,
	path: string
): Promise<LeafNode> {
	const bound = env.estimate ? await env.bound() : 0;
	return {
		kind: 'leaf',
		prop: c.prop,
		op: c.op,
		value: c.value,
		source,
		negate,
		posEst,
		scanCost,
		est: negate ? Math.max(0, bound - posEst) : posEst,
		path
	};
}

export async function compileCondition(env: CompileEnv, c: Condition): Promise<PlanNode> {
	const field = resolveField(env.registry, c.prop);
	if (!field) return FALSE;
	const kind = field.ops[c.op];
	if (kind === undefined) return FALSE;
	switch (field.valueClass) {
		case 'text':
			return textLeaf(env, c, field.def as PropertyDef);
		case 'number':
			return numberLeaf(env, c, field.def as PropertyDef);
		case 'boolean':
			return booleanLeaf(env, c, field.def as PropertyDef);
		case 'date':
			return dateLeaf(env, c, field.def as PropertyDef);
		case 'refs':
			return refsLeaf(env, c, field.def);
	}
}

const eavProp = (env: CompileEnv, c: Condition): number | undefined => env.registry.num(c.prop);

/** Rows of the property, any value: the positive side of is empty / is not empty. */
async function presenceLeaf(
	env: CompileEnv,
	c: Condition,
	table: 'p_text' | 'p_num' | 'p_date' | 'p_ref',
	prop: number,
	frag: Frag | null = null
): Promise<LeafNode> {
	const total = await env.est(() => totalCountOf(env.db, prop), NO_ESTIMATE);
	return leaf(env, c, eavSource(table, prop, frag), c.op === 'is_empty', total, total, `${table} prop=${prop} (rows)`);
}

// ───────────────────────────── text ─────────────────────────────

/** The smallest string above every string starting with `prefix` (code point order). */
export function prefixUpper(prefix: string): string | null {
	const cps = Array.from(prefix);
	while (cps.length) {
		const last = cps.pop() as string;
		let cp = (last.codePointAt(0) as number) + 1;
		if (cp > 0x10ffff) continue;
		if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xe000;
		return cps.join('') + String.fromCodePoint(cp);
	}
	return null;
}

async function textLeaf(env: CompileEnv, c: Condition, def: PropertyDef): Promise<PlanNode> {
	const prop = eavProp(env, c);
	if (prop === undefined) return FALSE;
	if (c.op === 'is_empty' || c.op === 'is_not_empty') return presenceLeaf(env, c, 'p_text', prop);
	if (typeof c.value !== 'string') return FALSE;
	const needle = foldText(c.value);
	if (needle === '') {
		switch (c.op) {
			case 'contains':
			case 'starts_with':
			case 'ends_with':
				return TRUE;
			case 'not_contains':
				return FALSE;
			case 'is':
			case 'is_not': {
				// An empty needle equals every empty value: the pages with no row (or a row cut to nothing).
				const total = await env.est(() => totalCountOf(env.db, prop), NO_ESTIMATE);
				return leaf(env, c, eavSource('p_text', prop, { sql: "v <> ''", params: [] }), c.op === 'is', total, total, `p_text prop=${prop} v<>''`);
			}
			default:
				return FALSE;
		}
	}
	const test = (h: string): boolean => {
		switch (c.op) {
			case 'contains':
			case 'not_contains':
				return h.includes(needle);
			case 'is':
			case 'is_not':
				return h === needle;
			case 'starts_with':
				return h.startsWith(needle);
			default:
				return h.endsWith(needle);
		}
	};
	const negate = c.op === 'not_contains' || c.op === 'is_not';
	const exactSql = needle.length <= EXACT_NEEDLE_UNITS;
	let frag: Frag;
	let verify: Verify | undefined;
	let posOp: FilterOp;
	let seek: boolean;
	switch (c.op) {
		case 'contains':
		case 'not_contains':
			frag = { sql: 'instr(v, ?) > 0', params: [needle] };
			verify = { propId: c.prop, test, orLong: true };
			posOp = 'contains';
			seek = false;
			break;
		case 'ends_with':
			frag = { sql: 'substr(v, -?) = ?', params: [Array.from(needle).length, needle] };
			verify = { propId: c.prop, test, orLong: true };
			posOp = 'ends_with';
			seek = false;
			break;
		case 'is':
		case 'is_not':
			frag = { sql: 'v = ?', params: [textSortKey(c.value)] };
			if (!exactSql) verify = { propId: c.prop, test, orLong: false };
			posOp = 'is';
			seek = true;
			break;
		default: {
			// starts_with: a range over the folded keys.
			const k = textSortKey(c.value);
			const upper = prefixUpper(k);
			frag = upper === null ? { sql: 'v >= ?', params: [k] } : { sql: 'v >= ? AND v < ?', params: [k, upper] };
			if (!exactSql) verify = { propId: c.prop, test, orLong: false };
			posOp = 'starts_with';
			seek = true;
		}
	}
	const total = await env.est(() => totalCountOf(env.db, prop), NO_ESTIMATE);
	const posEst = await env.est(() => selectivity(env.db, c.prop, posOp, c.value), NO_ESTIMATE);
	void def;
	return leaf(env, c, eavSource('p_text', prop, frag, verify), negate, posEst, seek ? posEst : total, `p_text prop=${prop} ${c.op}`);
}

// ───────────────────────────── numbers and checkboxes ─────────────────────────────

/** Rows read by a bounded probe of a range (capped), or a share of the property when the cap is hit. */
async function probeRows(env: CompileEnv, table: string, prop: number, frag: Frag): Promise<number> {
	const [r] = await all<{ n: number }>(
		env.db,
		`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE prop = ? AND (${frag.sql}) LIMIT ${PROBE_CAP})`,
		prop,
		...frag.params
	);
	const n = r?.n ?? 0;
	return n < PROBE_CAP ? n : Math.max(PROBE_CAP, Math.ceil((await totalCountOf(env.db, prop)) / 3));
}

async function numberLeaf(env: CompileEnv, c: Condition, def: PropertyDef): Promise<PlanNode> {
	const prop = eavProp(env, c);
	if (prop === undefined) return FALSE;
	void def;
	if (c.op === 'is_empty' || c.op === 'is_not_empty') return presenceLeaf(env, c, 'p_num', prop);
	if (typeof c.value !== 'number' || !Number.isFinite(c.value)) return FALSE;
	const n = c.value === 0 ? 0 : c.value;
	const sqlOp: Record<string, string> = { eq: '=', neq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
	const frag: Frag = { sql: `v ${sqlOp[c.op]} ?`, params: [n] };
	const equality = c.op === 'eq' || c.op === 'neq';
	const posEst = await env.est(() => (equality ? valueCountOf(env.db, prop, n) : probeRows(env, 'p_num', prop, frag)), NO_ESTIMATE);
	return leaf(env, c, eavSource('p_num', prop, frag), c.op === 'neq', posEst, posEst, `p_num prop=${prop} ${c.op}`);
}

async function booleanLeaf(env: CompileEnv, c: Condition, def: PropertyDef): Promise<PlanNode> {
	const prop = eavProp(env, c);
	if (prop === undefined) return FALSE;
	void def;
	if (typeof c.value !== 'boolean') return FALSE;
	// `is checked` is a row of 1; `is unchecked` is everything else, a missing row included.
	const posEst = await env.est(() => valueCountOf(env.db, prop, 1), NO_ESTIMATE);
	return leaf(env, c, eavSource('p_num', prop, { sql: 'v = 1', params: [] }), c.value === false, posEst, posEst, `p_num prop=${prop} v=1`);
}

// ───────────────────────────── dates ─────────────────────────────

const DAY_MS_SQL = 86_400_000;
/** End of the stored interval: a date-only value covers its day, a timed one a millisecond (see `dateValueInterval`). */
const END_DATE_ONLY = `(COALESCE(v_end, v) + CASE WHEN CAST(COALESCE(v_end, v) AS INTEGER) % ${DAY_MS_SQL} = 0 THEN ${DAY_MS_SQL} ELSE 1 END)`;
const END_TIMED = '(COALESCE(v_end, v) + 1)';

/** The SQL predicate of a date operator over `p_date` rows; `[os, oe)` is the operand's interval. */
function dateFrag(op: FilterOp, o: Interval, includeTime: boolean): Frag | null {
	const end = includeTime ? END_TIMED : END_DATE_ONLY;
	switch (op) {
		case 'is':
		case 'within':
			return { sql: `v < ? AND ${end} > ?`, params: [o.end, o.start] };
		case 'before':
			// The end is at least v + 1, so `v < os` is implied: it lets the index bound the scan.
			return { sql: `v < ? AND ${end} <= ?`, params: [o.start, o.start] };
		case 'after':
			return { sql: 'v >= ?', params: [o.end] };
		case 'on_or_before':
			return { sql: 'v < ?', params: [o.end] };
		case 'on_or_after':
			return { sql: `${end} > ?`, params: [o.start] };
		default:
			return null;
	}
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The predicate over a `page` timestamp column (ISO text, a one-millisecond instant). */
function pageDateFrag(col: string, op: FilterOp, o: Interval): Frag | null {
	switch (op) {
		case 'is':
		case 'within':
			return { sql: `${col} >= ? AND ${col} < ?`, params: [iso(o.start), iso(o.end)] };
		case 'before':
			return { sql: `${col} < ?`, params: [iso(o.start)] };
		case 'after':
			return { sql: `${col} >= ?`, params: [iso(o.end)] };
		case 'on_or_before':
			return { sql: `${col} < ?`, params: [iso(o.end)] };
		case 'on_or_after':
			return { sql: `${col} >= ?`, params: [iso(o.start)] };
		default:
			return null;
	}
}

async function dateLeaf(env: CompileEnv, c: Condition, def: PropertyDef): Promise<PlanNode> {
	const pageDerived = def.type === 'created_time' || def.type === 'last_edited_time';
	const prop = eavProp(env, c);
	if (!pageDerived && prop === undefined) return FALSE;
	if (c.op === 'is_empty' || c.op === 'is_not_empty') {
		// Page timestamps are always set.
		if (pageDerived) return c.op === 'is_not_empty' ? TRUE : FALSE;
		return presenceLeaf(env, c, 'p_date', prop as number);
	}
	if (c.value === undefined || typeof c.value !== 'object') return FALSE;
	const o: Interval | null =
		c.op === 'within' ? rangeInterval(c.value as DateRangeOperand, env.dctx) : operandInterval(c.value as DateOperand, env.dctx);
	if (o === null) return FALSE;
	if (pageDerived) {
		const col = def.type === 'created_time' ? 'created_at' : 'COALESCE(updated_at, created_at)';
		const frag = pageDateFrag(col, c.op, o) as Frag;
		const bound = await env.est(() => env.bound(), NO_ESTIMATE);
		return leaf(env, c, pageSource(frag), false, bound === NO_ESTIMATE ? bound : Math.ceil(bound / 3), bound, `page ${col} ${c.op}`);
	}
	const includeTime = def.type === 'date' && def.config.includeTime === true;
	const frag = dateFrag(c.op, o, includeTime);
	if (!frag) return FALSE;
	const posEst = await env.est(() => probeRows(env, 'p_date', prop as number, frag), NO_ESTIMATE);
	return leaf(env, c, eavSource('p_date', prop as number, frag), false, posEst, posEst, `p_date prop=${prop} ${c.op}`);
}

// ───────────────────────────── references ─────────────────────────────

async function refsLeaf(env: CompileEnv, c: Condition, def: PropertyDef | undefined): Promise<PlanNode> {
	const type = def?.type;
	// System and page-derived fields read a `page` column.
	let col: string | null = null;
	let indexed = false;
	if (c.prop === '$parent') [col, indexed] = ['parent_id', true];
	else if (c.prop === '$teamspace') [col, indexed] = ['teamspace_id', true];
	else if (type === 'created_by') col = 'created_by';
	else if (type === 'last_edited_by') col = 'COALESCE(updated_by, created_by)';

	if (c.op === 'is_empty' || c.op === 'is_not_empty') {
		if (col) {
			const frag: Frag =
				c.op === 'is_empty' ? { sql: `(${col} IS NULL OR ${col} = '')`, params: [] } : { sql: `(${col} IS NOT NULL AND ${col} <> '')`, params: [] };
			const bound = await env.est(() => env.bound(), NO_ESTIMATE);
			return leaf(env, c, pageSource(frag), false, bound === NO_ESTIMATE ? bound : Math.ceil(bound / 2), bound, `page ${col} ${c.op}`);
		}
		if (def?.type === 'relation' && def.config.reverseOf) return reverseLeaf(env, c, def.config.reverseOf, null);
		const prop = eavProp(env, c);
		if (prop === undefined) return FALSE;
		// A relation to a tombstone reads as gone: only rows pointing at a live page count as a value.
		return presenceLeaf(env, c, 'p_ref', prop, def?.type === 'relation' ? { sql: LIVE_TARGET_SQL, params: [] } : null);
	}

	let target: string;
	let negate: boolean;
	if (c.op === 'is_me' || c.op === 'is_not_me') {
		negate = c.op === 'is_not_me';
		if (env.me === undefined) return negate ? TRUE : FALSE;
		target = env.me;
	} else {
		if (typeof c.value !== 'string') return FALSE;
		target = c.value;
		negate = c.op === 'is_not' || c.op === 'not_contains';
	}

	if (col) {
		const frag: Frag = { sql: `${col} = ?`, params: [target] };
		const bound = await env.est(() => env.bound(), NO_ESTIMATE);
		let posEst = bound === NO_ESTIMATE ? bound : Math.ceil(bound / 4);
		if (indexed && env.estimate) {
			const [r] = await all<{ n: number }>(env.db, `SELECT COUNT(*) AS n FROM page WHERE ${col} = ?`, target);
			posEst = r?.n ?? 0;
		}
		return leaf(env, c, pageSource(frag), negate, posEst, indexed ? posEst : bound, `page ${col} = ?`);
	}

	if (def?.type === 'relation' && def.config.reverseOf) {
		const [holder] = await all<{ num: number }>(env.db, 'SELECT num FROM page WHERE id = ? AND deleted_at IS NULL', target);
		if (!holder) return negate ? TRUE : FALSE;
		return reverseLeaf(env, c, def.config.reverseOf, holder.num);
	}
	const prop = eavProp(env, c);
	if (prop === undefined || !def) return FALSE;
	let v = target;
	if (def.type === 'relation') {
		// Relation targets are stored as the target's `page.num`; a tombstoned target is no target.
		const [row] = await all<{ num: number }>(env.db, 'SELECT num FROM page WHERE id = ? AND deleted_at IS NULL', target);
		if (!row) return negate ? TRUE : FALSE;
		v = String(row.num);
	}
	const posEst = await env.est(() => valueCountOf(env.db, prop, v), NO_ESTIMATE);
	return leaf(env, c, eavSource('p_ref', prop, { sql: 'v = ?', params: [v] }), negate, posEst, posEst, `p_ref prop=${prop} v=${v}`);
}

// ───────────────────────────── reverse relations ─────────────────────────────

/**
 * The reverse side of a two-way relation: page T is related to X when X's relation points at T. A range scan of
 * `p_ref` on `(prop, v)` (or on `page` for one holder X); the holder must be live, the executor restricts T.
 * `holder === null`: any holder (the presence of the property).
 */
function reverseSource(prop: number, holder: number | null): Source {
	const live = 'EXISTS (SELECT 1 FROM page WHERE page.num = p_ref.page AND page.deleted_at IS NULL)';
	const where = holder === null ? `prop = ? AND ${live}` : 'prop = ? AND page = ?';
	const base = holder === null ? [prop] : [prop, holder];
	return {
		async scan(ctx: Ctx) {
			ctx.counters.scans++;
			const rows = await ctx.q<{ v: string }>(`SELECT DISTINCT v FROM p_ref WHERE ${where}`, ...base);
			return rows.map((r) => Number(r.v));
		},
		async probe(ctx: Ctx, nums: readonly number[]) {
			const out = new Set<number>();
			for (const part of chunks(nums, IN_CHUNK)) {
				ctx.counters.probes++;
				const rows = await ctx.q<{ v: string }>(`SELECT DISTINCT v FROM p_ref WHERE ${where} AND v IN (${qmarks(part.length)})`, ...base, ...part.map(String));
				for (const r of rows) out.add(Number(r.v));
			}
			return [...out];
		}
	};
}

async function reverseLeaf(env: CompileEnv, c: Condition, relationId: string, holder: number | null): Promise<PlanNode> {
	const prop = env.registry.num(relationId);
	if (prop === undefined) return FALSE;
	const negate = c.op === 'is_empty' || c.op === 'not_contains';
	const posEst = await env.est(() => (holder === null ? totalCountOf(env.db, prop) : probeRows(env, 'p_ref', prop, { sql: 'page = ?', params: [holder] })), NO_ESTIMATE);
	return leaf(env, c, reverseSource(prop, holder), negate, posEst, posEst, `p_ref prop=${prop} reverse${holder === null ? '' : ` page=${holder}`}`);
}

// ───────────────────────────── helpers ─────────────────────────────

export async function makeEnv(db: WorkspaceDb, opts: CompileOptions): Promise<CompileEnv> {
	return new CompileEnv(db, await loadEavRegistry(db), opts);
}

export type { FilterGroup };
