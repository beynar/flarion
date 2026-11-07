/**
 * The filter AST shared by the UI's filter builder, saved views, collection membership, the public
 * API and the P2 query engine, plus the sort and group-by specs.
 *
 * Shape
 *   FilterGroup = { and: FilterNode[] } | { or: FilterNode[] }
 *   FilterNode  = Condition | FilterGroup
 *   Condition   = { prop, op, value? }
 * The root is a group (level 1); groups nest up to MAX_FILTER_DEPTH (3) levels. An empty AND is
 * true (the "no filter" value is `{ and: [] }`), an empty OR is false.
 * `prop` is a property id or a system field (`$parent`, `$teamspace`), which is how membership
 * conditions are written: "parent = page" is `{prop:'$parent', op:'is', value: pageId}`, "tag = X"
 * is a select condition, "Project contains X" a relation condition.
 *
 * {@link evaluate} is the reference evaluator: deliberately naive, one boolean per page. The P2
 * query engine is tested against it on random data, so it favours obviousness over speed.
 * Semantics worth knowing:
 * - Text comparisons are case- and diacritic-insensitive (the same fold as the sort keys).
 * - `is_not`, `not_contains`, `neq`, `is_not_me` match empty values; `gt/gte/lt/lte/eq` do not.
 * - A checkbox with no value counts as unchecked.
 * - Date values are intervals (a day for date-only values, an instant for timed ones, a range when
 *   there is an end). `is` and `within` mean the intervals overlap; `before` means the value ends at
 *   or before the operand starts; `after` that it starts at or after the operand ends;
 *   `on_or_before` that it starts before the operand ends; `on_or_after` that it ends after the
 *   operand starts. All UTC.
 * - A condition on an unknown property, or with an operator the type does not allow, is false
 *   (saved views outlive deleted properties); {@link validateFilter} reports it.
 */
import * as v from 'valibot';
import {
	canonicalDate,
	dateOperandSchema,
	dateRangeOperandSchema,
	dateValueInterval,
	intervalsOverlap,
	operandInterval,
	rangeInterval,
	type DateCtx,
	type DateOperand,
	type DateRangeOperand,
	type DateUnit,
	DATE_UNITS
} from './dates.js';
import {
	FILTER_OPS,
	GROUPABLE_TYPES,
	SYSTEM_FIELDS,
	filterOpsOf,
	isDateValue,
	isSystemField,
	propertyTypes,
	sortKeyOf,
	valueClassOf,
	type FilterOp,
	type FilterOpMap,
	type FilterValueKind,
	type PropValue,
	type PropertyDef,
	type PropertyRegistry,
	type PropertyType,
	type ValueClass
} from './property-types.js';
import { fail, issue, ok, type Issue, type Result } from './result.js';
import { compareOptionalKeys, compareText, foldText, numberSortKey } from './sort-keys.js';

export type { FilterOp, FilterValueKind } from './property-types.js';
export { FILTER_OPS } from './property-types.js';

export const MAX_FILTER_DEPTH = 3;
export const MAX_FILTER_NODES = 200;
export const MAX_SORTS = 5;
/** Group key of pages with no value in the group-by property. */
export const GROUP_EMPTY = '$empty';

// ───────────────────────────── types ─────────────────────────────

export type FilterValue = string | number | boolean | DateOperand | DateRangeOperand;

export interface Condition {
	prop: string;
	op: FilterOp;
	value?: FilterValue;
}
export type AndGroup = { and: FilterNode[] };
export type OrGroup = { or: FilterNode[] };
export type FilterGroup = AndGroup | OrGroup;
export type FilterNode = Condition | FilterGroup;

export const EMPTY_FILTER: FilterGroup = { and: [] };

export const isGroup = (n: unknown): n is FilterGroup =>
	typeof n === 'object' && n !== null && ('and' in n || 'or' in n);
export const isCondition = (n: unknown): n is Condition =>
	typeof n === 'object' && n !== null && 'prop' in n && 'op' in n;

/** Operators that take no value. */
export const NO_VALUE_OPS: ReadonlySet<FilterOp> = new Set(['is_empty', 'is_not_empty', 'is_me', 'is_not_me']);

