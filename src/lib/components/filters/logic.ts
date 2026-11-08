/**
 * Pure logic of the filter builder, the sort editor and the group-by editor: operator labels and
 * defaults per property type, immutable edits of the filter tree by index path, pruning a working
 * draft (conditions may be incomplete while the user types) down to an AST that `validateFilter`
 * accepts, and readable summaries. No DOM and no store, so the tests run in node.
 */
import {
	DATE_UNITS,
	NAMED_RANGES,
	canonicalDate,
	dateOperandSchema,
	dateRangeOperandSchema,
	type DateOperand,
	type DateRangeOperand,
	type DateUnit,
	type NamedRange
} from '#lib/shared/dates.ts';
import {
	GROUP_EMPTY,
	GROUPABLE_TYPES,
	MAX_FILTER_DEPTH,
	NO_VALUE_OPS,
	filterDepth,
	isCondition,
	isGroup,
	resolveField,
	type Condition,
	type FilterGroup,
	type FilterNode,
	type FilterValue
} from '#lib/shared/filter-ast.ts';
import {
	TITLE_PROP_ID,
	filterOpsOf,
	propertyTypes,
	type FilterOp,
	type FilterValueKind,
	type PropertyDef,
	type PropertyRegistry
} from '#lib/shared/property-types.ts';
import * as v from 'valibot';
import { formatDateText, optionsOf } from '#lib/components/properties/helpers.ts';

export { MAX_FILTER_DEPTH, filterDepth as groupDepth };

// ───────────────────────────── operators ─────────────────────────────

/** Where operators sit in a menu; the first one a type allows is the default. */
const OP_ORDER: readonly FilterOp[] = [
	'contains',
	'not_contains',
	'is',
	'is_not',
	'starts_with',
	'ends_with',
	'eq',
	'neq',
	'gt',
	'gte',
	'lt',
	'lte',
	'before',
	'after',
	'on_or_before',
	'on_or_after',
	'within',
	'is_me',
	'is_not_me',
	'is_empty',
	'is_not_empty'
];

const OP_LABELS: Record<FilterOp, string> = {
	is: 'is',
	is_not: 'is not',
	contains: 'contains',
	not_contains: 'does not contain',
	starts_with: 'starts with',
	ends_with: 'ends with',
	eq: '=',
	neq: '≠',
	gt: '>',
	gte: '≥',
	lt: '<',
	lte: '≤',
	before: 'is before',
	after: 'is after',
	on_or_before: 'is on or before',
	on_or_after: 'is on or after',
	within: 'is within',
	is_empty: 'is empty',
	is_not_empty: 'is not empty',
	is_me: 'is me',
	is_not_me: 'is not me'
};

export const opLabel = (op: FilterOp): string => OP_LABELS[op];

export interface OpChoice {
	op: FilterOp;
	kind: FilterValueKind;
	label: string;
}

/** The operators a property allows, in menu order, with their labels and value kinds. */
export function opsFor(def: Pick<PropertyDef, 'type' | 'config'>): OpChoice[] {
	const map = filterOpsOf(def as PropertyDef);
	return OP_ORDER.flatMap((op) => {
		const kind = map[op];
		return kind === undefined ? [] : [{ op, kind, label: OP_LABELS[op] }];
	});
}

/** Properties a filter can reference: those with at least one operator. */
export const filterableProps = (properties: readonly PropertyDef[]): PropertyDef[] =>
	properties.filter((d) => opsFor(d).length > 0);

/** Properties a view can sort by (the title included). */
export const sortableProps = (properties: readonly PropertyDef[]): PropertyDef[] =>
	properties.filter((d) => propertyTypes[d.type].sortable);

/** Properties a view can group by. */
export const groupableProps = (properties: readonly PropertyDef[]): PropertyDef[] =>
	properties.filter((d) => GROUPABLE_TYPES.has(d.type));

/** The registry a builder validates against: the properties, plus the title when the list lacks it. */
export function registryOf(properties: readonly PropertyDef[]): PropertyRegistry {
	const map = new Map(properties.map((d) => [d.id, d]));
	if (!map.has(TITLE_PROP_ID)) map.set(TITLE_PROP_ID, { id: TITLE_PROP_ID, name: 'Name', type: 'title', config: {} });
	return { get: (id) => map.get(id) };
}

