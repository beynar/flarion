/**
 * Client side of search (docs/PLAN.md "Search"): the quick-find merge (`search.quick` for the order, `search.query` for
 * snippets and breadcrumb paths), the debounced finder behind `⌘K`, and the helpers the result rows share (snippet
 * highlighting without `{@html}`, relative times, the search page's filter state and its URL form).
 */
import type { Rpc } from './rpc.ts';

export type SearchApi = Pick<Rpc['search'], 'query' | 'quick'>;

export interface QuickRow {
	id: string;
	title: string;
	icon: string | null;
	source: 'title' | 'recent' | 'text';
	/** Ancestor titles, root first (empty for a root page, or when it is not known). */
	path: string[];
	/** FTS5 snippet: HTML-escaped text with `<mark>` around the matches. */
	snippet?: string;
}

/** What the store can say about the position of a page without the server. */
export type PathResolver = (id: string) => string[] | undefined;

/**
 * Quick find: `search.quick` decides the rows and their order (title prefixes, recent visits, full-text hits); a parallel
 * `search.query` supplies the snippet and the path the quick answer does not carry. A failing second call only costs
 * the decoration.
 */
export async function quickFind(api: SearchApi, q: string, resolvePath?: PathResolver, limit = 12): Promise<QuickRow[]> {
	const text = q.trim();
	const quick = await api.quick({ q: text, limit });
	const decorations = new Map<string, { snippet: string; path: string[] }>();
	if (text) {
		try {
			const full = await api.query({ q: text, limit: Math.max(limit, 10) });
			for (const hit of full.hits) decorations.set(hit.id, { snippet: hit.snippet, path: hit.path });
		} catch {
			// quick-find rows without snippets are still correct
		}
	}
	return quick.items.map((item) => {
		const extra = decorations.get(item.id);
		return {
			...item,
			path: extra?.path ?? resolvePath?.(item.id) ?? [],
			snippet: item.source === 'text' || extra?.snippet ? extra?.snippet : undefined
		};
	});
}

/** Debounces calls and drops the answers of superseded ones: only the latest query ever reports. */
export class QuickFinder {
	#timer: ReturnType<typeof setTimeout> | undefined;
	#serial = 0;
	readonly #run: (q: string) => Promise<QuickRow[]>;
	readonly #delay: number;
	readonly #onResult: (q: string, rows: QuickRow[]) => void;
	readonly #onState: (loading: boolean) => void;
	readonly #onError: (error: unknown) => void;

	constructor(options: {
		run: (q: string) => Promise<QuickRow[]>;
		onResult: (q: string, rows: QuickRow[]) => void;
		onState?: (loading: boolean) => void;
		onError?: (error: unknown) => void;
		delay?: number;
	}) {
		this.#run = options.run;
		this.#onResult = options.onResult;
		this.#onState = options.onState ?? (() => {});
		this.#onError = options.onError ?? (() => {});
		this.#delay = options.delay ?? 150;
	}