// ───────────────────────────── schemas ─────────────────────────────

const propRef = v.pipe(v.string(), v.minLength(1), v.maxLength(65));

export const filterValueSchema: v.GenericSchema<FilterValue> = v.union([
	v.pipe(v.string(), v.maxLength(2000)),
	v.pipe(v.number(), v.finite()),
	v.boolean(),
	dateOperandSchema,
	dateRangeOperandSchema
]);

export const conditionSchema: v.GenericSchema<Condition> = v.object({
	prop: propRef,
	op: v.picklist(FILTER_OPS),
	value: v.optional(filterValueSchema)
});

const MAX_CHILDREN = 50;
const children = <S extends v.GenericSchema>(s: S) => v.pipe(v.array(s), v.maxLength(MAX_CHILDREN));
const groupOf = <S extends v.GenericSchema>(s: S) =>
	v.union([v.strictObject({ and: children(s) }), v.strictObject({ or: children(s) })]);

// Three explicit levels instead of a recursive schema: no `lazy`, so the JSON Schema conversion
// for OpenAPI is exact, and the depth limit is structural.
const level3 = groupOf(conditionSchema);
const level2 = groupOf(v.union([conditionSchema, level3]));
export const filterGroupSchema: v.GenericSchema<FilterGroup> = groupOf(v.union([conditionSchema, level2])) as v.GenericSchema<FilterGroup>;

export const sortSpecSchema = v.object({
	prop: propRef,
	dir: v.picklist(['asc', 'desc']),
	/** Where empty values go; default `last` in both directions. */
	nulls: v.optional(v.picklist(['first', 'last']))
});
export type SortSpec = v.InferOutput<typeof sortSpecSchema>;
export const sortsSchema = v.pipe(v.array(sortSpecSchema), v.maxLength(MAX_SORTS));

const groupKey = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const groupKeys = v.pipe(v.array(groupKey), v.maxLength(500));

/**
 * How a view groups its pages (board columns, grouped lists).
 *
 * - `prop`: select, status, multi-select (a page appears in each of its groups), person, checkbox, relation,
 *   created/edited by, or a date.
 * - `sort`: the order of the groups. `manual` (default): `order`, then option order for select-like
 *   properties, then ascending; `asc` / `desc`: by label (option name, status group name, the key itself).
 * - `order`: group keys in the order the user dragged them (`manual` only). Keys it does not list follow in
 *   the default order; keys that are not groups right now are ignored. It may list {@link GROUP_EMPTY}: that
 *   is where the "No value" group sits (default: last, whatever the sort).
 * - `hidden`: group keys that are not shown (pages that belong only to hidden groups are not listed).
 * - `hideEmpty`: drop the groups that hold no page, and the "No value" group with them. (Without it the "No value"
 *   group is still only listed when it holds pages; hide it for good with `hidden: ['$empty']`.)
 * - `bucket`: date properties only, the bucket size (default `day`). Keys are `YYYY-MM-DD` bucket starts.
 * - `by`: status properties only: `option` (default) one group per status option, `group` one per status
 *   group (To-do, In progress, Complete); options outside every group land in "No value".
 */
export const groupBySpecSchema = v.object({
	prop: propRef,
	sort: v.optional(v.picklist(['manual', 'asc', 'desc'])),
	hideEmpty: v.optional(v.boolean()),
	bucket: v.optional(v.picklist(DATE_UNITS)),
	by: v.optional(v.picklist(['option', 'group'])),
	hidden: v.optional(groupKeys),
	order: v.optional(groupKeys)
});
export type GroupBySpec = v.InferOutput<typeof groupBySpecSchema>;

/** What a view (or a one-shot query) asks of the engine. */
export const querySpecSchema = v.object({
	filter: v.optional(filterGroupSchema),
	sorts: v.optional(sortsSchema),
	groupBy: v.optional(groupBySpecSchema)
});
export type QuerySpec = v.InferOutput<typeof querySpecSchema>;

export { GROUPABLE_TYPES } from './property-types.js';

// ───────────────────────────── fields ─────────────────────────────

