/**
 * The naive reference the engine is compared with: every page of the workspace as in-memory values, filtered,
 * sorted and grouped by the evaluators of `filter-ast.ts` (`evaluate`, `queryRows`, `groupRows`), with the same
 * visibility set and liveness applied. Collection membership is the source AST's `evaluate` plus hand-picked rows.
 */
import {
	evaluate,
	groupRows,
	isGroup,
	queryRows,
	type EvalCtx,
	type FilterNode,
	type PageValues,
	type QuerySpec,
	type Row
} from '../../../src/lib/shared/filter-ast';
import type { PropValue } from '../../../src/lib/shared/property-types';
import { runQuery, type QueryOptions, type QueryResult } from '../../../src/server/engine';
import { naiveValues } from './naive';
import { NOW, type PageRow, type World } from './world';

export interface OracleResult {
	total: number;
	rows: string[];
	groups?: { key: string; total: number; rows: string[] }[];
}

const naiveCache = new WeakMap<World, Map<string, Record<string, PropValue | null>>>();

/** Relations (tombstones dropped, reverse sides), formulas and rollups of every page, recomputed from scratch. */
export function naiveOf(w: World, now = NOW): Map<string, Record<string, PropValue | null>> {
	let m = naiveCache.get(w);
	if (!m) {
		m = naiveValues({ registry: w.registry, now, pages: w.pages.map((p) => ({ ...p, updatedAt: p.updatedAt, updatedBy: p.updatedBy })) });
		naiveCache.set(w, m);
	}
	return m;
}

export function valuesOf(w: World, p: PageRow): PageValues {
	const v: Record<string, PropValue | null> = { ...p.props, ...naiveOf(w).get(p.id), $parent: p.parentId, $teamspace: p.teamspaceId };
	for (const def of w.registry.all()) {
		if (def.type === 'created_time') v[def.id] = p.createdAt;
		else if (def.type === 'last_edited_time') v[def.id] = p.updatedAt ?? p.createdAt;
		else if (def.type === 'created_by') v[def.id] = p.createdBy;
		else if (def.type === 'last_edited_by') v[def.id] = p.updatedBy ?? p.createdBy;
	}
	return v;
}

export function oracle(w: World, spec: QuerySpec, opts: QueryOptions): OracleResult {
	const ctx: EvalCtx = { registry: w.registry, meId: opts.me, now: opts.now, weekStartsOn: opts.weekStartsOn ?? 1 };
	const visible = opts.visible instanceof Set ? opts.visible : new Set(opts.visible);
	const live = w.pages.filter((p) => !p.deletedAt && visible.has(p.num));

	let rows: Row[];
	const collection = opts.collectionId ? w.collections.find((c) => c.id === opts.collectionId) : undefined;
	if (collection) {
		const picked = new Map(collection.picked.map((m) => [m.pageId, m.rank]));
		rows = [];
		for (const p of live) {
			const values = valuesOf(w, p);
			const member = (collection.sourceAst !== null && evaluate(collection.sourceAst, values, ctx)) || picked.has(p.id);
			if (!member) continue;
			// A hand-picked-only collection keeps its members' manual order; others order ties by sibling rank.
			rows.push({ id: p.id, values, rank: collection.sourceAst === null ? (picked.get(p.id) as string) : p.rank });
		}
	} else {
		rows = live.map((p) => ({ id: p.id, values: valuesOf(w, p), rank: p.rank }));
	}

	const sorted = queryRows(rows, spec, ctx);
	const offset = opts.window?.offset ?? 0;
	const limit = opts.window?.limit ?? Infinity;
	const cut = (list: readonly Row[], key?: string) => {
		const win = (key !== undefined ? opts.groupWindows?.[key] : undefined) ?? { offset, limit };
		const o = win.offset ?? 0;
		const l = win.limit ?? Infinity;
		return list.slice(o, Number.isFinite(l) ? o + l : undefined).map((r) => r.id);
	};
	if (spec.groupBy) {
		const groups = groupRows(sorted, spec.groupBy, ctx).map((g) => ({ key: g.key, total: g.rows.length, rows: cut(g.rows, g.key) }));
		return { total: sorted.length, rows: [], groups };
	}
	return { total: sorted.length, rows: cut(sorted) };
}

export function summarize(res: QueryResult): OracleResult {
	return {
		total: res.total,
		rows: res.rows.map((r) => r.id),
		...(res.groups ? { groups: res.groups.map((g) => ({ key: g.key, total: g.total, rows: g.rows.map((r) => r.id) })) } : {})
	};
}

