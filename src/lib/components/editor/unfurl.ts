/**
 * The bookmark unfurl seam. P2's Worker fetches the page, parses it with HTMLRewriter and caches the
 * answer in KV (docs/PLAN.md "Files and media"). The client calls it through `/rpc`; until the
 * procedure exists the call is refused and the bookmark card shows the bare URL, which is the
 * plugin's documented fallback.
 */
import type { BookmarkPreview } from 'edytor';

export type Unfurl = (url: string) => Promise<BookmarkPreview | null>;

/** `POST /rpc/files/unfurl`, oRPC's JSON envelope. Anything but a 200 with a title-bearing body is `null`. */
export const rpcUnfurl =
	(workspaceId: string, fetcher: typeof fetch = fetch): Unfurl =>
	async (url) => {
		try {
			const response = await fetcher('/rpc/files/unfurl', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
				body: JSON.stringify({ json: { url } })
			});
			if (!response.ok) return null;
			const body = (await response.json()) as { json?: BookmarkPreview | null };
			return body.json ?? null;
		} catch {
			return null;
		}
	};
