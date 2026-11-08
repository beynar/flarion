/**
 * The page value cache of the live loop (docs/ops/load-test.md "Fourth pass"): the current values of the pages a view unit's
 * maintenance asks about (their stored properties, parent, teamspace, rank, liveness) and the hand-picked members of collections, kept
 * between commits, so that a value-only write re-checks every touched unit's membership, group and sort position in memory with no SQL
 * (`maintainInMemory`, `view-unit.ts`) instead of a dozen statements per unit.
 *
 * What it answers is what the SQL path answers: the evaluators are the shared oracle of the query engine (`evaluate`,
 * `groupKeysOfValue`, `sortKeyOf` from `filter-ast.ts` / `property-types.ts`, which `tests/workers/engine` compares the compiled SQL
 * with on random workspaces) and the live fuzz compares every unit with a fresh SQL evaluation after every step, with the cache on.
 * It only handles what is stored as typed values: title, text, url, email, phone, number, checkbox, select, status, multi-select and
 * person properties, and the `$parent` / `$teamspace` fields. A unit that reads anything else (dates and the clock, relations,
 * formulas, rollups, edit stamps, hand-picked-only collections) never uses it and keeps the SQL path.
 *
 * Correctness rests on two rules:
 *   - an entry is patched from the change rows of every commit before the fan-out reads anything (`apply`): a `setProp` row carries the
 *     new value exactly as `props_json` stores it; a `create` row changes no held page; any other kind of row (structure, lifecycle,
 *     definitions, membership) empties the whole cache, the next read loads from SQL;
 *   - a miss is a SQL read of the page rows, so a cold or emptied cache is only slower, never wrong. It is emptied on every definition
 *     change, when the registry of the live loop is cleared, and when it holds more than `max` pages.
 *
 * Memory: a page entry is its parsed property object (a few hundred bytes), at most `max` of them (default 20,000: about 6 MB), plus the
 * member ids of the collections units read: inside the plan's budget of half of the object's 128 MB for subscriptions, visibility sets,
 * bitmaps and row caches.
 */
import {
	evaluate,
	groupKeysOfValue,
	type EvalCtx,
	type FilterGroup,
	type FilterNode,
	type GroupBySpec,
	type PageValues,
	type SortSpec
} from '../../../lib/shared/filter-ast';
import { sortKeyOf, TITLE_PROP_ID, type PropValue } from '../../../lib/shared/property-types';
import type { SortTuple } from '../../engine/types';
import type { LogRow } from './changelog';
import type { EavRegistry } from './eav/registry';
import { chunks, MAX_PARAMS, qmarks } from './util';

/** Property types the cache can evaluate (see the header). */
const FILTER_TYPES: ReadonlySet<string> = new Set(['title', 'text', 'url', 'email', 'phone', 'number', 'checkbox', 'select', 'status', 'multi_select', 'person']);
const GROUP_TYPES: ReadonlySet<string> = new Set(['checkbox', 'select', 'status', 'multi_select', 'person']);
const SYSTEM = new Set(['$parent', '$teamspace']);
/** Row kinds a `setProp` patch handles; every other kind empties the cache. */
const VALUE_KINDS: ReadonlySet<string> = new Set(['setProp', 'setComputed']);

export interface PageSnap {
	id: string;
	num: number;
	live: boolean;
	parentId: string | null;
	teamspaceId: string | null;
	rank: string;
	/** The page's property values by property id (what `props_json` holds, the title included). */
	values: Record<string, PropValue | null>;
}

export interface PageCacheStats {
	/** Pages read from SQL, entries patched from change rows, times the whole cache was emptied. */
	loads: number;
	patches: number;
	clears: number;
	size: number;
}

export class PageCache {
	readonly #sql: SqlStorage;
	readonly #byId = new Map<string, PageSnap>();
	readonly #picked = new Map<string, Set<string>>();
	readonly max: number;
	loads = 0;
	patches = 0;
	clears = 0;

	constructor(sql: SqlStorage, max = 20_000) {
		this.#sql = sql;
		this.max = max;
	}

	get size(): number {
		return this.#byId.size;
	}

