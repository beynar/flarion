/**
 * View units: the evaluation and incremental maintenance of a live database view (docs/PLAN.md "Databases":
 * "Live updates (incremental view maintenance)").
 *
 * A unit is one query shared by every subscription that asks it: a collection, an optional saved view, the
 * subscription's own filter, sorts and group-by, and (when the filter reads `is me`) the user. Its state is the
 * ORDERED list of every matching page id, per group when grouped, whatever the actors can see: each socket's
 * window is that list ANDed with its own visibility set (`live.ts`). The state lives in `sub_unit.ids`.
 *
 * Keeping it current on a commit, in order of cost:
 *   1. Skip: the commit wrote no property the unit filters, sorts, groups or takes its membership from
 *      (`sub_prop`, the property-to-subscription index) and made no page-level change (create, trash, restore,
 *      move) that can matter.
 *   2. Incremental: for the commit's candidate pages only, the engine's `matchesFilterMany` says who matches
 *      (live, in the collection, passing the filter), `groupKeysOf` says where, `sortKeyOf` gives the sort
 *      tuples; a page that left is removed, one that entered or whose sort value changed is placed by binary
 *      search over the stored order. Tombstoned pages are removed without asking the engine.
 *   3. Full: `runQuery` again, when a definition changed (property, collection, view), the candidates are too
 *      many to be worth it, or the collection is hand-picked only (its manual ranks are not in the tuples).
 */
import {
	andFilters,
	isGroup,
	referencedProps,
	type FilterGroup,
	type FilterNode,
	type GroupBySpec,
	type QuerySpec,
	type SortSpec
} from '../../../lib/shared/filter-ast';
import type { DateOperand, DateRangeOperand } from '../../../lib/shared/dates';
import type { PropertyDef } from '../../../lib/shared/property-types';
import type { OptionIndex } from '../../bitmaps/option-index';
import { createBitmap, roaringReady, type Bitmap } from '../../bitmaps/roaring';
import type { SortTuple } from '../../engine/types';
import { compareSortTuples, groupKeysOf, matchesFilterMany, runQuery, sortKeyOf, type MatchMemo } from '../../engine';
import { orderGroups } from '../../engine/group';
import type { WorkspaceDb } from '../../db/workspace.client';
import { readCollection } from './eav';
import { loadEavRegistry, type EavRegistry } from './eav/registry';
import type { RowReader } from './rows';

/** The ungrouped list's key. */
export const FLAT = '';

/**
 * One string object per page id, shared by every unit that holds the page. A unit keeps the id of every page it
 * matches, and a page is in many units at once (the same board, table and filtered views of one database): without
 * sharing, each unit's parse or evaluation allocates its own copy of a 36-character id (about 56 bytes plus the array
 * slot), and a few hundred thousand ids across the live units are most of the object's 128 MB; shared, the pages cost
 * one copy and each unit only its 8-byte slot (docs/spikes/p4-scale.md "Memory"). Cleared when it holds more ids than
 * a workspace is expected to (the units keep their strings; the pool just starts over).
 */
const ID_POOL = new Map<string, string>();
const ID_POOL_MAX = 300_000;
export function internId(id: string): string {
	const known = ID_POOL.get(id);
	if (known !== undefined) return known;
	if (ID_POOL.size >= ID_POOL_MAX) ID_POOL.clear();
	ID_POOL.set(id, id);
	return id;
}
/** Pool size, for the state report. */
export const internedIds = (): number => ID_POOL.size;

/** What a view subscription asks (symbolic: the view and collection are resolved at every evaluation). */
export interface ViewUnitSpec {
	collectionId: string;
	viewId: string | null;
	/** The subscription's own filter (a `database_view` block's local filter). */
	filter: FilterGroup | null;
	sorts: SortSpec[] | null;
	/** `undefined`: the view's own grouping; `null`: ungrouped. */
	groupBy?: GroupBySpec | null;
	/** Set when the query reads `is me`: the user the unit is evaluated for. */
	me?: string;
}

export interface ResolvedView {
	collectionId: string;
	spec: QuerySpec;
	/** The collection has no source AST: hand-picked members only (manual ranks break ties). */
	manual: boolean;
	usesMe: boolean;
	/** A filter reads relative dates: the answer changes with the clock. */
	timed: boolean;
	/** Properties the unit depends on (filter, sorts, group-by, membership), plus `$edited` when it reads edit stamps. */
	props: string[];
}

