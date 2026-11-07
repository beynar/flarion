/**
 * Date parsing, canonical formatting and relative-range resolution.
 *
 * Everything is UTC. A date-only value ("2026-11-07") is stored at UTC midnight and covers the
 * whole day; a timed value is an instant and covers one millisecond. Resolving relative operands
 * ("this week", "one month ago") happens against `ctx.now`, always in UTC (a workspace time zone is
 * a later refinement: it needs an explicit date-only marker in storage, see property-types.ts).
 * Intervals are half-open `[start, end)` in epoch milliseconds.
 */
import * as v from 'valibot';

export const DAY_MS = 86_400_000;

export interface ParsedDate {
	/** Epoch ms. Date-only values sit at UTC midnight. */
	ms: number;
	dateOnly: boolean;
}

export interface Interval {
	start: number;
	end: number;
}

export type DateUnit = 'day' | 'week' | 'month' | 'year';
export const DATE_UNITS = ['day', 'week', 'month', 'year'] as const satisfies readonly DateUnit[];

export const NAMED_RANGES = [
	'past_week',
	'past_month',
	'past_year',
	'this_week',
	'this_month',
	'this_year',
	'next_week',
	'next_month',
	'next_year'
] as const;
export type NamedRange = (typeof NAMED_RANGES)[number];

/** A date on a property: ISO 8601, date-only or a UTC instant, with an optional end of range. */
export interface DateValue {
	start: string;
	end?: string | null;
}

/** An operand of `is`, `before`, `after`, ...: a fixed date or a point relative to today. */
export type DateOperand =
	| { kind: 'exact'; date: string }
	| { kind: 'relative'; unit: DateUnit; offset: number };

/** The operand of `within`. */
export type DateRangeOperand =
	| { kind: 'named'; range: NamedRange }
	| { kind: 'between'; from: DateOperand; to: DateOperand };

export interface DateCtx {
	/** Epoch ms of "now". */
	now: number;
	/** First day of the week: 1 = Monday (default), 0 = Sunday. */
	weekStartsOn?: 0 | 1;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;

function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
	const date = new Date(0);
	date.setUTCFullYear(y, mo, d);
	date.setUTCHours(h, mi, s, ms);
	return date.getTime();
}

