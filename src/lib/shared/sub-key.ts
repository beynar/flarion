/**
 * Subscription ids: the key a `tree`, `page`, `view` or `backlinks` subscription goes by on the workspace socket, and in
 * the store's windows. Shared by the browser store and the server render, which seeds the store's windows under the same
 * keys (`server/ssr/`), so a subscription made after hydration finds its window already there.
 */

/** A subscription id within the protocol's 40 characters. */
export function subKey(prefix: string, id: string): string {
	const k = `${prefix}:${id}`;
	if (k.length <= 40) return k;
	let h1 = 5381;
	let h2 = 52711;
	for (let i = 0; i < id.length; i++) {
		h1 = (h1 * 33) ^ id.charCodeAt(i);
		h2 = (h2 * 31) ^ id.charCodeAt(i);
	}
	return `${prefix}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${id.length}`;
}

/** The tree window's id (one per store). */
export const TREE_ID = 'tree';
/** The window of the home page's recent and favorite pages. */
export const PAGE_SET_ID = 'pg:set';
