import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isKeyFormat, keyBetween } from 'viborm/ordering';
import {
	MAX_RANK_LENGTH,
	RankCollisionError,
	TEXT_KEY_MAX,
	compareOptionalKeys,
	compareRanked,
	compareRank,
	compareSortKeys,
	compareText,
	evenRanks,
	foldText,
	isRank,
	needsRebalance,
	numberSortKey,
	placeAt,
	rankAfter,
	rankBefore,
	rankBetween,
	ranksBetween,
	rebalance,
	textSortKey,
	type RankedItem
} from '../../../src/lib/shared/sort-keys';
import { randomText, rng } from './helpers';

describe('text sort keys', () => {
	it('folds case and diacritics', () => {
		expect(foldText('Éclair')).toBe('eclair');
		expect(foldText('ÀÇÑÜ')).toBe('acnu');
		expect(foldText('Straße')).toBe('strasse');
		expect(foldText('Œuvre Ø')).toBe('oeuvre o');
		expect(foldText('ﬁn')).toBe('fin');
		// precomposed and decomposed forms fold alike
		expect(foldText('é')).toBe(foldText('é'));
	});

	it('is idempotent', () => {
		const r = rng(1);
		for (let i = 0; i < 500; i++) {
			const s = randomText(r, 20);
			expect(foldText(foldText(s))).toBe(foldText(s));
			expect(textSortKey(textSortKey(s))).toBe(textSortKey(s));
		}
	});

	it('sorts "Zebra" after "apple" and "Éa" with "ea"', () => {
		const keys = ['Zebra', 'apple', 'Éa', 'ea', 'Apple'].map(textSortKey);
		expect([...keys].sort(compareText)).toEqual(['apple', 'apple', 'ea', 'ea', 'zebra']);
	});

	it('truncates long text without splitting a surrogate pair', () => {
		const long = 'a'.repeat(TEXT_KEY_MAX - 1) + '😀' + 'tail';
		const key = textSortKey(long);
		expect(key.length).toBeLessThanOrEqual(TEXT_KEY_MAX);
		expect(key.length).toBe(TEXT_KEY_MAX - 1);
		expect(textSortKey('a'.repeat(1000)).length).toBe(TEXT_KEY_MAX);
	});

	it('compareText is a total order matching code point order', () => {
		const r = rng(2);
		const xs = Array.from({ length: 300 }, () => randomText(r, 6));
		const sorted = [...xs].sort(compareText);
		for (let i = 1; i < sorted.length; i++) expect(compareText(sorted[i - 1], sorted[i])).toBeLessThanOrEqual(0);
		// code point order: astral characters sort after the BMP private-use block
		expect(compareText('￿', '😀')).toBe(-1);
		expect(compareText('😀', '')).toBe(1);
	});

	it("matches SQLite's BINARY collation on random folded keys", () => {
		const db = new DatabaseSync(':memory:');
		db.exec('CREATE TABLE t (v TEXT, page INTEGER, PRIMARY KEY (v, page)) WITHOUT ROWID');
		const ins = db.prepare('INSERT OR IGNORE INTO t VALUES (?, ?)');
		const r = rng(3);
		const keys = new Set<string>();
		for (let i = 0; i < 1500; i++) keys.add(textSortKey(randomText(r, 8)));
		[...keys].forEach((k, i) => ins.run(k, i));
		const fromSqlite = (db.prepare('SELECT v FROM t ORDER BY v').all() as { v: string }[]).map((x) => x.v);
		expect(fromSqlite).toEqual([...keys].sort(compareText));
		db.close();
	});
});

