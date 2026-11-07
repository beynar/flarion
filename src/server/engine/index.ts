/**
 * The database query engine (docs/PLAN.md "Databases / Query pipeline").
 *
 *   compileQuery(db, spec, opts)      the plan: conditions ordered by selectivity, each on one indexed path
 *   runQuery(db, spec, opts)          one-shot: window, total, groups, referenced properties
 *   explainQuery(db, spec, opts)      the plan as a readable tree (the chosen order), for debugging
 *   matchesFilter(db, filter, num)    does one page satisfy a filter (P3's live loop)
 *   sortKeyOf(db, sorts, nums, opts)  the sort tuples of pages, with `compareSortTuples` (P3's live loop)
 *
 * The engine runs raw SQL, which bypasses viborm's permissions: every result is intersected with
 * `opts.visible` (the actor's visibility set), the collection's membership and the live (non-tombstoned)
 * pages. Run against the same data it returns what the naive evaluators of `filter-ast.ts`
 * (`queryRows`, `groupRows`) return; `tests/workers/engine` checks that on random workspaces.
 */
import {
	isGroup,
	referencedProps,
	type FilterGroup,
	type FilterNode,
	type GroupBySpec,
	type QuerySpec,
	type SortSpec
} from '../../lib/shared/filter-ast';
import type { WorkspaceDb } from '../db/workspace.client';
import { loadEavRegistry } from '../objects/workspace/eav/registry';
import { CompileEnv, compileFilter, type PlanNode } from './compile';
import { Ctx, toSet } from './context';
import { evalNode } from './execute';
import { runGroups } from './group';
import { compileSorts, loadTuples, selectTop, sortWindow, tupleComparator, type SortCol, type SortStrategy } from './sort';
import type { QueryOptions, QueryResult, QueryStats, ReferencedProps, SortTuple, VisibleSet } from './types';

export type * from './types';
export { selectTop, tupleComparator as compareSortTuples };
export type { PlanNode } from './compile';

export interface CompiledQuery {
	/** The membership source AST's plan (when the query has a collection with one). */
	membership: PlanNode | null;
	filter: PlanNode;
	sorts: SortCol[];
	groupBy: GroupBySpec | null;
}

interface CollectionRow {
	source_ast: string | null;
}

function parseSource(text: string | null): FilterGroup | null {
	if (text === null || text === undefined) return null;
	try {
		const ast = JSON.parse(text) as unknown;
		return isGroup(ast) ? (ast as FilterGroup) : null;
	} catch {
		return null;
	}
}

async function loadCollection(ctx: Ctx, collectionId: string): Promise<FilterGroup | null | undefined> {
	const [row] = await ctx.q<CollectionRow>('SELECT source_ast FROM collection WHERE id = ? AND deleted_at IS NULL', collectionId);
	return row ? parseSource(row.source_ast) : undefined;
}

/**
 * Membership of a collection: the pages its source AST matches plus the hand-picked rows, restricted to
 * visible and live pages. A collection without a source AST is hand-picked only, and its members' own
 * ranks (the manual order) break ties instead of the pages' sibling ranks.
 */
async function applyMembership(ctx: Ctx, env: CompileEnv, collectionId: string): Promise<{ source: FilterGroup | null; plan: PlanNode | null }> {
	const source = await loadCollection(ctx, collectionId);
	if (source === undefined) {
		ctx.mem = new Set();
		return { source: null, plan: null };
	}
	const mem = new Set<number>();
	let plan: PlanNode | null = null;
	if (source) {
		plan = await compileFilter(env, source);
		for (const n of await evalNode(plan, null, ctx)) mem.add(n);
	}
	const picked = await ctx.q<{ num: number; rank: string }>(
		'SELECT p.num AS num, m.rank AS rank FROM collection_member m JOIN page p ON p.id = m.page_id WHERE m.collection_id = ?',
		collectionId
	);
	const live = await ctx.restrict(picked.map((r) => r.num));
	for (const r of picked) if (live.has(r.num)) mem.add(r.num);
	if (!source) ctx.rankOverride = new Map(picked.filter((r) => live.has(r.num)).map((r) => [r.num, r.rank]));
	ctx.mem = mem;
	return { source, plan };
}