export interface ResolvedField {
	id: string;
	ops: FilterOpMap;
	valueClass: ValueClass;
	/** Absent for system fields. */
	def?: PropertyDef;
}

export function resolveField(registry: PropertyRegistry, id: string): ResolvedField | undefined {
	if (isSystemField(id)) {
		const f = SYSTEM_FIELDS[id];
		return { id, ops: f.ops, valueClass: f.valueClass };
	}
	const def = registry.get(id);
	if (!def) return undefined;
	return { id, def, ops: filterOpsOf(def), valueClass: valueClassOf(def) };
}

const valueSchemaOfKind: Record<Exclude<FilterValueKind, 'none'>, v.GenericSchema> = {
	text: v.pipe(v.string(), v.maxLength(2000)),
	number: v.pipe(v.number(), v.finite()),
	boolean: v.boolean(),
	ref: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
	date: dateOperandSchema,
	date_range: dateRangeOperandSchema
};

// ───────────────────────────── validation ─────────────────────────────

/** Number of levels of nested groups (a lone condition is 0, a flat group 1). */
export function filterDepth(node: unknown): number {
	if (!isGroup(node)) return 0;
	const kids = (('and' in node ? node.and : node.or) as unknown[]) ?? [];
	let max = 0;
	for (const k of Array.isArray(kids) ? kids : []) max = Math.max(max, filterDepth(k));
	return 1 + max;
}

/**
 * Checks an AST against the property registry: structure, depth (3 levels), size, that every
 * property exists, that each operator is allowed for the property's type, and that each value has
 * the shape its operator needs. Reports every problem, not just the first.
 */
export function validateFilter(ast: unknown, registry: PropertyRegistry): Result<FilterGroup> {
	const issues: Issue[] = [];
	let nodes = 0;

	const walk = (node: unknown, path: string, level: number): void => {
		if (++nodes > MAX_FILTER_NODES) {
			if (nodes === MAX_FILTER_NODES + 1)
				issues.push(issue(path, 'too_large', `A filter holds at most ${MAX_FILTER_NODES} conditions and groups`));
			return;
		}
		if (typeof node !== 'object' || node === null || Array.isArray(node)) {
			issues.push(issue(path, 'invalid_node', 'Expected a condition or a group'));
			return;
		}
		const hasAnd = 'and' in node;
		const hasOr = 'or' in node;
		if (hasAnd || hasOr) {
			if (hasAnd && hasOr) {
				issues.push(issue(path, 'ambiguous_group', 'A group has either "and" or "or", not both'));
				return;
			}
			if (level > MAX_FILTER_DEPTH) {
				issues.push(issue(path, 'too_deep', `Groups nest at most ${MAX_FILTER_DEPTH} levels`));
				return;
			}
			const key = hasAnd ? 'and' : 'or';
			const kids = (node as Record<string, unknown>)[key];
			if (!Array.isArray(kids)) {
				issues.push(issue(`${path}/${key}`, 'invalid_group', 'A group holds an array'));
				return;
			}
			if (kids.length > MAX_CHILDREN)
				issues.push(issue(`${path}/${key}`, 'too_large', `A group holds at most ${MAX_CHILDREN} items`));
			kids.forEach((k, i) => walk(k, `${path}/${key}/${i}`, level + 1));
			return;
		}
		walkCondition(node as Record<string, unknown>, path);
	};

	const walkCondition = (c: Record<string, unknown>, path: string): void => {
		const { prop, op, value } = c;
		if (typeof prop !== 'string' || prop === '') {
			issues.push(issue(`${path}/prop`, 'invalid_prop', 'A condition needs a property'));
			return;
		}
		if (typeof op !== 'string' || !(FILTER_OPS as readonly string[]).includes(op)) {
			issues.push(issue(`${path}/op`, 'invalid_op', `Unknown operator "${String(op)}"`));
			return;
		}
		const field = resolveField(registry, prop);
		if (!field) {
			issues.push(issue(`${path}/prop`, 'unknown_property', `Unknown property "${prop}"`));
			return;
		}
		const kind = field.ops[op as FilterOp];
		if (kind === undefined) {
			const type = field.def?.type ?? 'relation';
			issues.push(issue(`${path}/op`, 'op_not_allowed', `Operator "${op}" is not allowed for ${type} property "${prop}"`));
			return;
		}
		if (kind === 'none') {
			if (value !== undefined)
				issues.push(issue(`${path}/value`, 'unexpected_value', `Operator "${op}" takes no value`));
			return;
		}
		if (value === undefined) {
			issues.push(issue(`${path}/value`, 'missing_value', `Operator "${op}" needs a value`));
			return;
		}
		const r = v.safeParse(valueSchemaOfKind[kind], value);
		if (!r.success)
			issues.push(issue(`${path}/value`, 'invalid_value', `Value for "${op}" must be a ${kind.replace('_', ' ')}`));
	};

	walk(ast, '', 1);
	if (isGroup(ast) === false && issues.length === 0)
		issues.push(issue('', 'root_not_group', 'The root of a filter is a group'));
	return issues.length ? fail(issues) : ok(ast as FilterGroup);
}

