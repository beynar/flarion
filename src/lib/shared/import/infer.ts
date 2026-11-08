/**
 * Type inference and cell conversion for the CSV import (docs/PLAN.md "Databases: Imports").
 *
 * `inferColumns` looks at a sample of rows and gives every column a property type; the user may override it in the
 * preview. `convertCell` turns one text cell into the value of that type, and is what the import Workflow applies to
 * every row, so the preview and the import agree.
 *
 * Rules, in the order they are tried on the non-empty cells of a column (every one of them must fit):
 *   checkbox    true/false, yes/no, y/n, checked/unchecked, x (any case); empty cells stay empty
 *   number      -12, 3.5, 1,234.56 (or 1.234,56 when the file uses `;`), 1e3; not "007" or ids of 16+ digits (text)
 *   date        ISO 8601 (with or without time), 2026/01/15, 15/01/2026, 01/15/2026, 15.01.2026, 15 Jan 2026,
 *               January 15, 2026, with an optional time (24 h or AM/PM). Day-first or month-first follows the
 *               sample (a part above 12 decides; undecided reads month-first, as US spreadsheets do); a sample that
 *               needs both is text. A time anywhere in the column turns on the time of the property.
 *   email, url  user@host, http(s)://...
 *   phone       +33 6 12 34 56 78, (555) 123-4567: 7 to 15 digits with a `+`, parentheses or separators
 *   multi-select  at least 20% of the cells hold a comma list, and the items repeat (few distinct, short ones)
 *   select      few distinct short values that repeat (at most 20 distinct, and at most half as many as cells)
 *   text        anything else
 * The first column is the title, whatever it holds. A column with no value in the sample is text.
 */
import { canonicalDate } from '../dates.js';
import type { PropValue } from '../property-types.js';

