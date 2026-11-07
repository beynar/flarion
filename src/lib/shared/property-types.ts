/**
 * The property type registry: for every type its config schema, storage table, filter operators,
 * value schema, sort key, and the codecs between a value and its typed EAV rows.
 *
 * Values (what `setProp`, `props_json`, snapshots and the public API carry)
 *   title, text, url, email, phone, ai ........ string
 *   number, unique_id ......................... number
 *   select, status ............................ string, an option id
 *   multi_select .............................. string[], option ids
 *   date ...................................... DateValue {start, end?}, ISO 8601
 *   person, files, relation ................... string[] (user ids, file ids, target page ids)
 *   checkbox .................................. boolean
 *   created_time, last_edited_time ............ ISO datetime string      } read from `page` columns,
 *   created_by, last_edited_by ................ user id string           } never stored in EAV
 *   rollup, formula ........................... by `config.resultType`: string | number | boolean | DateValue
 * An empty value is `null` (never `''` or `[]`; {@link normalizeValue} maps them).
 *
 * EAV rows (`p_text`, `p_num`, `p_date`, `p_ref`, keyed `(prop, v, page)`)
 * - `v` is the sort key: text is folded ({@link textSortKey}), numbers are numbers, dates are epoch
 *   ms (`v_end` for the end of a range), refs are ids. Text rows are therefore LOSSY: `decode`
 *   returns the folded text, and display always reads `props_json`. Every other type round-trips.
 * - Multi-values are one row per member. Rows are an unordered set: `decode` returns members in
 *   config option order (select types) or sorted by `v`; the user's own order lives in `props_json`.
 * - Option ids, user ids and file ids are stored as text, relation targets as the target's integer
 *   `page.num`. The `p_ref.v` column therefore needs no type affinity (STRICT `ANY`, or BLOB).
 * - Checkbox stores a row for `true` (1) and for `false` (0); no row means empty.
 * - Date-only values are stored at UTC midnight. Decoding cannot tell a date-only value from a
 *   timed one at exactly 00:00:00.000Z: it answers date-only unless `config.includeTime` is set.
 * - Computed types (rollup, formula, ai) write rows with `computed: true`.
 */
import * as v from 'valibot';
import {
	DAY_MS,
	canonicalDate,
	dateValueSchema,
	formatDate,
	parseIsoDate,
	type DateValue
} from './dates.js';
import { fail, fromValibot, issue, ok, type Issue, type Result } from './result.js';
import { numberSortKey, textSortKey, type SortKey } from './sort-keys.js';

// ───────────────────────────── identifiers ─────────────────────────────

/** The reserved id of the title property every workspace has. */
export const TITLE_PROP_ID = 'title';

export const PROPERTY_TYPES = [
	'title',
	'text',
	'url',
	'email',
	'phone',
	'number',
	'select',
	'status',
	'multi_select',
	'date',
	'person',
	'checkbox',
	'files',
	'relation',
	'rollup',
	'formula',
	'created_time',
	'created_by',
	'last_edited_time',
	'last_edited_by',
	'unique_id',
	'ai'
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export type EavTable = 'p_text' | 'p_num' | 'p_date' | 'p_ref';
/** `page` marks the types read from `page` columns, which have no EAV rows. */
export type StorageTable = EavTable | 'page';

export interface EavRow {
	table: EavTable;
	v: string | number;
	/** End of a date range (epoch ms); only `p_date`. */
	v_end?: number | null;
	/** Set on rows written by the engine (rollup, formula, ai). */
	computed?: true;
}

/** Ids <-> page numbers, needed by the relation codec only. */
export interface CodecCtx {
	pageNum?: (pageId: string) => number | undefined;
	pageId?: (num: number) => string | undefined;
}

export class CodecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CodecError';
	}
}

// ───────────────────────────── filter operators ─────────────────────────────