	/** Schedules a search; `now` skips the wait (the first, empty query when the palette opens). */
	search(q: string, now = false): void {
		clearTimeout(this.#timer);
		const serial = ++this.#serial;
		this.#onState(true);
		const go = async () => {
			try {
				const rows = await this.#run(q);
				if (serial === this.#serial) this.#onResult(q, rows);
			} catch (error) {
				if (serial === this.#serial) this.#onError(error);
			} finally {
				if (serial === this.#serial) this.#onState(false);
			}
		};
		if (now) void go();
		else this.#timer = setTimeout(() => void go(), this.#delay);
	}

	cancel(): void {
		clearTimeout(this.#timer);
		this.#serial++;
		this.#onState(false);
	}
}

// ───────────────────────────── snippets ─────────────────────────────

export interface SnippetPart {
	text: string;
	mark: boolean;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&apos;': "'" };
export const unescapeHtml = (text: string) => text.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, (entity) => ENTITIES[entity] ?? entity);

/**
 * Splits FTS5's snippet (escaped text with `<mark>` pairs) into plain parts, so a template renders it with elements
 * of its own instead of `{@html}`. Any other tag is text, never markup.
 */
export function snippetParts(html: string): SnippetPart[] {
	const parts: SnippetPart[] = [];
	for (const [index, chunk] of html.split(/<\/?mark>/i).entries()) {
		if (chunk) parts.push({ text: unescapeHtml(chunk), mark: index % 2 === 1 });
	}
	return parts;
}

/** The snippet as plain text (for tests and aria labels). */
export const snippetText = (html: string) => snippetParts(html).map((part) => part.text).join('');

// ───────────────────────────── times ─────────────────────────────

const UNITS: [number, string][] = [
	[60, 'second'],
	[3600, 'minute'],
	[86_400, 'hour'],
	[2_592_000, 'day'],
	[31_536_000, 'month']
];

/** "just now", "5 minutes ago", "3 days ago"… in English, for the search rows. */
export function relativeTime(iso: string, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
	if (seconds < 45) return 'just now';
	let divisor = 1;
	for (const [limit, unit] of UNITS) {
		if (seconds < limit) {
			const count = Math.max(1, Math.round(seconds / divisor));
			return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
		}
		divisor = limit;
	}
	const years = Math.max(1, Math.round(seconds / 31_536_000));
	return `${years} year${years === 1 ? '' : 's'} ago`;
}

// ───────────────────────────── search page state ─────────────────────────────

export type SearchSort = 'relevance' | 'edited_desc' | 'edited_asc';
export type EditedPreset = 'any' | 'day' | 'week' | 'month' | 'year' | 'custom';

export interface SearchFilters {
	q: string;
	createdBy: string | null;
	edited: EditedPreset;
	/** `YYYY-MM-DD` bounds when `edited` is `custom`. */
	from: string | null;
	to: string | null;
	under: string | null;
	sort: SearchSort;
}

export const EMPTY_FILTERS: SearchFilters = { q: '', createdBy: null, edited: 'any', from: null, to: null, under: null, sort: 'relevance' };

const DAYS: Record<Exclude<EditedPreset, 'any' | 'custom'>, number> = { day: 1, week: 7, month: 30, year: 365 };
const DAY_MS = 86_400_000;

/** The `search.query` input a filter state stands for (no cursor, no limit). */
export function toQueryInput(filters: SearchFilters, now = Date.now()) {
	const input: {
		q: string;
		createdBy?: string;
		editedAfter?: string;
		editedBefore?: string;
		under?: string;
		sort?: SearchSort;
	} = { q: filters.q.trim() };
	if (filters.createdBy) input.createdBy = filters.createdBy;
	if (filters.edited === 'custom') {
		if (filters.from) input.editedAfter = new Date(`${filters.from}T00:00:00.000Z`).toISOString();
		// the whole last day counts
		if (filters.to) input.editedBefore = new Date(new Date(`${filters.to}T00:00:00.000Z`).getTime() + DAY_MS).toISOString();
	} else if (filters.edited !== 'any') {
		input.editedAfter = new Date(now - DAYS[filters.edited] * DAY_MS).toISOString();
	}
	if (filters.under) input.under = filters.under;
	if (filters.sort !== 'relevance') input.sort = filters.sort;
	return input;
}

/** The filter state as URL search params (defaults omitted), so a search can be shared and survives a reload. */
export function filtersToParams(filters: SearchFilters): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.q.trim()) params.set('q', filters.q);
	if (filters.createdBy) params.set('by', filters.createdBy);
	if (filters.edited !== 'any') params.set('edited', filters.edited);
	if (filters.edited === 'custom') {
		if (filters.from) params.set('from', filters.from);
		if (filters.to) params.set('to', filters.to);
	}
	if (filters.under) params.set('in', filters.under);
	if (filters.sort !== 'relevance') params.set('sort', filters.sort);
	return params;
}

const PRESETS: EditedPreset[] = ['any', 'day', 'week', 'month', 'year', 'custom'];
const SORTS: SearchSort[] = ['relevance', 'edited_desc', 'edited_asc'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function filtersFromParams(params: Pick<URLSearchParams, 'get'>): SearchFilters {
	const edited = params.get('edited') as EditedPreset | null;
	const sort = params.get('sort') as SearchSort | null;
	const from = params.get('from');
	const to = params.get('to');
	return {
		q: params.get('q') ?? '',
		createdBy: params.get('by') || null,
		edited: edited && PRESETS.includes(edited) ? edited : 'any',
		from: from && ISO_DAY.test(from) ? from : null,
		to: to && ISO_DAY.test(to) ? to : null,
		under: params.get('in') || null,
		sort: sort && SORTS.includes(sort) ? sort : 'relevance'
	};
}