// ───────────────────────────── operands ─────────────────────────────

export type RelativeOperand = Extract<DateOperand, { kind: 'relative' }>;
export const DEFAULT_RELATIVE: RelativeOperand = { kind: 'relative', unit: 'day', offset: 0 };
export const DEFAULT_RANGE: DateRangeOperand = { kind: 'named', range: 'past_week' };

/** The value a new condition of this kind starts with; undefined where the user must still type or pick one. */
export function defaultOperand(kind: FilterValueKind, _def?: Pick<PropertyDef, 'type' | 'config'>): FilterValue | undefined {
	switch (kind) {
		case 'text':
			return '';
		case 'boolean':
			return true;
		case 'date':
			return { ...DEFAULT_RELATIVE };
		case 'date_range':
			return { ...DEFAULT_RANGE };
		default:
			return undefined;
	}
}

/** A new condition on `def`, with its first operator and that operator's default value. */
export function defaultCondition(def: Pick<PropertyDef, 'id' | 'type' | 'config'>): Condition {
	const first = opsFor(def)[0];
	if (!first) return { prop: def.id, op: 'is_empty' };
	return makeCondition(def.id, first.op, defaultOperand(first.kind, def));
}

function makeCondition(prop: string, op: FilterOp, value: FilterValue | undefined): Condition {
	return value === undefined || NO_VALUE_OPS.has(op) ? { prop, op } : { prop, op, value };
}

/** The condition after the user picked another property: the new type's first operator and value. */
export const retarget = (def: Pick<PropertyDef, 'id' | 'type' | 'config'>): Condition => defaultCondition(def);

/** The condition after the user picked another operator: the value stays when its kind does, else it resets. */
export function changeOp(condition: Condition, op: FilterOp, def: Pick<PropertyDef, 'type' | 'config'>): Condition {
	const map = filterOpsOf(def as PropertyDef);
	const from = map[condition.op];
	const to = map[op];
	if (to === undefined) return condition;
	if (from === to && to !== 'none') return { ...condition, op };
	return makeCondition(condition.prop, op, defaultOperand(to, def));
}

const UNIT_LABEL: Record<DateUnit, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };
export const DATE_UNIT_CHOICES = DATE_UNITS.map((unit) => ({ unit, label: UNIT_LABEL[unit] }));

const plural = (n: number, unit: DateUnit): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "Today", "Yesterday", "Tomorrow", "1 week ago", "In 2 months", "This week"... */
export function relativeLabel(operand: { unit: DateUnit; offset: number }): string {
	const { unit, offset } = operand;
	if (offset === 0) return unit === 'day' ? 'Today' : `This ${unit}`;
	if (unit === 'day' && offset === -1) return 'Yesterday';
	if (unit === 'day' && offset === 1) return 'Tomorrow';
	const n = Math.abs(offset);
	return offset < 0 ? `${plural(n, unit)} ago` : `In ${plural(n, unit)}`;
}

const NAMED_LABELS: Record<NamedRange, string> = {
	past_week: 'Past week',
	past_month: 'Past month',
	past_year: 'Past year',
	this_week: 'This week',
	this_month: 'This month',
	this_year: 'This year',
	next_week: 'Next week',
	next_month: 'Next month',
	next_year: 'Next year'
};
export const NAMED_RANGE_CHOICES = NAMED_RANGES.map((range) => ({ range, label: NAMED_LABELS[range] }));
export const namedRangeLabel = (range: NamedRange): string => NAMED_LABELS[range];

export function operandLabel(operand: DateOperand): string {
	return operand.kind === 'relative' ? relativeLabel(operand) : formatDateText(operand.date);
}

export function rangeLabel(range: DateRangeOperand): string {
	return range.kind === 'named' ? NAMED_LABELS[range.range] : `${operandLabel(range.from)} → ${operandLabel(range.to)}`;
}

// ───────────────────────────── completeness and pruning ─────────────────────────────