export const FILTER_OPS = [
	'is',
	'is_not',
	'contains',
	'not_contains',
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
	'is_empty',
	'is_not_empty',
	'is_me',
	'is_not_me'
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** What an operator's `value` holds. */
export type FilterValueKind = 'none' | 'text' | 'number' | 'boolean' | 'ref' | 'date' | 'date_range';
export type FilterOpMap = Readonly<Partial<Record<FilterOp, FilterValueKind>>>;

const EMPTY_OPS = { is_empty: 'none', is_not_empty: 'none' } as const;
export const TEXT_OPS: FilterOpMap = {
	contains: 'text',
	not_contains: 'text',
	is: 'text',
	is_not: 'text',
	starts_with: 'text',
	ends_with: 'text',
	...EMPTY_OPS
};
export const NUMBER_OPS: FilterOpMap = {
	eq: 'number',
	neq: 'number',
	gt: 'number',
	gte: 'number',
	lt: 'number',
	lte: 'number',
	...EMPTY_OPS
};
export const SELECT_OPS: FilterOpMap = { is: 'ref', is_not: 'ref', ...EMPTY_OPS };
export const MULTI_OPS: FilterOpMap = { contains: 'ref', not_contains: 'ref', ...EMPTY_OPS };
export const DATE_OPS: FilterOpMap = {
	is: 'date',
	before: 'date',
	after: 'date',
	on_or_before: 'date',
	on_or_after: 'date',
	within: 'date_range',
	...EMPTY_OPS
};
export const PERSON_OPS: FilterOpMap = {
	contains: 'ref',
	not_contains: 'ref',
	is_me: 'none',
	is_not_me: 'none',
	...EMPTY_OPS
};
export const CHECKBOX_OPS: FilterOpMap = { is: 'boolean' };
export const FILES_OPS: FilterOpMap = { ...EMPTY_OPS };
export const RELATION_OPS: FilterOpMap = MULTI_OPS;
export const UNIQUE_ID_OPS: FilterOpMap = { eq: 'number' };

// ───────────────────────────── config schemas ─────────────────────────────

export const SELECT_COLORS = [
	'default',
	'gray',
	'brown',
	'orange',
	'yellow',
	'green',
	'blue',
	'purple',
	'pink',
	'red'
] as const;

/** Ids of pages, users, files, options, properties. `$` is reserved for system fields. */
export const idSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(64), v.regex(/^[A-Za-z0-9_.:-]+$/));
export const nameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));

export const selectOptionSchema = v.object({
	id: idSchema,
	name: nameSchema,
	color: v.optional(v.picklist(SELECT_COLORS), 'default')
});
export type SelectOption = v.InferOutput<typeof selectOptionSchema>;

export const statusGroupSchema = v.object({
	id: idSchema,
	name: nameSchema,
	color: v.optional(v.picklist(SELECT_COLORS), 'default'),
	optionIds: v.array(idSchema)
});
export type StatusGroup = v.InferOutput<typeof statusGroupSchema>;

export const COMPUTED_RESULT_TYPES = ['text', 'number', 'date', 'checkbox'] as const;
export type ComputedResultType = (typeof COMPUTED_RESULT_TYPES)[number];

export const ROLLUP_FUNCTIONS = [
	'count_all',
	'count_values',
	'count_unique',
	'empty',
	'not_empty',
	'percent_empty',
	'percent_not_empty',
	'sum',
	'average',
	'median',
	'min',
	'max',
	'range',
	'earliest',
	'latest',
	'date_range',
	'checked',
	'unchecked',
	'percent_checked',
	'percent_unchecked',
	'show_unique',
	'show_original'
] as const;
export type RollupFunction = (typeof ROLLUP_FUNCTIONS)[number];

export const AI_PROPERTY_KINDS = ['summary', 'keywords', 'translation', 'custom'] as const;

const EmptyConfig = v.object({});

/** Suffix of the id of a two-way relation's synthetic reverse property: `<relation id>:reverse`. */
export const REVERSE_SUFFIX = ':reverse';
export const reverseIdOf = (relationId: string): string => relationId + REVERSE_SUFFIX;
export const isReverseId = (id: string): boolean => id.endsWith(REVERSE_SUFFIX) && id.length > REVERSE_SUFFIX.length;
/** The relation a synthetic reverse id mirrors. */
export const relationOfReverse = (id: string): string => id.slice(0, id.length - REVERSE_SUFFIX.length);
/** The longest id a two-way relation can have: its reverse id must still be a valid property id (64). */
export const MAX_TWO_WAY_ID_LENGTH = 64 - REVERSE_SUFFIX.length;

export const propertyConfigSchemas = {
	title: EmptyConfig,
	text: EmptyConfig,
	url: EmptyConfig,
	email: EmptyConfig,
	phone: EmptyConfig,
	number: v.object({
		format: v.optional(
			v.picklist(['number', 'number_with_commas', 'percent', 'dollar', 'euro', 'pound', 'yen']),
			'number'
		),
		precision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10)))
	}),
	select: v.object({ options: v.optional(v.array(selectOptionSchema), []) }),
	status: v.object({
		options: v.optional(v.array(selectOptionSchema), []),
		groups: v.optional(v.array(statusGroupSchema), [])
	}),
	multi_select: v.object({ options: v.optional(v.array(selectOptionSchema), []) }),
	date: v.object({ includeTime: v.optional(v.boolean(), false) }),
	person: EmptyConfig,
	checkbox: EmptyConfig,
	files: EmptyConfig,
	relation: v.object({
		/** The collection whose pages the relation points at; null/absent: any page. */
		collectionId: v.optional(v.nullable(idSchema)),
		limit: v.optional(v.picklist(['one', 'many']), 'many'),
		/**
		 * Two-way: the target pages show the reverse side as a synthetic property (id `<id>:reverse`, see
		 * {@link reverseIdOf}), computed by a range scan of `p_ref` on `(prop, v)`. No mirrored rows are stored.
		 */
		twoWay: v.optional(v.boolean()),
		/** Name of the synthetic reverse property (default: "<name> (reverse)"). */
		reverseName: v.optional(nameSchema),
		/** Set by the server on the synthetic reverse property only: the id of the relation it mirrors. Never stored. */
		reverseOf: v.optional(idSchema)
	}),
	rollup: v.object({
		relationProp: idSchema,
		targetProp: idSchema,
		fn: v.picklist(ROLLUP_FUNCTIONS),
		resultType: v.picklist(COMPUTED_RESULT_TYPES)
	}),
	formula: v.object({
		expression: v.pipe(v.string(), v.maxLength(10_000)),
		resultType: v.picklist(COMPUTED_RESULT_TYPES)
	}),
	created_time: EmptyConfig,
	created_by: EmptyConfig,
	last_edited_time: EmptyConfig,
	last_edited_by: EmptyConfig,
	unique_id: v.object({
		prefix: v.optional(v.pipe(v.string(), v.maxLength(10), v.regex(/^[A-Za-z0-9_-]*$/)))
	}),
	ai: v.object({
		kind: v.picklist(AI_PROPERTY_KINDS),
		prompt: v.optional(v.pipe(v.string(), v.maxLength(4000))),
		language: v.optional(v.pipe(v.string(), v.maxLength(40))),
		/** Properties whose values are quoted to the model besides the page text. */
		sources: v.optional(v.array(idSchema), [])
	})
} as const;