/** Where two results first differ, or null when they are equal. */
export function diff(expected: OracleResult, actual: OracleResult): string | null {
	if (expected.total !== actual.total) return `total: oracle ${expected.total}, engine ${actual.total}`;
	const rowsDiff = (label: string, a: string[], b: string[]): string | null => {
		for (let i = 0; i < Math.max(a.length, b.length); i++)
			if (a[i] !== b[i]) return `${label}[${i}]: oracle ${a[i] ?? '<none>'}, engine ${b[i] ?? '<none>'} (lengths ${a.length} / ${b.length})`;
		return null;
	};
	const rd = rowsDiff('rows', expected.rows, actual.rows);
	if (rd) return rd;
	const eg = expected.groups;
	const ag = actual.groups;
	if (!eg && !ag) return null;
	if (!eg || !ag) return `groups: oracle ${eg ? 'has' : 'has no'} groups, engine ${ag ? 'has' : 'has none'}`;
	const keysE = eg.map((g) => g.key);
	const keysA = ag.map((g) => g.key);
	if (keysE.join('|') !== keysA.join('|')) return `group keys: oracle [${keysE}], engine [${keysA}]`;
	for (let i = 0; i < eg.length; i++) {
		if (eg[i].total !== ag[i].total) return `group ${eg[i].key} total: oracle ${eg[i].total}, engine ${ag[i].total}`;
		const d = rowsDiff(`group ${eg[i].key} rows`, eg[i].rows, ag[i].rows);
		if (d) return d;
	}
	return null;
}

export async function compare(w: World, spec: QuerySpec, opts: QueryOptions): Promise<string | null> {
	const engine = summarize(await runQuery(w.db, spec, opts));
	return diff(oracle(w, spec, opts), engine);
}

// ───────────────────────────── shrinking ─────────────────────────────

/** Smaller variants of a filter: a child removed, a group replaced by one of its children, recursively. */
function filterVariants(node: FilterNode): FilterNode[] {
	if (!isGroup(node)) return [];
	const key = 'and' in node ? 'and' : 'or';
	const kids = 'and' in node ? node.and : node.or;
	const out: FilterNode[] = [];
	for (let i = 0; i < kids.length; i++) {
		if (kids.length > 1) out.push({ [key]: kids.filter((_, j) => j !== i) } as FilterNode);
		out.push(kids[i]);
		for (const v of filterVariants(kids[i])) out.push({ [key]: kids.map((k, j) => (j === i ? v : k)) } as FilterNode);
	}
	return out;
}

/** Greedily shrinks a failing scenario (filter, sorts, grouping, window, collection) to a small repro. */
export async function shrink(w: World, spec: QuerySpec, opts: QueryOptions): Promise<{ spec: QuerySpec; opts: QueryOptions; message: string }> {
	let cur = { spec, opts };
	let message = (await compare(w, spec, opts)) ?? 'passes';
	// Each attempt runs the engine and the oracle: bound the effort (a few seconds) rather than minimize fully.
	const deadline = Date.now() + 8000;
	const tryIt = async (next: { spec: QuerySpec; opts: QueryOptions }): Promise<boolean> => {
		if (Date.now() > deadline) return false;
		let m: string | null;
		try {
			m = await compare(w, next.spec, next.opts);
		} catch (e) {
			m = `engine error: ${e instanceof Error ? e.message : String(e)}`;
		}
		if (m === null) return false;
		cur = next;
		message = m;
		return true;
	};
	for (let progress = true; progress && Date.now() < deadline; ) {
		progress = false;
		if (cur.opts.window && (await tryIt({ ...cur, opts: { ...cur.opts, window: undefined } }))) progress = true;
		if (cur.opts.groupWindows && (await tryIt({ ...cur, opts: { ...cur.opts, groupWindows: undefined } }))) progress = true;
		if (cur.opts.collectionId && (await tryIt({ ...cur, opts: { ...cur.opts, collectionId: undefined } }))) progress = true;
		if (cur.spec.groupBy && (await tryIt({ ...cur, spec: { ...cur.spec, groupBy: undefined } }))) progress = true;
		if (cur.spec.sorts?.length) {
			if (await tryIt({ ...cur, spec: { ...cur.spec, sorts: [] } })) progress = true;
			else
				for (let i = 0; i < (cur.spec.sorts?.length ?? 0); i++)
					if (await tryIt({ ...cur, spec: { ...cur.spec, sorts: cur.spec.sorts!.filter((_, j) => j !== i) } })) {
						progress = true;
						break;
					}
		}
		if (cur.spec.filter) {
			for (const v of filterVariants(cur.spec.filter)) {
				const f = isGroup(v) ? v : { and: [v] };
				if (await tryIt({ ...cur, spec: { ...cur.spec, filter: f as never } })) {
					progress = true;
					break;
				}
			}
		}
	}
	return { ...cur, message };
}
