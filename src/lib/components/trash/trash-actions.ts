/**
 * Trash actions shared by the sidebar, the Trash screen, the trash popover and the "moved to Trash" page:
 * delete with an Undo toast, restore, purge, and finding a page in the trash list. Pure of the DOM: toasts go
 * through an injectable `notify` (default: entasis Toast, loaded on first use), so tests run in node.
 */
import type * as v from 'valibot';
import type { Rpc } from '#lib/client/rpc.ts';
import type { trashEntrySchema } from '#lib/shared/schemas.ts';
import type { Op } from '#lib/shared/ops.ts';

export type TrashEntry = v.InferOutput<typeof trashEntrySchema>;
export type TrashSort = 'deleted_desc' | 'deleted_asc' | 'title';

/** An action button of an entasis toast. */
export type ToastAction = NonNullable<NonNullable<Parameters<typeof import('entasis/toast').toast.info>[0]>['actions']>[number];
export interface TrashNotice {
	kind: 'info' | 'success' | 'danger';
	title: string;
	description?: string;
	actions?: ToastAction[];
	duration?: number;
}
export type Notify = (notice: TrashNotice) => void;

/** The slice of `WorkspaceStore` the helpers use. */
export interface TrashStore {
	trashPage(id: string): Promise<boolean>;
	mutate(ops: Op[]): Promise<{ seq: number }>;
	titleOf(id: string): string;
}

/** Entasis Toast, imported on first use so this module loads in node. */
export const defaultNotify: Notify = (notice) => {
	void import('entasis/toast').then(({ toast }) => {
		const { kind, ...options } = notice;
		toast[kind](options);
	});
};

/** Ids this tab moved to Trash (the store forgets a page once it is gone), newest last. */
const trashedHere = new Map<string, { title: string; at: number }>();
export const wasTrashedHere = (id: string): boolean => trashedHere.has(id);
export const forgetTrashed = (id: string): void => void trashedHere.delete(id);

const messageOf = (error: unknown): string | undefined => (error instanceof Error && error.message ? error.message : undefined);

/** Restores a page (and its subtree) from Trash. Resolves false after raising a toast when the call fails. */
export async function restorePage(store: Pick<TrashStore, 'mutate'>, id: string, opts: { notify?: Notify; quiet?: boolean } = {}): Promise<boolean> {
	const notify = opts.notify ?? defaultNotify;
	try {
		await store.mutate([{ op: 'restore', page: id }]);
		forgetTrashed(id);
		return true;
	} catch (error) {
		// The store raises its own toast for a rejected mutation; offline it throws before any request.
		if (!opts.quiet) notify({ kind: 'danger', title: 'Could not restore the page', description: messageOf(error) });
		return false;
	}
}

/** Deletes a trashed page forever. Resolves false after raising a toast when the call fails. */
export async function purgePage(rpc: { page: Pick<Rpc['page'], 'purge'> }, id: string, opts: { notify?: Notify } = {}): Promise<boolean> {
	const notify = opts.notify ?? defaultNotify;
	try {
		await rpc.page.purge({ id });
		forgetTrashed(id);
		return true;
	} catch (error) {
		notify({ kind: 'danger', title: 'Could not delete the page', description: messageOf(error) });
		return false;
	}
}

export interface TrashWithUndoOptions {
	notify?: Notify;
	/** Called after the page was trashed, before the toast (navigate away from it). */
	onTrashed?: () => void | Promise<void>;
	/** Called after Undo restored the page. */
	onUndo?: () => void | Promise<void>;
}

/**
 * Moves a page to Trash and raises "Moved '<title>' to Trash" with an Undo action that restores it. Resolves true
 * when the page was trashed (false: the store refused or the call failed, and has raised its own toast).
 */
export async function trashWithUndo(store: TrashStore, id: string, opts: TrashWithUndoOptions = {}): Promise<boolean> {
	const notify = opts.notify ?? defaultNotify;
	const title = store.titleOf(id);
	if (!(await store.trashPage(id))) return false;
	trashedHere.set(id, { title, at: Date.now() });
	await opts.onTrashed?.();
	notify({
		kind: 'info',
		title: `Moved '${title}' to Trash`,
		duration: 8000,
		actions: [
			{
				content: 'Undo',
				onclick: async () => {
					if (await restorePage(store, id, { notify })) await opts.onUndo?.();
				}
			}
		]
	});
	return true;
}

/** The entry of `id` in a list of trash entries (only roots of a deleted subtree are listed). */
export function findTrashEntry(list: readonly TrashEntry[], id: string): TrashEntry | undefined {
	return list.find((entry) => entry.id === id);
}

/**
 * Looks `id` up in the Trash through `page.trashList`, paging through at most `maxPages` pages (most recent
 * deletions first). Null when it is not there (a page that does not exist, a purged page, no access) or when
 * the lookup failed.
 */
export async function lookupTrashEntry(rpc: { page: Pick<Rpc['page'], 'trashList'> }, id: string, maxPages = 5): Promise<TrashEntry | null> {
	let cursor: string | undefined;
	try {
		for (let i = 0; i < maxPages; i++) {
			const result = await rpc.page.trashList({ sort: 'deleted_desc', limit: 100, ...(cursor ? { cursor } : {}) });
			const hit = findTrashEntry(result.items, id);
			if (hit) return hit;
			if (!result.nextCursor) return null;
			cursor = result.nextCursor;
		}
	} catch {
		return null;
	}
	return null;
}

/** Relative "Deleted 3 days ago" style text of an ISO timestamp. */
export function deletedAgo(iso: string, now: number = Date.now()): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return '';
	const minutes = Math.max(0, Math.round((now - ms) / 60_000));
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
	return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