export type ConfigOf<T extends PropertyType> = v.InferOutput<(typeof propertyConfigSchemas)[T]>;
export type ConfigInputOf<T extends PropertyType> = v.InferInput<(typeof propertyConfigSchemas)[T]>;

/** A config schema that may be omitted: absent means its defaults. */
const cfg = <S extends v.GenericSchema>(s: S) => v.optional(s, () => v.parse(s, {}) as v.InferOutput<S>);

const base = { id: idSchema, name: nameSchema };

/** A property as stored in the registry and sent to clients. Discriminated by `type`. */
export const propertyDefSchema = v.variant('type', [
	v.object({ ...base, type: v.literal('title'), config: cfg(propertyConfigSchemas.title) }),
	v.object({ ...base, type: v.literal('text'), config: cfg(propertyConfigSchemas.text) }),
	v.object({ ...base, type: v.literal('url'), config: cfg(propertyConfigSchemas.url) }),
	v.object({ ...base, type: v.literal('email'), config: cfg(propertyConfigSchemas.email) }),
	v.object({ ...base, type: v.literal('phone'), config: cfg(propertyConfigSchemas.phone) }),
	v.object({ ...base, type: v.literal('number'), config: cfg(propertyConfigSchemas.number) }),
	v.object({ ...base, type: v.literal('select'), config: cfg(propertyConfigSchemas.select) }),
	v.object({ ...base, type: v.literal('status'), config: cfg(propertyConfigSchemas.status) }),
	v.object({ ...base, type: v.literal('multi_select'), config: cfg(propertyConfigSchemas.multi_select) }),
	v.object({ ...base, type: v.literal('date'), config: cfg(propertyConfigSchemas.date) }),
	v.object({ ...base, type: v.literal('person'), config: cfg(propertyConfigSchemas.person) }),
	v.object({ ...base, type: v.literal('checkbox'), config: cfg(propertyConfigSchemas.checkbox) }),
	v.object({ ...base, type: v.literal('files'), config: cfg(propertyConfigSchemas.files) }),
	v.object({ ...base, type: v.literal('relation'), config: cfg(propertyConfigSchemas.relation) }),
	v.object({ ...base, type: v.literal('rollup'), config: propertyConfigSchemas.rollup }),
	v.object({ ...base, type: v.literal('formula'), config: propertyConfigSchemas.formula }),
	v.object({ ...base, type: v.literal('created_time'), config: cfg(propertyConfigSchemas.created_time) }),
	v.object({ ...base, type: v.literal('created_by'), config: cfg(propertyConfigSchemas.created_by) }),
	v.object({ ...base, type: v.literal('last_edited_time'), config: cfg(propertyConfigSchemas.last_edited_time) }),
	v.object({ ...base, type: v.literal('last_edited_by'), config: cfg(propertyConfigSchemas.last_edited_by) }),
	v.object({ ...base, type: v.literal('unique_id'), config: cfg(propertyConfigSchemas.unique_id) }),
	v.object({ ...base, type: v.literal('ai'), config: propertyConfigSchemas.ai })
]);
export type PropertyDef = v.InferOutput<typeof propertyDefSchema>;
export type PropertyDefInput = v.InferInput<typeof propertyDefSchema>;
/** Anything with a type and its config: what the codecs need. */
export type TypedConfig = { [T in PropertyType]: { type: T; config: ConfigOf<T> } }[PropertyType];

export function defaultConfig<T extends PropertyType>(type: T): ConfigOf<T> {
	return v.parse(propertyConfigSchemas[type] as v.GenericSchema, {}) as ConfigOf<T>;
}

