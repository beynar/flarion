/**
 * The Workspace DO's read for the server render (`WorkspaceDO.ssrRead`): the first screen of a page in one call, as the
 * snapshots a socket would have been sent, so the browser store can start from them and resume the socket at `seq`
 * (`src/server/ssr/`, `WorkspaceStore.seed`).
 */
import type { PropertyDef } from '../../../lib/shared/property-types';
import type { Subscription } from '../../../lib/shared/protocol';
import type { SeedWindow } from '../../../lib/shared/seed';
import type { CollectionDef, ViewDef } from '../../../lib/shared/definitions';
import type { Teamspace } from '../../../lib/shared/schemas';

export interface SsrRequest {
	/**
	 * Subscriptions to answer with a snapshot, under the ids the store will use. `tree`, `page` and `backlinks` are read like a socket's
	 * snapshot; a `view` is read with `queryView` (and is left out when the caller cannot read it).
	 */
	subs?: { id: string; sub: Subscription }[];
	/** The page being opened: the pages above it that the caller can see are added to every `tree` subscription's parents (the sidebar opens down to it). */
	reveal?: string;
	/** The property registry. */
	properties?: boolean;
	/** The teamspaces and the caller's own sidebar rank in each of theirs. */
	teamspaces?: boolean;
	/** A collection and its views. */
	collection?: string;
}

export interface SsrRead {
	/** The log position everything below was read at (the head when the call started). */
	seq: number;
	/** The snapshots with the subscriptions they answer (a `tree` one carries the parents it ended up with). */
	windows: SeedWindow[];
	properties?: PropertyDef[];
	teamspaces?: { list: Teamspace[]; ranks: Record<string, string> };
	collection?: { collection: CollectionDef; views: ViewDef[] } | null;
}