	stats(): PageCacheStats {
		return { loads: this.loads, patches: this.patches, clears: this.clears, size: this.#byId.size };
	}

	clear(): void {
		if (this.#byId.size === 0 && this.#picked.size === 0) return;
		this.#byId.clear();
		this.#picked.clear();
		this.clears++;
	}

	/** Brings the cache up to date with the rows of the commits about to be fanned out (in order), before anything reads it. */
	apply(rows: readonly LogRow[]): void {
		for (const row of rows) {
			// A new page changes no page that is held (its own entry is read when a unit first asks for it).
			if (row.kind === 'create') continue;
			if (!VALUE_KINDS.has(row.kind) || !row.page || !row.prop) {
				this.clear();
				return;
			}
			const entry = this.#byId.get(row.page);
			if (!entry) continue;
			if (row.new === null || row.new === undefined) delete entry.values[row.prop];
			else entry.values[row.prop] = row.new as PropValue;
			this.patches++;
		}
	}

	/** The snapshots of `ids` (null: no such page), read from SQL for the ones not held. */
	load(ids: readonly string[]): Map<string, PageSnap | null> {
		const out = new Map<string, PageSnap | null>();
		let missing: string[] | null = null;
		for (const id of ids) {
			const hit = this.#byId.get(id);
			if (hit) out.set(id, hit);
			else (missing ??= []).push(id);
		}
		if (!missing) return out;
		if (this.#byId.size + missing.length > this.max) this.clear();
		for (const part of chunks(missing, MAX_PARAMS)) {
			const found = new Set<string>();
			for (const r of this.#sql
				.exec<{ id: string; num: number; parent_id: string | null; teamspace_id: string | null; rank: string; title: string; props_json: string | null; deleted_at: string | null }>(
					`SELECT id, num, parent_id, teamspace_id, rank, title, props_json, deleted_at FROM page WHERE id IN (${qmarks(part.length)})`,
					...part
				)
				.toArray()) {
				let values: Record<string, PropValue | null> = {};
				try {
					const parsed = r.props_json ? (JSON.parse(r.props_json) as unknown) : {};
					if (parsed && typeof parsed === 'object') values = parsed as Record<string, PropValue | null>;
				} catch {
					// an unreadable props column reads as no values, as `RowReader` does
				}
				values[TITLE_PROP_ID] = r.title;
				const snap: PageSnap = { id: r.id, num: r.num, live: r.deleted_at === null, parentId: r.parent_id, teamspaceId: r.teamspace_id, rank: r.rank, values };
				this.#byId.set(r.id, snap);
				out.set(r.id, snap);
				found.add(r.id);
				this.loads++;
			}
			for (const id of part) if (!found.has(id)) out.set(id, null);
		}
		return out;
	}

	/** The hand-picked members of a collection (page ids). */
	picked(collectionId: string): ReadonlySet<string> {
		let set = this.#picked.get(collectionId);
		if (!set) {
			set = new Set(this.#sql.exec<{ page_id: string }>('SELECT page_id FROM collection_member WHERE collection_id = ?', collectionId).toArray().map((r) => r.page_id));
			this.#picked.set(collectionId, set);
		}
		return set;
	}
}

// ───────────────────────── evaluation ─────────────────────────

const propsOf = (node: FilterNode | null | undefined, out: Set<string>): void => {
	if (!node) return;
	if ('and' in node) for (const n of node.and) propsOf(n, out);
	else if ('or' in node) for (const n of node.or) propsOf(n, out);
	else out.add(node.prop);
};

const eligibility = new WeakMap<object, boolean>();

/** Whether a unit's filter, collection source, sorts and group-by only read what the cache can evaluate. Decided once per resolved unit. */
export function memoryEligible(
	key: object,
	registry: EavRegistry,
	spec: { filter?: FilterNode | null; sorts?: readonly SortSpec[] | null; groupBy?: GroupBySpec | null },
	source: FilterGroup | null,
	manual: boolean
): boolean {
	const known = eligibility.get(key);
	if (known !== undefined) return known;
	let ok = !manual && source !== null;
	if (ok) {
		const filterProps = new Set<string>();
		propsOf(spec.filter, filterProps);
		propsOf(source, filterProps);
		for (const id of filterProps) {
			if (SYSTEM.has(id)) continue;
			const type = registry.get(id)?.type;
			if (!type || !FILTER_TYPES.has(type)) ok = false;
		}
		for (const s of spec.sorts ?? []) {
			const type = registry.get(s.prop)?.type;
			if (!type || !FILTER_TYPES.has(type)) ok = false;
		}
		if (spec.groupBy) {
			const type = registry.get(spec.groupBy.prop)?.type;
			if (!type || !GROUP_TYPES.has(type)) ok = false;
		}
	}
	eligibility.set(key, ok);
	return ok;
}

export const valuesOfSnap = (snap: PageSnap): PageValues => ({ ...snap.values, $parent: snap.parentId, $teamspace: snap.teamspaceId });

export interface MemoryContext {
	cache: PageCache;
	registry: EavRegistry;
	me: string | undefined;
	now: number;
	collectionId: string;
	source: FilterGroup;
	filter: FilterNode | null | undefined;
	groupBy: GroupBySpec | null;
	sorts: readonly SortSpec[];
}

export interface MemoryCheck {
	/** Candidate page id -> snapshot of the ones that exist. */
	snaps: Map<string, PageSnap | null>;
	/** Matching pages: number -> the group keys. */
	matched: Map<number, string[]>;
	/** Sort tuples of the matching pages. */
	tuples: Map<number, SortTuple>;
}

/** Membership, groups and sort tuples of `candidates` from the cache: what `matchesFilterMany`, `groupKeysOf` and `sortKeyOf` answer from SQL. */
export function checkInMemory(m: MemoryContext, candidates: readonly string[], flat: string): MemoryCheck {
	const snaps = m.cache.load(candidates);
	const ctx: EvalCtx = { registry: m.registry, meId: m.me, now: m.now, weekStartsOn: 1 };
	const matched = new Map<number, string[]>();
	const tuples = new Map<number, SortTuple>();
	const groupDef = m.groupBy ? m.registry.get(m.groupBy.prop) : undefined;
	const picked = m.cache.picked(m.collectionId);
	for (const id of candidates) {
		const snap = snaps.get(id);
		if (!snap || !snap.live) continue;
		const values = valuesOfSnap(snap);
		if (!(picked.has(id) || evaluate(m.source, values, ctx))) continue;
		if (m.filter && !evaluate(m.filter, values, ctx)) continue;
		matched.set(snap.num, m.groupBy ? (groupDef ? groupKeysOfValue(groupDef, m.groupBy, snap.values[m.groupBy.prop] ?? null, ctx) : ['$empty']) : [flat]);
		tuples.set(snap.num, {
			num: snap.num,
			id,
			rank: snap.rank,
			keys: m.sorts.map((s) => {
				const def = m.registry.get(s.prop);
				return def ? (sortKeyOf(def, snap.values[s.prop] ?? null) ?? null) : null;
			})
		});
	}
	return { snaps, matched, tuples };
}
