/**
 * The page lock as the client sees it (docs/PLAN.md "Lock page"). The lock lives in the page's room (PageDO) and is
 * read and written through `page.lock.get` / `page.lock.set`; this module keeps the last answer per page so the
 * editor (read-only plus a banner) and the top bar's "Lock page" menu item agree. A page is read when it opens and when
 * the tab comes back; after that the workspace socket pushes every change (`lock` message, `apply` here), and a socket
 * reconnect reads the open pages again (`refreshWatched`). There is no polling.
 */
import { SvelteMap } from 'svelte/reactivity';
import { rpc } from '#lib/client/rpc.ts';
import type { PageLock } from '#lib/shared/schemas.ts';

export type LockFetcher = (pageId: string) => Promise<PageLock>;
export type LockSetter = (pageId: string, locked: boolean) => Promise<PageLock>;

export const rpcLockFetcher: LockFetcher = (id) => rpc.page.lock.get({ id });
export const rpcLockSetter: LockSetter = (id, locked) => rpc.page.lock.set({ id, locked });

class PageLocks {
	#states = new SvelteMap<string, PageLock>();

	/** The last known lock of a page (`undefined` until the first answer). */
	get(pageId: string): PageLock | undefined {
		return this.#states.get(pageId);
	}

	/** Whether edits to `pageId` are refused for the caller: locked, and no bypass. */
	blocks(pageId: string): boolean {
		const lock = this.#states.get(pageId);
		return !!lock?.locked && !lock.bypass;
	}

	set(pageId: string, lock: PageLock): void {
		this.#states.set(pageId, lock);
	}

	async refresh(pageId: string, fetcher: LockFetcher = rpcLockFetcher): Promise<void> {
		try {
			this.#states.set(pageId, await fetcher(pageId));
		} catch {
			// Offline or no access: keep what we know.
		}
	}

	/** Locks or unlocks; resolves with the new state or throws the server's refusal. */
	async toggle(pageId: string, locked: boolean, setter: LockSetter = rpcLockSetter): Promise<PageLock> {
		const lock = await setter(pageId, locked);
		this.#states.set(pageId, lock);
		return lock;
	}

	/** The pages the editor has open, with the function that reads each one's lock (several editors may share a page). */
	#watched = new Map<string, { fetcher: LockFetcher; holders: number }>();

	/**
	 * Applies a pushed change (the socket's `lock` message). The receiver's own `bypass` (full access) is not in the
	 * push: the cached one is kept, and a page never read before is read now (a page nobody has open is ignored).
	 */
	apply(pageId: string, change: { locked: boolean; lockedBy: string | null; lockedAt: number | null }): void {
		const known = this.#states.get(pageId);
		if (known) this.#states.set(pageId, { ...known, locked: change.locked, lockedBy: change.lockedBy, lockedAt: change.lockedAt });
		else {
			// Never read: only an open page needs it (it is read when it opens), and its `bypass` is not guessed.
			const open = this.#watched.get(pageId);
			if (open) void this.refresh(pageId, open.fetcher);
		}
	}

	/** Reads every open page again: pushes were missed while the socket was down. */
	refreshWatched(): void {
		for (const [pageId, { fetcher }] of this.#watched) void this.refresh(pageId, fetcher);
	}

	/** Reads now and when the tab comes back, until the returned function is called. */
	watch(pageId: string, fetcher: LockFetcher = rpcLockFetcher): () => void {
		const held = this.#watched.get(pageId);
		if (held) held.holders++;
		else this.#watched.set(pageId, { fetcher, holders: 1 });
		void this.refresh(pageId, fetcher);
		const onVisible = () => document.visibilityState === 'visible' && void this.refresh(pageId, fetcher);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			const entry = this.#watched.get(pageId);
			if (entry && --entry.holders <= 0) this.#watched.delete(pageId);
		};
	}
}

export const pageLocks = new PageLocks();