/** The defaults a new status property starts with (Notion's three groups). */
export function defaultStatusConfig(): ConfigOf<'status'> {
	return {
		options: [
			{ id: 'not_started', name: 'Not started', color: 'gray' },
			{ id: 'in_progress', name: 'In progress', color: 'blue' },
			{ id: 'done', name: 'Done', color: 'green' }
		],
		groups: [
			{ id: 'todo', name: 'To-do', color: 'gray', optionIds: ['not_started'] },
			{ id: 'in_progress', name: 'In progress', color: 'blue', optionIds: ['in_progress'] },
			{ id: 'complete', name: 'Complete', color: 'green', optionIds: ['done'] }
		]
	};
}

// ───────────────────────────── values ─────────────────────────────

export type PropScalar = string | number | boolean | DateValue;
export type PropValue = PropScalar | string[];

export const propValueSchema: v.GenericSchema<PropValue> = v.union([
	v.string(),
	v.pipe(v.number(), v.finite()),
	v.boolean(),
	v.array(v.string()),
	dateValueSchema
]);

export type ValueClass = 'text' | 'number' | 'boolean' | 'date' | 'refs';

export function isDateValue(x: unknown): x is DateValue {
	return typeof x === 'object' && x !== null && !Array.isArray(x) && typeof (x as DateValue).start === 'string';
}

export function isEmptyValue(x: unknown): boolean {
	return x === null || x === undefined || x === '' || (Array.isArray(x) && x.length === 0);
}

// ───────────────────────────── the registry ─────────────────────────────

export interface PropertyTypeDef<C> {
	readonly type: PropertyType;
	/** Not writable by clients: computed by the engine, assigned by the server, or read from `page`. */
	readonly readOnly: boolean;
	/** Holds several members (one EAV row each). */
	readonly multi: boolean;
	/** Whether a view may sort on it. */
	readonly sortable: boolean;
	/** Text values are stored folded: `decode(encode(x))` returns the folded text, not `x` (computed types: when the result is text). */
	readonly lossy: boolean;
	readonly configSchema: v.GenericSchema<unknown, C>;
	storage(config: C): StorageTable;
	valueClass(config: C): ValueClass;
	valueSchema(config: C): v.GenericSchema<unknown, PropValue>;
	filterOps(config: C): FilterOpMap;
	encode(value: PropValue | null, config: C, ctx?: CodecCtx): EavRow[];
	decode(rows: readonly EavRow[], config: C, ctx?: CodecCtx): PropValue | null;
	sortKey(value: PropValue | null, config: C): SortKey | null;
}

const asString = (x: PropValue | null): string => {
	if (typeof x !== 'string') throw new CodecError(`Expected a string, got ${typeof x}`);
	return x;
};
const asNumber = (x: PropValue | null): number => {
	if (typeof x !== 'number') throw new CodecError(`Expected a number, got ${typeof x}`);
	return numberSortKey(x);
};
const asRefs = (x: PropValue | null): string[] => {
	if (typeof x === 'string') return [x];
	if (!Array.isArray(x)) throw new CodecError(`Expected a list of ids, got ${typeof x}`);
	return [...new Set(x)];
};
const asDate = (x: PropValue | null): DateValue => {
	if (!isDateValue(x)) throw new CodecError('Expected a date value');
	return x;
};

const rowsOf = (table: EavTable, vs: readonly (string | number)[], computed?: true): EavRow[] =>
	vs.map((v_) => (computed ? { table, v: v_, computed } : { table, v: v_ }));

function encodeText(value: PropValue | null, computed?: true): EavRow[] {
	if (isEmptyValue(value)) return [];
	return rowsOf('p_text', [textSortKey(asString(value))], computed);
}
function decodeText(rows: readonly EavRow[]): string | null {
	const r = rows.find((x) => x.table === 'p_text');
	return r ? String(r.v) : null;
}
function encodeNumber(value: PropValue | null, computed?: true): EavRow[] {
	if (value === null || value === undefined) return [];
	return rowsOf('p_num', [asNumber(value)], computed);
}
function decodeNumber(rows: readonly EavRow[]): number | null {
	const r = rows.find((x) => x.table === 'p_num');
	return r ? Number(r.v) : null;
}
function encodeBool(value: PropValue | null, computed?: true): EavRow[] {
	if (value === null || value === undefined) return [];
	if (typeof value !== 'boolean') throw new CodecError('Expected a boolean');
	return rowsOf('p_num', [value ? 1 : 0], computed);
}
function decodeBool(rows: readonly EavRow[]): boolean | null {
	const r = rows.find((x) => x.table === 'p_num');
	return r ? Number(r.v) === 1 : null;
}
function encodeDate(value: PropValue | null, computed?: true): EavRow[] {
	if (value === null || value === undefined) return [];
	const d = asDate(value);
	const a = parseIsoDate(d.start);
	if (!a) throw new CodecError(`Invalid date: ${d.start}`);
	const row: EavRow = { table: 'p_date', v: a.ms };
	if (d.end != null) {
		const b = parseIsoDate(d.end);
		if (!b) throw new CodecError(`Invalid date: ${d.end}`);
		if (b.ms < a.ms) throw new CodecError('Date range ends before it starts');
		row.v_end = b.ms;
	}
	if (computed) row.computed = true;
	return [row];
}
function decodeDate(rows: readonly EavRow[], includeTime: boolean): DateValue | null {
	const r = rows.find((x) => x.table === 'p_date');
	if (!r) return null;
	const start = Number(r.v);
	const end = r.v_end == null ? null : Number(r.v_end);
	const dateOnly = !includeTime && start % DAY_MS === 0 && (end === null || end % DAY_MS === 0);
	const out: DateValue = { start: formatDate(start, dateOnly) };
	if (end !== null) out.end = formatDate(end, dateOnly);
	return out;
}

