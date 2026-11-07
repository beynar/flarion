/**
 * Sort keys: the normalized `v` of the typed EAV tables, and fractional ranks for ordered lists.
 *
 * Value keys
 * - Text: folded (NFKD, combining marks removed, lower-cased, a few Latin letters expanded) and cut
 *   at TEXT_KEY_MAX code units. SQLite's default BINARY collation compares UTF-8 bytes, which is
 *   code point order; `compareText` does the same in memory, so a JS sort and `ORDER BY v` agree.
 *   Equal keys ("Éa" and "ea") are stable by the EAV primary key (`prop, v, page`); the in-memory
 *   comparators take the raw string, then the page id, as tie-breaks.
 * - Numbers: the number itself (an INTEGER or REAL in SQLite). -0 becomes 0, NaN and infinities
 *   are refused.
 * - Dates: epoch milliseconds (date-only values at UTC midnight).
 *
 * Rank keys (sibling `rank`, `collection_member.rank`, view order, manual order)
 * - The format is viborm's `viborm/ordering` key grammar: a self-delimiting integer part followed by
 *   a decimal fraction without trailing zeros, digits only, at most 64 characters, compared as plain
 *   strings. `viborm/ordering`'s `isKeyFormat` accepts every key produced here and `keyBetween`'s
 *   keys are valid inputs to `rankBetween` (tests check both). It is re-implemented, not imported,
 *   because `viborm/ordering` pulls the whole ORM client into any bundle that imports it, and this
 *   module must stay light enough for the browser. Jitter is optional (`rand`): without it keys are
 *   deterministic, which is what the oracle tests want.
 */

export type SortKey = string | number;

// ───────────────────────────── value keys ─────────────────────────────

/** Longest text key kept in the index, in UTF-16 code units. */
export const TEXT_KEY_MAX = 256;

const EXPANSIONS: Readonly<Record<string, string>> = {
	'ß': 'ss',
	'æ': 'ae',
	'œ': 'oe',
	'ø': 'o',
	'đ': 'd',
	'ł': 'l',
	'ı': 'i',
	'þ': 'th'
};
const EXPAND_RE = /[ßæœøđłıþ]/g;
const MARKS_RE = /\p{M}+/gu;

/** Case- and diacritic-insensitive form of a string. Idempotent. */
export function foldText(s: string): string {
	return s
		.normalize('NFKD')
		.replace(MARKS_RE, '')
		.toLowerCase()
		.replace(EXPAND_RE, (c) => EXPANSIONS[c] ?? c);
}

/** The folded text, cut to TEXT_KEY_MAX code units without splitting a surrogate pair. */
export function textSortKey(s: string): string {
	const folded = foldText(s);
	if (folded.length <= TEXT_KEY_MAX) return folded;
	let end = TEXT_KEY_MAX;
	const last = folded.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return folded.slice(0, end);
}

// Re-order UTF-16 units so that plain unit comparison equals code point (UTF-8 byte) order.
const fix = (c: number): number => (c >= 0xe000 ? c - 0x800 : c >= 0xd800 ? c + 0x2000 : c);

/** Compares two strings by code point, as SQLite's BINARY collation does on UTF-8. */
export function compareText(a: string, b: string): number {
	if (a === b) return 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x !== y) return fix(x) < fix(y) ? -1 : 1;
	}
	return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** A number as a `p_num.v`. */
export function numberSortKey(n: number): number {
	if (!Number.isFinite(n)) throw new RangeError(`Not a finite number: ${n}`);
	return n === 0 ? 0 : n;
}

/** Order of SQLite storage classes: numbers before text. Equal-class keys compare by value. */
export function compareSortKeys(a: SortKey, b: SortKey): number {
	if (typeof a === 'number') {
		if (typeof b !== 'number') return -1;
		return a < b ? -1 : a > b ? 1 : 0;
	}
	if (typeof b === 'number') return 1;
	return compareText(a, b);
}

/**
 * Compares two optional keys for a sort direction. Empty values go last by default, whatever the
 * direction (as Notion does); `nulls: 'first'` puts them first.
 */
export function compareOptionalKeys(
	a: SortKey | null,
	b: SortKey | null,
	dir: 'asc' | 'desc' = 'asc',
	nulls: 'first' | 'last' = 'last'
): number {
	if (a === null || b === null) {
		if (a === b) return 0;
		const aFirst = nulls === 'first';
		return a === null ? (aFirst ? -1 : 1) : aFirst ? 1 : -1;
	}
	const c = compareSortKeys(a, b);
	return dir === 'asc' ? c : -c;
}