const validOperand = (x: unknown): x is DateOperand => {
	const r = v.safeParse(dateOperandSchema, x);
	return r.success && (r.output.kind !== 'exact' || canonicalDate(r.output.date) !== null);
};
const validRange = (x: unknown): x is DateRangeOperand => {
	const r = v.safeParse(dateRangeOperandSchema, x);
	return r.success && (r.output.kind === 'named' || (validOperand(r.output.from) && validOperand(r.output.to)));
};

/** Whether a value has the shape its kind needs (a text value must not be blank). */
export function isCompleteValue(kind: FilterValueKind, value: unknown): boolean {
	switch (kind) {
		case 'none':
			return true;
		case 'text':
			return typeof value === 'string' && value.trim() !== '';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'ref':
			return typeof value === 'string' && value !== '';
		case 'date':
			return validOperand(value);
		case 'date_range':
			return validRange(value);
	}
}

/** True when the condition names a known property and an allowed operator, and holds the value that operator needs. */
export function isCompleteCondition(condition: Condition, registry: PropertyRegistry): boolean {
	const field = resolveField(registry, condition.prop);
	const kind = field?.ops[condition.op];
	return kind !== undefined && isCompleteValue(kind, condition.value);
}

/**
 * The AST the engine can run: incomplete or invalid conditions and empty groups are dropped, valueless operators lose
 * their value, groups deeper than three levels are cut. The root always stays (an empty one is `{ and: [] }`).
 */
export function pruneFilter(filter: FilterGroup, registry: PropertyRegistry): FilterGroup {
	const walk = (node: FilterNode, level: number): FilterNode | null => {
		if (isGroup(node)) {
			if (level > MAX_FILTER_DEPTH) return null;
			const kind = kindOf(node);
			const kids = childrenOf(node)
				.map((k) => walk(k, level + 1))
				.filter((k): k is FilterNode => k !== null);
			return kids.length ? makeGroup(kind, kids) : null;
		}
		if (!isCondition(node) || !isCompleteCondition(node, registry)) return null;
		const kind = resolveField(registry, node.prop)?.ops[node.op];
		return kind === 'none' ? { prop: node.prop, op: node.op } : node;
	};
	const root = walk(filter, 1);
	return root && isGroup(root) ? root : { and: [] };
}

/** Number of conditions in a filter, nested groups included. */
export function countConditions(node: FilterNode | null | undefined): number {
	if (!node) return 0;
	if (isGroup(node)) return childrenOf(node).reduce((n, k) => n + countConditions(k), 0);
	return 1;
}

// ───────────────────────────── the tree ─────────────────────────────

export type GroupKind = 'and' | 'or';
/** Indexes from the root: `[]` is the root group, `[1, 0]` the first child of the root's second child. */
export type Path = readonly number[];

export const kindOf = (group: FilterGroup): GroupKind => ('and' in group ? 'and' : 'or');
export const childrenOf = (group: FilterGroup): FilterNode[] => ('and' in group ? group.and : group.or);
export const makeGroup = (kind: GroupKind, children: FilterNode[]): FilterGroup => (kind === 'and' ? { and: children } : { or: children });

export function getAtPath(root: FilterGroup, path: Path): FilterNode | undefined {
	let node: FilterNode = root;
	for (const i of path) {
		if (!isGroup(node)) return undefined;
		const next: FilterNode | undefined = childrenOf(node)[i];
		if (next === undefined) return undefined;
		node = next;
	}
	return node;
}

/** Rebuilds the tree with the node at `path` replaced by `fn(node)`; null removes it. A bad path changes nothing. */
function update(root: FilterGroup, path: Path, fn: (node: FilterNode) => FilterNode | null): FilterGroup {
	if (path.length === 0) {
		const out = fn(root);
		return out && isGroup(out) ? out : root;
	}
	const [i, ...rest] = path;
	const kids = childrenOf(root);
	const child = kids[i];
	if (child === undefined) return root;
	let next: FilterNode | null;
	if (rest.length === 0) next = fn(child);
	else if (isGroup(child)) next = update(child, rest, fn);
	else return root;
	const copy = [...kids];
	if (next === null) copy.splice(i, 1);
	else copy[i] = next;
	return makeGroup(kindOf(root), copy);
}