const refRows = (vs: readonly (string | number)[]): EavRow[] => rowsOf('p_ref', vs);
const compareRefs = (a: string | number, b: string | number) =>
	typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;

const stringIds = (max: number) =>
	v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
		v.maxLength(max),
		v.check((a) => new Set(a).size === a.length, 'Duplicate entries')
	);

const textValue = (max: number) => v.pipe(v.string(), v.maxLength(max));
const dateKey = (value: PropValue | null): SortKey | null => {
	if (!isDateValue(value)) return null;
	const p = parseIsoDate(value.start);
	return p ? p.ms : null;
};
const textKey = (value: PropValue | null): SortKey | null =>
	typeof value === 'string' && value !== '' ? textSortKey(value) : null;
const numKey = (value: PropValue | null): SortKey | null => (typeof value === 'number' ? numberSortKey(value) : null);
const boolKey = (value: PropValue | null): SortKey | null => (typeof value === 'boolean' ? (value ? 1 : 0) : null);

const textLike = (
	type: PropertyType,
	max: number,
	extra?: v.GenericSchema<string>
): PropertyTypeDef<Record<string, never>> => ({
	type,
	readOnly: false,
	multi: false,
	sortable: true,
	lossy: true,
	configSchema: propertyConfigSchemas.text as v.GenericSchema<unknown, Record<string, never>>,
	storage: () => 'p_text',
	valueClass: () => 'text',
	valueSchema: () => (extra ? v.pipe(textValue(max), v.check((s) => v.is(extra, s), 'Invalid value')) : textValue(max)),
	filterOps: () => TEXT_OPS,
	encode: (value) => encodeText(value),
	decode: (rows) => decodeText(rows),
	sortKey: textKey
});

const emailSchema = v.pipe(v.string(), v.regex(/^[^\s@]+@[^\s@]+$/, 'Invalid email address'));
const optionIdsOf = (c: { options: readonly { id: string }[] }) => new Set(c.options.map((o) => o.id));
const optionOrder = (c: { options: readonly { id: string }[] }) => new Map(c.options.map((o, i) => [o.id, i]));

type SelectLike = { options: readonly { id: string }[] };

function selectValueSchema(c: SelectLike): v.GenericSchema<unknown, PropValue> {
	const ids = optionIdsOf(c);
	return v.pipe(
		v.string(),
		v.check((s) => ids.has(s), 'Unknown option id')
	);
}

function decodeRefsInOrder(rows: readonly EavRow[], order: Map<string, number> | null): string[] {
	return rows
		.filter((r) => r.table === 'p_ref')
		.map((r) => String(r.v))
		.sort((a, b) => {
			if (order) {
				const d = (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER);
				if (d) return d;
			}
			return a < b ? -1 : a > b ? 1 : 0;
		});
}

const selectDef = (type: 'select' | 'status'): PropertyTypeDef<SelectLike> => ({
	type,
	readOnly: false,
	multi: false,
	sortable: true,
	lossy: false,
	configSchema: propertyConfigSchemas[type] as v.GenericSchema<unknown, SelectLike>,
	storage: () => 'p_ref',
	valueClass: () => 'refs',
	valueSchema: selectValueSchema,
	filterOps: () => SELECT_OPS,
	encode: (value) => (isEmptyValue(value) ? [] : refRows([asString(value)])),
	decode: (rows) => decodeRefsInOrder(rows, null)[0] ?? null,
	// Select-like columns sort by option order, not by option id.
	sortKey: (value, c) => {
		if (typeof value !== 'string') return null;
		const i = optionOrder(c).get(value);
		return i === undefined ? c.options.length : i;
	}
});

const refsDef = (
	type: 'person' | 'files',
	max: number,
	ops: FilterOpMap
): PropertyTypeDef<Record<string, never>> => ({
	type,
	readOnly: false,
	multi: true,
	sortable: false,
	lossy: false,
	configSchema: EmptyConfig as v.GenericSchema<unknown, Record<string, never>>,
	storage: () => 'p_ref',
	valueClass: () => 'refs',
	valueSchema: () => stringIds(max),
	filterOps: () => ops,
	encode: (value) => (isEmptyValue(value) ? [] : refRows(asRefs(value))),
	decode: (rows) => {
		const r = decodeRefsInOrder(rows, null);
		return r.length ? r : null;
	},
	sortKey: () => null
});

