/**
 * Search queries over the FTS5 `search` table (see `index-writes.ts` for its layout), run inside the Workspace
 * DO. Backends of P4's quick find (`⌘K`) and search page (docs/PLAN.md "Search").
 *
 * ## Ranking (the SQL shape; docs/spikes/p0-fts5.md)
 * ```sql
 * WITH hits AS MATERIALIZED (
 *   SELECT rowid AS rid, page_num, field,
 *          bm25(search, 0.0, 0.0, 1.0) * CASE field WHEN 'title' THEN 5.0 WHEN 'property' THEN 2.0 ELSE 1.0 END AS rank
 *   FROM search WHERE search MATCH 'text : ("quoted" "words")'
 * ), best AS (SELECT page_num, MIN(rank) AS rank, rid, field FROM hits GROUP BY page_num)  -- best row per page
 * SELECT … FROM best JOIN page p ON p.num = best.page_num WHERE p.deleted_at IS NULL AND <filters>
 * ORDER BY best.rank, best.page_num LIMIT ? OFFSET ?
 * ```
 * `bm25()` is lower-is-better and negative, so a title hit (x5) beats a body hit of equal strength. The
 * `snippet()` of each page on the final page of results is taken by a second query on the winning `rowid`
 * (`snippet()` only works in the query that holds the MATCH).
 *
 * ## Permissions
 * The candidate query is run in batches of three times the number of rows still needed; rows whose page `num`
 * is not in the actor's visibility set are dropped in TypeScript BEFORE ranking is cut to a page, and batches
 * continue until enough visible rows are found or the matches run out. No count is ever returned, snippets
 * are taken only for visible pages, and the path of a result lists only ancestors the actor can see.
 *
 * ## Semantic results
 * For question-like queries with a vector index, Vectorize hits are filtered (workspace, visibility, trash,
 * filters) first, then merged with the full-text list by reciprocal rank fusion.
 */
import type * as v from 'valibot';
import type { quickFindInputSchema, quickFindResultSchema, searchInputSchema, searchResultSchema } from '../../lib/shared/schemas';
import type { WorkspaceDb } from '../db/workspace.client';
import { chunks, qmarks, rawAll, rawRun } from '../objects/workspace/util';
import { buildMatch, foldText, looksLikeQuestion, plainSnippet, queryTokens, reciprocalRankFusion, renderSnippet, SNIPPET_MARKS } from './match';

export type SearchInput = v.InferOutput<typeof searchInputSchema>;
export type SearchResult = v.InferOutput<typeof searchResultSchema>;
export type QuickFindInput = v.InferOutput<typeof quickFindInputSchema>;
export type QuickFindResult = v.InferOutput<typeof quickFindResultSchema>;
type Hit = SearchResult['hits'][number];

/** Vector similarity search over the workspace's chunks, best first. Never rejects for "no index": return []. */
export type VectorSearch = (query: string, topK: number) => Promise<{ pageId: string; score: number }[]>;

export interface SearchContext {
	db: WorkspaceDb;
	/** `num` of every live page the actor may read (`WorkspaceDO.visibleNums`). */
	visible: ReadonlySet<number>;
	vector?: VectorSearch | null;
}

export const TITLE_BOOST = 5;
export const PROPERTY_BOOST = 2;
const DEFAULT_LIMIT = 20;
const DEFAULT_QUICK = 10;
const OVERFETCH = 3;
const MAX_ROUNDS = 12;
const MAX_VISITS = 200;
const SNIPPET_TOKENS = 16;
const SNIPPET_ELLIPSIS = '…';

const RANK_SQL = `bm25(search, 0.0, 0.0, 1.0) * CASE field WHEN 'title' THEN ${TITLE_BOOST}.0 WHEN 'property' THEN ${PROPERTY_BOOST}.0 ELSE 1.0 END`;

interface Cand {
	id: string;
	num: number;
	title: string;
	icon: string | null;
	updatedAt: string;
	field: Hit['field'];
	/** `rowid` of the winning FTS row; null for a vector-only candidate. */
	rid: number | null;
}

type PageSql = { id: string; num: number; title: string; icon: string | null; updated_at: string | null; field?: Hit['field']; rid?: number };

const toCand = (r: PageSql): Cand => ({
	id: r.id,
	num: r.num,
	title: r.title,
	icon: r.icon,
	updatedAt: r.updated_at ?? new Date(0).toISOString(),
	field: r.field ?? 'body',
	rid: r.rid ?? null
});

