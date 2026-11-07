/**
 * "A new row created from a view gets values that satisfy the view's filter" (and the collection's
 * membership filter, and its defaults). `deriveDefaults` is pure: it picks, per property, a value that
 * satisfies every condition the filter puts on it, by generating candidates and checking each with the
 * oracle `evaluate`; an `or` group contributes its first satisfiable branch.
 */
import { andFilters, evaluate, isCondition, type Condition, type EvalCtx, type FilterNode, type FilterGroup } from '../../../../lib/shared/filter-ast';
import { DAY_MS, formatDate, operandInterval, rangeInterval, type DateOperand, type DateRangeOperand } from '../../../../lib/shared/dates';
import {
	isSystemField,
	type PropValue,
	type PropertyDef,
	type PropertyRegistry
} from '../../../../lib/shared/property-types';
import type { Values } from '../../../../lib/shared/protocol';
import type { WorkspaceDb } from '../../../db/workspace.client';
import { loadEavRegistry } from './registry';
import { all } from './sql';
import { collectionDefOf, loadCollectionRow, loadViewRow, viewDefOf } from './read';

export interface ViewDefaults {
	/** Initial values by property id (what `create.values` takes). */
	values: Values;
	/** Where the new row goes: a `$parent is X` condition's X, else the collection's page. */
	parentId: string | null;
	/** A `$teamspace is X` condition's X; undefined when the filter says nothing. */
	teamspaceId?: string | null;
	/** Whether the derived row satisfies the whole filter (false for contradictions or underivable conditions). */
	satisfies: boolean;
}

export interface DeriveOptions {
	registry: PropertyRegistry;
	/** Epoch ms for relative dates; default `Date.now()`. */
	now?: number;
	/** The signed-in user, for `is_me`. */
	meId?: string;
	/** Values a new row starts with before the filter is applied (the collection's defaults). */
	base?: Values;
}

const flatConditions = (node: FilterNode, out: Condition[], pick: (g: FilterGroup) => FilterNode | undefined): void => {
	if (isCondition(node)) {
		out.push(node);
		return;
	}
	if ('and' in node) node.and.forEach((n) => flatConditions(n, out, pick));
	else {
		const branch = pick(node);
		if (branch) flatConditions(branch, out, pick);
	}
};

function dateCandidates(def: PropertyDef, operand: unknown, ctx: EvalCtx): PropValue[] {
	const includeTime = def.type === 'date' && def.config.includeTime;
	const out: PropValue[] = [];
	const push = (ms: number) => out.push({ start: formatDate(ms, !includeTime && ms % DAY_MS === 0) });
	const iv =
		typeof operand === 'object' && operand !== null
			? 'range' in operand || ('kind' in operand && (operand.kind === 'named' || operand.kind === 'between'))
				? rangeInterval(operand as DateRangeOperand, ctx)
				: operandInterval(operand as DateOperand, ctx)
			: null;
	if (!iv) return out;
	for (const ms of [iv.start, iv.end - 1, iv.end, iv.start - DAY_MS, iv.end + DAY_MS]) push(ms);
	return out;
}

function candidates(def: PropertyDef, c: Condition, ctx: EvalCtx): PropValue[] {
	const op = c.value;
	switch (def.type) {
		case 'number':
		case 'unique_id':
			return typeof op === 'number' ? [op, op + 1, op - 1, 0, 1] : [0, 1];
		case 'checkbox':
			return [true, false];
		case 'select':
		case 'status':
			return [typeof op === 'string' ? op : '', ...def.config.options.map((o) => o.id)].filter((x) => x !== '');
		case 'multi_select':
			return [
				...(typeof op === 'string' ? [[op]] : []),
				...def.config.options.map((o) => [o.id])
			];
		case 'person':
		case 'files':
		case 'relation':
			return [...(typeof op === 'string' ? [[op]] : []), ...(ctx.meId ? [[ctx.meId]] : [])];
		case 'date':
			return dateCandidates(def, op, ctx);
		case 'email':
			return typeof op === 'string' && op.includes('@') ? [op] : [];
		default:
			return typeof op === 'string' ? [op, op + ' ', ' ' + op, op + 'x', 'x' + op] : [];
	}
}

/**
 * Derives the values a new row should start with so that it satisfies `filter`. Never throws: what it
 * cannot satisfy is reported through `satisfies: false`.
 */
