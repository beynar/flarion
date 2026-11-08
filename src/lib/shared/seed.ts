/**
 * What the server render hands the browser store (`WorkspaceStore.seed`): the snapshots a socket would have sent for the first
 * screen (with the subscriptions they answer, so the store's windows and the components' later `subscribe` calls line up), the
 * definitions around them, and the remembered preferences the server could read from cookies. The server reads it in `+layout.server.ts`
 * and `+page.server.ts` (`src/server/ssr/`); the layout and the page seed the store with it before anything renders, on the server
 * and again in the browser, where the socket then resumes at the snapshots' `seq` instead of asking for everything.
 */
import type { CollectionDef, ViewDef } from './definitions';
import type { PropertyDef } from './property-types';
import type { SnapshotMessage, Subscription } from './protocol';
import type { Member, Teamspace } from './schemas';

export interface SeedWindow {
	id: string;
	sub: Subscription;
	snapshot: SnapshotMessage;
}

export interface StoreSeed {
	windows?: SeedWindow[];
	/** Tree parents beyond the root level whose children the `tree` window holds. */
	expanded?: string[];
	properties?: PropertyDef[];
	members?: Member[];
	teamspaces?: { list: Teamspace[]; ranks: Record<string, string> };
	collection?: { collection: CollectionDef; views: ViewDef[] } | null;
	/** Favorites and recently opened pages, kept in the browser (localStorage) and mirrored to a cookie. */
	prefs?: { favorites: string[]; recent: { id: string; at: number }[] };
	/** Folded sidebar sections (`private`, `shared`, `teamspaces`, `ts:<id>`). */
	folded?: string[];
}
