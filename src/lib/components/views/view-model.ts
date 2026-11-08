/**
 * Pure logic of the view host: which columns a view shows, the `view` subscription it asks for, the values a new
 * row starts with, group labels for boards, and the date arithmetic of the calendar and timeline. No DOM and no
 * store, so the tests run in node.
 */
import { parseIsoDate, DAY_MS, type DateOperand, type DateValue } from '#lib/shared/dates.ts';
import type { CollectionDef, ViewColumn, ViewDef, ViewOptions, ViewType } from '#lib/shared/definitions.ts';
import {
	GROUP_EMPTY,
	andFilters,
	isCondition,
	isGroup,
	type FilterGroup,
	type FilterNode,
	type GroupBySpec
} from '#lib/shared/filter-ast.ts';
import {
	GROUPABLE_TYPES,
	TITLE_PROP_ID,
	isDateValue,
	type PropValue,
	type PropertyDef,
	type PropertyRegistry,
	type PropertyType
} from '#lib/shared/property-types.ts';
import type { Subscription, Values } from '#lib/shared/protocol.ts';
import type { Member } from '#lib/shared/schemas.ts';
import { findOption, optionColorName, optionsOf, statusGroups } from '#lib/components/properties/helpers.ts';

// ───────────────────────────── columns ─────────────────────────────

export interface ColumnSpec {
	def: PropertyDef;
	width: number;
}

const WIDTHS: Partial<Record<PropertyType, number>> = {
	title: 280,
	text: 200,
	number: 120,
	select: 150,
	status: 150,
	multi_select: 200,
	date: 170,
	person: 160,
	checkbox: 100,
	url: 200,
	email: 200,
	phone: 160,
	files: 180,
	relation: 200,
	formula: 160,
	rollup: 160
};

export const defaultWidth = (type: PropertyType): number => WIDTHS[type] ?? 160;
export const TITLE_MIN_WIDTH = 140;

const titleDef = (props: readonly PropertyDef[]): PropertyDef =>
	props.find((p) => p.id === TITLE_PROP_ID) ?? ({ id: TITLE_PROP_ID, name: 'Name', type: 'title', config: {} } as PropertyDef);

/**
 * The columns a view shows, left to right: the title first (always), then the view's visible columns in its
 * order, or the collection's shown properties when the view lists none. Properties that no longer exist drop out.
 */
export function visibleColumns(view: Pick<ViewDef, 'columns'> | null, collection: Pick<CollectionDef, 'shownProps'> | null, props: readonly PropertyDef[]): ColumnSpec[] {
	const byId = new Map(props.map((p) => [p.id, p]));
	const listed = view?.columns.columns ?? [];
	const widthOf = (id: string, def: PropertyDef) => listed.find((c) => c.prop === id)?.width ?? defaultWidth(def.type);
	const ids = (listed.length > 0 ? listed.filter((c) => !c.hidden).map((c) => c.prop) : (collection?.shownProps ?? [])).filter((id) => id !== TITLE_PROP_ID);
	const title = titleDef(props);
	const out: ColumnSpec[] = [{ def: title, width: widthOf(TITLE_PROP_ID, title) }];
	const seen = new Set<string>([TITLE_PROP_ID]);
	for (const id of ids) {
		const def = byId.get(id);
		if (!def || seen.has(id)) continue;
		seen.add(id);
		out.push({ def, width: widthOf(id, def) });
	}
	return out;
}

export interface ColumnEntry {
	def: PropertyDef;
	hidden: boolean;
}

/** Every property the properties menu lists: the visible columns in order, then the hidden ones (the rest of the registry). */
export function allColumns(view: Pick<ViewDef, 'columns'> | null, collection: Pick<CollectionDef, 'shownProps'> | null, props: readonly PropertyDef[]): ColumnEntry[] {
	const shown = visibleColumns(view, collection, props);
	const shownIds = new Set(shown.map((c) => c.def.id));
	const hidden = props.filter((p) => !shownIds.has(p.id));
	return [...shown.map((c) => ({ def: c.def, hidden: false })), ...hidden.map((def) => ({ def, hidden: true }))];
}

/** The `columns_json` columns list for a given ordered entry list (hidden entries keep their place, flagged). */
export function columnsFromEntries(entries: readonly ColumnEntry[], widths: ReadonlyMap<string, number> | Record<string, number> = {}): ViewColumn[] {
	const width = (id: string) => (widths instanceof Map ? widths.get(id) : (widths as Record<string, number>)[id]);
	return entries.map((e) => {
		const w = width(e.def.id);
		return { prop: e.def.id, ...(w ? { width: Math.round(w) } : {}), ...(e.hidden ? { hidden: true } : {}) };
	});
}