export function deriveDefaults(filter: FilterNode | null | undefined, opts: DeriveOptions): ViewDefaults {
	const ctx: EvalCtx = { registry: opts.registry, now: opts.now ?? Date.now(), ...(opts.meId ? { meId: opts.meId } : {}) };
	const base: Values = { ...(opts.base ?? {}) };
	const node: FilterNode = filter ?? { and: [] };

	// For `or`, the first child whose own derivation satisfies it.
	const pick = (g: FilterGroup): FilterNode | undefined => {
		const kids = 'or' in g ? g.or : g.and;
		return kids.find((k) => {
			const d = solve(k);
			return d.satisfies;
		}) ?? kids[0];
	};
	function solve(n: FilterNode): ViewDefaults {
		const conds: Condition[] = [];
		flatConditions(n, conds, pick);
		const values: Values = {};
		let parentId: string | null = null;
		let teamspaceId: string | null | undefined;
		const byProp = new Map<string, Condition[]>();
		for (const c of conds) (byProp.get(c.prop) ?? byProp.set(c.prop, []).get(c.prop)!).push(c);
		for (const [prop, cs] of byProp) {
			if (isSystemField(prop)) {
				const is = cs.find((c) => c.op === 'is' && typeof c.value === 'string');
				if (prop === '$parent' && is) parentId = is.value as string;
				if (prop === '$teamspace' && is) teamspaceId = is.value as string;
				continue;
			}
			const def = opts.registry.get(prop);
			if (!def) continue;
			const holds = (candidate: PropValue | null) => cs.every((c) => evaluate(c, { [prop]: candidate }, ctx));
			const start = base[prop] ?? null;
			if (holds(start)) {
				if (start !== null) values[prop] = start;
				continue;
			}
			const found = cs.flatMap((c) => candidates(def, c, ctx)).find((cand) => holds(cand));
			if (found !== undefined) values[prop] = found;
			else if (holds(null)) values[prop] = null;
		}
		return { values, parentId, teamspaceId, satisfies: false };
	}

	const solved = solve(node);
	const values: Values = { ...base, ...solved.values };
	for (const [k, val] of Object.entries(values)) if (val === null) delete values[k];
	const check = {
		...values,
		...(solved.parentId ? { $parent: [solved.parentId] } : {}),
		...(solved.teamspaceId ? { $teamspace: [solved.teamspaceId] } : {})
	} as Values;
	const satisfies = evaluate(node, check, ctx);
	return {
		values,
		parentId: solved.parentId,
		...(solved.teamspaceId !== undefined ? { teamspaceId: solved.teamspaceId } : {}),
		satisfies
	};
}

export interface DefaultsOptions {
	meId?: string;
	now?: number;
}

/**
 * The initial values (and parent) of a row created from a view: the collection's defaults, adjusted so
 * the row satisfies the collection's membership filter AND the view's filter. `parentId` falls back to
 * the collection's page (the default parent of its rows).
 */
export async function defaultsForView(db: WorkspaceDb, viewId: string, options: DefaultsOptions = {}): Promise<ViewDefaults | null> {
	const viewRow = await loadViewRow(db, viewId);
	if (!viewRow) return null;
	const view = viewDefOf(viewRow);
	const collRow = await loadCollectionRow(db, view.collectionId);
	if (!collRow) return null;
	const collection = collectionDefOf(collRow);
	const registry = await loadEavRegistry(db);
	const d = deriveDefaults(andFilters(collection.sourceAst, view.filter), {
		registry,
		base: collection.defaults,
		...options
	});
	return { ...d, parentId: d.parentId ?? collection.pageId };
}

/** Same as {@link defaultsForView} for a collection with no view in hand (its own filter and defaults). */
export async function defaultsForCollection(db: WorkspaceDb, collectionId: string, options: DefaultsOptions = {}): Promise<ViewDefaults | null> {
	const [row] = await all<{ id: string }>(db, 'SELECT id FROM collection WHERE id = ? AND deleted_at IS NULL', collectionId);
	if (!row) return null;
	const collection = collectionDefOf((await loadCollectionRow(db, collectionId))!);
	const registry = await loadEavRegistry(db);
	const d = deriveDefaults(collection.sourceAst, { registry, base: collection.defaults, ...options });
	return { ...d, parentId: d.parentId ?? collection.pageId };
}
