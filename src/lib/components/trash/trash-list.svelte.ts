/**
 * The state behind the Trash screen and the sidebar's Trash popover: one server-paged, searchable and sortable
 * list of `page.trashList` entries. A newer query supersedes an older one still in flight.
 */
import type { Rpc } from '#lib/client/rpc.ts';
import type { TrashEntry, TrashSort } from './trash-actions.ts';

export class TrashList {
	items = $state.raw<TrashEntry[]>([]);
	q = $state('');
	sort = $state<TrashSort>('deleted_desc');
	status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	more = $state(false);
	loadingMore = $state(false);
	error = $state<string | null>(null);

	readonly #rpc: { page: Pick<Rpc['page'], 'trashList'> };
	readonly #limit: number;
	#cursor: string | null = null;
	#run = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(rpc: { page: Pick<Rpc['page'], 'trashList'> }, limit = 50) {
		this.#rpc = rpc;
		this.#limit = limit;
	}

	#input(cursor?: string) {
		const q = this.q.trim();
		return { sort: this.sort, limit: this.#limit, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) };
	}

	/** Reads the first page again (keeps the rows on screen until the answer comes, so a refresh does not flash). */
	async reload(): Promise<void> {
		const run = ++this.#run;
		if (this.status !== 'ready') this.status = 'loading';
		try {
			const page = await this.#rpc.page.trashList(this.#input());
			if (run !== this.#run) return;
			this.items = page.items;
			this.#cursor = page.nextCursor;
			this.more = page.nextCursor !== null;
			this.error = null;
			this.status = 'ready';
		} catch (error) {
			if (run !== this.#run) return;
			this.error = error instanceof Error && error.message ? error.message : 'The Trash could not be loaded.';
			this.status = 'error';
		}
	}

	async loadMore(): Promise<void> {
		if (!this.#cursor || this.loadingMore) return;
		const run = this.#run;
		this.loadingMore = true;
		try {
			const page = await this.#rpc.page.trashList(this.#input(this.#cursor));
			if (run !== this.#run) return;
			const seen = new Set(this.items.map((e) => e.id));
			this.items = [...this.items, ...page.items.filter((e) => !seen.has(e.id))];
			this.#cursor = page.nextCursor;
			this.more = page.nextCursor !== null;
		} catch (error) {
			if (run === this.#run) this.error = error instanceof Error ? error.message : 'Could not load more.';
		} finally {
			this.loadingMore = false;
		}
	}

	/** Types into the search box: the query goes to the server after a short pause. */
	search(q: string, debounceMs = 250): void {
		this.q = q;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.reload();
		}, debounceMs);
	}

	setSort(sort: TrashSort): void {
		if (sort === this.sort) return;
		this.sort = sort;
		void this.reload();
	}

	/** Drops a row after restore or purge, without another request. */
	remove(id: string): void {
		this.items = this.items.filter((e) => e.id !== id);
	}

	dispose(): void {
		this.#run++;
		if (this.#timer) clearTimeout(this.#timer);
	}
}