/** The view's columns with one property shown or hidden, widths kept; adds the property when the view does not list it. */
export function withColumnShown(view: Pick<ViewDef, 'columns'>, collection: Pick<CollectionDef, 'shownProps'> | null, props: readonly PropertyDef[], id: string, show: boolean): ViewColumn[] {
	const entries = allColumns(view, collection, props).map((e) => (e.def.id === id ? { ...e, hidden: !show } : e));
	const widths = Object.fromEntries((view.columns.columns ?? []).filter((c) => c.width).map((c) => [c.prop, c.width!]));
	return columnsFromEntries(entries.filter((e) => e.def.id !== TITLE_PROP_ID || !e.hidden), widths);
}

/** Moves one entry (by id) to `index` in the ordered entry list. */
export function moveEntry<T extends { def: { id: string } }>(entries: readonly T[], id: string, index: number): T[] {
	const from = entries.findIndex((e) => e.def.id === id);
	if (from === -1) return [...entries];
	const next = [...entries];
	const [item] = next.splice(from, 1);
	next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
	return next;
}

// ───────────────────────────── view options ─────────────────────────────

export const optionsOfView = (view: Pick<ViewDef, 'columns'> | null): ViewOptions => view?.columns.options ?? {};

export const CARD_SIZES = ['small', 'medium', 'large'] as const;

/** The date property a calendar or timeline reads: its option, else the first date property. */
export function dateProps(view: Pick<ViewDef, 'columns'>, props: readonly PropertyDef[]): { start: PropertyDef | null; end: PropertyDef | null } {
	const o = optionsOfView(view);
	const dates = props.filter((p) => p.type === 'date');
	const start = (o.dateProp ? props.find((p) => p.id === o.dateProp) : undefined) ?? dates[0] ?? null;
	const end = o.endDateProp ? (props.find((p) => p.id === o.endDateProp) ?? null) : null;
	return { start, end };
}

/** The group-by a board uses: the view's, else the first status, select, person or checkbox property. */
export function defaultGroupProp(props: readonly PropertyDef[]): PropertyDef | null {
	for (const type of ['status', 'select', 'person', 'checkbox', 'multi_select'] as const) {
		const found = props.find((p) => p.type === type);
		if (found) return found;
	}
	return props.find((p) => GROUPABLE_TYPES.has(p.type) && p.type !== 'date') ?? null;
}

// ───────────────────────────── the subscription ─────────────────────────────

export const GROUPED_TYPES: ReadonlySet<ViewType> = new Set(['board']);

export interface SubscriptionInput {
	collectionId: string;
	view: ViewDef;
	/** The `database_view` block's local filter. */
	localFilter?: FilterGroup | null;
	/** More conditions ANDed on: the search box, the calendar's visible range. */
	extraFilter?: FilterGroup | null;
	props: readonly string[];
	limit: number;
}

/** The `view` subscription of a view. Sorts and group-by are sent as the view has them, so the store does not depend on the definition's arrival. */
export function viewSubscription(input: SubscriptionInput): Subscription {
	const { view } = input;
	const filter = andFilters(input.localFilter, input.extraFilter);
	const empty = 'and' in filter && filter.and.length === 0;
	const props = [...new Set(input.props)].slice(0, 200);
	return {
		kind: 'view',
		collectionId: input.collectionId,
		viewId: view.id,
		...(empty ? {} : { filter }),
		sorts: view.sorts,
		groupBy: GROUPED_TYPES.has(view.type) ? view.groupBy : null,
		props,
		limit: input.limit
	};
}

/** Every property a view's rows must carry: its columns and what its layout reads. */
export function neededProps(view: ViewDef, columns: readonly ColumnSpec[], extra: readonly (string | null | undefined)[] = []): string[] {
	const o = optionsOfView(view);
	const ids = [...columns.map((c) => c.def.id), view.groupBy?.prop, o.coverProp, o.dateProp, o.endDateProp, ...extra];
	return [...new Set(ids.filter((id): id is string => !!id && id !== TITLE_PROP_ID))];
}

