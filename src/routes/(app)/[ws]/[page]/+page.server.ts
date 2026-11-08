import { shellOf } from '../../../../server/ssr/shell';
import { pageData, type PageData } from '../../../../server/ssr/page';
import type { PageServerLoad } from './$types';

const NOTHING: PageData = { seed: {}, row: null, body: null };

export const load: PageServerLoad = async (event) => {
	// A client-side navigation (`__data.json`) is served by the live store and its socket, as before the server render existed:
	// answering it with a Durable Object read would only make the click wait for data the store fetches anyway.
	if (event.isDataRequest) return NOTHING;
	const shell = await shellOf(event);
	// The active view is `?v=`: a view switch is a client-side replace that needs no server read (the host subscribes), so it is not tracked.
	const viewId = event.untrack(() => event.url.searchParams.get('v'));
	return pageData(shell, event.params.page, { viewId });
};