/** Checks sort specs: known, sortable properties, no repeats, at most MAX_SORTS. */
export function validateSorts(sorts: unknown, registry: PropertyRegistry): Result<SortSpec[]> {
	const parsed = v.safeParse(sortsSchema, sorts);
	if (!parsed.success)
		return fail(parsed.issues.map((i) => issue('', i.type, i.message)));
	const issues: Issue[] = [];
	const seen = new Set<string>();
	parsed.output.forEach((s, i) => {
		const def = isSystemField(s.prop) ? undefined : registry.get(s.prop);
		if (!def) issues.push(issue(`/${i}/prop`, 'unknown_property', `Cannot sort by "${s.prop}"`));
		else if (!propertyTypes[def.type].sortable)
			issues.push(issue(`/${i}/prop`, 'not_sortable', `${def.type} properties cannot be sorted`));
		if (seen.has(s.prop)) issues.push(issue(`/${i}/prop`, 'duplicate_sort', `"${s.prop}" is sorted twice`));
		seen.add(s.prop);
	});
	return issues.length ? fail(issues) : ok(parsed.output);
}

export function validateGroupBy(spec: unknown, registry: PropertyRegistry): Result<GroupBySpec> {
	const parsed = v.safeParse(groupBySpecSchema, spec);
	if (!parsed.success) return fail(parsed.issues.map((i) => issue('', i.type, i.message)));
	const def = registry.get(parsed.output.prop);
	if (!def) return fail([issue('/prop', 'unknown_property', `Cannot group by "${parsed.output.prop}"`)]);
	if (!GROUPABLE_TYPES.has(def.type)) return fail([issue('/prop', 'not_groupable', `${def.type} properties cannot be grouped`)]);
	if (parsed.output.bucket && def.type !== 'date')
		return fail([issue('/bucket', 'bucket_not_allowed', 'Only date properties group in buckets')]);
	if (parsed.output.by && def.type !== 'status')
		return fail([issue('/by', 'by_not_allowed', 'Only status properties group by status group')]);
	if (parsed.output.by === 'group' && def.type === 'status' && def.config.groups.length === 0)
		return fail([issue('/by', 'no_status_groups', 'This status property has no groups')]);
	const issues: Issue[] = [];
	for (const key of ['hidden', 'order'] as const) {
		const list = parsed.output[key];
		if (list && new Set(list).size !== list.length) issues.push(issue(`/${key}`, 'duplicate_group', `"${key}" lists a group twice`));
	}
	if (issues.length) return fail(issues);
	return ok(parsed.output);
}

