import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * A published page. Server code never calls a Durable Object (dev deadlock): it asks the Worker route
 * `/share-data/:token` (src/server/share/route.ts), which resolves the share and reads the page. P4 adds the
 * rendered, read-only body (edytor/export, cached in KV) to that response.
 */
export const load: PageServerLoad = async ({ params, setHeaders, request, getClientAddress }) => {
	// Every response of a published page is noindex, found or not.
	setHeaders({ 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' });
	let client = 'unknown';
	try {
		client = getClientAddress();
	} catch {
		// no client address behind some proxies
	}
	const origin = new URL(request.url).origin;
	const response = await globalThis.fetch(`${origin}/share-data/${encodeURIComponent(params.token)}`, {
		headers: { 'x-share-client': client }
	});
	if (response.status === 429) error(429, 'Too many requests. Try again in a minute.');
	if (!response.ok) error(404, 'This page is not published, or the link was turned off.');
	const data = (await response.json()) as { title: string; icon: string | null };
	return { title: data.title || 'Untitled', icon: data.icon };
};
