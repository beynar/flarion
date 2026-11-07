/** Static types and runtime values of the formula language. */
import { formatDate, parseIsoDate } from '../dates';
import type { ComputedResultType, PropValue, PropertyDef } from '../property-types';

export type FType = 'text' | 'number' | 'date' | 'checkbox' | 'any' | { list: FType };

export interface FormulaDate {
	/** Epoch ms (UTC). */
	start: number;
	end: number | null;
	/** Carries a time of day (false: a calendar day). */
	time: boolean;
}
/** `null` is an empty value. Lists hold values of one type. */
export type FormulaValue = string | number | boolean | FormulaDate | FormulaValue[] | null;

export const isList = (t: FType): t is { list: FType } => typeof t === 'object';

export function typeName(t: FType): string {
	return isList(t) ? `list of ${typeName(t.list)}` : t;
}

/** Whether a value of type `actual` can be used where `expected` is wanted (`any` fits everything). */
export function fits(actual: FType, expected: FType): boolean {
	if (actual === 'any' || expected === 'any') return true;
	if (isList(actual) || isList(expected)) return isList(actual) && isList(expected) && fits(actual.list, expected.list);
	return actual === expected;
}

/** The common type of two branches, or null when they differ. */
export function unify(a: FType, b: FType): FType | null {
	if (a === 'any') return b;
	if (b === 'any') return a;
	if (isList(a) || isList(b)) {
		if (!isList(a) || !isList(b)) return null;
		const inner = unify(a.list, b.list);
		return inner === null ? null : { list: inner };
	}
	return a === b ? a : null;
}

/** The property type a formula result is stored as: lists and unknowns are stored as text. */
export function resultTypeOf(t: FType): ComputedResultType {
	return t === 'number' || t === 'date' || t === 'checkbox' ? t : 'text';
}

/** The formula type a property exposes through `prop("Name")`. */
export function formulaTypeOf(def: PropertyDef): FType {
	switch (def.type) {
		case 'number':
		case 'unique_id':
			return 'number';
		case 'checkbox':
			return 'checkbox';
		case 'date':
		case 'created_time':
		case 'last_edited_time':
			return 'date';
		case 'multi_select':
		case 'person':
		case 'files':
		case 'relation':
			return { list: 'text' };
		case 'formula':
		case 'rollup':
			return def.config.resultType;
		default:
			// Text, url, email, phone, title, select, status, created_by, last_edited_by, ai.
			return 'text';
	}
}

/** What `prop("Name")` is typed as: `undefined` means there is no such property. */
export type PropTypeEnv = (name: string) => FType | undefined;

/** A type environment over a property list, by name (the first property of a name wins). */
export function envFromProperties(defs: Iterable<PropertyDef>): PropTypeEnv {
	const byName = new Map<string, FType>();
	for (const d of defs) if (!byName.has(d.name)) byName.set(d.name, formulaTypeOf(d));
	return (name) => byName.get(name);
}

// ───────────────────────────── values <-> property values ─────────────────────────────

const parseDay = (s: string): { ms: number; time: boolean } | null => {
	const p = parseIsoDate(s);
	return p ? { ms: p.ms, time: !p.dateOnly } : null;
};

/** A stored property value as a formula value. */
export function fromPropValue(value: PropValue | null | undefined, def?: PropertyDef): FormulaValue {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') {
		if (def && (def.type === 'created_time' || def.type === 'last_edited_time')) {
			const d = parseDay(value);
			return d ? { start: d.ms, end: null, time: d.time } : null;
		}
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) return value;
	const start = parseDay(value.start);
	if (!start) return null;
	const end = value.end ? parseDay(value.end) : null;
	return { start: start.ms, end: end ? end.ms : null, time: start.time || (end?.time ?? false) };
}

const isFormulaDate = (v: unknown): v is FormulaDate => typeof v === 'object' && v !== null && !Array.isArray(v) && 'start' in v;

export function formatNumber(n: number): string {
	return String(parseFloat(n.toPrecision(15)));
}

/** Text of any value, as `format()` and `concat()` show it. */
export function formatValue(v: FormulaValue): string {
	if (v === null) return '';
	if (typeof v === 'string') return v;
	if (typeof v === 'number') return formatNumber(v);
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (Array.isArray(v)) return v.map(formatValue).join(', ');
	const a = formatDate(v.start, !v.time);
	return v.end === null ? a : `${a} → ${formatDate(v.end, !v.time)}`;
}

/** A formula result as the value to store for a property of `resultType` (null: empty). */
export function toPropValue(resultType: ComputedResultType, value: FormulaValue): PropValue | null {
	if (value === null) return null;
	switch (resultType) {
		case 'text': {
			const s = formatValue(value);
			return s === '' ? null : s;
		}
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
		case 'checkbox':
			return typeof value === 'boolean' ? value : null;
		case 'date': {
			if (!isFormulaDate(value)) return null;
			const out: { start: string; end?: string } = { start: formatDate(value.start, !value.time) };
			if (value.end !== null && value.end >= value.start) out.end = formatDate(value.end, !value.time);
			return out;
		}
	}
}
