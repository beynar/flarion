/** Random filters, sorts, groupings, windows and visibility sets for the oracle tests. */
import type { Condition, FilterGroup, FilterNode, GroupBySpec, QuerySpec, SortSpec } from '../../../src/lib/shared/filter-ast';
import { resolveField, validateFilter } from '../../../src/lib/shared/filter-ast';
import { DATE_UNITS, NAMED_RANGES, type DateOperand, type DateRangeOperand } from '../../../src/lib/shared/dates';
import { FILTER_OPS, type FilterOp, type PropertyDef } from '../../../src/lib/shared/property-types';
import type { QueryOptions } from '../../../src/server/engine';
import type { Rng } from '../../unit/shared/helpers';
import { NEEDLE_TAIL, NOW, USERS, TEAMSPACES, randomGroup, type PageRow, type World } from './world';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function pageText(page: PageRow, prop: string): string | undefined {
	const v = page.props[prop];
	return typeof v === 'string' ? v : undefined;
}

function textNeedle(r: Rng, w: World, prop: string): string {
	if (r.bool(0.05)) return '';
	const samples = w.pages.map((p) => pageText(p, prop)).filter((s): s is string => !!s);
	if (samples.length === 0 || r.bool(0.1)) return r.pick(['a', 'é', 'plan', 'zzz', 'Œ', 'ß', 'CAFE', 'x']);
	const s = r.pick(samples);
	if (r.bool(0.15)) return NEEDLE_TAIL;
	switch (r.int(0, 4)) {
		case 0:
			return s; // full
		case 1:
			return s.slice(0, r.int(1, Math.min(8, s.length))); // prefix
		case 2:
			return s.slice(-r.int(1, Math.min(8, s.length))); // suffix
		case 3: {
			const a = r.int(0, Math.max(0, s.length - 1));
			return s.slice(a, a + r.int(1, 6));
		}
		default:
			return r.bool() ? s.toUpperCase() : s.toLowerCase();
	}
}

/** Dates taken from the data (and the days around them), so operands land exactly on stored boundaries. */
export function sampledDate(r: Rng, w: World, prop: string): string | undefined {
	const field = w.registry.get(prop);
	let candidates: string[];
	if (field?.type === 'created_time') candidates = w.pages.map((p) => p.createdAt);
	else if (field?.type === 'last_edited_time') candidates = w.pages.map((p) => p.updatedAt ?? p.createdAt);
	else {
		candidates = [];
		for (const p of w.pages) {
			const v = p.props[prop];
			if (v && typeof v === 'object' && !Array.isArray(v)) candidates.push(r.bool() || !v.end ? v.start : v.end);
		}
	}
	if (candidates.length === 0) return undefined;
	const s = r.pick(candidates);
	const day = s.slice(0, 10);
	const shift = r.pick([0, 0, 1, -1]);
	const t = Date.parse(`${day}T00:00:00Z`) + shift * 86_400_000;
	const d = new Date(t).toISOString().slice(0, 10);
	return r.bool(0.5) ? d : s.length === 10 ? d : s;
}

function dateOperand(r: Rng, w?: World, prop?: string): DateOperand {
	const sampled = w && prop && r.bool(0.6) ? sampledDate(r, w, prop) : undefined;
	if (sampled) return { kind: 'exact', date: sampled };
	if (r.bool(0.45)) return { kind: 'relative', unit: r.pick(DATE_UNITS), offset: r.int(-4, 4) };
	const y = r.bool(0.9) ? 2026 : r.pick([2025, 2027]);
	const day = `${y}-${pad(r.int(1, 12))}-${pad(r.int(1, 28))}`;
	return { kind: 'exact', date: r.bool(0.7) ? day : `${day}T${pad(r.int(0, 23))}:${pad(r.pick([0, 15, 30, 45]))}:00Z` };
}

function dateRange(r: Rng, w: World, prop: string): DateRangeOperand {
	if (r.bool(0.4)) return { kind: 'named', range: r.pick(NAMED_RANGES) };
	return { kind: 'between', from: dateOperand(r, w, prop), to: dateOperand(r, w, prop) };
}

