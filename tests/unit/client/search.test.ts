import { describe, expect, it, vi } from 'vitest';
import {
	EMPTY_FILTERS,
	QuickFinder,
	filtersFromParams,
	filtersToParams,
	quickFind,
	relativeTime,
	snippetParts,
	snippetText,
	toQueryInput,
	type QuickRow,
	type SearchApi
} from '#lib/client/search.ts';

const api = (quick: unknown, query?: unknown): SearchApi =>
	({
		quick: vi.fn(async () => quick),
		query: vi.fn(async () => {
			if (query === 'fail') throw new Error('down');
			return query ?? { hits: [], nextCursor: null };
		})
	}) as unknown as SearchApi;

describe('quickFind', () => {
	it('keeps the order of search.quick and decorates rows with the snippet and path of search.query', async () => {
		const search = api(
			{
				items: [
					{ id: 'a', title: 'Alpha', icon: null, source: 'title' },
					{ id: 'b', title: 'Beta', icon: '🎯', source: 'recent' },
					{ id: 'c', title: 'Gamma', icon: null, source: 'text' }
				]
			},
			{ hits: [{ id: 'c', title: 'Gamma', icon: null, snippet: 'the <mark>alp</mark>ine', field: 'body', updatedAt: '2026-01-01T00:00:00Z', path: ['Root', 'Docs'] }], nextCursor: null }
		);
		const rows = await quickFind(search, 'alp', (id) => (id === 'a' ? ['Root'] : undefined));
		expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
		expect(rows[0]).toMatchObject({ path: ['Root'], snippet: undefined });
		expect(rows[1]).toMatchObject({ path: [], snippet: undefined });
		expect(rows[2]).toMatchObject({ path: ['Root', 'Docs'], snippet: 'the <mark>alp</mark>ine' });
	});

	it('does not run the full-text call for an empty query, and survives its failure', async () => {
		const empty = api({ items: [{ id: 'a', title: 'A', icon: null, source: 'recent' }] });
		await quickFind(empty, '  ');
		expect(empty.query).not.toHaveBeenCalled();
		const broken = api({ items: [{ id: 'a', title: 'A', icon: null, source: 'title' }] }, 'fail');
		await expect(quickFind(broken, 'a')).resolves.toHaveLength(1);
	});
});

describe('QuickFinder', () => {
	const row = (id: string): QuickRow => ({ id, title: id, icon: null, source: 'title', path: [] });

	it('debounces: only the last of a burst runs', async () => {
		vi.useFakeTimers();
		const run = vi.fn(async (q: string) => [row(q)]);
		const seen: string[] = [];
		const finder = new QuickFinder({ run, onResult: (q) => seen.push(q), delay: 100 });
		finder.search('a');
		finder.search('ab');
		finder.search('abc');
		await vi.advanceTimersByTimeAsync(99);
		expect(run).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2);
		expect(run).toHaveBeenCalledTimes(1);
		expect(seen).toEqual(['abc']);
		vi.useRealTimers();
	});

	it('drops the answer of a superseded query and reports loading', async () => {
		vi.useFakeTimers();
		const resolvers = new Map<string, (rows: QuickRow[]) => void>();
		const run = (q: string) => new Promise<QuickRow[]>((resolve) => resolvers.set(q, resolve));
		const seen: string[] = [];
		const states: boolean[] = [];
		const finder = new QuickFinder({ run, onResult: (q) => seen.push(q), onState: (s) => states.push(s), delay: 10 });
		finder.search('slow');
		await vi.advanceTimersByTimeAsync(11);
		finder.search('fast');
		await vi.advanceTimersByTimeAsync(11);
		resolvers.get('fast')!([row('fast')]);
		await vi.advanceTimersByTimeAsync(0);
		resolvers.get('slow')!([row('slow')]);
		await vi.advanceTimersByTimeAsync(0);
		expect(seen).toEqual(['fast']);
		expect(states.at(-1)).toBe(false);
		vi.useRealTimers();
	});

	it('runs at once when asked, and cancel silences a pending search', async () => {
		vi.useFakeTimers();
		const run = vi.fn(async () => []);
		const finder = new QuickFinder({ run, onResult: () => {}, delay: 500 });
		finder.search('', true);
		expect(run).toHaveBeenCalledTimes(1);
		finder.search('later');
		finder.cancel();
		await vi.advanceTimersByTimeAsync(600);
		expect(run).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});

describe('snippetParts', () => {
	it('splits on mark pairs and unescapes the text', () => {
		expect(snippetParts('a &lt;b&gt; <mark>hit</mark> &amp; <MARK>more</MARK>!')).toEqual([
			{ text: 'a <b> ', mark: false },
			{ text: 'hit', mark: true },
			{ text: ' & ', mark: false },
			{ text: 'more', mark: true },
			{ text: '!', mark: false }
		]);
	});

	it('never treats another tag as markup', () => {
		const html = '&lt;img src=x onerror=alert(1)&gt; <mark>x</mark>';
		expect(snippetText(html)).toBe('<img src=x onerror=alert(1)> x');
		expect(snippetParts(html).every((part) => !part.text.includes('<mark'))).toBe(true);
	});
});

describe('relativeTime', () => {
	const now = Date.parse('2026-11-08T12:00:00Z');
	it.each([
		['2026-11-08T11:59:50Z', 'just now'],
		['2026-11-08T11:55:00Z', '5 minutes ago'],
		['2026-11-08T11:00:00Z', '1 hour ago'],
		['2026-11-05T12:00:00Z', '3 days ago'],
		['2026-08-08T12:00:00Z', '3 months ago'],
		['2024-11-08T12:00:00Z', '2 years ago']
	])('%s is %s', (iso, text) => expect(relativeTime(iso, now)).toBe(text));
});

describe('search filters', () => {
	const now = Date.parse('2026-11-08T12:00:00Z');

	it('maps filters to the search.query input', () => {
		expect(toQueryInput({ ...EMPTY_FILTERS, q: ' roadmap ' }, now)).toEqual({ q: 'roadmap' });
		expect(toQueryInput({ ...EMPTY_FILTERS, q: 'x', createdBy: 'u1', under: 'p1', sort: 'edited_desc', edited: 'week' }, now)).toEqual({
			q: 'x',
			createdBy: 'u1',
			under: 'p1',
			sort: 'edited_desc',
			editedAfter: '2026-11-01T12:00:00.000Z'
		});
		// the last day of a custom range counts whole
		expect(toQueryInput({ ...EMPTY_FILTERS, q: 'x', edited: 'custom', from: '2026-11-01', to: '2026-11-03' }, now)).toEqual({
			q: 'x',
			editedAfter: '2026-11-01T00:00:00.000Z',
			editedBefore: '2026-11-04T00:00:00.000Z'
		});
	});

	it('round-trips through URL params and ignores junk', () => {
		const filters = { ...EMPTY_FILTERS, q: 'a b', createdBy: 'u1', edited: 'custom' as const, from: '2026-01-01', to: null, under: 'p9', sort: 'edited_asc' as const };
		expect(filtersFromParams(filtersToParams(filters))).toEqual(filters);
		expect(filtersToParams(EMPTY_FILTERS).toString()).toBe('');
		expect(filtersFromParams(new URLSearchParams('edited=bogus&sort=nope&from=yesterday'))).toEqual(EMPTY_FILTERS);
	});
});
