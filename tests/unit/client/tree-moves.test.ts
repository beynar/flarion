import { describe, expect, it, vi } from 'vitest';
import type { PageRow } from '#lib/shared/protocol.ts';
import type { Teamspace } from '#lib/shared/schemas.ts';
import { MOCK_USER, MOCK_WORKSPACE } from '#lib/client/mock-socket.ts';
import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
import { pageRow, setup } from './helpers.ts';

const ME = MOCK_USER.id;
const ts = (id: string, myRole: Teamspace['myRole'] = 'member'): Teamspace => ({
	id,
	name: id,
	icon: null,
	description: '',
	privacy: 'open',
	defaultLevel: 'update',
	createdBy: 'u_other',
	myRole
});

/** Pages: a, b, c at the top of team "eng"; kid under a; mine and theirs outside any teamspace. */
function pages(): PageRow[] {
	const p = (id: string, parentId: string | null, rank: string, extra: Partial<PageRow> = {}) =>
		pageRow(id, { parentId, rank, title: id, values: { title: id }, createdBy: ME, ...extra });
	return [
		p('a', null, '11', { teamspaceId: 'eng', hasChildren: true }),
		p('b', null, '12', { teamspaceId: 'eng' }),
		p('c', null, '13', { teamspaceId: 'eng' }),
		p('kid', 'a', '11', { teamspaceId: 'eng' }),
		p('mine', null, '11'),
		p('theirs', null, '12', { createdBy: 'u_other', access: 'update' }),
		p('viewer', null, '14', { teamspaceId: 'eng', access: 'update' }),
		p('rdonly', null, '15', { teamspaceId: 'eng', access: 'read' }),
		p('design-page', null, '11', { teamspaceId: 'design' })
	];
}

async function boot(role: 'owner' | 'member' = 'member') {
	const ctx = setup({ server: { pages: pages() }, store: { workspace: { ...MOCK_WORKSPACE, role } } });
	const { store } = ctx;
	await store.start();
	await vi.waitFor(() => expect(store.ready && store.status === 'online').toBe(true));
	store.teamspaces = [ts('eng', 'owner'), ts('design', null), ts('ops')];
	return ctx;
}

const order = (store: WorkspaceStore, parent: string | null, team?: string) =>
	store
		.children(parent)
		.filter((p) => parent !== null || (p.teamspaceId ?? null) === (team ?? null))
		.map((p) => p.id);

describe('canMove', () => {
	it('refuses a move into the page itself or its own subtree', async () => {
		const { store } = await boot();
		store.expand('a');
		await vi.waitFor(() => expect(store.branchState('a')).toBe('ready'));
		expect(store.canMove('a', { parentId: 'a' })).toMatchObject({ ok: false });
		expect(store.canMove('a', { parentId: 'kid' })).toMatchObject({ ok: false, reason: expect.stringContaining('inside itself') });
		expect(store.canMove('kid', { parentId: 'a' })).toEqual({ ok: true });
		store.dispose();
	});

	it('needs full access to change parent or teamspace, and update access to reorder', async () => {
		const { store } = await boot();
		expect(store.canMove('viewer', { parentId: 'b' })).toMatchObject({ ok: false, reason: expect.stringContaining('full access') });
		expect(store.canMove('viewer', { parentId: null, teamspaceId: 'eng' })).toEqual({ ok: true }); // same level: a reorder
		expect(store.canMove('viewer', { parentId: null, teamspaceId: null })).toMatchObject({ ok: false });
		expect(store.canMove('rdonly', { parentId: null, teamspaceId: 'eng' })).toMatchObject({ ok: false });
		expect(store.canMove('b', { parentId: 'c' })).toEqual({ ok: true });
		store.dispose();
	});

	it('only moves into teamspaces the user belongs to, never into Shared, and Private holds only own pages', async () => {
		const { store } = await boot();
		expect(store.canMove('mine', { parentId: null, teamspaceId: 'eng' })).toEqual({ ok: true });
		expect(store.canMove('mine', { parentId: null, teamspaceId: 'design' })).toMatchObject({ ok: false, reason: expect.stringContaining('Join') });
		const admin = await boot('owner'); // owners and admins may use any teamspace
		expect(admin.store.canMove('mine', { parentId: null, teamspaceId: 'design' })).toEqual({ ok: true });
		admin.store.dispose();
		expect(store.canMove('mine', { parentId: null, teamspaceId: null, shared: true })).toMatchObject({ ok: false });
		expect(store.canMove('mine', { parentId: null, teamspaceId: null })).toEqual({ ok: true }); // a reorder within Private
		expect(store.canMove('theirs', { parentId: null, teamspaceId: null })).toMatchObject({ ok: false }); // theirs is Shared, not Private
		expect(store.canMove('theirs', { parentId: null, teamspaceId: null, shared: true })).toEqual({ ok: true }); // reorder in Shared
		expect(store.canMove('b', { parentId: null, teamspaceId: null })).toEqual({ ok: true }); // own page out of a teamspace into Private
		store.dispose();
	});
});

