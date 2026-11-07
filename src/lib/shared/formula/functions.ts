/**
 * The built-in functions: for each, its arity, its static result type given argument types, and its
 * implementation over evaluated values. `if`, `map` and `filter` are special forms handled by the analyzer
 * and the evaluator (lazy arguments, a scope).
 */
import { DAY_MS, formatDate, parseIsoDate } from '../dates';
import { formatNumber, formatValue, fits, isList, typeName, type FType, type FormulaDate, type FormulaValue } from './types';

/** A problem found while running a function (wrong kind of value, bad unit). */
export class RuntimeFailure extends Error {}
const fail = (message: string): never => {
	throw new RuntimeFailure(message);
};

export interface RunCtx {
	now: number;
}

export interface FnDef {
	min: number;
	max: number;
	/** Result type from the argument types; `bad(i, message)` flags argument `i`. */
	type(args: FType[], bad: (index: number, message: string) => void): FType;
	run(args: FormulaValue[], ctx: RunCtx): FormulaValue;
}

// ───────────────────────────── coercions ─────────────────────────────

const kind = (v: FormulaValue): string =>
	v === null ? 'an empty value' : typeof v === 'string' ? 'text' : typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'a checkbox' : Array.isArray(v) ? 'a list' : 'a date';

export const asNumber = (v: FormulaValue): number => {
	if (v === null) return 0;
	if (typeof v === 'number') return v;
	return fail(`Expected a number, got ${kind(v)}`);
};
export const asText = (v: FormulaValue): string => (typeof v === 'string' ? v : v === null ? '' : fail(`Expected text, got ${kind(v)}`));
export const asBool = (v: FormulaValue): boolean => (v === null ? false : typeof v === 'boolean' ? v : fail(`Expected a checkbox, got ${kind(v)}`));
const asList = (v: FormulaValue): FormulaValue[] => (v === null ? [] : Array.isArray(v) ? v : fail(`Expected a list, got ${kind(v)}`));
const isDate = (v: FormulaValue): v is FormulaDate => typeof v === 'object' && v !== null && !Array.isArray(v);
const asDate = (v: FormulaValue): FormulaDate | null => (v === null ? null : isDate(v) ? v : fail(`Expected a date, got ${kind(v)}`));

// ───────────────────────────── dates ─────────────────────────────

const UNITS: Record<string, string> = {
	year: 'years',
	years: 'years',
	quarter: 'quarters',
	quarters: 'quarters',
	month: 'months',
	months: 'months',
	week: 'weeks',
	weeks: 'weeks',
	day: 'days',
	days: 'days',
	hour: 'hours',
	hours: 'hours',
	minute: 'minutes',
	minutes: 'minutes',
	second: 'seconds',
	seconds: 'seconds',
	millisecond: 'milliseconds',
	milliseconds: 'milliseconds'
};
export const DATE_UNIT_NAMES = Object.keys(UNITS);
const UNIT_MS: Record<string, number> = { weeks: 7 * DAY_MS, days: DAY_MS, hours: 3_600_000, minutes: 60_000, seconds: 1000, milliseconds: 1 };

const unitOf = (v: FormulaValue): string => {
	const u = UNITS[asText(v).toLowerCase()];
	return u ?? fail(`Unknown unit "${asText(v)}" (use years, quarters, months, weeks, days, hours, minutes or seconds)`);
};

/** `ms` moved by `n` calendar months, clamping the day ("Jan 31 + 1 month" is the end of February). */
function addMonths(ms: number, n: number): number {
	const d = new Date(ms);
	const target = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
	const y = Math.floor(target / 12);
	const m = ((target % 12) + 12) % 12;
	const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
	const out = new Date(ms);
	out.setUTCFullYear(y, m, Math.min(d.getUTCDate(), last));
	return out.getTime();
}

function shift(ms: number, n: number, unit: string): number {
	if (unit === 'years') return addMonths(ms, n * 12);
	if (unit === 'quarters') return addMonths(ms, n * 3);
	if (unit === 'months') return addMonths(ms, n);
	return ms + n * UNIT_MS[unit];
}

function dateAdd(d: FormulaDate | null, n: number, unit: string): FormulaDate | null {
	if (d === null) return null;
	const time = d.time || unit === 'hours' || unit === 'minutes' || unit === 'seconds' || unit === 'milliseconds';
	return { start: shift(d.start, n, unit), end: d.end === null ? null : shift(d.end, n, unit), time };
}