// ───────────────────────────── rank keys ─────────────────────────────

/** The longest rank accepted (viborm's MAX_KEY_LENGTH). */
export const MAX_RANK_LENGTH = 64;
/** Past this length, callers should rebalance the list the next time they write to it. */
export const REBALANCE_LENGTH = 32;

export class RankOverflowError extends RangeError {
	constructor(message = 'Rank key would exceed the maximum length: rebalance the list') {
		super(message);
		this.name = 'RankOverflowError';
	}
}
export class RankCollisionError extends RangeError {
	constructor(message = 'Neighbouring ranks are equal: rebalance the list') {
		super(message);
		this.name = 'RankCollisionError';
	}
}

const TEN = 10n;
const DIGITS = /^\d+$/;

interface RankParts {
	integer: string;
	fraction: string;
}

function split(key: string): RankParts | undefined {
	if (key.length < 2 || !DIGITS.test(key)) return undefined;
	let integer: string;
	if (key[0] === '0') {
		const n = 9 - Number(key[1]);
		if (n < 1) return undefined;
		integer = key.slice(0, 2 + n);
		if (integer.length !== 2 + n) return undefined;
		const digits = BigInt(integer.slice(2));
		if (digits < 1n || digits > 9n * TEN ** BigInt(n - 1)) return undefined;
	} else {
		const n = Number(key[0]);
		integer = key.slice(0, 1 + n);
		if (integer.length !== 1 + n || (n > 1 && integer[1] === '0')) return undefined;
	}
	const fraction = key.slice(integer.length);
	if (fraction.endsWith('0')) return undefined;
	return { integer, fraction };
}

/** Whether `value` is a well-formed rank key (viborm's `isKeyFormat`). */
export function isRank(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_RANK_LENGTH && split(value) !== undefined;
}

function integerValue(integer: string): bigint {
	return integer[0] === '0'
		? BigInt(integer.slice(2)) - TEN ** BigInt(integer.length - 2)
		: BigInt(integer.slice(1));
}

function encodeInteger(n: bigint): string {
	if (n >= 0n) {
		const t = n.toString();
		if (t.length > 9) throw new RankOverflowError('Rank integer part out of range');
		return `${t.length}${t}`;
	}
	const t = (-n).toString();
	if (t.length > 9) throw new RankOverflowError('Rank integer part out of range');
	const digits = (TEN ** BigInt(t.length) + n).toString().padStart(t.length, '0');
	return `0${9 - t.length}${digits}`;
}

/** A decimal fraction strictly between `lo` and `hi` (digit strings; `hi` null is 1). */
function fractionBetween(lo: string, hi: string | null, rand?: () => number): string {
	let n = Math.max(lo.length, hi?.length ?? 0) + 1;
	for (;;) {
		const a = BigInt(lo.padEnd(n, '0') || '0');
		const b = hi === null ? TEN ** BigInt(n) : BigInt(hi.padEnd(n, '0'));
		const span = b - a;
		if (span >= 2n) {
			let m: bigint;
			if (rand && span >= 9n) {
				// The middle third, so two clients inserting at one spot rarely pick the same key.
				const third = span / 3n;
				m = a + third + BigInt(Math.floor(rand() * Number(third)));
			} else {
				m = (a + b) / 2n;
			}
			return m.toString().padStart(n, '0').replace(/0+$/, '');
		}
		n += 1;
	}
}

function parseRank(key: string): { value: bigint; fraction: string } {
	const parts = split(key);
	if (!parts) throw new RangeError(`"${key}" is not a rank key`);
	return { value: integerValue(parts.integer), fraction: parts.fraction };
}

/**
 * One rank strictly between `lower` and `upper` (null is an open end). Throws RankCollisionError
 * when `lower >= upper` and RankOverflowError when the result would be longer than MAX_RANK_LENGTH.
 */
