/**
 * The page lock as the client sees it (docs/PLAN.md "Lock page"). The lock lives in the page's room (PageDO) and is
 * read and written through `page.lock.get` / `page.lock.set`; this module keeps the last answer per page so the
 * editor (read-only plus a banner) and the top bar's "Lock page" menu item agree, and refreshes it while a page is open.
 */
import { SvelteMap } from 'svelte/reactivity';
import { rpc } from '#lib/client/rpc.ts';
import type { PageLock } from '#lib/shared/schemas.ts';

export type LockFetcher = (pageId: string) => Promise<PageLock>;
export type LockSetter = (pageId: string, locked: boolean) => Promise<PageLock>;

export const rpcLockFetcher: LockFetcher = (id) => rpc.page.lock.get({ id });
export const rpcLockSetter: LockSetter = (id, locked) => rpc.page.lock.set({ id, locked });

const REFRESH_MS = 8_000;

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

	/** Reads now, then every few seconds and when the tab comes back, until the returned function is called. */
	watch(pageId: string, fetcher: LockFetcher = rpcLockFetcher, intervalMs = REFRESH_MS): () => void {
		void this.refresh(pageId, fetcher);
		const timer = setInterval(() => document.visibilityState === 'visible' && void this.refresh(pageId, fetcher), intervalMs);
		const onVisible = () => document.visibilityState === 'visible' && void this.refresh(pageId, fetcher);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}
}

export const pageLocks = new PageLocks();
