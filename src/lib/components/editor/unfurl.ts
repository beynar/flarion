/**
 * The bookmark unfurl: `files.unfurl`, answered by the Worker (it fetches the page behind an SSRF guard, parses it
 * with HTMLRewriter and caches the result in KV: src/server/files/unfurl.ts). A refused or failed unfurl is
 * `null`, and the bookmark card shows the bare URL, which is the plugin's documented fallback.
 */
import type { BookmarkPreview } from 'edytor';
import type { Rpc } from '#lib/client/rpc.ts';

export type Unfurl = (url: string) => Promise<BookmarkPreview | null>;

/** The oRPC call `files.unfurl` (the client adds the CSRF header, the app version and the workspace). */
export const rpcUnfurl =
	(rpc: Pick<Rpc['files'], 'unfurl'> | { files: Pick<Rpc['files'], 'unfurl'> }): Unfurl =>
	async (url) => {
		try {
			const files = 'files' in rpc ? rpc.files : rpc;
			return (await files.unfurl({ url })) ?? null;
		} catch {
			return null;
		}
	};