function between(a: number, b: number, unit: string): number {
	if (unit === 'years' || unit === 'quarters' || unit === 'months') {
		const da = new Date(a);
		const db = new Date(b);
		let months = (da.getUTCFullYear() - db.getUTCFullYear()) * 12 + (da.getUTCMonth() - db.getUTCMonth());
		const moved = addMonths(b, months);
		if (months > 0 && moved > a) months--;
		else if (months < 0 && moved < a) months++;
		return unit === 'months' ? months : Math.trunc(months / (unit === 'years' ? 12 : 3));
	}
	return Math.trunc((a - b) / UNIT_MS[unit]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Formats a date with moment-style tokens (`YYYY-MM-DD`, `MMMM D, YYYY`, `HH:mm`, `[text]` escapes), in UTC. */
export function formatWithPattern(ms: number, pattern: string): string {
	const d = new Date(ms);
	const p2 = (n: number) => String(n).padStart(2, '0');
	const h12 = d.getUTCHours() % 12 || 12;
	const tokens: Record<string, string> = {
		YYYY: String(d.getUTCFullYear()).padStart(4, '0'),
		YY: p2(d.getUTCFullYear() % 100),
		MMMM: MONTHS[d.getUTCMonth()],
		MMM: MONTHS[d.getUTCMonth()].slice(0, 3),
		MM: p2(d.getUTCMonth() + 1),
		M: String(d.getUTCMonth() + 1),
		DD: p2(d.getUTCDate()),
		D: String(d.getUTCDate()),
		dddd: WEEKDAYS[d.getUTCDay()],
		ddd: WEEKDAYS[d.getUTCDay()].slice(0, 3),
		HH: p2(d.getUTCHours()),
		H: String(d.getUTCHours()),
		hh: p2(h12),
		h: String(h12),
		mm: p2(d.getUTCMinutes()),
		m: String(d.getUTCMinutes()),
		ss: p2(d.getUTCSeconds()),
		s: String(d.getUTCSeconds()),
		A: d.getUTCHours() < 12 ? 'AM' : 'PM',
		a: d.getUTCHours() < 12 ? 'am' : 'pm'
	};
	return pattern.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g, (m, lit: string | undefined) => (lit !== undefined ? lit : (tokens[m] ?? m)));
}

// ───────────────────────────── type helpers ─────────────────────────────

type Bad = (index: number, message: string) => void;
const need = (args: FType[], i: number, expected: FType, bad: Bad): void => {
	if (!fits(args[i], expected)) bad(i, `Expected ${typeName(expected)}, got ${typeName(args[i])}`);
};
const needList = (args: FType[], i: number, bad: Bad): FType => {
	const t = args[i];
	if (t === 'any') return 'any';
	if (!isList(t)) {
		bad(i, `Expected a list, got ${typeName(t)}`);
		return 'any';
	}
	return t.list;
};
const fixed = (min: number, max: number, params: FType[], result: FType, run: FnDef['run']): FnDef => ({
	min,
	max,
	type: (args, bad) => {
		args.forEach((_, i) => need(args, i, params[Math.min(i, params.length - 1)], bad));
		return result;
	},
	run
});

const numbersOf = (args: FormulaValue[]): number[] => (args.length === 1 && Array.isArray(args[0]) ? args[0].map(asNumber) : args.map(asNumber));
const variadicNumbers = (run: (xs: number[]) => number | null): FnDef => ({
	min: 1,
	max: Infinity,
	type: (args, bad) => {
		if (args.length === 1 && (isList(args[0]) || args[0] === 'any')) {
			if (isList(args[0])) need([args[0].list], 0, 'number', bad);
			return 'number';
		}
		args.forEach((_, i) => need(args, i, 'number', bad));
		return 'number';
	},
	run: (args) => run(numbersOf(args))
});

const equalValues = (a: FormulaValue, b: FormulaValue): boolean => {
	if (a === null || b === null) {
		const other = a === null ? b : a;
		return other === null || other === '' || other === 0 || other === false || (Array.isArray(other) && other.length === 0);
	}
	if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equalValues(x, b[i]));
	if (isDate(a) || isDate(b)) return isDate(a) && isDate(b) && a.start === b.start && a.end === b.end;
	return a === b;
};
export { equalValues };

const roundHalfAway = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