/** The `$` marker of units whose filter or sort reads last-edited time or person: any change to a page moves it. */
export const EDITED = '$edited';

const conditionsOf = (node: FilterNode | null | undefined, out: { prop: string; op: string; value?: unknown }[] = []) => {
	if (!node) return out;
	if (isGroup(node)) for (const child of 'and' in node ? node.and : node.or) conditionsOf(child, out);
	else out.push(node as { prop: string; op: string; value?: unknown });
	return out;
};

const isRelative = (operand: unknown): boolean => {
	const o = operand as DateOperand | DateRangeOperand | undefined;
	if (!o || typeof o !== 'object') return false;
	if ('kind' in o && (o.kind === 'relative' || o.kind === 'named')) return true;
	if ('kind' in o && o.kind === 'between') return isRelative((o as { from: unknown }).from) || isRelative((o as { to: unknown }).to);
	return false;
};

/** Resolves a unit's spec against the current definitions (the same rules as `queryViewRows`). Null: no such collection. */
export async function resolveView(db: WorkspaceDb, spec: ViewUnitSpec): Promise<ResolvedView | null> {
	const found = await readCollection(db, spec.collectionId);
	if (!found) return null;
	const view = spec.viewId ? found.views.find((v) => v.id === spec.viewId) : undefined;
	const groupBy = spec.groupBy !== undefined ? spec.groupBy : (view?.groupBy ?? null);
	const query: QuerySpec = {
		filter: andFilters(view?.filter, spec.filter),
		sorts: spec.sorts ?? view?.sorts ?? [],
		...(groupBy ? { groupBy } : {})
	};
	const source = found.collection.sourceAst;
	const conditions = [...conditionsOf(query.filter), ...conditionsOf(source)];
	const registry = await loadEavRegistry(db);
	const props = new Set<string>([...referencedProps(query), ...(source ? referencedProps({ filter: source }) : [])]);
	for (const id of [...props]) {
		const type = registry.get(id)?.type;
		if (type === 'last_edited_time' || type === 'last_edited_by') props.add(EDITED);
	}
	return {
		collectionId: spec.collectionId,
		spec: query,
		manual: source === null,
		usesMe: conditions.some((c) => c.op === 'is_me' || c.op === 'is_not_me'),
		timed: conditions.some((c) => isRelative(c.value)),
		props: [...props]
	};
}

// ───────────────────────── state ─────────────────────────

/**
 * The ordered ids of a unit: one list under {@link FLAT}, or one per non-empty group. Each list can carry a Roaring
 * bitmap of its pages' numbers (built the first time the live loop needs it, then kept current by `maintainView`
 * and `evaluateView`): intersecting it with an actor's visibility bitmap gives the visible total, and tells whether
 * everything is visible, without looking at the ids one by one. Bitmaps are an optimization: a state without them
 * answers the same questions the slow way.
 */
export class ViewState {
	#bits: Map<string, Bitmap> | null;
	#union: Bitmap | null = null;

	constructor(
		readonly groupBy: GroupBySpec | null,
		readonly lists: ReadonlyMap<string, readonly string[]>,
		bits: Map<string, Bitmap> | null = null
	) {
		this.#bits = bits;
	}

	get grouped(): boolean {
		return this.groupBy !== null;
	}

	/** The bitmap of one list when it is already built. */
	bitsOf(key: string): Bitmap | undefined {
		return this.#bits?.get(key);
	}

