/** `search` of the public API: the app's search (FTS5 plus Vectorize for questions), every hit already permission-checked. */
import { authenticated, pub } from './base';
import { loadDatabase } from './databases';
import { DEFAULT_PAGE_SIZE, listOf, loadPages, offsetOf } from './shared';

export const searchHandler = pub.search.use(authenticated).handler(async ({ input, context }) => {
	const auth = context.auth;
	const query = input.query?.trim() ?? '';
	// An empty query matches nothing (the search index has nothing to rank); the response is a well-formed empty list.
	if (!query) return listOf([], null);
	const offset = offsetOf(input.start_cursor);
	const size = input.page_size ?? DEFAULT_PAGE_SIZE;
	const result = await auth.workspace.searchQuery(auth.actor, {
		q: query,
		limit: Math.min(100, size),
		...(offset > 0 ? { cursor: String(offset) } : {}),
		sort: input.sort ? (input.sort.direction === 'ascending' ? 'edited_asc' : 'edited_desc') : 'relevance'
	});
	const pages = await loadPages(context, auth, result.hits.map((hit) => hit.id));
	const { databases } = await auth.workspace.apiPages(auth.actor, pages.map((p) => p.id));
	const isDatabase = new Set(databases);
	const wanted = input.filter?.value;
	const results = [];
	for (const page of pages) {
		const database = isDatabase.has(page.id);
		if (wanted === 'page' && database) continue;
		if (wanted === 'database' && !database) continue;
		const asDatabase = database ? await loadDatabase(context, auth, page.id) : null;
		results.push(asDatabase ?? page);
	}
	return listOf(results, result.nextCursor === null ? null : Number(result.nextCursor));
});
