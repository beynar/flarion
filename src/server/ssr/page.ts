/**
 * The data of a page route (`(app)/[ws]/[page]/+page.server.ts`): the page's header and properties, its backlinks, the sidebar
 * rows of the pages above it, and, by kind,
 *
 * - **a document**: the body as JSON from the Page Durable Object, which the editor renders on the server from edytor's own
 *   `snapshot` support (the same plugins, the same DOM the live editor then replaces in one update), the page's lock, and a room
 *   token so the browser dials its room without a round trip first;
 * - **a database**: the collection and its views, and the first window of the active view, read under the exact subscription
 *   `ViewHost` will hold (`hostSubscription`), so the store's window and the host's `subscribe` are one.
 *
 * Everything is read as the actor. A page the actor cannot read has no row: `page` is null and the component shows what it shows
 * for a page that does not exist.
 */
import { env } from 'cloudflare:workers';
import { hostSubscription } from '../../lib/components/views/view-model';
import type { PropertyDef } from '../../lib/shared/property-types';
import type { PageRow } from '../../lib/shared/protocol';
import type { StoreSeed } from '../../lib/shared/seed';
import { subKey } from '../../lib/shared/sub-key';
import { roomAccessForLevel } from '../rooms/access';
import { issueRoomToken } from '../rooms/issue-token';
import { openPageRoom } from '../rooms/page-room';
import type { PageLockState } from '../objects/page/page-do';
import type { JSONDoc } from 'edytor/crdt/edytor';
import type { Shell } from './shell';

export interface PageData {
	/** What the store is seeded with. */
	seed: StoreSeed;
	/** The page's row, null when the actor cannot read the page (or it does not exist). */
	row: PageRow | null;
	/** A document's body and its lock; null for a database, an unreadable page, and a client-side navigation. */
	body: { doc: JSONDoc; lock: PageLockState; room: { token: string; expiresAt: number; access: 'read' | 'comment' | 'write' } | null } | null;
}

export async function pageData(shell: Shell, pageId: string, options: { viewId: string | null }): Promise<PageData> {
	const { actor, stub } = shell;
	const pageSub = { id: subKey('pg', pageId), sub: { kind: 'page' as const, pageIds: [pageId] } };
	const first = await stub.ssrRead(actor, {
		subs: [pageSub, { id: subKey('bl', pageId), sub: { kind: 'backlinks' as const, pageId } }],
		collection: pageId,
		properties: true
	});
	const row = (first.windows.find((w) => w.id === pageSub.id)?.snapshot.rows[0] as PageRow | undefined) ?? null;
	const windows = [...first.windows];
	const seed: StoreSeed = { windows, ...(first.collection ? { collection: first.collection } : {}), ...(first.properties ? { properties: first.properties } : {}) };
	if (!row) return { seed, row: null, body: null };

	if (row.isDatabase) {
		const properties: readonly PropertyDef[] = first.properties ?? [];
		const view = first.collection?.views.find((v) => v.id === options.viewId) ?? first.collection?.views[0];
		const sub = hostSubscription({ collectionId: pageId, collection: first.collection?.collection, view, properties, localFilter: null });
		if (sub) {
			const read = await stub.ssrRead(actor, { subs: [{ id: subKey('vw', pageId + JSON.stringify(sub)), sub }] });
			windows.push(...read.windows);
		}
		return { seed: { ...seed, windows }, row, body: null };
	}

	const { room } = await openPageRoom(env, actor.workspaceId, pageId);
	const [read, token] = await Promise.all([
		room.readForRender(actor.userId),
		issueRoomToken(env, actor, pageId, roomAccessForLevel(row.access)).catch(() => null)
	]);
	return { seed, row, body: { doc: read.doc, lock: read.lock, room: token } };
}