export function rankBetween(lower: string | null, upper: string | null, rand?: () => number): string {
	if (lower !== null && upper !== null && lower >= upper) {
		if (lower === upper) throw new RankCollisionError();
		throw new RangeError(`Rank bounds out of order: "${lower}" >= "${upper}"`);
	}
	let result: string;
	if (lower === null && upper === null) {
		result = encodeInteger(0n);
	} else if (upper === null) {
		result = encodeInteger(parseRank(lower as string).value + 1n);
	} else if (lower === null) {
		const b = parseRank(upper);
		result = encodeInteger(b.fraction ? b.value : b.value - 1n);
	} else {
		const a = parseRank(lower);
		const b = parseRank(upper);
		if (b.value > a.value) {
			const next = encodeInteger(a.value + 1n);
			result =
				next < upper ? next : encodeInteger(a.value) + fractionBetween(a.fraction, null, rand);
		} else {
			result = encodeInteger(a.value) + fractionBetween(a.fraction, b.fraction, rand);
		}
	}
	if (result.length > MAX_RANK_LENGTH) throw new RankOverflowError();
	return result;
}

/** `n` ranks, ascending, strictly between `lower` and `upper`. */
export function ranksBetween(
	lower: string | null,
	upper: string | null,
	n: number,
	rand?: () => number
): string[] {
	if (!Number.isInteger(n) || n < 0) throw new RangeError('n must be a non-negative integer');
	if (n === 0) return [];
	const mid = rankBetween(lower, upper, rand);
	const left = Math.floor((n - 1) / 2);
	return [
		...ranksBetween(lower, mid, left, rand),
		mid,
		...ranksBetween(mid, upper, n - 1 - left, rand)
	];
}

/** A rank after every existing one (`last` null: the list is empty). */
export const rankAfter = (last: string | null, rand?: () => number): string => rankBetween(last, null, rand);
/** A rank before every existing one. */
export const rankBefore = (first: string | null, rand?: () => number): string => rankBetween(null, first, rand);

export function compareRank(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export interface RankedItem {
	id: string;
	rank: string;
}
export interface RankAssignment {
	id: string;
	rank: string;
}

/** Sibling order: rank, then id for equal ranks. */
export function compareRanked(a: RankedItem, b: RankedItem): number {
	return compareRank(a.rank, b.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Evenly spaced fresh ranks (`"10"`, `"11"`, ...) for `n` items. */
export function evenRanks(n: number): string[] {
	return Array.from({ length: n }, (_, i) => encodeInteger(BigInt(i)));
}

/** Whether a sorted list of ranks should be rebalanced: a long key, or two equal neighbours. */
export function needsRebalance(ranks: readonly string[]): boolean {
	for (let i = 0; i < ranks.length; i++) {
		if (ranks[i].length > REBALANCE_LENGTH) return true;
		if (i > 0 && ranks[i] === ranks[i - 1]) return true;
	}
	return false;
}

/** New evenly spaced ranks for a list, in its current order (rank, then id). */
export function rebalance(items: readonly RankedItem[]): RankAssignment[] {
	const sorted = [...items].sort(compareRanked);
	const ranks = evenRanks(sorted.length);
	return sorted.map((s, i) => ({ id: s.id, rank: ranks[i] }));
}

export interface Placement {
	/** The rank of the moved item. */
	rank: string;
	/** Other items whose ranks changed because the list had to be rebalanced; null when none. */
	rebalanced: RankAssignment[] | null;
}

/**
 * The rank that puts `id` at `index` among `siblings` (the item itself is ignored if present).
 * When no rank fits between the neighbours, the list is rebalanced and the other items' new ranks
 * are returned with it.
 */
export function placeAt(
	siblings: readonly RankedItem[],
	id: string,
	index: number,
	rand?: () => number
): Placement {
	const others = siblings.filter((s) => s.id !== id).sort(compareRanked);
	const at = Math.max(0, Math.min(index, others.length));
	const lower = at > 0 ? others[at - 1].rank : null;
	const upper = at < others.length ? others[at].rank : null;
	try {
		return { rank: rankBetween(lower, upper, rand), rebalanced: null };
	} catch (e) {
		if (!(e instanceof RankCollisionError || e instanceof RankOverflowError)) throw e;
		const ordered = [...others.slice(0, at), { id, rank: '' }, ...others.slice(at)];
		const ranks = evenRanks(ordered.length);
		return {
			rank: ranks[at],
			rebalanced: ordered.map((s, i) => ({ id: s.id, rank: ranks[i] })).filter((a) => a.id !== id)
		};
	}
}