function refValue(r: Rng, w: World, id: string, def: PropertyDef | undefined): string {
	if (id === '$parent') return r.bool(0.8) ? r.pick(w.dbPages) : r.pick(w.pages).id;
	if (id === '$teamspace') return r.pick(TEAMSPACES);
	switch (def?.type) {
		case 'select':
		case 'status':
		case 'multi_select':
			return r.bool(0.95) ? r.pick(def.config.options.map((o) => o.id)) : 'nope';
		case 'relation':
			return r.bool(0.97) ? r.pick(w.pages).id : 'missing-page';
		case 'files':
			return `f${r.int(1, 4)}`;
		default:
			return r.pick(USERS);
	}
}

/** `strict`: a condition that validates (known property, allowed operator), as a saved collection source must. */
export function randomCondition(r: Rng, w: World, strict = false): Condition {
	const props = [...w.registry.all().map((d) => d.id), '$parent', '$teamspace'];
	const prop = !strict && r.bool(0.02) ? 'ghost' : r.pick(props);
	const field = resolveField(w.registry, prop);
	if (!field) return { prop, op: 'is', value: 'x' };
	const ops = Object.keys(field.ops) as FilterOp[];
	const op = !strict && r.bool(0.02) ? r.pick(FILTER_OPS) : r.pick(ops);
	const kind = field.ops[op];
	switch (kind) {
		case 'none':
			return { prop, op };
		case 'text':
			return { prop, op, value: textNeedle(r, w, prop) };
		case 'number': {
			const nums = w.pages.map((p) => p.props[prop]).filter((x): x is number => typeof x === 'number');
			const base = nums.length && r.bool(0.8) ? r.pick(nums) : r.pick([0, 1, 2, 3, 5, 100, -1]);
			return { prop, op, value: r.bool(0.15) ? base + 0.5 : base };
		}
		case 'boolean':
			return { prop, op, value: r.bool() };
		case 'ref':
			return { prop, op, value: refValue(r, w, prop, field.def) };
		case 'date':
			return { prop, op, value: dateOperand(r, w, prop) };
		case 'date_range':
			return { prop, op, value: dateRange(r, w, prop) };
		default:
			return { prop, op: op ?? 'is', value: 'x' };
	}
}

export const randomFilter = (r: Rng, w: World, depth = 3): FilterGroup => randomGroup(r, () => randomCondition(r, w), depth);

/** A filter that passes `validateFilter`: what a collection's source AST must be. */
export function randomSource(r: Rng, w: Pick<World, 'pages' | 'registry' | 'dbPages'>, depth = 2): FilterGroup {
	for (let i = 0; i < 50; i++) {
		const g = randomGroup(r, () => randomCondition(r, w as World, true), depth);
		if (validateFilter(g, w.registry).ok) return g;
	}
	return { and: [{ prop: 'done', op: 'is', value: false }] };
}

export function randomSorts(r: Rng, w: World): SortSpec[] {
	const n = r.pick([0, 0, 1, 1, 2, 3]);
	const props = [...w.registry.all().map((d) => d.id), 'ghost'];
	const out: SortSpec[] = [];
	for (let i = 0; i < n; i++) {
		const prop = r.bool(0.7) ? r.pick(['title', 'amount', 'score', 'due', 'meeting', 'prio', 'stage', 'tags', 'done', 'created', 'edited', 'notes', 'fnum', 'ftext', 'fdate', 'fbool', 'fdue', 'ftitles', 'fchain', 'uid', 'ai', 'rnum', 'rcount', 'rdue', 'rtags', 'rback', 'rchain']) : r.pick(props);
		if (out.some((s) => s.prop === prop)) continue;
		out.push({ prop, dir: r.pick(['asc', 'desc']), ...(r.bool(0.4) ? { nulls: r.pick(['first', 'last'] as const) } : {}) });
	}
	return out;
}

