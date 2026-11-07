import { describe, expect, it, vi } from 'vitest';
import {
	deletedAgo,
	findTrashEntry,
	lookupTrashEntry,
	purgePage,
	restorePage,
	trashWithUndo,
	wasTrashedHere,
	type Notify,
	type TrashEntry,
	type TrashNotice,
	type TrashStore
} from '#lib/components/trash/trash-actions.ts';
import { TrashList } from '#lib/components/trash/trash-list.svelte.ts';
import { setup, tick } from './helpers.ts';

const entry = (id: string, extra: Partial<TrashEntry> = {}): TrashEntry => ({
	id,
	title: id,
	icon: null,
	deletedAt: '2026-11-01T10:00:00.000Z',
	deletedBy: 'u_ada',
	pageCount: 1,
	parentId: null,
	...extra
});

const recorder = () => {
	const notices: TrashNotice[] = [];
	const notify: Notify = (n) => void notices.push(n);
	return { notices, notify };
};

describe('findTrashEntry', () => {
	it('finds an entry by id', () => {
		const list = [entry('a'), entry('b', { title: 'Bee' })];
		expect(findTrashEntry(list, 'b')?.title).toBe('Bee');
		expect(findTrashEntry(list, 'zzz')).toBeUndefined();
	});
});

describe('trashWithUndo, restorePage, purgePage', () => {
	it('trashes, toasts with an Undo that restores through a restore op, and remembers the id', async () => {
		const { store, server } = setup();
		await store.start();
		await vi.waitFor(() => expect(store.ready && store.status === 'online').toBe(true));
		const victim = [...server.pages.keys()][0];
		const title = store.titleOf(victim);
		const { notices, notify } = recorder();
		const undone = vi.fn();
		expect(await trashWithUndo(store, victim, { notify, onUndo: undone })).toBe(true);
		expect(wasTrashedHere(victim)).toBe(true);
		expect(server.pages.has(victim)).toBe(false);
		expect(notices).toHaveLength(1);
		expect(notices[0].title).toBe(`Moved '${title}' to Trash`);
		expect(notices[0].actions?.[0].content).toBe('Undo');

		await (notices[0].actions![0].onclick as unknown as () => Promise<void>)();
		await tick(5);
		expect(server.pages.has(victim)).toBe(true);
		expect(server.log.at(-1)?.ops).toEqual([{ op: 'restore', page: victim }]);
		expect(wasTrashedHere(victim)).toBe(false);
		expect(undone).toHaveBeenCalledOnce();
		store.dispose();
	});

	it('does not toast when the store refuses the delete', async () => {
		const { notices, notify } = recorder();
		const store: TrashStore = {
			trashPage: async () => false,
			mutate: async () => ({ seq: 1 }),
			titleOf: () => 'x'
		};
		expect(await trashWithUndo(store, 'nope', { notify })).toBe(false);
		expect(notices).toEqual([]);
		expect(wasTrashedHere('nope')).toBe(false);
	});

	it('reports a failed restore with a danger notice', async () => {
		const { notices, notify } = recorder();
		const ok = await restorePage({ mutate: async () => Promise.reject(new Error('Parent is gone')) }, 'p', { notify });
		expect(ok).toBe(false);
		expect(notices[0]).toMatchObject({ kind: 'danger', description: 'Parent is gone' });
	});

	it('purges through rpc.page.purge and reports failures', async () => {
		const purge = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Forbidden'));
		const { notices, notify } = recorder();
		expect(await purgePage({ page: { purge } }, 'p1', { notify })).toBe(true);
		expect(purge).toHaveBeenCalledWith({ id: 'p1' });
		expect(await purgePage({ page: { purge } }, 'p2', { notify })).toBe(false);
		expect(notices[0].kind).toBe('danger');
	});
});

describe('lookupTrashEntry', () => {
	it('pages through the list until it finds the page', async () => {
		const trashList = vi
			.fn()
			.mockResolvedValueOnce({ items: [entry('a')], nextCursor: 'c1' })
			.mockResolvedValueOnce({ items: [entry('target', { title: 'Plan' })], nextCursor: null });
		const found = await lookupTrashEntry({ page: { trashList } }, 'target');
		expect(found?.title).toBe('Plan');
		expect(trashList).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'c1' }));
	});

	it('gives up after the page cap, and returns null when the call fails', async () => {
		const endless = vi.fn().mockResolvedValue({ items: [entry('a')], nextCursor: 'more' });
		expect(await lookupTrashEntry({ page: { trashList: endless } }, 'zz', 3)).toBeNull();
		expect(endless).toHaveBeenCalledTimes(3);
		expect(await lookupTrashEntry({ page: { trashList: vi.fn().mockRejectedValue(new Error('x')) } }, 'zz')).toBeNull();
	});
});

describe('TrashList', () => {
	it('searches on the server, sorts, loads more and drops removed rows', async () => {
		const trashList = vi
			.fn()
			.mockResolvedValueOnce({ items: [entry('a'), entry('b')], nextCursor: 'next' })
			.mockResolvedValueOnce({ items: [entry('b'), entry('c')], nextCursor: null })
			.mockResolvedValue({ items: [entry('c')], nextCursor: null });
		const list = new TrashList({ page: { trashList } }, 2);
		await list.reload();
		expect(list.status).toBe('ready');
		expect(list.more).toBe(true);
		await list.loadMore();
		expect(list.items.map((e) => e.id)).toEqual(['a', 'b', 'c']);
		expect(list.more).toBe(false);
		list.remove('a');
		expect(list.items.map((e) => e.id)).toEqual(['b', 'c']);

		list.search('plan', 0);
		await vi.waitFor(() => expect(trashList).toHaveBeenCalledTimes(3));
		expect(trashList).toHaveBeenLastCalledWith({ sort: 'deleted_desc', limit: 2, q: 'plan' });
		list.setSort('deleted_asc');
		await vi.waitFor(() => expect(trashList).toHaveBeenCalledTimes(4));
		expect(trashList).toHaveBeenLastCalledWith({ sort: 'deleted_asc', limit: 2, q: 'plan' });
		list.dispose();
	});

	it('ends in the error state when the first read fails', async () => {
		const list = new TrashList({ page: { trashList: vi.fn().mockRejectedValue(new Error('Boom')) } });
		await list.reload();
		expect(list.status).toBe('error');
		expect(list.error).toBe('Boom');
	});
});

describe('deletedAgo', () => {
	const now = Date.parse('2026-11-07T12:00:00Z');
	it('reads naturally', () => {
		expect(deletedAgo('2026-11-07T11:59:40Z', now)).toBe('just now');
		expect(deletedAgo('2026-11-07T11:30:00Z', now)).toBe('30 min ago');
		expect(deletedAgo('2026-11-07T09:00:00Z', now)).toBe('3 hours ago');
		expect(deletedAgo('2026-11-04T12:00:00Z', now)).toBe('3 days ago');
	});
});
