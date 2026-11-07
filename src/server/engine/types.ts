/**
 * Public types of the query engine (`src/server/engine`). The engine runs raw SQL over the typed EAV
 * tables, which bypasses viborm's permissions: every result is therefore intersected with the visibility
 * set the caller passes in (`QueryOptions.visible`), and with the live pages (`deleted_at IS NULL`).
 */
import type { GroupBySpec, SortSpec } from '../../lib/shared/filter-ast';

/** `page.num`s the actor may see: a Set, or a plain (sorted or not) array. */
export type VisibleSet = ReadonlySet<number> | readonly number[];

export interface Window {
	/** Rows to skip (default 0). */
	offset?: number;
	/** Rows to return (default: all of them). */
	limit?: number;
}

export interface QueryOptions {
	/**
	 * Pages the actor may see (from the Sync core's `visibleNums(actor)`). Everything is intersected with it.
	 * `null`: no restriction beyond liveness, for callers that intersect with each viewer's set themselves (the live loop).
	 */
	visible: VisibleSet | null;
	/** The signed-in user, for `is me`. */
	me?: string;
	/** Epoch ms of "now", for relative dates. */
	now: number;
	/** First day of the week: 1 = Monday (default), 0 = Sunday. */
	weekStartsOn?: 0 | 1;
	/** The window of the (ungrouped) result, or of each group of a grouped one. */
	window?: Window;
	/** Per-group windows of a grouped query, by group key; they replace `window` for that group. */
	groupWindows?: Readonly<Record<string, Window>>;
	/** The collection whose membership (source AST plus hand-picked members) the result is restricted to. */
	collectionId?: string;
	/** Properties the caller shows (only echoed back in `props.shown`). */
	shown?: readonly string[];
}

export interface RowRef {
	num: number;
	id: string;
}

export interface GroupResult {
	/** An option id, user id, page id, `true`/`false`, a date bucket (`YYYY-MM-DD`) or `$empty`. */
	key: string;
	/** Pages in the group (not just the window). */
	total: number;
	rows: RowRef[];
}

/** The properties a query reads: what a live subscription is indexed by. */
export interface ReferencedProps {
	filter: string[];
	sort: string[];
	group: string[];
	shown: string[];
	/** Properties read by the collection's source AST. */
	membership: string[];
	/** The union of all of the above. */
	all: string[];
}

export interface QueryStats {
	statements: number;
	/** Range scans over a whole property (or `page`). */
	scans: number;
	/** Candidate-driven lookups (`page IN (...)`). */
	probes: number;
	rowsRead: number;
	/** How the first sort key was served. */
	sort: 'none' | 'walk' | 'heap' | 'sort' | 'mixed';
	ms: number;
}

export interface QueryResult {
	/** Pages matching (all groups together, a multi-valued page counted once). */
	total: number;
	/** The window of an ungrouped query; empty when grouped. */
	rows: RowRef[];
	groups?: GroupResult[];
	props: ReferencedProps;
	stats: QueryStats;
}

/** What the live loop needs to place a page in a sorted window. */
export interface SortTuple {
	num: number;
	id: string;
	rank: string;
	/** One key per sort spec; `null` is empty. */
	keys: (string | number | null)[];
}

export type { GroupBySpec, SortSpec };
