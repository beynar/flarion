/**
 * `queryView`: one-shot read of a collection's view, the body of `WorkspaceDO.queryView` and of
 * `collection.query`. It resolves the view's spec (the view's filter ANDed with the caller's `spec.filter`
 * and `localFilter`; the caller's `sorts` and `groupBy` replace the view's), runs the engine with the
 * actor's visibility set, and turns the window's page numbers into display rows (`props_json`).
 */
import {
	andFilters,
	validateFilter,
	validateQuerySpec,
	type FilterGroup,
	type GroupBySpec,
	type QuerySpec,
	type SortSpec
} from '../../lib/shared/filter-ast';
import type { Values, ViewRow } from '../../lib/shared/protocol';
import { MAX_WINDOW } from '../../lib/shared/protocol';
import type { AccessLevel } from '../db/workspace.schema';
import type { WorkspaceDb } from '../db/workspace.client';
import { decorateValues, readCollection, usesNow } from '../objects/workspace/eav';
import { loadEavRegistry } from '../objects/workspace/eav/registry';
import { all, chunks, qmarks } from '../objects/workspace/eav/sql';
import { WorkspaceError, notFound } from '../objects/workspace/errors';
import { runQuery } from './index';
import type { QueryResult, ReferencedProps, RowRef, VisibleSet } from './types';

export interface QueryViewInput {
	collectionId: string;
	viewId?: string;
	/** ANDed with the view's filter; its `sorts` and `groupBy` (`null`: none) replace the view's. */
	spec?: { filter?: FilterGroup; sorts?: SortSpec[]; groupBy?: GroupBySpec | null };
	/** A `database_view` block's extra filter, ANDed with everything else. */
	localFilter?: FilterGroup;
	/** The window; per group when the view is grouped. */
	window: { offset?: number; limit?: number };
	/** Per-group windows by group key. */
	groupWindows?: Record<string, { offset?: number; limit?: number }>;
	/** Properties to carry in each row's `values` (default: all). */
	props?: string[];
}

export interface QueryViewGroup {
	key: string;
	total: number;
	rows: ViewRow[];
}

export interface QueryViewResult {
	rows: ViewRow[];
	total: number;
	/** Present when the view is grouped: `rows` is then empty. */
	groups?: QueryViewGroup[];
	/** The properties filtered, sorted, grouped and shown: what a live subscription registers. */
	props: ReferencedProps;
	/** The spec that ran. */
	spec: QuerySpec;
	seq: number;
	stats: QueryResult['stats'];
}

export interface QueryViewContext {
	userId: string | undefined;
	visible: VisibleSet;
	/** `$access` of the visible pages, when known. */
	levels?: ReadonlyMap<number, AccessLevel> | null;
	fallbackLevel?: AccessLevel;
	seq: number;
	now: number;
}

const clampWindow = (w: { offset?: number; limit?: number }): { offset: number; limit: number } => ({
	offset: Math.max(0, Math.floor(w.offset ?? 0)),
	limit: Math.min(MAX_WINDOW, Math.max(1, Math.floor(w.limit ?? 50)))
});

function parseValues(text: string): Values {
	try {
		return JSON.parse(text) as Values;
	} catch {
		return {};
	}
}