/** SQL conditions for the search page's filters (creator, last edited, location in the tree). */
function pageFilter(input: Pick<SearchInput, 'createdBy' | 'editedAfter' | 'editedBefore' | 'under'>): { where: string; params: unknown[] } {
	const where: string[] = ['p.deleted_at IS NULL'];
	const params: unknown[] = [];
	if (input.createdBy) {
		where.push('p.created_by = ?');
		params.push(input.createdBy);
	}
	const iso = (s: string) => {
		const t = Date.parse(s);
		return Number.isNaN(t) ? null : new Date(t).toISOString();
	};
	const after = input.editedAfter ? iso(input.editedAfter) : null;
	const before = input.editedBefore ? iso(input.editedBefore) : null;
	if (after) {
		where.push('COALESCE(p.updated_at, p.created_at) >= ?');
		params.push(after);
	}
	if (before) {
		where.push('COALESCE(p.updated_at, p.created_at) <= ?');
		params.push(before);
	}
	if (input.under) {
		where.push(
			`p.id IN (WITH RECURSIVE sub(id) AS (SELECT id FROM page WHERE id = ? UNION ALL SELECT c.id FROM page c JOIN sub ON c.parent_id = sub.id) SELECT id FROM sub)`
		);
		params.push(input.under);
	}
	return { where: where.join(' AND '), params };
}

const PAGE_COLUMNS = 'p.id AS id, p.num AS num, p.title AS title, p.icon AS icon, COALESCE(p.updated_at, p.created_at) AS updated_at';

/**
 * Runs `fetchBatch(size, offset)` until `need` visible rows are collected. Each batch is three times the
 * rows still wanted (at least 30); hidden rows are dropped as they arrive.
 */
async function collectVisible<T extends { num: number }>(
	visible: ReadonlySet<number>,
	need: number,
	fetchBatch: (size: number, offset: number) => Promise<T[]>
): Promise<T[]> {
	const out: T[] = [];
	const size = Math.max(30, need * OVERFETCH);
	let offset = 0;
	for (let round = 0; round < MAX_ROUNDS; round++) {
		const rows = await fetchBatch(size, offset);
		for (const row of rows) if (visible.has(row.num)) out.push(row);
		offset += rows.length;
		if (out.length >= need || rows.length < size) break;
	}
	return out.slice(0, need);
}