/** Validates a whole query spec (filter, sorts, group by) against a registry. */
export function validateQuerySpec(spec: unknown, registry: PropertyRegistry): Result<QuerySpec> {
	const parsed = v.safeParse(querySpecSchema, spec);
	if (!parsed.success) {
		// The structural schema rejects deep or malformed filters; give the precise reasons.
		const raw = (spec ?? {}) as Record<string, unknown>;
		if (raw.filter !== undefined) {
			const f = validateFilter(raw.filter, registry);
			if (!f.ok) return f;
		}
		return fail(parsed.issues.map((i) => issue('/' + (i.path ?? []).map((p) => String(p.key)).join('/'), i.type, i.message)));
	}
	const issues: Issue[] = [];
	const q = parsed.output;
	if (q.filter) {
		const r = validateFilter(q.filter, registry);
		if (!r.ok) issues.push(...r.issues.map((i) => ({ ...i, path: `/filter${i.path}` })));
	}
	if (q.sorts) {
		const r = validateSorts(q.sorts, registry);
		if (!r.ok) issues.push(...r.issues.map((i) => ({ ...i, path: `/sorts${i.path}` })));
	}
	if (q.groupBy) {
		const r = validateGroupBy(q.groupBy, registry);
		if (!r.ok) issues.push(...r.issues.map((i) => ({ ...i, path: `/groupBy${i.path}` })));
	}
	return issues.length ? fail(issues) : ok(q);
}

// ───────────────────────────── normalization ─────────────────────────────

const stable = (x: unknown): string =>
	JSON.stringify(x, (_k, val: unknown) =>
		val && typeof val === 'object' && !Array.isArray(val)
			? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
			: val
	);

function normCondition(c: Condition): Condition {
	if (NO_VALUE_OPS.has(c.op) || c.value === undefined) return { prop: c.prop, op: c.op };
	const value = c.value;
	if (typeof value === 'number') return { prop: c.prop, op: c.op, value: numberSortKey(value) };
	if (typeof value === 'object') {
		if (value.kind === 'exact')
			return { prop: c.prop, op: c.op, value: { kind: 'exact', date: canonicalDate(value.date) ?? value.date } };
		if (value.kind === 'between') {
			const fix = (o: DateOperand): DateOperand =>
				o.kind === 'exact' ? { kind: 'exact', date: canonicalDate(o.date) ?? o.date } : o;
			return { prop: c.prop, op: c.op, value: { kind: 'between', from: fix(value.from), to: fix(value.to) } };
		}
	}
	return { prop: c.prop, op: c.op, value };
}

const isTrue = (n: FilterNode): boolean => 'and' in n && n.and.length === 0;
const isFalse = (n: FilterNode): boolean => 'or' in n && n.or.length === 0;

function normNode(n: FilterNode): FilterNode {
	if (!isGroup(n)) return normCondition(n);
	const kind = 'and' in n ? 'and' : 'or';
	const kids = 'and' in n ? n.and : n.or;
	const out = new Map<string, FilterNode>();
	for (const k of kids) {
		const nk = normNode(k);
		if (isGroup(nk) && kind in nk) {
			// A group of the same kind merges into its parent (an empty one just vanishes).
			for (const g of (nk as Record<string, FilterNode[]>)[kind]) out.set(stable(g), g);
		} else if (isTrue(nk)) {
			if (kind === 'or') return { and: [] };
		} else if (isFalse(nk)) {
			if (kind === 'and') return { or: [] };
		} else out.set(stable(nk), nk);
	}
	// AND and OR are commutative and idempotent: sort and dedupe so equal filters get equal keys.
	const sorted = [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, node]) => node);
	if (sorted.length === 0) return kind === 'and' ? { and: [] } : { or: [] };
	if (sorted.length === 1) return sorted[0];
	return kind === 'and' ? { and: sorted } : { or: sorted };
}

/**
 * The canonical form of a filter: values canonicalized, valueless operators stripped, same-kind
 * nested groups merged, single-child groups unwrapped, constant groups folded, children sorted and
 * deduplicated. `evaluate(normalizeFilter(x)) === evaluate(x)` for every page. The result is always
 * a group, and never deeper than the input.
 */
export function normalizeFilter(input: FilterNode | null | undefined): FilterGroup {
	if (input === null || input === undefined) return { and: [] };
	const n = normNode(input);
	return isGroup(n) ? n : { and: [n] };
}

/** A stable string for a filter: equal for equivalent filters, so identical queries share a subscription. */
export const filterKey = (input: FilterNode | null | undefined): string => stable(normalizeFilter(input));

/** AND of two filters (a view's filter and a block's local filter), normalized. */
export function andFilters(...filters: (FilterNode | null | undefined)[]): FilterGroup {
	return normalizeFilter({ and: filters.filter((f): f is FilterNode => !!f) });
}