async function makeCtx(db: WorkspaceDb, opts: Pick<QueryOptions, 'me' | 'now' | 'weekStartsOn'> & { visible: VisibleSet | null }): Promise<{ ctx: Ctx; env: CompileEnv }> {
	const registry = await loadEavRegistry(db);
	const ctx = new Ctx(db, registry, opts.visible === null ? null : toSet(opts.visible), opts.me, opts.now, opts.weekStartsOn ?? 1);
	const env = new CompileEnv(db, registry, { me: opts.me, now: opts.now, weekStartsOn: opts.weekStartsOn });
	return { ctx, env };
}

const propsOf = (spec: QuerySpec, source: FilterGroup | null, shown: readonly string[] | undefined): ReferencedProps => {
	const filter = [...referencedProps({ filter: spec.filter })];
	const sort = [...referencedProps({ sorts: spec.sorts })];
	const group = spec.groupBy ? [spec.groupBy.prop] : [];
	const membership = source ? [...referencedProps({ filter: source })] : [];
	const all = [...new Set([...filter, ...sort, ...group, ...(shown ?? []), ...membership])];
	return { filter, sort, group, shown: [...(shown ?? [])], membership, all };
};

/** The plan of a query without running it. */
export async function compileQuery(db: WorkspaceDb, spec: QuerySpec, opts: QueryOptions): Promise<CompiledQuery> {
	const { ctx, env } = await makeCtx(db, opts);
	let membership: PlanNode | null = null;
	if (opts.collectionId) {
		const source = await loadCollection(ctx, opts.collectionId);
		if (source) membership = await compileFilter(env, source);
	}
	return {
		membership,
		filter: await compileFilter(env, spec.filter),
		sorts: compileSorts(ctx.registry, spec.sorts),
		groupBy: spec.groupBy ?? null
	};
}

/**
 * Runs a query: the pages matching the filter (and the collection's membership), visible to the actor and
 * live, ordered by the sorts then rank then id, cut to `opts.window`; or, with `groupBy`, split into groups
 * that each carry a total and their own window.
 */
export async function runQuery(db: WorkspaceDb, spec: QuerySpec, opts: QueryOptions): Promise<QueryResult> {
	const started = Date.now();
	const { ctx, env } = await makeCtx(db, opts);
	let source: FilterGroup | null = null;
	if (opts.collectionId) source = (await applyMembership(ctx, env, opts.collectionId)).source;

	const plan = await compileFilter(env, spec.filter);
	const matched = await evalNode(plan, ctx.mem, ctx);
	const cols = compileSorts(ctx.registry, spec.sorts);
	const window = opts.window ?? {};

	let rows: QueryResult['rows'] = [];
	let groups: QueryResult['groups'];
	let strategy: SortStrategy[] = [];
	if (spec.groupBy) {
		const run = await runGroups(ctx, matched, spec.groupBy, cols, window, opts.groupWindows);
		groups = run.groups;
		strategy = run.strategies;
	} else {
		const r = await sortWindow(ctx, matched, cols, window);
		rows = r.rows;
		strategy = [r.strategy];
	}
	const kinds = new Set(strategy.filter((s) => s !== 'none'));
	const stats: QueryStats = {
		...ctx.counters,
		sort: kinds.size === 0 ? 'none' : kinds.size === 1 ? ([...kinds][0] as QueryStats['sort']) : 'mixed',
		ms: Date.now() - started
	};
	return { total: matched.size, rows, ...(groups ? { groups } : {}), props: propsOf(spec, source, opts.shown), stats };
}

// ───────────────────────────── explain ─────────────────────────────

export interface ExplainNode {
	kind: 'and' | 'or' | 'condition' | 'const';
	/** Estimated pages kept. */
	est?: number;
	prop?: string;
	op?: string;
	/** The access path, e.g. `p_ref prop=3 v=done`. */
	path?: string;
	negate?: boolean;
	scanCost?: number;
	value?: boolean;
	/** Children in the order they are evaluated. */
	children?: ExplainNode[];
}

export interface Explain {
	membership: ExplainNode | null;
	filter: ExplainNode;
	/** The conditions in evaluation order, depth first. */
	order: string[];
	sorts: { prop: string; dir: 'asc' | 'desc'; index: string | null }[];
	groupBy: string | null;
}