async function viewRows(db: WorkspaceDb, refs: readonly RowRef[], props: readonly string[] | undefined, ctx: QueryViewContext): Promise<ViewRow[]> {
	const byNum = new Map<number, { id: string; title: string; icon: string | null; cover: string | null; props_json: string }>();
	for (const part of chunks(
		refs.map((r) => r.num),
		90
	)) {
		const rows = await all<{ num: number; id: string; title: string; icon: string | null; cover: string | null; props_json: string }>(
			db,
			`SELECT num, id, title, icon, cover, props_json FROM page WHERE num IN (${qmarks(part.length)})`,
			...part
		);
		for (const r of rows) byNum.set(r.num, r);
	}
	const want = props ? new Set(props) : null;
	// Display values: relations to tombstones read as gone, two-way relations show their reverse side.
	const registry = await loadEavRegistry(db);
	const entries = refs.flatMap((ref) => {
		const r = byNum.get(ref.num);
		return r ? [{ ref, r, row: { id: r.id, num: ref.num, values: parseValues(r.props_json) } }] : [];
	});
	await decorateValues(db, registry, entries.map((e) => e.row), want);
	const out: ViewRow[] = [];
	for (const { ref, r, row } of entries) {
		let values = row.values;
		if (want) values = Object.fromEntries(Object.entries(values).filter(([k]) => want.has(k))) as Values;
		const access = ctx.levels?.get(ref.num) ?? ctx.fallbackLevel;
		out.push({ id: r.id, title: r.title, icon: r.icon, cover: r.cover, values, ...(access ? { access } : {}) });
	}
	return out;
}

/** Runs a view of a collection. Throws `NOT_FOUND` for an unknown collection or view, `VALIDATION_FAILED` for a bad spec. */
export async function queryViewRows(db: WorkspaceDb, input: QueryViewInput, ctx: QueryViewContext): Promise<QueryViewResult> {
	const found = await readCollection(db, input.collectionId);
	if (!found) throw notFound(`Collection "${input.collectionId}"`);
	const view = input.viewId ? found.views.find((v) => v.id === input.viewId) : undefined;
	if (input.viewId && !view) throw notFound(`View "${input.viewId}"`);

	// Only what the caller sent is validated: a saved view may outlive a property (it then matches nothing).
	const registry = await loadEavRegistry(db);
	const client = { ...(input.spec ?? {}), ...(input.spec?.groupBy === null ? { groupBy: undefined } : {}) } as QuerySpec;
	const checked = validateQuerySpec(client, registry);
	if (!checked.ok) throw new WorkspaceError('VALIDATION_FAILED', 'Validation failed', checked.issues.map((i) => ({ ...i, path: `/spec${i.path}` })));
	const primary = client.sorts?.[0];
	if (primary && (await usesNow(db, primary.prop)))
		throw new WorkspaceError('VALIDATION_FAILED', 'Validation failed', [
			{ path: '/spec/sorts/0/prop', code: 'now_sort', message: 'A formula that reads now() cannot be the primary sort of a view' }
		]);
	if (input.localFilter) {
		const f = validateFilter(input.localFilter, registry);
		if (!f.ok) throw new WorkspaceError('VALIDATION_FAILED', 'Validation failed', f.issues.map((i) => ({ ...i, path: `/localFilter${i.path}` })));
	}

	const groupBy = input.spec?.groupBy !== undefined ? input.spec.groupBy : (view?.groupBy ?? null);
	const spec: QuerySpec = {
		filter: andFilters(view?.filter, input.spec?.filter, input.localFilter),
		sorts: input.spec?.sorts ?? view?.sorts ?? [],
		...(groupBy ? { groupBy } : {})
	};
	const shown = [...new Set([...found.collection.shownProps, ...(view?.columns.columns.filter((c) => !c.hidden).map((c) => c.prop) ?? [])])];
	const window = clampWindow(input.window);
	const result = await runQuery(db, spec, {
		visible: ctx.visible,
		me: ctx.userId,
		now: ctx.now,
		window,
		collectionId: input.collectionId,
		shown,
		...(input.groupWindows ? { groupWindows: Object.fromEntries(Object.entries(input.groupWindows).map(([k, w]) => [k, clampWindow(w)])) } : {})
	});

	const rows = await viewRows(db, result.rows, input.props, ctx);
	let groups: QueryViewGroup[] | undefined;
	if (result.groups) {
		groups = [];
		for (const g of result.groups) groups.push({ key: g.key, total: g.total, rows: await viewRows(db, g.rows, input.props, ctx) });
	}
	return { rows, total: result.total, ...(groups ? { groups } : {}), props: result.props, spec, seq: ctx.seq, stats: result.stats };
}