/** The properties a filter, sort and group-by read: what a subscription is indexed by. */
export function referencedProps(spec: { filter?: FilterNode | null; sorts?: readonly SortSpec[]; groupBy?: GroupBySpec | null }): Set<string> {
	const out = new Set<string>();
	const walk = (n: FilterNode): void => {
		if (isGroup(n)) (('and' in n ? n.and : n.or) as FilterNode[]).forEach(walk);
		else out.add(n.prop);
	};
	if (spec.filter) walk(spec.filter);
	spec.sorts?.forEach((s) => out.add(s.prop));
	if (spec.groupBy) out.add(spec.groupBy.prop);
	return out;
}

// ───────────────────────────── reference evaluator ─────────────────────────────

/** The values of one page by property id, plus `$parent` and `$teamspace`. Missing means empty. */
export type PageValues = Readonly<Record<string, PropValue | null | undefined>>;

export interface EvalCtx extends DateCtx {
	registry: PropertyRegistry;
	/** The signed-in user, for `is_me`. */
	meId?: string;
}

const refList = (val: PropValue | null | undefined): string[] =>
	Array.isArray(val) ? val : typeof val === 'string' && val !== '' ? [val] : [];

function evalCondition(c: Condition, values: PageValues, ctx: EvalCtx): boolean {
	const field = resolveField(ctx.registry, c.prop);
	if (!field) return false;
	if (field.ops[c.op] === undefined) return false;
	const val = values[c.prop] ?? null;
	const operand = c.value;

	switch (field.valueClass) {
		case 'text': {
			const empty = val === null || val === '';
			if (c.op === 'is_empty') return empty;
			if (c.op === 'is_not_empty') return !empty;
			if (typeof operand !== 'string') return false;
			const hay = foldText(typeof val === 'string' ? val : '');
			const needle = foldText(operand);
			switch (c.op) {
				case 'contains':
					return hay.includes(needle);
				case 'not_contains':
					return !hay.includes(needle);
				case 'is':
					return hay === needle;
				case 'is_not':
					return hay !== needle;
				case 'starts_with':
					return hay.startsWith(needle);
				case 'ends_with':
					return hay.endsWith(needle);
				default:
					return false;
			}
		}
		case 'number': {
			const n = typeof val === 'number' ? val : null;
			if (c.op === 'is_empty') return n === null;
			if (c.op === 'is_not_empty') return n !== null;
			if (typeof operand !== 'number') return false;
			switch (c.op) {
				case 'eq':
					return n !== null && n === operand;
				case 'neq':
					return n === null || n !== operand;
				case 'gt':
					return n !== null && n > operand;
				case 'gte':
					return n !== null && n >= operand;
				case 'lt':
					return n !== null && n < operand;
				case 'lte':
					return n !== null && n <= operand;
				default:
					return false;
			}
		}
		case 'boolean': {
			if (c.op !== 'is' || typeof operand !== 'boolean') return false;
			return (val === true) === operand;
		}
		case 'refs': {
			const list = refList(val);
			switch (c.op) {
				case 'is_empty':
					return list.length === 0;
				case 'is_not_empty':
					return list.length > 0;
				case 'is_me':
					return ctx.meId !== undefined && list.includes(ctx.meId);
				case 'is_not_me':
					return !(ctx.meId !== undefined && list.includes(ctx.meId));
				default:
			}
			if (typeof operand !== 'string') return false;
			switch (c.op) {
				case 'is':
				case 'contains':
					return list.includes(operand);
				case 'is_not':
				case 'not_contains':
					return !list.includes(operand);
				default:
					return false;
			}
		}
		case 'date': {
			const dv = isDateValue(val) ? val : typeof val === 'string' && val !== '' ? { start: val } : null;
			const iv = dv ? dateValueInterval(dv) : null;
			if (c.op === 'is_empty') return iv === null;
			if (c.op === 'is_not_empty') return iv !== null;
			if (iv === null || operand === undefined || typeof operand !== 'object') return false;
			if (c.op === 'within') {
				const r = rangeInterval(operand as DateRangeOperand, ctx);
				return r !== null && intervalsOverlap(iv, r);
			}
			const o = operandInterval(operand as DateOperand, ctx);
			if (o === null) return false;
			switch (c.op) {
				case 'is':
					return intervalsOverlap(iv, o);
				case 'before':
					return iv.end <= o.start;
				case 'after':
					return iv.start >= o.end;
				case 'on_or_before':
					return iv.start < o.end;
				case 'on_or_after':
					return iv.end > o.start;
				default:
					return false;
			}
		}
	}
}