/** Replaces the node at `path` (the root with a group). */
export const setAtPath = (root: FilterGroup, path: Path, node: FilterNode): FilterGroup => update(root, path, () => node);

/** Removes the node at `path` (not the root). */
export const removeAt = (root: FilterGroup, path: Path): FilterGroup => (path.length === 0 ? root : update(root, path, () => null));

/** Inserts `node` into the group at `groupPath`, at `index` (the end by default). Refuses a group below the third level. */
export function insertAt(root: FilterGroup, groupPath: Path, node: FilterNode, index?: number): FilterGroup {
	if (isGroup(node) && groupPath.length + 1 >= MAX_FILTER_DEPTH) return root;
	return update(root, groupPath, (g) => {
		if (!isGroup(g)) return g;
		const kids = [...childrenOf(g)];
		kids.splice(index === undefined ? kids.length : Math.max(0, Math.min(index, kids.length)), 0, node);
		return makeGroup(kindOf(g), kids);
	});
}

/** Turns the group at `groupPath` from AND to OR or back. */
export const setGroupKind = (root: FilterGroup, groupPath: Path, kind: GroupKind): FilterGroup =>
	update(root, groupPath, (g) => (isGroup(g) ? makeGroup(kind, childrenOf(g)) : g));

/** Whether the group at `groupPath` may hold another group (groups nest at most three levels). */
export const canAddGroup = (groupPath: Path): boolean => groupPath.length + 1 < MAX_FILTER_DEPTH;

// ───────────────────────────── summaries ─────────────────────────────

export interface Named {
	userId: string;
	name: string;
}

/** A readable summary of one condition: `Status is Done`, `Due is within Past week`, `Owner is me`. */
export function describeCondition(
	condition: Condition,
	registry: PropertyRegistry,
	members: readonly Named[] = [],
	resolvePage?: (id: string) => string | undefined
): string {
	const field = resolveField(registry, condition.prop);
	const name = field?.def?.name ?? (condition.prop === '$parent' ? 'Parent' : condition.prop === '$teamspace' ? 'Teamspace' : condition.prop);
	const label = opLabel(condition.op);
	const kind = field?.ops[condition.op];
	if (kind === undefined || kind === 'none' || condition.value === undefined) return `${name} ${label}`;
	const value = condition.value;
	let text: string;
	switch (kind) {
		case 'ref': {
			const id = String(value);
			const type = field?.def?.type;
			if (field?.def && (type === 'select' || type === 'status' || type === 'multi_select')) text = optionsOf(field.def).find((o) => o.id === id)?.name ?? id;
			else if (type === 'person' || type === 'created_by' || type === 'last_edited_by') text = members.find((m) => m.userId === id)?.name ?? 'Deleted user';
			else text = resolvePage?.(id) ?? 'Deleted page';
			break;
		}
		case 'boolean':
			text = value === true ? 'Checked' : 'Unchecked';
			break;
		case 'date':
			text = validOperand(value) ? operandLabel(value) : '';
			break;
		case 'date_range':
			text = validRange(value) ? rangeLabel(value) : '';
			break;
		case 'text':
			text = `"${String(value)}"`;
			break;
		default:
			text = String(value);
	}
	return `${name} ${label} ${text}`;
}

/** Display name of a group key in a grouped view: an option's name, Checked/Unchecked, or "No <property>". */
export function groupKeyLabel(def: Pick<PropertyDef, 'type' | 'config' | 'name'> | undefined, key: string, members: readonly Named[] = []): string {
	if (key === GROUP_EMPTY) return `No ${def?.name ?? 'value'}`;
	if (!def) return key;
	if (def.type === 'checkbox') return key === 'true' ? 'Checked' : 'Unchecked';
	const option = optionsOf(def).find((o) => o.id === key);
	if (option) return option.name;
	if (def.type === 'person' || def.type === 'created_by' || def.type === 'last_edited_by') return members.find((m) => m.userId === key)?.name ?? 'Deleted user';
	return key;
}