/** Parses a strict ISO date or datetime. A datetime without offset is read as UTC. Returns null when invalid. */
export function parseIsoDate(input: string): ParsedDate | null {
	const d = DATE_RE.exec(input);
	if (d) {
		const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
		const ms = utc(y, m - 1, day);
		const back = new Date(ms);
		if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== day) return null;
		return { ms, dateOnly: true };
	}
	const t = DATETIME_RE.exec(input);
	if (!t) return null;
	const [y, m, day, h, mi] = [Number(t[1]), Number(t[2]), Number(t[3]), Number(t[4]), Number(t[5])];
	const s = t[6] ? Number(t[6]) : 0;
	const frac = t[7] ? Number(t[7].padEnd(3, '0')) : 0;
	if (h > 23 || mi > 59 || s > 59) return null;
	const base = utc(y, m - 1, day, h, mi, s, frac);
	const back = new Date(base);
	if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== day) return null;
	let offsetMin = 0;
	const z = t[8];
	if (z && z !== 'Z') {
		const sign = z[0] === '-' ? -1 : 1;
		const oh = Number(z.slice(1, 3));
		const om = Number(z.slice(4, 6));
		if (oh > 23 || om > 59) return null;
		offsetMin = sign * (oh * 60 + om);
	}
	return { ms: base - offsetMin * 60_000, dateOnly: false };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Canonical text of an instant: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss[.SSS]Z`. */
export function formatDate(ms: number, dateOnly: boolean): string {
	const d = new Date(ms);
	const day = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	if (dateOnly) return day;
	const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
	const frac = d.getUTCMilliseconds();
	return `${day}T${time}${frac ? `.${pad(frac, 3).replace(/0+$/, '')}` : ''}Z`;
}

/** Normalizes an ISO string to its canonical form (UTC for timed values), or null when invalid. */
export function canonicalDate(input: string): string | null {
	const p = parseIsoDate(input);
	return p ? formatDate(p.ms, p.dateOnly) : null;
}

export const isoDateSchema = v.pipe(
	v.string(),
	v.maxLength(40),
	v.check((s) => parseIsoDate(s) !== null, 'Invalid ISO 8601 date')
);

const dateValueBase = v.object({
	start: isoDateSchema,
	end: v.optional(v.nullable(isoDateSchema))
});

/** Checks `end >= start`. */
export const dateValueSchema: v.GenericSchema<DateValue> = v.pipe(
	dateValueBase,
	v.check((d) => {
		if (d.end == null) return true;
		const a = parseIsoDate(d.start);
		const b = parseIsoDate(d.end);
		return a !== null && b !== null && b.ms >= a.ms;
	}, 'Date range end is before its start')
);

export const dateOperandSchema: v.GenericSchema<DateOperand> = v.variant('kind', [
	v.object({ kind: v.literal('exact'), date: isoDateSchema }),
	v.object({
		kind: v.literal('relative'),
		unit: v.picklist(DATE_UNITS),
		offset: v.pipe(v.number(), v.integer(), v.minValue(-1000), v.maxValue(1000))
	})
]);

export const dateRangeOperandSchema: v.GenericSchema<DateRangeOperand> = v.variant('kind', [
	v.object({ kind: v.literal('named'), range: v.picklist(NAMED_RANGES) }),
	v.object({ kind: v.literal('between'), from: dateOperandSchema, to: dateOperandSchema })
]);

/** The interval a stored date covers: the whole day for date-only values, the instant otherwise. */
export function dateValueInterval(value: DateValue): Interval | null {
	const a = parseIsoDate(value.start);
	if (!a) return null;
	const b = value.end != null ? parseIsoDate(value.end) : a;
	if (!b) return null;
	const end = b.ms + (b.dateOnly ? DAY_MS : 1);
	const start = a.ms;
	return { start, end: Math.max(end, start + 1) };
}

/** Start of the calendar unit containing `ms`, shifted by `offset` units, with its end. */
export function unitInterval(ms: number, unit: DateUnit, offset: number, ctx: DateCtx): Interval {
	const dayStart = Math.floor(ms / DAY_MS) * DAY_MS;
	switch (unit) {
		case 'day':
			return { start: dayStart + offset * DAY_MS, end: dayStart + (offset + 1) * DAY_MS };
		case 'week': {
			const weekStartsOn = ctx.weekStartsOn ?? 1;
			const dow = new Date(dayStart).getUTCDay();
			const back = (dow - weekStartsOn + 7) % 7;
			const start = dayStart - back * DAY_MS + offset * 7 * DAY_MS;
			return { start, end: start + 7 * DAY_MS };
		}
		case 'month': {
			const d = new Date(ms);
			const y = d.getUTCFullYear();
			const m = d.getUTCMonth() + offset;
			return { start: utc(y, m, 1), end: utc(y, m + 1, 1) };
		}
		case 'year': {
			const y = new Date(ms).getUTCFullYear() + offset;
			return { start: utc(y, 0, 1), end: utc(y + 1, 0, 1) };
		}
	}
}

/** The interval of a date operand. A relative operand covers its whole unit ("one week ago" is that week). */
export function operandInterval(operand: DateOperand, ctx: DateCtx): Interval | null {
	if (operand.kind === 'relative') return unitInterval(ctx.now, operand.unit, operand.offset, ctx);
	return dateValueInterval({ start: operand.date });
}

/**
 * The interval of a range operand. Named ranges: `this_*` is the current calendar unit; `past_*`
 * runs from one unit before today through the end of today; `next_*` from today through one unit
 * after today (end of that day included).
 */
export function rangeInterval(range: DateRangeOperand, ctx: DateCtx): Interval | null {
	if (range.kind === 'between') {
		const a = operandInterval(range.from, ctx);
		const b = operandInterval(range.to, ctx);
		if (!a || !b) return null;
		return { start: a.start, end: Math.max(b.end, a.start + 1) };
	}
	const today = unitInterval(ctx.now, 'day', 0, ctx);
	const [dir, unit] = range.range.split('_') as ['past' | 'this' | 'next', 'week' | 'month' | 'year'];
	if (dir === 'this') return unitInterval(ctx.now, unit, 0, ctx);
	const shiftDay = (anchor: number, n: number): number => {
		if (unit === 'week') return anchor + n * 7 * DAY_MS;
		const d = new Date(anchor);
		const months = unit === 'month' ? n : n * 12;
		const target = utc(d.getUTCFullYear(), d.getUTCMonth() + months, 1);
		// Clamp the day of month ("Mar 31 minus one month" is Feb 28/29).
		const last = new Date(utc(new Date(target).getUTCFullYear(), new Date(target).getUTCMonth() + 1, 0)).getUTCDate();
		return utc(
			new Date(target).getUTCFullYear(),
			new Date(target).getUTCMonth(),
			Math.min(d.getUTCDate(), last)
		);
	};
	if (dir === 'past') return { start: shiftDay(today.start, -1), end: today.end };
	return { start: today.start, end: shiftDay(today.start, 1) + DAY_MS };
}

export function intervalsOverlap(a: Interval, b: Interval): boolean {
	return a.start < b.end && b.start < a.end;
}
