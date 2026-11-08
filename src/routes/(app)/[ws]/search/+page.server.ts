import { filtersFromParams, toQueryInput } from '../../../../lib/client/search';
import { shellOf } from '../../../../server/ssr/shell';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 20;

/** The results of the search the URL names (`?q=` and its filters, the page's own state), read as the actor; nothing without a query. */
export const load: PageServerLoad = async (event) => {
	if (event.isDataRequest) return { results: null };
	const filters = filtersFromParams(event.url.searchParams);
	if (!filters.q.trim()) return { results: null };
	const { actor, stub } = await shellOf(event);
	const found = await stub.searchQuery(actor, { ...toQueryInput(filters), limit: PAGE_SIZE });
	return { results: { hits: found.hits, nextCursor: found.nextCursor } };
};