	/** Whether every list has its bitmap (so a successor can inherit them). */
	get hasBits(): boolean {
		if (!this.#bits) return false;
		for (const key of this.lists.keys()) if (!this.#bits.has(key)) return false;
		return true;
	}

	setBits(key: string, bits: Bitmap): void {
		(this.#bits ??= new Map()).set(key, bits);
		this.#union = null;
	}

	/** The pages of every list together (a page of two groups once): the grouped view's distinct total. */
	union(): Bitmap | null {
		if (this.#union) return this.#union;
		if (!this.#bits) return null;
		const all = createBitmap();
		for (const key of this.lists.keys()) {
			const bits = this.#bits.get(key);
			if (!bits) return null;
			all.orInPlace(bits);
		}
		return (this.#union = all);
	}

	/** Releases the bitmaps (the state was replaced and nothing reads it any more). */
	dispose(): void {
		for (const bits of this.#bits?.values() ?? []) bits.dispose();
		this.#union?.dispose();
		this.#bits = null;
		this.#union = null;
	}

	static parse(text: string): ViewState {
		const raw = JSON.parse(text) as { groupBy: GroupBySpec | null; lists: [string, string[]][] };
		return new ViewState(raw.groupBy, new Map(raw.lists.map(([key, ids]) => [key, ids.map(internId)] as [string, string[]])));
	}

	serialize(): string {
		return JSON.stringify({ groupBy: this.groupBy, lists: [...this.lists] });
	}

	/** Distinct ids over all lists, in list order. */
	ids(): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const list of this.lists.values()) {
			for (const id of list) {
				if (!seen.has(id)) {
					seen.add(id);
					out.push(id);
				}
			}
		}
		return out;
	}

	equals(other: ViewState): boolean {
		if (JSON.stringify(this.groupBy) !== JSON.stringify(other.groupBy) || this.lists.size !== other.lists.size) return false;
		for (const [key, list] of this.lists) {
			const o = other.lists.get(key);
			if (!o || o.length !== list.length) return false;
			for (let i = 0; i < list.length; i++) if (o[i] !== list[i]) return false;
		}
		return true;
	}
}

export const EMPTY_STATE = new ViewState(null, new Map());

/** The group keys an actor sees, in display order, from the sizes of their visible lists. */
export function groupKeysFor(registry: EavRegistry, groupBy: GroupBySpec, sizes: ReadonlyMap<string, number>): string[] {
	const def: PropertyDef | undefined = registry.get(groupBy.prop);
	// An unknown property: one group with everything (the engine's rule).
	if (!def) return ['$empty'];
	return orderGroups(def, groupBy, sizes);
}

// ───────────────────────── full evaluation ─────────────────────────

export interface EvalEnv {
	now: number;
	/** The option index (select, status, multi-select and person conditions read bitmaps). */
	bitmaps?: OptionIndex | null;
}

/** Runs the query over every live page of the collection (no visibility restriction: sockets apply their own). */
export async function evaluateView(db: WorkspaceDb, resolved: ResolvedView, spec: ViewUnitSpec, env: EvalEnv): Promise<ViewState> {
	// A unit keeps every matching page, whatever `hideEmpty` hides from a socket: it is applied per actor.
	const query: QuerySpec = resolved.spec.groupBy ? { ...resolved.spec, groupBy: { ...resolved.spec.groupBy, hideEmpty: false } } : resolved.spec;
	const result = await runQuery(db, query, {
		visible: null,
		me: spec.me,
		now: env.now,
		collectionId: resolved.collectionId,
		window: {},
		bitmaps: env.bitmaps
	});
	const groupBy = resolved.spec.groupBy ?? null;
	const lists = new Map<string, string[]>();
	const bits = roaringReady() ? new Map<string, Bitmap>() : null;
	const keep = (key: string, rows: readonly { id: string; num: number }[]) => {
		lists.set(key, rows.map((r) => internId(r.id)));
		if (bits) {
			const nums = createBitmap(rows.map((r) => r.num));
			nums.optimize();
			bits.set(key, nums);
		}
	};
	if (groupBy && result.groups) {
		for (const g of result.groups) if (g.rows.length > 0) keep(g.key, g.rows);
	} else if (result.rows.length > 0) {
		keep(FLAT, result.rows);
	}
	return new ViewState(groupBy, lists, bits);
}

// ───────────────────────── incremental maintenance ─────────────────────────

/** Sort tuples loaded once per commit and sort specification. */
export class TupleCache {
	readonly #byKey: Map<string, Map<number, SortTuple>>;
	constructor(
		readonly db: WorkspaceDb,
		readonly now: number,
		/** Tuples kept between commits by the live loop, which forgets the pages and sorts a commit changed (`forgetTuples`). */
		store?: Map<string, Map<number, SortTuple>>
	) {
		this.#byKey = store ?? new Map();
	}

	async load(sorts: readonly SortSpec[], nums: readonly number[]): Promise<Map<number, SortTuple>> {
		const key = JSON.stringify(sorts);
		let have = this.#byKey.get(key);
		if (!have) this.#byKey.set(key, (have = new Map()));
		const missing = nums.filter((n) => !have!.has(n));
		if (missing.length > 0) for (const [n, t] of await sortKeyOf(this.db, sorts, missing, { now: this.now })) have.set(n, t);
		return have;
	}
}

/** Candidate pages beyond which a full evaluation is cheaper than checking them one by one. */
export const MAX_INCREMENTAL = 40;

export interface MaintainInput {
	db: WorkspaceDb;
	resolved: ResolvedView;
	spec: ViewUnitSpec;
	state: ViewState;
	/** Page ids whose membership, group or sort position may have changed. */
	candidates: readonly string[];
	reader: RowReader;
	tuples: TupleCache;
	now: number;
	bitmaps?: OptionIndex | null;
	/** The live loop's id-to-number cache: the binary search over a unit's stored order looks up many ids, and each miss is a query. */
	numOf?: (id: string) => number | undefined;
	/** Candidate-check answers shared by the units of one commit's maintenance. */
	memo?: MatchMemo;
}

/**
 * The state after a commit, derived from the previous one by re-checking only `candidates`. Null when the
 * incremental path cannot answer (a page's tuple could not be loaded): the caller evaluates in full.
 */
export async function maintainView(input: MaintainInput): Promise<ViewState | null> {
	const { db, resolved, spec, state, candidates, reader, tuples, now, bitmaps, numOf: cachedNumOf, memo } = input;
	const groupBy = resolved.spec.groupBy ?? null;
	if ((state.groupBy === null) !== (groupBy === null) || JSON.stringify(state.groupBy) !== JSON.stringify(groupBy)) return null;
	const sorts = resolved.spec.sorts ?? [];
	const cset = new Set(candidates);

	const numOf = reader.nums(candidates);
	const live = reader.liveIds(candidates);
	const liveNums = candidates.filter((id) => live.has(id) && numOf.has(id)).map((id) => numOf.get(id) as number);
	const matched = await matchesFilterMany(db, resolved.spec.filter, liveNums, { me: spec.me, now, collectionId: resolved.collectionId, bitmaps, memo });
	const matchedNums = [...matched];
	const keysOf = new Map<number, string[]>();
	if (groupBy) for (const [n, keys] of await groupKeysOf(db, groupBy, matchedNums, { now })) keysOf.set(n, keys);
	else for (const n of matchedNums) keysOf.set(n, [FLAT]);
	const idOf = new Map<number, string>();
	for (const id of candidates) {
		const n = numOf.get(id);
		if (n !== undefined) idOf.set(n, id);
	}

	// Remove every candidate, then place the ones that match.
	const lists = new Map<string, string[]>();
	for (const [key, list] of state.lists) lists.set(key, list.some((id) => cset.has(id)) ? list.filter((id) => !cset.has(id)) : (list as string[]).slice());

	if (matchedNums.length > 0) {
		const mine = await tuples.load(sorts, matchedNums);
		const cmp = compareSortTuples(sorts);
		const probe = new Map<string, SortTuple>();
		const tupleOfId = async (id: string): Promise<SortTuple | undefined> => {
			const hit = probe.get(id);
			if (hit) return hit;
			const n = cachedNumOf?.(id) ?? reader.nums([id]).get(id);
			if (n === undefined) return undefined;
			const t = (await tuples.load(sorts, [n])).get(n);
			if (t) probe.set(id, t);
			return t;
		};
		for (const n of matchedNums) {
			const tuple = mine.get(n);
			const id = idOf.get(n);
			if (!tuple || !id) return null;
			for (const key of keysOf.get(n) ?? []) {
				let list = lists.get(key);
				if (!list) lists.set(key, (list = []));
				let lo = 0;
				let hi = list.length;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					const other = await tupleOfId(list[mid]);
					if (!other) return null;
					if (cmp(other, tuple) < 0) lo = mid + 1;
					else hi = mid;
				}
				list.splice(lo, 0, internId(id));
			}
		}
	}
	for (const [key, list] of lists) if (list.length === 0) lists.delete(key);
	// The successor inherits the bitmaps: every candidate leaves, the pages that matched are put where they belong.
	let bits: Map<string, Bitmap> | null = null;
	if (roaringReady() && state.hasBits) {
		const left = [...idOf.keys()];
		bits = new Map();
		for (const key of lists.keys()) {
			const next = (state.bitsOf(key) ?? createBitmap()).clone();
			next.removeMany(left);
			bits.set(key, next);
		}
		for (const n of matchedNums) for (const key of keysOf.get(n) ?? []) bits.get(key)?.add(n);
	}
	return new ViewState(groupBy, lists, bits);
}

/** Whether a unit with these properties is touched by writes to `changed` (or by an edit of a page when it reads edit stamps). */
export function unitReads(props: readonly string[], changed: ReadonlySet<string>): boolean {
	for (const p of props) if (changed.has(p)) return true;
	return false;
}