export const FUNCTIONS: Readonly<Record<string, FnDef>> = {
	// text
	concat: { min: 0, max: Infinity, type: () => 'text', run: (a) => a.map(formatValue).join('') },
	length: {
		min: 1,
		max: 1,
		type: (args, bad) => {
			if (args[0] !== 'text' && args[0] !== 'any' && !isList(args[0])) bad(0, `Expected text or a list, got ${typeName(args[0])}`);
			return 'number';
		},
		run: ([v]) => (v === null ? 0 : typeof v === 'string' ? [...v].length : Array.isArray(v) ? v.length : fail(`Expected text or a list, got ${kind(v)}`))
	},
	contains: fixed(2, 2, ['text'], 'checkbox', ([a, b]) => asText(a).includes(asText(b))),
	replace: fixed(3, 3, ['text'], 'text', ([a, b, c]) => {
		const s = asText(a);
		const i = s.indexOf(asText(b));
		return i < 0 || asText(b) === '' ? s : s.slice(0, i) + asText(c) + s.slice(i + asText(b).length);
	}),
	replaceall: fixed(3, 3, ['text'], 'text', ([a, b, c]) => (asText(b) === '' ? asText(a) : asText(a).split(asText(b)).join(asText(c)))),
	lower: fixed(1, 1, ['text'], 'text', ([a]) => asText(a).toLowerCase()),
	upper: fixed(1, 1, ['text'], 'text', ([a]) => asText(a).toUpperCase()),
	trim: fixed(1, 1, ['text'], 'text', ([a]) => asText(a).trim()),
	slice: {
		min: 2,
		max: 3,
		type: (args, bad) => {
			need(args, 0, 'text', bad);
			args.slice(1).forEach((_, i) => need(args, i + 1, 'number', bad));
			return 'text';
		},
		run: ([a, s, e]) => asText(a).slice(asNumber(s), e === undefined ? undefined : asNumber(e))
	},
	format: { min: 1, max: 1, type: () => 'text', run: ([a]) => formatValue(a) },
	tonumber: {
		min: 1,
		max: 1,
		type: (args, bad) => {
			if (args[0] !== 'text' && args[0] !== 'number' && args[0] !== 'checkbox' && args[0] !== 'any') bad(0, `Expected text, a number or a checkbox, got ${typeName(args[0])}`);
			return 'number';
		},
		run: ([a]) => {
			if (typeof a === 'number') return a;
			if (typeof a === 'boolean') return a ? 1 : 0;
			const s = asText(a).trim();
			const n = s === '' ? NaN : Number(s.replace(/,/g, ''));
			return Number.isFinite(n) ? n : null;
		}
	},
	empty: {
		min: 1,
		max: 1,
		type: () => 'checkbox',
		run: ([a]) => a === null || a === '' || (Array.isArray(a) && a.length === 0)
	},
	// numbers
	round: {
		min: 1,
		max: 2,
		type: (args, bad) => {
			args.forEach((_, i) => need(args, i, 'number', bad));
			return 'number';
		},
		run: ([a, p]) => {
			const f = 10 ** (p === undefined ? 0 : Math.trunc(asNumber(p)));
			return roundHalfAway(asNumber(a) * f) / f;
		}
	},
	floor: fixed(1, 1, ['number'], 'number', ([a]) => Math.floor(asNumber(a))),
	ceil: fixed(1, 1, ['number'], 'number', ([a]) => Math.ceil(asNumber(a))),
	abs: fixed(1, 1, ['number'], 'number', ([a]) => Math.abs(asNumber(a))),
	sqrt: fixed(1, 1, ['number'], 'number', ([a]) => (asNumber(a) < 0 ? null : Math.sqrt(asNumber(a)))),
	pow: fixed(2, 2, ['number'], 'number', ([a, b]) => asNumber(a) ** asNumber(b)),
	min: variadicNumbers((xs) => (xs.length ? Math.min(...xs) : null)),
	max: variadicNumbers((xs) => (xs.length ? Math.max(...xs) : null)),
	sum: variadicNumbers((xs) => xs.reduce((s, x) => s + x, 0)),
	// dates
	now: { min: 0, max: 0, type: () => 'date', run: (_a, ctx) => ({ start: ctx.now, end: null, time: true }) },
	today: { min: 0, max: 0, type: () => 'date', run: (_a, ctx) => ({ start: Math.floor(ctx.now / DAY_MS) * DAY_MS, end: null, time: false }) },
	date: {
		min: 1,
		max: 1,
		type: (args, bad) => {
			need(args, 0, 'text', bad);
			return 'date';
		},
		run: ([a]) => {
			const p = parseIsoDate(asText(a).trim());
			return p ? { start: p.ms, end: null, time: !p.dateOnly } : null;
		}
	},
	timestamp: fixed(1, 1, ['date'], 'number', ([a]) => asDate(a)?.start ?? null),
	year: fixed(1, 1, ['date'], 'number', ([a]) => (asDate(a) ? new Date((asDate(a) as FormulaDate).start).getUTCFullYear() : null)),
	month: fixed(1, 1, ['date'], 'number', ([a]) => (asDate(a) ? new Date((asDate(a) as FormulaDate).start).getUTCMonth() + 1 : null)),
	day: fixed(1, 1, ['date'], 'number', ([a]) => (asDate(a) ? new Date((asDate(a) as FormulaDate).start).getUTCDate() : null)),
	dateadd: {
		min: 3,
		max: 3,
		type: (args, bad) => {
			need(args, 0, 'date', bad);
			need(args, 1, 'number', bad);
			need(args, 2, 'text', bad);
			return 'date';
		},
		run: ([d, n, u]) => dateAdd(asDate(d), asNumber(n), unitOf(u))
	},
	datesubtract: {
		min: 3,
		max: 3,
		type: (args, bad) => {
			need(args, 0, 'date', bad);
			need(args, 1, 'number', bad);
			need(args, 2, 'text', bad);
			return 'date';
		},
		run: ([d, n, u]) => dateAdd(asDate(d), -asNumber(n), unitOf(u))
	},
	datebetween: {
		min: 3,
		max: 3,
		type: (args, bad) => {
			need(args, 0, 'date', bad);
			need(args, 1, 'date', bad);
			need(args, 2, 'text', bad);
			return 'number';
		},
		run: ([a, b, u]) => {
			const x = asDate(a);
			const y = asDate(b);
			return x && y ? between(x.start, y.start, unitOf(u)) : null;
		}
	},
	formatdate: {
		min: 1,
		max: 2,
		type: (args, bad) => {
			need(args, 0, 'date', bad);
			if (args[1] !== undefined) need(args, 1, 'text', bad);
			return 'text';
		},
		run: ([d, f]) => {
			const x = asDate(d);
			if (!x) return null;
			return f === undefined ? formatDate(x.start, !x.time) : formatWithPattern(x.start, asText(f));
		}
	},
	start: fixed(1, 1, ['date'], 'date', ([d]) => (asDate(d) ? { start: (asDate(d) as FormulaDate).start, end: null, time: (asDate(d) as FormulaDate).time } : null)),
	end: fixed(1, 1, ['date'], 'date', ([d]) => {
		const x = asDate(d);
		return x ? { start: x.end ?? x.start, end: null, time: x.time } : null;
	}),
	// lists
	join: {
		min: 1,
		max: 2,
		type: (args, bad) => {
			needList(args, 0, bad);
			if (args[1] !== undefined) need(args, 1, 'text', bad);
			return 'text';
		},
		run: ([l, sep]) => asList(l).map(formatValue).join(sep === undefined ? ', ' : asText(sep))
	},
	includes: {
		min: 2,
		max: 2,
		type: (args, bad) => {
			const inner = needList(args, 0, bad);
			need([inner, args[1]], 1, inner, bad);
			return 'checkbox';
		},
		run: ([l, x]) => asList(l).some((y) => equalValues(y, x))
	},
	first: { min: 1, max: 1, type: (args, bad) => needList(args, 0, bad), run: ([l]) => asList(l)[0] ?? null },
	last: { min: 1, max: 1, type: (args, bad) => needList(args, 0, bad), run: ([l]) => asList(l).at(-1) ?? null },
	at: {
		min: 2,
		max: 2,
		type: (args, bad) => {
			need(args, 1, 'number', bad);
			return needList(args, 0, bad);
		},
		run: ([l, i]) => asList(l)[Math.trunc(asNumber(i))] ?? null
	}
};

/** Functions the analyzer and evaluator treat specially. */
export const SPECIAL_FORMS: ReadonlySet<string> = new Set(['if', 'map', 'filter']);
export const FUNCTION_NAMES: readonly string[] = [...Object.keys(FUNCTIONS), ...SPECIAL_FORMS];
export { formatNumber };