describe('number and mixed keys', () => {
	it('normalizes -0 and refuses non-finite numbers', () => {
		expect(Object.is(numberSortKey(-0), 0)).toBe(true);
		expect(() => numberSortKey(NaN)).toThrow(RangeError);
		expect(() => numberSortKey(Infinity)).toThrow(RangeError);
	});

	it("orders numbers as SQLite does, integers and reals together", () => {
		const db = new DatabaseSync(':memory:');
		db.exec('CREATE TABLE n (v, page INTEGER, PRIMARY KEY (v, page)) WITHOUT ROWID');
		const ins = db.prepare('INSERT OR IGNORE INTO n VALUES (?, ?)');
		const r = rng(4);
		const nums: number[] = [];
		for (let i = 0; i < 1000; i++) {
			const x = r.bool(0.4) ? r.int(-1000, 1000) : (r.next() - 0.5) * 10 ** r.int(-3, 12);
			nums.push(numberSortKey(x));
		}
		nums.forEach((x, i) => ins.run(x, i));
		const rows = (db.prepare('SELECT v FROM n ORDER BY v').all() as { v: number }[]).map((x) => x.v);
		expect(rows).toEqual([...nums].sort(compareSortKeys));
		db.close();
	});

	it('puts numbers before text and handles empty values', () => {
		expect(compareSortKeys(5, 'a')).toBe(-1);
		expect(compareSortKeys('a', 5)).toBe(1);
		const xs: (number | string | null)[] = [3, null, 1, null, 2];
		expect([...xs].sort((a, b) => compareOptionalKeys(a, b, 'asc'))).toEqual([1, 2, 3, null, null]);
		expect([...xs].sort((a, b) => compareOptionalKeys(a, b, 'desc'))).toEqual([3, 2, 1, null, null]);
		expect([...xs].sort((a, b) => compareOptionalKeys(a, b, 'asc', 'first'))).toEqual([null, null, 1, 2, 3]);
	});
});