const describe = (n: PlanNode): ExplainNode => {
	switch (n.kind) {
		case 'const':
			return { kind: 'const', value: n.value };
		case 'leaf':
			return { kind: 'condition', est: n.est, prop: n.prop, op: n.op, path: n.path, negate: n.negate, scanCost: n.scanCost };
		case 'group':
			return { kind: n.op, est: n.est, children: n.children.map(describe) };
	}
};

const flatten = (n: ExplainNode): string[] =>
	n.kind === 'condition'
		? [`${n.prop} ${n.op} (est ${Number.isFinite(n.est) ? n.est : '?'}, ${n.path}${n.negate ? ', complement' : ''})`]
		: (n.children ?? []).flatMap(flatten);

/** The chosen plan: conditions in the order they will run, with estimates and access paths. */
export async function explainQuery(db: WorkspaceDb, spec: QuerySpec, opts: QueryOptions): Promise<Explain> {
	const c = await compileQuery(db, spec, opts);
	const filter = describe(c.filter);
	return {
		membership: c.membership ? describe(c.membership) : null,
		filter,
		order: [...(c.membership ? flatten(describe(c.membership)).map((s) => `membership: ${s}`) : []), ...flatten(filter)],
		sorts: c.sorts.map((s) => ({ prop: s.spec.prop, dir: s.spec.dir, index: s.walk ? `${s.walk.table} prop=${s.walk.prop}` : null })),
		groupBy: c.groupBy?.prop ?? null
	};
}

// ───────────────────────────── helpers for the live loop ─────────────────────────────

export interface MatchOptions {
	me?: string;
	now: number;
	weekStartsOn?: 0 | 1;
	/** When given, the page must also be in this set. */
	visible?: VisibleSet;
	/** When given, the page must also belong to this collection (source AST or hand-picked). */
	collectionId?: string;
}

const filterOf = (x: FilterNode | QuerySpec | null | undefined): FilterNode | undefined =>
	x === null || x === undefined ? undefined : isGroup(x) ? x : ((x as QuerySpec).filter ?? undefined);

/**
 * Whether one page satisfies a filter (or a spec's filter): live, visible (when `visible` is given), a
 * member of the collection (when `collectionId` is given) and matching the conditions. Candidate-driven:
 * every condition is a point lookup through the `(page, prop)` index.
 */
export async function matchesFilter(db: WorkspaceDb, spec: FilterNode | QuerySpec | null | undefined, pageNum: number, opts: MatchOptions): Promise<boolean> {
	const { ctx } = await makeCtx(db, { ...opts, visible: opts.visible ?? null });
	const env = new CompileEnv(db, ctx.registry, { me: opts.me, now: opts.now, weekStartsOn: opts.weekStartsOn, estimate: false });
	const one = new Set([pageNum]);
	if ((await ctx.restrict(one)).size === 0) return false;
	if (opts.collectionId) {
		const source = await loadCollection(ctx, opts.collectionId);
		if (source === undefined) return false;
		let member = false;
		if (source) member = (await evalNode(await compileFilter(env, source), one, ctx)).size > 0;
		if (!member) {
			const hit = await ctx.q('SELECT 1 FROM collection_member m JOIN page p ON p.id = m.page_id WHERE m.collection_id = ? AND p.num = ?', opts.collectionId, pageNum);
			member = hit.length > 0;
		}
		if (!member) return false;
	}
	const plan = await compileFilter(env, filterOf(spec));
	return (await evalNode(plan, one, ctx)).has(pageNum);
}

/**
 * The sort tuples (keys, rank, id) of pages under `sorts`: what the live loop compares to place a page in a
 * sorted window. Order tuples with {@link compareSortTuples}`(sorts)`.
 */
export async function sortKeyOf(
	db: WorkspaceDb,
	sorts: readonly SortSpec[] | undefined,
	pageNums: readonly number[],
	opts: Pick<MatchOptions, 'now'> = { now: Date.now() }
): Promise<Map<number, SortTuple>> {
	const { ctx } = await makeCtx(db, { now: opts.now, visible: null });
	const tuples = await loadTuples(ctx, pageNums, compileSorts(ctx.registry, sorts));
	return new Map(tuples.map((t) => [t.num, t]));
}