const pageDerived = (
	type: PropertyType,
	cls: ValueClass,
	ops: FilterOpMap,
	schema: v.GenericSchema<unknown, PropValue>
): PropertyTypeDef<Record<string, never>> => ({
	type,
	readOnly: true,
	multi: false,
	sortable: cls === 'date',
	lossy: false,
	configSchema: EmptyConfig as v.GenericSchema<unknown, Record<string, never>>,
	storage: () => 'page',
	valueClass: () => cls,
	valueSchema: () => schema,
	filterOps: () => ops,
	encode: () => [],
	decode: () => null,
	sortKey: (value) => (cls === 'date' && typeof value === 'string' ? dateKey({ start: value }) : null)
});

const resultStorage = (r: ComputedResultType): StorageTable =>
	r === 'text' ? 'p_text' : r === 'date' ? 'p_date' : 'p_num';
const resultClass = (r: ComputedResultType): ValueClass =>
	r === 'text' ? 'text' : r === 'date' ? 'date' : r === 'checkbox' ? 'boolean' : 'number';
const resultOps = (r: ComputedResultType): FilterOpMap =>
	r === 'text' ? TEXT_OPS : r === 'date' ? DATE_OPS : r === 'checkbox' ? CHECKBOX_OPS : NUMBER_OPS;
const resultSchema = (r: ComputedResultType): v.GenericSchema<unknown, PropValue> =>
	r === 'text'
		? v.string()
		: r === 'date'
			? dateValueSchema
			: r === 'checkbox'
				? v.boolean()
				: v.pipe(v.number(), v.finite());

type Computed = { resultType: ComputedResultType };
const computedDef = (
	type: 'rollup' | 'formula',
	schema: v.GenericSchema<unknown, Computed>
): PropertyTypeDef<Computed> => ({
	type,
	readOnly: true,
	multi: false,
	sortable: true,
	lossy: true,
	configSchema: schema,
	storage: (c) => resultStorage(c.resultType),
	valueClass: (c) => resultClass(c.resultType),
	valueSchema: (c) => resultSchema(c.resultType),
	filterOps: (c) => resultOps(c.resultType),
	encode: (value, c) => {
		switch (c.resultType) {
			case 'text':
				return encodeText(value, true);
			case 'number':
				return encodeNumber(value, true);
			case 'checkbox':
				return encodeBool(value, true);
			case 'date':
				return encodeDate(value, true);
		}
	},
	decode: (rows, c) => {
		switch (c.resultType) {
			case 'text':
				return decodeText(rows);
			case 'number':
				return decodeNumber(rows);
			case 'checkbox':
				return decodeBool(rows);
			case 'date':
				return decodeDate(rows, false);
		}
	},
	sortKey: (value, c) => {
		switch (c.resultType) {
			case 'text':
				return textKey(value);
			case 'number':
				return numKey(value);
			case 'checkbox':
				return boolKey(value);
			case 'date':
				return dateKey(value);
		}
	}
});

type Registry = { [T in PropertyType]: PropertyTypeDef<ConfigOf<T>> };