export const IMPORT_TYPES = ['title', 'text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];
export type ImportColumnType = ImportType | 'skip';

/** What the import knows about a column: where it is in the file, its property name and type, and how to read it. */
export interface ImportColumn {
	/** Index of the column in the file. */
	index: number;
	/** The property's name (the header, made unique). */
	name: string;
	type: ImportColumnType;
	/** `date` only: day first (15/01/2026) or month first (01/15/2026) for numeric dates. */
	dateOrder?: 'dmy' | 'mdy';
	/** `date` only: the column holds times, so the property keeps them. */
	includeTime?: boolean;
	/** `number` only: the comma is the decimal mark (1.234,56). */
	decimalComma?: boolean;
}

// ───────────────────────────── headers ─────────────────────────────

/** Header cells as property names: trimmed, never empty, at most 100 characters, unique (case-insensitive). */
export function headerNames(header: readonly string[]): string[] {
	const seen = new Set<string>();
	return header.map((raw, i) => {
		const base = (raw.trim().replace(/\s+/g, ' ') || `Column ${i + 1}`).slice(0, 94);
		let name = base;
		for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base} ${n}`;
		seen.add(name.toLowerCase());
		return name;
	});
}

// ───────────────────────────── cell parsers ─────────────────────────────

const TRUE_WORDS = new Set(['true', 'yes', 'y', 'checked', 'x', 'oui']);
const FALSE_WORDS = new Set(['false', 'no', 'n', 'unchecked', 'non']);
const CHECKBOX_WORDS = new Set([...TRUE_WORDS, ...FALSE_WORDS]);

/** `true` or `false` for a checkbox word, `null` for anything else. */
export function parseBoolean(raw: string): boolean | null {
	const word = raw.trim().toLowerCase();
	if (TRUE_WORDS.has(word)) return true;
	if (FALSE_WORDS.has(word)) return false;
	return null;
}

const PLAIN_INT = /^[+-]?\d+$/;
const PLAIN_DECIMAL = /^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?\d+[eE][+-]?\d+$/;
const US_THOUSANDS = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const EU_THOUSANDS = /^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/;
const EU_DECIMAL = /^[+-]?\d+,\d+$/;

/** A number, or `null`. Ids with leading zeros and 16+ digit strings are not numbers (they would lose digits). */
export function parseNumber(raw: string, decimalComma = false): number | null {
	const s = raw.trim().replace(/\s/g, '');
	if (s === '') return null;
	let text: string;
	if (PLAIN_INT.test(s)) {
		const digits = s.replace(/^[+-]/, '');
		if (digits.length > 15 || (digits.length > 1 && digits.startsWith('0'))) return null;
		text = s;
	} else if (PLAIN_DECIMAL.test(s)) text = s;
	else if (decimalComma ? EU_THOUSANDS.test(s) : US_THOUSANDS.test(s)) text = decimalComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
	else if (decimalComma && EU_DECIMAL.test(s)) text = s.replace(',', '.');
	else return null;
	const n = Number(text);
	return Number.isFinite(n) ? n : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (word: string): number => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const TIME = '(?:[ T,]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([ap]m)?)?';
const YMD = new RegExp(`^(\\d{4})[/.](\\d{1,2})[/.](\\d{1,2})${TIME}$`, 'i');
const NUMERIC = new RegExp(`^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{2}|\\d{4})${TIME}$`, 'i');
const DAY_MONTH_NAME = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[ -]${MONTH_NAME}[ ,-]+(\\d{4})${TIME}$`, 'i');
const MONTH_NAME_DAY = new RegExp(`^${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${TIME}$`, 'i');

const pad = (n: number | string, width = 2) => String(n).padStart(width, '0');
const fullYear = (y: string): string => (y.length === 4 ? y : Number(y) < 70 ? `20${y}` : `19${y}`);

/** The first and second part of a numeric date (`15/01/2026`), when the text is one. */
function numericParts(raw: string): [number, number] | null {
	const m = NUMERIC.exec(raw.trim());
	return m ? [Number(m[1]), Number(m[2])] : null;
}

export interface LooseDate {
	/** Canonical text: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:ss(.SSS)Z` with a time (read as UTC when it has no offset). */
	value: string;
	hasTime: boolean;
}

function timeOf(h: string | undefined, mi: string | undefined, s: string | undefined, ampm: string | undefined): string | null {
	if (h === undefined) return '';
	let hour = Number(h);
	if (ampm) {
		if (hour < 1 || hour > 12) return null;
		hour = (hour % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
	}
	return `T${pad(hour)}:${mi}:${s ?? '00'}`;
}

/** Reads a date written any of the ways listed in the module note. `order` settles `01/02/2026`. */
export function parseLooseDate(raw: string, order: 'dmy' | 'mdy' = 'mdy'): LooseDate | null {
	const text = raw.trim();
	if (text === '') return null;
	// ISO first, also with a space between the date and the time.
	const iso = canonicalDate(text.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'));
	if (iso) return { value: iso, hasTime: iso.length > 10 };
	let year: string | undefined;
	let month: number | undefined;
	let day: string | undefined;
	let time: RegExpExecArray | null = null;
	let m: RegExpExecArray | null;
	if ((m = YMD.exec(text))) [year, month, day, time] = [m[1], Number(m[2]), m[3], m];
	else if ((m = NUMERIC.exec(text))) {
		const [a, b] = [m[1]!, m[2]!];
		[year, month, day, time] = order === 'dmy' ? [fullYear(m[3]!), Number(b), a, m] : [fullYear(m[3]!), Number(a), b, m];
	} else if ((m = DAY_MONTH_NAME.exec(text))) [year, month, day, time] = [m[3], monthOf(m[2]!), m[1], m];
	else if ((m = MONTH_NAME_DAY.exec(text))) [year, month, day, time] = [m[3], monthOf(m[1]!), m[2], m];
	else return null;
	// The time groups follow the three date groups in every pattern.
	const t = timeOf(time![4], time![5], time![6], time![7]);
	if (t === null || month === undefined || month < 1 || month > 12) return null;
	const candidate = `${pad(year!, 4)}-${pad(month)}-${pad(day!)}${t}`;
	const value = canonicalDate(candidate);
	return value ? { value, hasTime: t !== '' } : null;
}

/** `dmy` / `mdy` when the numeric dates of a column settle it, `null` when they do not say, `'conflict'` when they disagree. */
export function detectDateOrder(values: readonly string[]): 'dmy' | 'mdy' | null | 'conflict' {
	let dayFirst = false;
	let monthFirst = false;
	for (const raw of values) {
		const parts = numericParts(raw);
		if (!parts) continue;
		if (parts[0] > 12) dayFirst = true;
		if (parts[1] > 12) monthFirst = true;
	}
	if (dayFirst && monthFirst) return 'conflict';
	return dayFirst ? 'dmy' : monthFirst ? 'mdy' : null;
}

const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
const PHONE = /^(?:\+\d|\(\d)[\d\s().-]{5,}$|^\d{2,4}(?:[ .-]\d{2,4}){2,}$/;

export const isEmail = (s: string): boolean => EMAIL.test(s.trim());
export const isUrl = (s: string): boolean => URL_RE.test(s.trim());
export function isPhone(s: string): boolean {
	const t = s.trim();
	if (!PHONE.test(t)) return false;
	// "2026-01-15" and "12.5.2026" are not phones: digits only 7 to 15, no date shape.
	const digits = t.replace(/\D/g, '').length;
	return digits >= 7 && digits <= 15 && parseLooseDate(t) === null;
}

// ───────────────────────────── select options ─────────────────────────────

/** The longest option name, and the most options a column may grow (more is a text column in disguise). */
export const MAX_OPTION_NAME = 100;
export const MAX_OPTIONS = 200;
/** Items in one multi-select cell. */
export const MAX_MULTI_ITEMS = 50;

const OPTION_COLORS = ['gray', 'blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'brown', 'red'] as const;

export const foldOption = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** The options of a select-like column, grown as new values appear. Ids are `o1`, `o2`...: stable, never reused. */
export class OptionBook {
	readonly labels: string[];
	readonly #ids = new Map<string, string>();
	constructor(labels: readonly string[] = []) {
		this.labels = [];
		for (const label of labels) this.#intern(label);
	}
	#intern(label: string): string {
		const key = foldOption(label);
		const known = this.#ids.get(key);
		if (known) return known;
		const id = `o${this.labels.length + 1}`;
		this.labels.push(label.trim().replace(/\s+/g, ' ').slice(0, MAX_OPTION_NAME));
		this.#ids.set(key, id);
		return id;
	}
	/** The option id for `label`, adding it; `null` when the column is full. `added` says whether it is new. */
	id(label: string): { id: string; added: boolean } | null {
		const key = foldOption(label);
		const known = this.#ids.get(key);
		if (known) return { id: known, added: false };
		if (this.labels.length >= MAX_OPTIONS) return null;
		return { id: this.#intern(label), added: true };
	}
	/** The property's options: ids `o1`.., colours cycling through the palette so a board reads at a glance. */
	options(): { id: string; name: string; color: (typeof OPTION_COLORS)[number] }[] {
		return this.labels.map((name, i) => ({ id: `o${i + 1}`, name, color: OPTION_COLORS[i % OPTION_COLORS.length]! }));
	}
}

/** The items of a multi-select cell. */
export function splitList(raw: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of raw.split(/\s*[,;|]\s*/)) {
		const item = part.trim();
		const key = foldOption(item);
		if (item && !seen.has(key)) {
			seen.add(key);
			out.push(item);
		}
	}
	return out;
}

// ───────────────────────────── inference ─────────────────────────────

/** Rows read to infer the types. */
export const SAMPLE_ROWS = 1000;

export interface InferOptions {
	delimiter?: string;
}

const allOf = (values: readonly string[], test: (v: string) => boolean): boolean => values.length > 0 && values.every(test);

function inferColumn(index: number, name: string, values: readonly string[], options: InferOptions): ImportColumn {
	const base = { index, name };
	if (values.length === 0) return { ...base, type: 'text' };
	if (allOf(values, (v) => CHECKBOX_WORDS.has(v.trim().toLowerCase()))) return { ...base, type: 'checkbox' };
	const decimalComma = options.delimiter === ';';
	if (allOf(values, (v) => parseNumber(v, decimalComma) !== null)) return { ...base, type: 'number', ...(decimalComma ? { decimalComma } : {}) };
	const order = detectDateOrder(values);
	if (order !== 'conflict') {
		const dateOrder = order ?? 'mdy';
		const parsed = values.map((v) => parseLooseDate(v, dateOrder));
		if (parsed.every((d) => d !== null)) {
			const includeTime = parsed.some((d) => d!.hasTime);
			return { ...base, type: 'date', dateOrder, ...(includeTime ? { includeTime } : {}) };
		}
	}
	if (allOf(values, isEmail)) return { ...base, type: 'email' };
	if (allOf(values, isUrl)) return { ...base, type: 'url' };
	if (allOf(values, isPhone)) return { ...base, type: 'phone' };

	const lists = values.filter((v) => /[,;|]/.test(v));
	if (lists.length >= Math.max(1, values.length * 0.2)) {
		const tokens = values.flatMap(splitList);
		const distinct = new Set(tokens.map(foldOption));
		if (distinct.size >= 2 && distinct.size <= 50 && distinct.size <= tokens.length * 0.5 && tokens.every((t) => t.length <= 40)) return { ...base, type: 'multi_select' };
	}
	const distinct = new Set(values.map(foldOption));
	if (distinct.size <= 20 && distinct.size <= values.length / 2 && values.every((v) => v.length <= 60) && distinct.size >= 1) return { ...base, type: 'select' };
	return { ...base, type: 'text' };
}

/**
 * Infers the columns of a CSV: `header` is the first record, `rows` a sample of the records after it. The first
 * column is the title; the others are typed from the sample (see the module note).
 */
export function inferColumns(header: readonly string[], rows: readonly (readonly string[])[], options: InferOptions = {}): ImportColumn[] {
	const names = headerNames(header);
	return names.map((name, index) => {
		if (index === 0) return { index, name, type: 'title' as const };
		const values = rows.map((r) => (r[index] ?? '').trim()).filter((v) => v !== '');
		return inferColumn(index, name, values, options);
	});
}

// ───────────────────────────── conversion ─────────────────────────────

export interface Converted {
	/** The value, `null` for an empty cell or one that could not be read. */
	value: PropValue | null;
	/** The cell had text that did not fit the column's type (it is dropped). */
	rejected?: boolean;
	/** The text was cut to the property's limit. */
	truncated?: boolean;
}

export const LIMITS = { title: 2000, text: 20_000, url: 2048, email: 320, phone: 64 } as const;

/**
 * One cell as a value of the column's type. `options` is the column's {@link OptionBook} for select and
 * multi-select (the caller sends the new options to the property); a full book drops the value (`rejected`).
 */
export function convertCell(column: ImportColumn, raw: string, options?: OptionBook): Converted {
	const text = raw.trim();
	if (text === '' || column.type === 'skip') return { value: null };
	switch (column.type) {
		case 'title':
		case 'text': {
			const limit = LIMITS[column.type];
			return text.length > limit ? { value: text.slice(0, limit), truncated: true } : { value: text };
		}
		case 'number': {
			const n = parseNumber(text, column.decimalComma);
			return n === null ? { value: null, rejected: true } : { value: n };
		}
		case 'checkbox': {
			const b = parseBoolean(text);
			return b === null ? { value: null, rejected: true } : { value: b };
		}
		case 'date': {
			const d = parseLooseDate(text, column.dateOrder);
			return d ? { value: { start: d.value } } : { value: null, rejected: true };
		}
		case 'email':
			return text.length <= LIMITS.email && /^[^\s@]+@[^\s@]+$/.test(text) ? { value: text } : { value: null, rejected: true };
		case 'url':
			return text.length <= LIMITS.url ? { value: text } : { value: null, rejected: true };
		case 'phone':
			return text.length <= LIMITS.phone ? { value: text } : { value: null, rejected: true };
		case 'select': {
			const found = options?.id(text);
			return found ? { value: found.id } : { value: null, rejected: true };
		}
		case 'multi_select': {
			const ids: string[] = [];
			let rejected = false;
			for (const item of splitList(text).slice(0, MAX_MULTI_ITEMS)) {
				const found = options?.id(item);
				if (found) ids.push(found.id);
				else rejected = true;
			}
			return { value: ids.length ? ids : null, ...(rejected ? { rejected } : {}) };
		}
	}
}

/**
 * The column with another type (the user's override in the preview): the reading rules that go with the type are set
 * from the column's sample values, as inference would have set them.
 */
export function retype(column: ImportColumn, type: ImportColumnType, values: readonly string[], options: InferOptions = {}): ImportColumn {
	const { dateOrder: _order, includeTime: _time, decimalComma: _comma, ...base } = column;
	void [_order, _time, _comma];
	const next: ImportColumn = { ...base, type };
	if (type === 'number' && options.delimiter === ';') next.decimalComma = true;
	if (type === 'date') {
		const order = detectDateOrder(values);
		next.dateOrder = order === 'dmy' ? 'dmy' : 'mdy';
		if (values.some((v) => parseLooseDate(v, next.dateOrder)?.hasTime)) next.includeTime = true;
	}
	return next;
}

/** How many of the non-empty `values` do not fit the column's type (they would be left empty by the import). */
export function countRejected(column: ImportColumn, values: readonly string[]): number {
	const book = new OptionBook();
	let rejected = 0;
	for (const v of values) if (convertCell(column, v, book).rejected) rejected++;
	return rejected;
}