/** Best FTS row per page, ranked, with the page's columns: the shape every full-text candidate query shares. */
function rankedPagesSql(order: 'relevance' | 'edited_desc' | 'edited_asc', where: string, extraHitWhere = ''): string {
	const orderBy =
		order === 'relevance'
			? 'best.rank, best.page_num'
			: order === 'edited_desc'
				? 'updated_at DESC, best.page_num'
				: 'updated_at ASC, best.page_num';
	return `WITH hits AS MATERIALIZED (
		SELECT rowid AS rid, page_num, field, ${RANK_SQL} AS rank FROM search WHERE search MATCH ?${extraHitWhere}
	), best AS (SELECT page_num, MIN(rank) AS rank, rid, field FROM hits GROUP BY page_num)
	SELECT ${PAGE_COLUMNS}, best.field AS field, best.rid AS rid, best.rank AS rank
	FROM best JOIN page p ON p.num = best.page_num
	WHERE ${where}
	ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
}

/** Pages by id, in the given order, that pass the filters (live, creator, edit dates, subtree). */
async function loadFilteredPages(ctx: SearchContext, input: SearchInput, ids: readonly string[]): Promise<Cand[]> {
	const filter = pageFilter(input);
	const found = new Map<string, Cand>();
	for (const part of chunks([...ids], 80)) {
		const rows = await rawAll<PageSql>(
			ctx.db,
			`SELECT ${PAGE_COLUMNS} FROM page p WHERE p.id IN (${qmarks(part.length)}) AND ${filter.where}`,
			...part,
			...filter.params
		);
		for (const r of rows) found.set(r.id, toCand(r));
	}
	return ids.flatMap((id) => (found.has(id) && ctx.visible.has(found.get(id)!.num) ? [found.get(id)!] : []));
}

/** Highlighted snippets of the winning FTS rows (taken only for pages already known to be visible). */
async function snippetsOf(db: WorkspaceDb, match: string, rids: readonly number[]): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	for (const part of chunks([...rids], 80)) {
		const rows = await rawAll<{ rid: number; snip: string }>(
			db,
			`SELECT rowid AS rid, snippet(search, 2, ?, ?, ?, ${SNIPPET_TOKENS}) AS snip FROM search WHERE search MATCH ? AND rowid IN (${qmarks(part.length)})`,
			SNIPPET_MARKS.open,
			SNIPPET_MARKS.close,
			SNIPPET_ELLIPSIS,
			match,
			...part
		);
		for (const r of rows) out.set(r.rid, renderSnippet(r.snip));
	}
	return out;
}

/** Ancestor titles of each page (root first), listing only ancestors the actor can see. */
async function pathsOf(ctx: SearchContext, ids: readonly string[]): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	for (const part of chunks([...ids], 80)) {
		const rows = await rawAll<{ start: string; num: number; title: string; depth: number }>(
			ctx.db,
			`WITH RECURSIVE anc(start, id, num, title, parent_id, depth) AS (
				SELECT id, id, num, title, parent_id, 0 FROM page WHERE id IN (${qmarks(part.length)})
				UNION ALL
				SELECT anc.start, p.id, p.num, p.title, p.parent_id, anc.depth + 1 FROM page p JOIN anc ON p.id = anc.parent_id
			) SELECT start, num, title, depth FROM anc WHERE depth > 0 ORDER BY start, depth DESC`,
			...part
		);
		for (const r of rows) {
			if (!ctx.visible.has(r.num)) continue;
			const list = out.get(r.start) ?? [];
			list.push(r.title);
			out.set(r.start, list);
		}
	}
	return out;
}

/** The start of a page's body text, for a vector-only hit that has no FTS snippet. */
async function excerptsOf(db: WorkspaceDb, nums: readonly number[]): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	for (const part of chunks([...nums], 80)) {
		const rows = await rawAll<{ page_num: number; head: string }>(
			db,
			`SELECT page_num, substr(text, 1, 400) AS head FROM page_text WHERE page_num IN (${qmarks(part.length)})`,
			...part
		);
		for (const r of rows) out.set(r.page_num, r.head);
	}
	return out;
}

const parseOffset = (cursor: string | undefined): number => {
	const n = cursor ? Number.parseInt(cursor, 10) : 0;
	return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The search page: ranked, filtered, permission-checked pages with snippets and paths. */
export async function searchPages(ctx: SearchContext, input: SearchInput): Promise<SearchResult> {
	const limit = input.limit ?? DEFAULT_LIMIT;
	const offset = parseOffset(input.cursor);
	const need = offset + limit + 1;
	const sort = input.sort ?? 'relevance';
	const question = looksLikeQuestion(input.q);
	const match = buildMatch(input.q, { dropStopwords: question });
	if (!match) return { hits: [], nextCursor: null };

	const filter = pageFilter(input);
	const sql = rankedPagesSql(sort, filter.where);
	const fts = (
		await collectVisible(ctx.visible, need, (size, from) =>
			rawAll<PageSql>(ctx.db, sql, match, ...filter.params, size, from)
		)
	).map(toCand);

	let ordered = fts;
	if (ctx.vector && sort === 'relevance' && question) {
		const vectorIds = await semanticIds(ctx, input.q, Math.min(100, need * OVERFETCH));
		if (vectorIds.length > 0) {
			const vectorCands = await loadFilteredPages(ctx, input, vectorIds);
			const byId = new Map<string, Cand>();
			for (const c of [...vectorCands, ...fts]) if (!byId.has(c.id) || c.rid !== null) byId.set(c.id, c);
			ordered = reciprocalRankFusion([fts.map((c) => c.id), vectorCands.map((c) => c.id)]).map((r) => byId.get(r.id)!);
		}
	}

	const page = ordered.slice(offset, offset + limit);
	const snippets = await snippetsOf(ctx.db, match, page.flatMap((c) => (c.rid !== null ? [c.rid] : [])));
	const orphans = page.filter((c) => c.rid === null);
	const excerpts = orphans.length ? await excerptsOf(ctx.db, orphans.map((c) => c.num)) : new Map<number, string>();
	const paths = await pathsOf(ctx, page.map((c) => c.id));
	return {
		hits: page.map((c) => ({
			id: c.id,
			title: c.title,
			icon: c.icon,
			snippet: c.rid !== null ? (snippets.get(c.rid) ?? plainSnippet(c.title)) : plainSnippet(excerpts.get(c.num) ?? c.title),
			field: c.field,
			updatedAt: c.updatedAt,
			path: paths.get(c.id) ?? []
		})),
		nextCursor: ordered.length > offset + limit ? String(offset + limit) : null
	};
}

/** Page ids of the best chunks, best first, one per page. Failures of the vector side degrade to nothing. */
async function semanticIds(ctx: SearchContext, query: string, topK: number): Promise<string[]> {
	try {
		const hits = await ctx.vector!(query, topK);
		return [...new Set(hits.map((h) => h.pageId))];
	} catch (error) {
		console.warn('[search] vector query failed, full-text only:', String(error));
		return [];
	}
}

// ───────────────────────────── quick find ─────────────────────────────

const likePrefix = (s: string) => `${s.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Quick find (`⌘K`): title prefix matches first, then recently visited pages (all of them for an empty query,
 * else those whose title holds every word), then full-text hits. A page appears once, at its first source.
 */
export async function quickFind(ctx: SearchContext, userId: string | null, input: QuickFindInput): Promise<QuickFindResult> {
	const limit = input.limit ?? DEFAULT_QUICK;
	const q = input.q.trim();
	const items: QuickFindResult['items'] = [];
	const seen = new Set<string>();
	const push = (c: Pick<Cand, 'id' | 'title' | 'icon'>, source: 'title' | 'recent' | 'text') => {
		if (items.length >= limit || seen.has(c.id)) return;
		seen.add(c.id);
		items.push({ id: c.id, title: c.title, icon: c.icon, source });
	};

	const titleMatch = buildMatch(q, { prefix: true });
	if (titleMatch) {
		const sql = `WITH hits AS MATERIALIZED (
				SELECT page_num, ${RANK_SQL} AS rank FROM search WHERE search MATCH ? AND field = 'title'
			)
			SELECT ${PAGE_COLUMNS} FROM hits h JOIN page p ON p.num = h.page_num WHERE p.deleted_at IS NULL
			ORDER BY (lower(p.title) LIKE ? ESCAPE '\\') DESC, h.rank, p.num LIMIT ? OFFSET ?`;
		const rows = await collectVisible(ctx.visible, limit, (size, from) =>
			rawAll<PageSql>(ctx.db, sql, titleMatch, likePrefix(q), size, from)
		);
		for (const r of rows) push(r, 'title');
	}

	if (userId && items.length < limit) {
		const words = queryTokens(q).map(foldText);
		const rows = await collectVisible(ctx.visible, MAX_VISITS, (size, from) =>
			rawAll<PageSql>(
				ctx.db,
				`SELECT ${PAGE_COLUMNS} FROM visit v JOIN page p ON p.num = v.page_num
				 WHERE v.user_id = ? AND p.deleted_at IS NULL ORDER BY v.visited_at DESC LIMIT ? OFFSET ?`,
				userId,
				size,
				from
			)
		);
		for (const r of rows) {
			const title = foldText(r.title);
			if (words.every((w) => title.includes(w))) push(r, 'recent');
		}
	}

	const textMatch = buildMatch(q, { prefix: true });
	if (textMatch && items.length < limit) {
		const filter = pageFilter({});
		const sql = rankedPagesSql('relevance', filter.where);
		// Titles and recents already listed take slots: ask for enough rows to still fill the list.
		const rows = await collectVisible(ctx.visible, limit + items.length, (size, from) =>
			rawAll<PageSql>(ctx.db, sql, textMatch, ...filter.params, size, from)
		);
		for (const r of rows) push(r, 'text');
	}
	return { items };
}

/** Records that a user opened a page (a page they can read): feeds "recent". Keeps their latest 200. */
export async function recordVisit(db: WorkspaceDb, userId: string, num: number, now: number = Date.now()): Promise<void> {
	await rawRun(db, 'INSERT OR REPLACE INTO visit (user_id, page_num, visited_at) VALUES (?, ?, ?)', userId, num, now);
	await rawRun(
		db,
		`DELETE FROM visit WHERE user_id = ? AND page_num NOT IN (
			SELECT page_num FROM visit WHERE user_id = ? ORDER BY visited_at DESC LIMIT ${MAX_VISITS}
		)`,
		userId,
		userId
	);
}