export const propertyTypes: Registry = {
	title: { ...textLike('title', 2000), type: 'title' },
	text: textLike('text', 20_000),
	url: textLike('url', 2048),
	email: { ...textLike('email', 320, emailSchema), type: 'email' },
	phone: textLike('phone', 64),
	number: {
		type: 'number',
		readOnly: false,
		multi: false,
		sortable: true,
		lossy: false,
		configSchema: propertyConfigSchemas.number,
		storage: () => 'p_num',
		valueClass: () => 'number',
		valueSchema: () => v.pipe(v.number(), v.finite()),
		filterOps: () => NUMBER_OPS,
		encode: (value) => encodeNumber(value),
		decode: (rows) => decodeNumber(rows),
		sortKey: numKey
	},
	select: selectDef('select') as PropertyTypeDef<ConfigOf<'select'>>,
	status: selectDef('status') as PropertyTypeDef<ConfigOf<'status'>>,
	multi_select: {
		type: 'multi_select',
		readOnly: false,
		multi: true,
		sortable: true,
		lossy: false,
		configSchema: propertyConfigSchemas.multi_select,
		storage: () => 'p_ref',
		valueClass: () => 'refs',
		valueSchema: (c) => {
			const ids = optionIdsOf(c);
			return v.pipe(
				stringIds(100),
				v.check((a) => a.every((x) => ids.has(x)), 'Unknown option id')
			);
		},
		filterOps: () => MULTI_OPS,
		encode: (value) => (isEmptyValue(value) ? [] : refRows(asRefs(value))),
		decode: (rows, c) => {
			const r = decodeRefsInOrder(rows, optionOrder(c));
			return r.length ? r : null;
		},
		// Sorts by the first selected option in config order.
		sortKey: (value, c) => {
			if (!Array.isArray(value) || value.length === 0) return null;
			const order = optionOrder(c);
			return Math.min(...value.map((x) => order.get(x) ?? c.options.length));
		}
	},
	date: {
		type: 'date',
		readOnly: false,
		multi: false,
		sortable: true,
		lossy: false,
		configSchema: propertyConfigSchemas.date,
		storage: () => 'p_date',
		valueClass: () => 'date',
		valueSchema: () => dateValueSchema,
		filterOps: () => DATE_OPS,
		encode: (value) => encodeDate(value),
		decode: (rows, c) => decodeDate(rows, c.includeTime),
		sortKey: dateKey
	},
	person: refsDef('person', 100, PERSON_OPS) as PropertyTypeDef<ConfigOf<'person'>>,
	checkbox: {
		type: 'checkbox',
		readOnly: false,
		multi: false,
		sortable: true,
		lossy: false,
		configSchema: propertyConfigSchemas.checkbox,
		storage: () => 'p_num',
		valueClass: () => 'boolean',
		valueSchema: () => v.boolean(),
		filterOps: () => CHECKBOX_OPS,
		encode: (value) => encodeBool(value),
		decode: (rows) => decodeBool(rows),
		sortKey: boolKey
	},
	files: refsDef('files', 100, FILES_OPS) as PropertyTypeDef<ConfigOf<'files'>>,
	relation: {
		type: 'relation',
		readOnly: false,
		multi: true,
		sortable: false,
		lossy: false,
		configSchema: propertyConfigSchemas.relation,
		storage: () => 'p_ref',
		valueClass: () => 'refs',
		valueSchema: () => stringIds(500),
		filterOps: () => RELATION_OPS,
		encode: (value, _c, ctx) => {
			if (isEmptyValue(value)) return [];
			const nums = asRefs(value).map((id) => {
				const n = ctx?.pageNum?.(id);
				if (n === undefined) throw new CodecError(`Unknown page for relation target "${id}"`);
				return n;
			});
			return refRows(nums);
		},
		decode: (rows, _c, ctx) => {
			const ids = rows
				.filter((r) => r.table === 'p_ref')
				.map((r) => Number(r.v))
				.sort((a, b) => a - b)
				.map((n) => {
					const id = ctx?.pageId?.(n);
					if (id === undefined) throw new CodecError(`Unknown page number ${n}`);
					return id;
				});
			return ids.length ? ids : null;
		},
		sortKey: () => null
	},
	rollup: computedDef('rollup', propertyConfigSchemas.rollup) as PropertyTypeDef<ConfigOf<'rollup'>>,
	formula: computedDef('formula', propertyConfigSchemas.formula) as PropertyTypeDef<ConfigOf<'formula'>>,
	created_time: pageDerived('created_time', 'date', DATE_OPS, v.string()) as PropertyTypeDef<ConfigOf<'created_time'>>,
	created_by: pageDerived('created_by', 'refs', PERSON_OPS, v.string()) as PropertyTypeDef<ConfigOf<'created_by'>>,
	last_edited_time: pageDerived('last_edited_time', 'date', DATE_OPS, v.string()) as PropertyTypeDef<
		ConfigOf<'last_edited_time'>
	>,
	last_edited_by: pageDerived('last_edited_by', 'refs', PERSON_OPS, v.string()) as PropertyTypeDef<
		ConfigOf<'last_edited_by'>
	>,
	unique_id: {
		type: 'unique_id',
		readOnly: true,
		multi: false,
		sortable: true,
		lossy: false,
		configSchema: propertyConfigSchemas.unique_id,
		storage: () => 'p_num',
		valueClass: () => 'number',
		valueSchema: () => v.pipe(v.number(), v.integer(), v.minValue(0)),
		filterOps: () => UNIQUE_ID_OPS,
		encode: (value) => encodeNumber(value),
		decode: (rows) => decodeNumber(rows),
		sortKey: numKey
	},
	ai: {
		type: 'ai',
		readOnly: true,
		multi: false,
		sortable: true,
		lossy: true,
		configSchema: propertyConfigSchemas.ai,
		storage: () => 'p_text',
		valueClass: () => 'text',
		valueSchema: () => v.string(),
		filterOps: () => TEXT_OPS,
		encode: (value) => encodeText(value, true),
		decode: (rows) => decodeText(rows),
		sortKey: textKey
	}
};

/** The registry entry of a type, with its config typed loosely for dispatch by a runtime type. */
function entry(def: TypedConfig): PropertyTypeDef<unknown> {
	return propertyTypes[def.type] as unknown as PropertyTypeDef<unknown>;
}

export const getPropertyType = (type: PropertyType): PropertyTypeDef<unknown> =>
	propertyTypes[type] as unknown as PropertyTypeDef<unknown>;

export const storageTable = (def: TypedConfig): StorageTable => entry(def).storage(def.config);
export const valueClassOf = (def: TypedConfig): ValueClass => entry(def).valueClass(def.config);
export const filterOpsOf = (def: TypedConfig): FilterOpMap => entry(def).filterOps(def.config);
export const isReadOnlyProperty = (def: { type: PropertyType }): boolean => propertyTypes[def.type].readOnly;