/** Whether a page's values satisfy the filter. The oracle for the query engine. */
export function evaluate(ast: FilterNode, values: PageValues, ctx: EvalCtx): boolean {
	if (isGroup(ast)) {
		if ('and' in ast) return ast.and.every((n) => evaluate(n, values, ctx));
		return ast.or.some((n) => evaluate(n, values, ctx));
	}
	return evalCondition(ast, values, ctx);
}

// ───────────────────────────── reference sort and group ─────────────────────────────

export interface Row {
	id: string;
	values: PageValues;
	/** Sibling rank (or the hand-picked member's): breaks ties between equal sort keys before the id does. */
	rank?: string;
}

function sortKeyForRow(row: Row, prop: string, registry: PropertyRegistry) {
	const def = registry.get(prop);
	if (!def) return null;
	return sortKeyOf(def, row.values[prop] ?? null);
}

/** Order of rows under sort specs; ties break by rank (when rows carry one), then id, so the order is total and stable. */
export function compareRows(a: Row, b: Row, sorts: readonly SortSpec[], registry: PropertyRegistry): number {
	for (const s of sorts) {
		const c = compareOptionalKeys(
			sortKeyForRow(a, s.prop, registry),
			sortKeyForRow(b, s.prop, registry),
			s.dir,
			s.nulls ?? 'last'
		);
		if (c !== 0) return c;
	}
	if (a.rank !== undefined && b.rank !== undefined && a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
	return compareText(a.id, b.id);
}

export function sortRows<R extends Row>(rows: readonly R[], sorts: readonly SortSpec[], registry: PropertyRegistry): R[] {
	return [...rows].sort((a, b) => compareRows(a, b, sorts, registry));
}

/** Filters, then sorts: the whole reference query for one view. */
export function queryRows<R extends Row>(
	rows: readonly R[],
	spec: QuerySpec,
	ctx: EvalCtx
): R[] {
	const filter = spec.filter;
	const kept = filter ? rows.filter((r) => evaluate(filter, r.values, ctx)) : [...rows];
	return sortRows(kept, spec.sorts ?? [], ctx.registry);
}

export interface RowGroup<R extends Row = Row> {
	key: string;
	rows: R[];
}

function bucketKey(unit: DateUnit, dateStart: string, ctx: DateCtx): string | null {
	const iv = dateValueInterval({ start: dateStart });
	if (!iv) return null;
	// Reuse the unit arithmetic through an interval anchored at the value.
	const anchored = operandInterval({ kind: 'relative', unit, offset: 0 }, { ...ctx, now: iv.start });
	return anchored ? new Date(anchored.start).toISOString().slice(0, 10) : null;
}

/** Groups the property lists as groups even when no page is in them yet (a board's empty columns), in this order. */
function knownGroupKeys(def: PropertyDef, spec: GroupBySpec): string[] {
	switch (def.type) {
		case 'select':
		case 'multi_select':
			return def.config.options.map((o) => o.id);
		case 'status':
			return spec.by === 'group' ? def.config.groups.map((g) => g.id) : def.config.options.map((o) => o.id);
		case 'checkbox':
			return ['false', 'true'];
		default:
			return [];
	}
}

/** What `asc` / `desc` sort a group by: its option or status group name, else its key. */
function groupLabel(def: PropertyDef, spec: GroupBySpec, key: string): string {
	switch (def.type) {
		case 'select':
		case 'multi_select':
			return def.config.options.find((o) => o.id === key)?.name ?? key;
		case 'status':
			return spec.by === 'group'
				? (def.config.groups.find((g) => g.id === key)?.name ?? key)
				: (def.config.options.find((o) => o.id === key)?.name ?? key);
		default:
			return key;
	}
}

/**
 * The group keys of one value of the group-by property (several for a multi-valued one, `GROUP_EMPTY` for no
 * value). The value must already hold only live relation targets. Pure: the oracle and `groupKeysOf` use it.
 */
export function groupKeysOfValue(def: PropertyDef, spec: GroupBySpec, val: PropValue | null | undefined, ctx: DateCtx): string[] {
	switch (def.type) {
		case 'checkbox':
			return [val === true ? 'true' : 'false'];
		case 'date': {
			const start = isDateValue(val) ? val.start : typeof val === 'string' ? val : null;
			const k = start ? bucketKey(spec.bucket ?? 'day', start, ctx) : null;
			return [k ?? GROUP_EMPTY];
		}
		case 'status': {
			const list = refList(val);
			if (spec.by === 'group') {
				const g = list.length ? def.config.groups.find((x) => x.optionIds.includes(list[0])) : undefined;
				return [g ? g.id : GROUP_EMPTY];
			}
			return list.length ? list : [GROUP_EMPTY];
		}
		default: {
			const list = refList(val);
			return list.length ? list : [GROUP_EMPTY];
		}
	}
}

/**
 * The groups to list, in order: the known groups (select options, status groups, checkbox false/true) and every
 * group that has pages (`counts`), arranged by `sort` and `order`, with the "No value" group where `order` puts it
 * (default last) and only when it has pages, minus `hidden` and, with `hideEmpty`, the groups without pages and
 * the "No value" group.
 * See {@link groupBySpecSchema}.
 */
export function orderGroupKeys(def: PropertyDef, spec: GroupBySpec, counts: ReadonlyMap<string, number>): string[] {
	const known = knownGroupKeys(def, spec);
	const all = new Set<string>(known);
	for (const k of counts.keys()) if (k !== GROUP_EMPTY) all.add(k);
	const mode = spec.sort ?? 'manual';
	let base = [...all];
	if (mode === 'manual') {
		const rank = new Map(known.map((k, i) => [k, i]));
		base.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || compareText(a, b));
		if (spec.order?.length) {
			const pinned = [...new Set(spec.order.filter((k) => k !== GROUP_EMPTY && all.has(k)))];
			const pin = new Set(pinned);
			base = [...pinned, ...base.filter((k) => !pin.has(k))];
		}
	} else {
		base.sort((a, b) => compareText(groupLabel(def, spec, a), groupLabel(def, spec, b)) || compareText(a, b));
		if (mode === 'desc') base.reverse();
	}
	let at = base.length;
	if (mode === 'manual' && spec.order) {
		const i = spec.order.indexOf(GROUP_EMPTY);
		if (i >= 0) at = new Set(spec.order.slice(0, i).filter((k) => k !== GROUP_EMPTY && all.has(k))).size;
	}
	base.splice(at, 0, GROUP_EMPTY);
	const hidden = new Set(spec.hidden ?? []);
	return base.filter((k) => {
		if (hidden.has(k)) return false;
		const n = counts.get(k) ?? 0;
		return k === GROUP_EMPTY ? n > 0 && !spec.hideEmpty : !(spec.hideEmpty && n === 0);
	});
}

/**
 * Splits already-sorted rows into groups (see {@link groupBySpecSchema} for the spec and {@link orderGroupKeys}
 * for the order). A multi-valued row appears in each of its groups; a row whose groups are all hidden appears in
 * none.
 */
export function groupRows<R extends Row>(
	rows: readonly R[],
	spec: GroupBySpec,
	ctx: EvalCtx
): RowGroup<R>[] {
	const def = ctx.registry.get(spec.prop);
	if (!def) return [{ key: GROUP_EMPTY, rows: [...rows] }];
	const groups = new Map<string, R[]>();
	for (const row of rows)
		for (const k of groupKeysOfValue(def, spec, row.values[spec.prop] ?? null, ctx)) (groups.get(k) ?? groups.set(k, []).get(k)!).push(row);
	const counts = new Map([...groups].map(([k, list]) => [k, list.length]));
	return orderGroupKeys(def, spec, counts).map((key) => ({ key, rows: groups.get(key) ?? [] }));
}