/** A title search as a filter node. */
export function searchFilter(text: string): FilterGroup | null {
	const q = text.trim();
	return q ? { and: [{ prop: TITLE_PROP_ID, op: 'contains', value: q }] } : null;
}

/** A calendar's or timeline's visible range as a filter on its date property(ies): rows overlapping `[from, to)`. */
export function rangeFilter(startProp: string, endProp: string | null, from: string, to: string): FilterGroup {
	const within = (prop: string): FilterNode => ({
		prop,
		op: 'within',
		value: { kind: 'between', from: { kind: 'exact', date: from }, to: { kind: 'exact', date: to } }
	});
	return endProp ? { or: [within(startProp), within(endProp)] } : { and: [within(startProp)] };
}

// ───────────────────────────── new rows ─────────────────────────────


function operandStart(op: DateOperand, now: number): string {
	if (op.kind === 'exact') return op.date;
	const d = new Date(now);
	const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	if (op.unit === 'day') return new Date(day + op.offset * DAY_MS).toISOString().slice(0, 10);
	if (op.unit === 'week') return new Date(day + op.offset * 7 * DAY_MS).toISOString().slice(0, 10);
	if (op.unit === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + op.offset, d.getUTCDate())).toISOString().slice(0, 10);
	return new Date(Date.UTC(d.getUTCFullYear() + op.offset, d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}

/**
 * The values a conjunction of conditions pins down: `status is X` gives X, `tags contains Y` gives [Y],
 * `owner is me` gives [me], a checkbox, a number, a text, a relation or a date `is`. An OR group contributes its
 * first branch. Conditions that cannot be satisfied by one value (`is not`, `before`...) are left out. A
 * `$parent is P` condition is returned as the parent.
 */
export function valuesFromFilter(filter: FilterNode | null | undefined, registry: PropertyRegistry, meId: string, now = Date.now()): { values: Values; parentId?: string } {
	const values: Values = {};
	let parentId: string | undefined;
	const walk = (node: FilterNode): void => {
		if (isGroup(node)) {
			if ('and' in node) node.and.forEach(walk);
			else if (node.or[0]) walk(node.or[0]);
			return;
		}
		if (!isCondition(node)) return;
		if (node.prop === '$parent' && node.op === 'is' && typeof node.value === 'string') {
			parentId = node.value;
			return;
		}
		const def = registry.get(node.prop);
		if (!def || values[node.prop] !== undefined) return;
		const v = node.value;
		switch (def.type) {
			case 'select':
			case 'status':
				if (node.op === 'is' && typeof v === 'string') values[def.id] = v;
				break;
			case 'multi_select':
			case 'relation':
				if (node.op === 'contains' && typeof v === 'string') values[def.id] = [v];
				break;
			case 'person':
				if (node.op === 'is_me') values[def.id] = [meId];
				else if (node.op === 'contains' && typeof v === 'string') values[def.id] = [v];
				break;
			case 'checkbox':
				if (node.op === 'is' && typeof v === 'boolean') values[def.id] = v;
				break;
			case 'number':
				if (node.op === 'eq' && typeof v === 'number') values[def.id] = v;
				break;
			case 'text':
			case 'url':
			case 'email':
			case 'phone':
				if (node.op === 'is' && typeof v === 'string') values[def.id] = v;
				break;
			case 'date':
				if (node.op === 'is' && v && typeof v === 'object' && 'kind' in v && (v.kind === 'exact' || v.kind === 'relative')) {
					values[def.id] = { start: operandStart(v as DateOperand, now) };
				}
				break;
			default:
		}
	};
	if (filter) walk(filter);
	return { values, ...(parentId ? { parentId } : {}) };
}

/** What a new row of a view starts with: the collection's defaults, then the filters', then `extra` (a board column's group value). */
export function newRowInit(input: {
	collection: Pick<CollectionDef, 'pageId' | 'defaults' | 'sourceAst'>;
	view: Pick<ViewDef, 'filter'>;
	localFilter?: FilterGroup | null;
	registry: PropertyRegistry;
	meId: string;
	extra?: Values;
	now?: number;
}): { parentId: string; values: Values } {
	const source = valuesFromFilter(input.collection.sourceAst, input.registry, input.meId, input.now);
	const filter = valuesFromFilter(andFilters(input.view.filter, input.localFilter), input.registry, input.meId, input.now);
	return {
		parentId: filter.parentId ?? source.parentId ?? input.collection.pageId,
		values: { ...input.collection.defaults, ...source.values, ...filter.values, ...input.extra }
	};
}

/** The value a board column stands for, to start a card in it. `undefined` for the "no value" column. */
export function valueOfGroup(def: PropertyDef, key: string, spec?: GroupBySpec | null): PropValue | null | undefined {
	if (key === GROUP_EMPTY) return undefined;
	switch (def.type) {
		case 'select':
		case 'status':
			if (spec?.by === 'group') return (def.config as { groups?: { id: string; optionIds: string[] }[] }).groups?.find((g) => g.id === key)?.optionIds[0];
			return key;
		case 'multi_select':
		case 'person':
		case 'relation':
			return [key];
		case 'checkbox':
			return key === 'true';
		default:
			return undefined;
	}
}

// ───────────────────────────── groups ─────────────────────────────

export interface GroupMeta {
	key: string;
	label: string;
	color: string | null;
	/** True for the "no value" group. */
	empty: boolean;
}

/** How a board column is titled: an option's name and color, a person's name, "Checked"... */
export function groupMeta(def: PropertyDef | undefined, key: string, lookup: { member?: (id: string) => string | undefined; page?: (id: string) => string | undefined; spec?: GroupBySpec | null } = {}): GroupMeta {
	if (!def) return { key, label: key, color: null, empty: key === GROUP_EMPTY };
	if (key === GROUP_EMPTY) return { key, label: `No ${def.name.toLowerCase()}`, color: null, empty: true };
	switch (def.type) {
		case 'select':
		case 'status':
		case 'multi_select': {
			if (def.type === 'status' && lookup.spec?.by === 'group') {
				const g = statusGroups(def).find((x) => x.id === key);
				return { key, label: g?.name ?? key, color: optionColorName(g?.options[0]?.color), empty: false };
			}
			const o = findOption(def, key);
			return { key, label: o?.name ?? 'Unknown option', color: optionColorName(o?.color), empty: false };
		}
		case 'person':
		case 'created_by':
		case 'last_edited_by':
			return { key, label: lookup.member?.(key) ?? 'Deleted user', color: null, empty: false };
		case 'checkbox':
			return { key, label: key === 'true' ? 'Checked' : 'Unchecked', color: null, empty: false };
		case 'relation':
			return { key, label: lookup.page?.(key) ?? 'Deleted page', color: null, empty: false };
		case 'date':
			return { key, label: key, color: null, empty: false };
		default:
			return { key, label: key, color: null, empty: false };
	}
}

/** Names the options of a select-like property, in order (for the group editor's hidden list). */
export const optionNames = (def: PropertyDef): { id: string; name: string }[] => optionsOf(def).map((o) => ({ id: o.id, name: o.name }));

export const memberName = (members: readonly Member[], id: string): string | undefined => members.find((m) => m.userId === id)?.name;

// ───────────────────────────── dates: calendar and timeline ─────────────────────────────

export interface RowDates {
	/** `YYYY-MM-DD` (date-only) or an ISO instant. */
	start: string;
	/** Same format; null for a single date. */
	end: string | null;
}

/** The dates of a row from its start property (and optional end property); null when it has none. */
export function rowDates(startValue: PropValue | null | undefined, endValue?: PropValue | null): RowDates | null {
	const s = isDateValue(startValue) ? startValue : typeof startValue === 'string' && parseIsoDate(startValue) ? ({ start: startValue } as DateValue) : null;
	if (!s || !parseIsoDate(s.start)) return null;
	let end = s.end ?? null;
	if (endValue !== undefined && endValue !== null) {
		const e = isDateValue(endValue) ? endValue.start : typeof endValue === 'string' ? endValue : null;
		if (e && parseIsoDate(e)) end = e;
	}
	return { start: s.start, end };
}

/** A date value to store for a start/end pair. An end before the start is swapped; an end equal to the start is dropped. */
export function toDateValue(start: string, end: string | null): DateValue {
	if (!end || end === start) return { start };
	const a = parseIsoDate(start);
	const b = parseIsoDate(end);
	if (a && b && b.ms < a.ms) return { start: end, end: start };
	return { start, end };
}

export const addDaysIso = (iso: string, days: number): string => {
	const p = parseIsoDate(iso);
	if (!p) return iso;
	const d = new Date(p.ms + days * DAY_MS);
	return p.dateOnly ? d.toISOString().slice(0, 10) : d.toISOString().replace(/\.000Z$/, 'Z');
};

export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