describe('rank keys', () => {
	it('produces keys viborm accepts, and accepts keys viborm produces', () => {
		const r = rng(5);
		let list: string[] = [];
		for (let i = 0; i < 400; i++) {
			const at = r.int(0, list.length);
			const k = rankBetween(list[at - 1] ?? null, list[at] ?? null, r.bool() ? r.next.bind(r) : undefined);
			expect(isKeyFormat(k)).toBe(true);
			expect(isRank(k)).toBe(true);
			list.splice(at, 0, k);
			if (needsRebalance(list)) list = evenRanks(list.length);
		}
		// viborm's own keys are valid inputs, and what we generate between them sorts between them
		let lo: string | null = null;
		let hi: string | null = null;
		const theirs: string[] = [];
		for (let i = 0; i < 200; i++) {
			const at = r.int(0, theirs.length);
			const k = keyBetween(theirs[at - 1] ?? null, theirs[at] ?? null);
			theirs.splice(at, 0, k);
		}
		for (let i = 1; i < theirs.length; i++) {
			lo = theirs[i - 1];
			hi = theirs[i];
			expect(isRank(lo)).toBe(true);
			const mid = rankBetween(lo, hi);
			expect(lo < mid && mid < hi).toBe(true);
			expect(isKeyFormat(mid)).toBe(true);
		}
	});

	it('inserting at random positions keeps the list sorted and distinct', () => {
		for (const seed of [10, 11, 12]) {
			const r = rng(seed);
			const list: string[] = [];
			for (let i = 0; i < 1000; i++) {
				const at = r.bool(0.3) ? list.length : r.bool(0.2) ? 0 : r.int(0, list.length);
				const k = rankBetween(list[at - 1] ?? null, list[at] ?? null);
				if (list[at - 1] !== undefined) expect(k > list[at - 1]).toBe(true);
				if (list[at] !== undefined) expect(k < list[at]).toBe(true);
				list.splice(at, 0, k);
				expect(k.length).toBeLessThanOrEqual(MAX_RANK_LENGTH);
			}
			expect([...list].sort(compareRank)).toEqual(list);
			expect(new Set(list).size).toBe(list.length);
		}
	});

	it('appends and prepends', () => {
		let tail: string | null = null;
		const appended: string[] = [];
		for (let i = 0; i < 30; i++) appended.push((tail = rankAfter(tail)));
		expect([...appended].sort(compareRank)).toEqual(appended);
		let head: string | null = null;
		const prepended: string[] = [];
		for (let i = 0; i < 30; i++) prepended.unshift((head = rankBefore(head)));
		expect([...prepended].sort(compareRank)).toEqual(prepended);
		expect(isRank(prepended[0])).toBe(true);
		expect(rankBetween(null, null)).toBe('10');
	});

	it('crosses the negative and positive integer boundary', () => {
		const neg = rankBefore('10');
		expect(neg).toBe('089');
		expect(neg < '10').toBe(true);
		expect(rankBetween(neg, '10')).toBeTruthy();
		expect(rankBetween(neg, '10') > neg).toBe(true);
	});

	it('ranksBetween returns n ascending distinct keys inside the bounds', () => {
		const r = rng(6);
		for (let i = 0; i < 50; i++) {
			const lo = rankBetween(null, null);
			const hi = rankAfter(lo);
			const n = r.int(0, 40);
			const keys = ranksBetween(lo, hi, n);
			expect(keys).toHaveLength(n);
			for (const k of keys) expect(lo < k && k < hi).toBe(true);
			expect([...keys].sort(compareRank)).toEqual(keys);
			expect(new Set(keys).size).toBe(n);
		}
		expect(ranksBetween(null, null, 5)).toHaveLength(5);
	});

	it('rejects bad bounds', () => {
		expect(() => rankBetween('11', '10')).toThrow(RangeError);
		expect(() => rankBetween('10', '10')).toThrow(RankCollisionError);
		expect(() => rankBetween('x1', null)).toThrow(RangeError);
		expect(isRank('0')).toBe(false);
		expect(isRank('100')).toBe(false); // trailing zero in the fraction
		expect(isRank('1')).toBe(false);
		expect(isRank('10')).toBe(true);
		expect(isRank('105')).toBe(true);
	});

	it('degrades past the length limit and rebalances', () => {
		// Always insert right after the first key: the fraction grows until the limit.
		let lo = '10';
		const hi = '11';
		let guard = 0;
		const grown: string[] = [];
		try {
			for (; guard < 400; guard++) {
				lo = rankBetween(lo, hi);
				grown.push(lo);
			}
		} catch (e) {
			expect((e as Error).name).toBe('RankOverflowError');
		}
		expect(guard).toBeGreaterThan(30); // worst case: one digit per insert at a single spot
		expect(needsRebalance(grown)).toBe(true);
		expect(needsRebalance(evenRanks(grown.length))).toBe(false);
	});

	it('rebalance keeps order, ties broken by id', () => {
		const items: RankedItem[] = [
			{ id: 'c', rank: '10' },
			{ id: 'a', rank: '10' },
			{ id: 'b', rank: '105' }
		];
		const out = rebalance(items);
		expect(out.map((x) => x.id)).toEqual(['a', 'c', 'b']);
		expect(out.map((x) => x.rank)).toEqual(evenRanks(3));
		expect(needsRebalance(['10', '10'])).toBe(true);
	});

	it('placeAt puts an item at an index, rebalancing when neighbours collide', () => {
		const r = rng(7);
		let items: RankedItem[] = [];
		for (let i = 0; i < 300; i++) {
			const id = `p${i}`;
			const index = r.int(0, items.length);
			const { rank, rebalanced } = placeAt(items, id, index);
			if (rebalanced) {
				const m = new Map(rebalanced.map((x) => [x.id, x.rank]));
				items = items.map((x) => ({ id: x.id, rank: m.get(x.id) ?? x.rank }));
			}
			items.push({ id, rank });
			items.sort(compareRanked);
			expect(items[index].id).toBe(id);
		}
		expect(new Set(items.map((x) => x.rank)).size).toBe(items.length);
		// equal neighbours force a rebalance
		const tied = [
			{ id: 'a', rank: '10' },
			{ id: 'b', rank: '10' }
		];
		const placed = placeAt(tied, 'z', 1);
		expect(placed.rebalanced).not.toBeNull();
		expect(placed.rank).toBe('11');
		// moving an item ignores its own current position
		const moved = placeAt([{ id: 'a', rank: '10' }, { id: 'b', rank: '11' }, { id: 'c', rank: '12' }], 'a', 2);
		expect(moved.rank > '12').toBe(true);
	});
});