describe('movePage', () => {
	it('reorders among siblings with a rank between the neighbours, optimistically', async () => {
		const { store, server } = await boot();
		const moved = store.movePage('c', { parentId: null, teamspaceId: 'eng', beforeId: 'b' });
		expect(order(store, null, 'eng')).toEqual(['a', 'c', 'b', 'viewer', 'rdonly']); // before the answer
		expect(await moved).toBe(true);
		const rank = store.page('c')!.rank;
		expect(rank > '11' && rank < '12').toBe(true);
		await vi.waitFor(() => expect(store.layerCount).toBe(0));
		expect(server.pages.get('c')!.rank).toBe(rank);
		store.dispose();
	});

	it('nests under a page, appending after its children, and opens the branch', async () => {
		const { store, server } = await boot();
		expect(store.isExpanded('a')).toBe(false);
		expect(await store.movePage('b', { parentId: 'a' })).toBe(true);
		expect(store.isExpanded('a')).toBe(true);
		await vi.waitFor(() => expect(store.layerCount).toBe(0));
		expect(server.pages.get('b')!.parentId).toBe('a');
		expect(order(store, 'a')).toEqual(['kid', 'b']); // the unloaded child was loaded first, so b lands after it
		expect(store.page('b')!.rank > store.page('kid')!.rank).toBe(true);
		store.dispose();
	});

	it('moves a page to another section with its teamspace, and puts it first with an index', async () => {
		const { store, server } = await boot();
		expect(await store.movePage('mine', { parentId: null, teamspaceId: 'eng', index: 0 })).toBe(true);
		await vi.waitFor(() => expect(store.layerCount).toBe(0));
		expect(server.pages.get('mine')!.teamspaceId).toBe('eng');
		expect(order(store, null, 'eng')[0]).toBe('mine');
		store.dispose();
	});

	it('refuses an illegal move with a toast and sends nothing', async () => {
		const { store, server, notices } = await boot();
		const before = server.log.length;
		expect(await store.movePage('a', { parentId: 'a' })).toBe(false);
		expect(notices.at(-1)).toMatchObject({ kind: 'info', title: 'Cannot move the page there' });
		expect(server.log.length).toBe(before);
		store.dispose();
	});

	it('rebalances the neighbours in the same batch when no rank fits between them', async () => {
		const rows = pages();
		rows.find((p) => p.id === 'a')!.rank = '12';
		rows.find((p) => p.id === 'b')!.rank = '12'; // equal neighbours: no rank fits between them
		const ctx = setup({ server: { pages: rows } });
		await ctx.store.start();
		await vi.waitFor(() => expect(ctx.store.ready && ctx.store.status === 'online').toBe(true));
		ctx.store.teamspaces = [ts('eng', 'owner')];
		expect(await ctx.store.movePage('c', { parentId: null, teamspaceId: 'eng', afterId: 'a' })).toBe(true);
		await vi.waitFor(() => expect(ctx.store.layerCount).toBe(0));
		expect(order(ctx.store, null, 'eng').slice(0, 3)).toEqual(['a', 'c', 'b']);
		ctx.store.dispose();
	});
});

describe('trash and duplicate', () => {
	it('trashes a page: it leaves the tree at once', async () => {
		const { store } = await boot();
		const done = store.trashPage('c');
		expect(store.page('c')).toBeUndefined();
		expect(await done).toBe(true);
		store.dispose();
	});
});

describe('the teamspace directory', () => {
	it('is fetched again when a page of a teamspace it does not list arrives', async () => {
		const { store, rpc } = await boot();
		const list = vi.spyOn(rpc.workspace.teamspaces, 'list');
		store.receive({
			t: 'diff',
			seq: store.seq! + 1,
			subs: [{ id: 'tree', ops: [{ op: 'add', index: 0, row: { ...pageRow('fresh'), parentId: null, teamspaceId: 'brand-new', hasChildren: false } }] }]
		});
		await vi.waitFor(() => expect(list).toHaveBeenCalled());
		store.dispose();
	});

	it('orders my teamspaces by my own sidebar rank, then by name', async () => {
		const { store } = await boot();
		store.teamspaces = [ts('z'), ts('b'), ts('a'), ts('hidden', null)];
		store.teamspaceRanks = { z: '11', b: '13', a: '13' };
		expect(store.myTeamspaces.map((t) => t.id)).toEqual(['z', 'a', 'b']);
		store.dispose();
	});
});