/** Encodes a value into EAV rows; `[]` for null/empty and for types read from `page`. Throws CodecError. */
export function encodeValue(def: TypedConfig, value: PropValue | null, ctx?: CodecCtx): EavRow[] {
	return entry(def).encode(value, def.config, ctx);
}

/** Decodes the rows of one page and one property. Text comes back folded (see the module note). */
export function decodeValue(def: TypedConfig, rows: readonly EavRow[], ctx?: CodecCtx): PropValue | null {
	return entry(def).decode(rows, def.config, ctx);
}

/** The key a view sorts a value by, or null when empty or the type is not sortable. */
export function sortKeyOf(def: TypedConfig, value: PropValue | null): SortKey | null {
	return entry(def).sortKey(value, def.config);
}

/** Validates a value for a property, including option membership for select types. */
export function validateValue(def: TypedConfig, value: unknown): Result<PropValue | null> {
	if (isEmptyValue(value)) return ok(null);
	const r = v.safeParse(entry(def).valueSchema(def.config), value);
	if (!r.success) return fail(fromValibot(r.issues));
	return ok(r.output);
}

/** Canonical form of a valid value: empty to null, arrays deduplicated, dates canonical, -0 to 0. */
export function normalizeValue(def: TypedConfig, value: PropValue | null | undefined): PropValue | null {
	if (isEmptyValue(value)) return null;
	const x = value as PropValue;
	if (typeof x === 'number') return numberSortKey(x);
	if (Array.isArray(x)) return [...new Set(x)];
	if (isDateValue(x)) {
		const start = canonicalDate(x.start) ?? x.start;
		const out: DateValue = { start };
		if (x.end != null) out.end = canonicalDate(x.end) ?? x.end;
		return out;
	}
	void def;
	return x;
}

/** Checks a config against its schema and the cross-field rules the schemas cannot express. */
export function parsePropertyConfig<T extends PropertyType>(type: T, config: unknown): Result<ConfigOf<T>> {
	const r = v.safeParse(propertyConfigSchemas[type] as v.GenericSchema, config ?? {});
	if (!r.success) return fail(fromValibot(r.issues, '/config'));
	const out = r.output as ConfigOf<T>;
	const problems: Issue[] = [];
	if (type === 'select' || type === 'multi_select' || type === 'status') {
		const c = out as ConfigOf<'select'>;
		const seen = new Set<string>();
		c.options.forEach((o, i) => {
			if (seen.has(o.id)) problems.push(issue(`/config/options/${i}/id`, 'duplicate_option', `Duplicate option id "${o.id}"`));
			seen.add(o.id);
		});
		if (type === 'status') {
			const g = (out as ConfigOf<'status'>).groups;
			const inGroup = new Set<string>();
			g.forEach((grp, gi) =>
				grp.optionIds.forEach((id, i) => {
					if (!seen.has(id)) problems.push(issue(`/config/groups/${gi}/optionIds/${i}`, 'unknown_option', `Unknown option "${id}"`));
					if (inGroup.has(id)) problems.push(issue(`/config/groups/${gi}/optionIds/${i}`, 'duplicate_option', `Option "${id}" is in two groups`));
					inGroup.add(id);
				})
			);
		}
	}
	return problems.length ? fail(problems) : ok(out);
}

/** `PREFIX-12`, or `12` without a prefix. */
export function formatUniqueId(prefix: string | undefined, n: number): string {
	return prefix ? `${prefix}-${n}` : String(n);
}

/** Property types a view may group by (board columns, grouped lists). */
export const GROUPABLE_TYPES: ReadonlySet<PropertyType> = new Set<PropertyType>([
	'select',
	'status',
	'multi_select',
	'person',
	'checkbox',
	'date',
	'relation',
	'created_by',
	'last_edited_by'
]);

// ───────────────────────────── property lookup ─────────────────────────────

export interface PropertyRegistry {
	get(id: string): PropertyDef | undefined;
}

export function createRegistry(defs: Iterable<PropertyDef>): PropertyRegistry & { all(): PropertyDef[] } {
	const map = new Map<string, PropertyDef>();
	for (const d of defs) map.set(d.id, d);
	return { get: (id) => map.get(id), all: () => [...map.values()] };
}

/**
 * System fields a filter may reference besides properties. `$parent` and `$teamspace` hold one id
 * (null at the root / in Private); they back membership conditions such as "parent = this page".
 */
export const SYSTEM_FIELDS = {
	$parent: { ops: SELECT_OPS, valueClass: 'refs' },
	$teamspace: { ops: SELECT_OPS, valueClass: 'refs' }
} as const satisfies Record<string, { ops: FilterOpMap; valueClass: ValueClass }>;
export type SystemField = keyof typeof SYSTEM_FIELDS;
export const isSystemField = (id: string): id is SystemField => Object.hasOwn(SYSTEM_FIELDS, id);