/** Group keys a spec can mention (hide, order): the ones the property has, `$empty`, and a stranger. */
function candidateKeys(r: Rng, w: World, prop: string, by: 'option' | 'group' | undefined): string[] {
	const def = w.registry.get(prop);
	let keys: string[] = [];
	switch (def?.type) {
		case 'select':
		case 'multi_select':
			keys = def.config.options.map((o) => o.id);
			break;
		case 'status':
			keys = by === 'group' ? def.config.groups.map((g) => g.id) : def.config.options.map((o) => o.id);
			break;
		case 'checkbox':
			keys = ['true', 'false'];
			break;
		case 'person':
		case 'created_by':
		case 'last_edited_by':
			keys = USERS;
			break;
		case 'relation':
			keys = Array.from({ length: 4 }, () => r.pick(w.pages).id);
			break;
		case 'date':
			keys = Array.from({ length: 3 }, () => sampledDate(r, w, prop) ?? '2026-03-01');
			break;
		default:
	}
	return [...new Set([...keys, '$empty', 'nope'])];
}

export function randomGroupBy(r: Rng, w: World): GroupBySpec | undefined {
	if (!r.bool(0.35)) return undefined;
	const prop = r.pick(['prio', 'stage', 'stage', 'tags', 'owner', 'done', 'due', 'rel', 'rel:reverse', 'rel1', 'by', 'editor', 'prio', 'ghost']);
	const by = prop === 'stage' && r.bool(0.5) ? ('group' as const) : undefined;
	const keys = candidateKeys(r, w, prop, by);
	const some = (n: number) => [...new Set(r.shuffle(keys).slice(0, r.int(1, n)))];
	return {
		prop,
		...(r.bool(0.5) ? { sort: r.pick(['manual', 'asc', 'desc'] as const) } : {}),
		...(r.bool(0.3) ? { hideEmpty: true } : {}),
		...(prop === 'due' ? { bucket: r.pick(DATE_UNITS) } : {}),
		...(by ? { by } : {}),
		...(r.bool(0.25) ? { hidden: some(3) } : {}),
		...(r.bool(0.35) ? { order: some(6) } : {})
	};
}

/** Visibility sets: everything, a random share (trashed pages included), a handful, nothing. */
export function randomVisible(r: Rng, w: World): Set<number> {
	const all = w.pages.map((p) => p.num);
	switch (r.int(0, 4)) {
		case 0:
			return new Set(all);
		case 1:
			return new Set(all.filter(() => r.bool(0.6)));
		case 2:
			return new Set(all.filter(() => r.bool(0.9)));
		case 3:
			return new Set(all.filter(() => r.bool(0.04)));
		default:
			return new Set(w.pages.filter((p) => !p.deletedAt).map((p) => p.num));
	}
}

export interface Scenario {
	spec: QuerySpec;
	opts: QueryOptions;
}

export function randomScenario(r: Rng, w: World): Scenario {
	const spec: QuerySpec = {};
	if (r.bool(0.85)) spec.filter = randomFilter(r, w, r.pick([1, 2, 3, 3]));
	const sorts = randomSorts(r, w);
	if (sorts.length || r.bool(0.2)) spec.sorts = sorts;
	const groupBy = randomGroupBy(r, w);
	if (groupBy) spec.groupBy = groupBy;
	const opts: QueryOptions = { visible: randomVisible(r, w), me: r.bool(0.9) ? r.pick(USERS) : undefined, now: NOW };
	if (r.bool(0.5)) opts.collectionId = r.pick(w.collections).id;
	if (r.bool(0.6)) opts.window = { offset: r.pick([0, 0, 0, 1, 5, 30, 200]), limit: r.pick([1, 5, 20, 50, 400]) };
	if (spec.groupBy && r.bool(0.2)) opts.groupWindows = { [r.pick(['p1', 'p2', 'in_progress', 'todo', 'complete', 'true', '$empty'])]: { offset: 1, limit: 3 } };
	return { spec, opts };
}
