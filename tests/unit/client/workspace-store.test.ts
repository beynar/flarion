import { describe, expect, it } from 'vitest';
import { TITLE_PROP_ID } from '#lib/shared/property-types.ts';
import type { Op } from '#lib/shared/ops.ts';
import { WorkspaceStore, OfflineError } from '#lib/client/workspace.svelte.ts';
import { MemoryCache } from '#lib/client/idb.ts';
import { MOCK_USER, MOCK_WORKSPACE, MockServer, createMockRpc } from '#lib/client/mock-socket.ts';
import { fastClock, memoryStorage, pageRow, setup, snapshot, tick, treeRow } from './helpers.ts';
import { vi } from 'vitest';

const ready = async (store: WorkspaceStore) => {
	await store.start();
	await vi.waitFor(() => expect(store.ready && store.status === 'online').toBe(true));
};

describe('applying snapshots and diffs in seq order', () => {
	/** A store with no socket: messages are fed with `receive`. */
	const bare = () => {
		const { store, notices } = setup();
		store.status = 'online';
		store.initTree();
		return { store, notices };
	};

	it('builds the tree from a snapshot and sorts siblings by rank', () => {
		const { store } = bare();
		store.receive(
			snapshot('tree', [treeRow('b', null, '02'), treeRow('a', null, '01'), treeRow('c', 'a', '01', 'Child', { teamspaceId: null })], 10)
		);
		expect(store.seq).toBe(10);
		expect(store.ready).toBe(true);
		expect(store.children(null).map((p) => p.id)).toEqual(['a', 'b']);
		expect(store.children('a').map((p) => p.id)).toEqual(['c']);
	});

	it('applies add, update, move and remove ops of a diff', () => {
		const { store } = bare();
		store.receive(snapshot('tree', [treeRow('a', null, '01'), treeRow('b', null, '02')], 10));
		store.receive({
			t: 'diff',
			seq: 11,
			subs: [
				{
					id: 'tree',
					ops: [
						{ op: 'add', index: 2, row: treeRow('c', null, '03', 'Third') },
						{ op: 'update', id: 'a', prop: TITLE_PROP_ID, value: 'Renamed' },
						{ op: 'update', id: 'b', prop: '$rank', value: '00' },
						{ op: 'count', total: 3 }
					]
				}
			]
		});
		expect(store.children(null).map((p) => p.title)).toEqual(['b', 'Renamed', 'Third']);
		expect(store.windows.get('tree')?.total).toBe(3);
		store.receive({ t: 'diff', seq: 12, subs: [{ id: 'tree', ops: [{ op: 'remove', id: 'b' }] }] });
		expect(store.children(null).map((p) => p.id)).toEqual(['a', 'c']);
		expect(store.page('b')).toBeUndefined();
		expect(store.seq).toBe(12);
	});

	it('drops a diff at or below the applied seq and keeps the newer value', () => {
		const { store } = bare();
		store.receive(snapshot('tree', [treeRow('a', null, '01', 'v0')], 10));
		const rename = (seq: number, value: string) =>
			store.receive({ t: 'diff', seq, subs: [{ id: 'tree', ops: [{ op: 'update', id: 'a', prop: TITLE_PROP_ID, value }] }] });
		rename(12, 'v12');
		rename(11, 'v11 (late)');
		rename(12, 'v12 again');
		expect(store.page('a')?.title).toBe('v12');
		expect(store.seq).toBe(12);
	});

	it('buffers a diff that arrives before its snapshot and replays only what the snapshot lacks', () => {
		const { store } = bare();
		store.receive(snapshot('tree', [treeRow('a', null, '01')], 10));
		store.subscribe('pg:a', { kind: 'page', pageIds: ['a'] });
		const upd = (seq: number, value: string) =>
			store.receive({ t: 'diff', seq, subs: [{ id: 'pg:a', ops: [{ op: 'update', id: 'a', prop: 'status', value }] }] });
		// Out of order and ahead of the snapshot: 14 before 12, both before the snapshot at 11 lands.
		upd(14, 'fourteen');
		upd(12, 'twelve');
		upd(9, 'nine (already in the snapshot)');
		expect(store.pageStatus('a')).toBe('pending');
		expect(store.seq).toBe(10);
		store.receive({ t: 'snapshot', kind: 'page', id: 'pg:a', rows: [pageRow('a', { values: { title: 'a', status: 'eleven' } })], total: 1, seq: 11 });
		expect(store.pageStatus('a')).toBe('ready');
		// Replayed in seq order (12 then 14): the last one wins; seq 9 was ignored.
		expect(store.page('a')?.values.status).toBe('fourteen');
		expect(store.seq).toBe(14);
	});

	it('advances on head frames and ignores diffs for unknown subscriptions', () => {
		const { store } = bare();
		store.receive(snapshot('tree', [treeRow('a', null, '01')], 10));
		store.receive({ t: 'diff', seq: 11, subs: [{ id: 'nope', ops: [{ op: 'remove', id: 'a' }] }] });
		store.receive({ t: 'head', seq: 15 });
		expect(store.page('a')).toBeDefined();
		expect(store.seq).toBe(15);
	});

	it('marks a subscription failed on an error frame', () => {
		const { store } = bare();
		store.subscribe('pg:x', { kind: 'page', pageIds: ['x'] });
		store.receive({ t: 'error', code: 'not_found', message: 'Page not found', id: 'pg:x' });
		expect(store.pageStatus('x')).toBe('error');
	});

	it('keeps view rows in their window and applies update ops there', () => {
		const { store } = bare();
		store.subscribe('v1', { kind: 'view', collectionId: 'db', limit: 50 });
		store.receive({
			t: 'snapshot',
			kind: 'view',
			id: 'v1',
			rows: [{ id: 'r1', title: 'Row 1', icon: null, values: { status: 'a' } }],
			total: 1,
			seq: 20
		});
		store.receive({ t: 'diff', seq: 21, subs: [{ id: 'v1', ops: [{ op: 'update', id: 'r1', prop: 'status', value: 'b' }] }] });
		expect(store.windowRows('v1')).toMatchObject([{ id: 'r1', values: { status: 'b' } }]);
		expect(store.page('r1')).toBeUndefined();
	});

	it('shows presence and keeps me out of othersOn', () => {
		const { store } = bare();
		store.receive({
			t: 'presence',
			entries: [{ pageId: 'a', users: [{ userId: MOCK_USER.id, name: 'Ada' }, { userId: 'u_grace', name: 'Grace' }] }]
		});
		expect(store.othersOn('a').map((u) => u.name)).toEqual(['Grace']);
		store.receive({ t: 'presence', entries: [{ pageId: 'a', users: [] }] });
		expect(store.othersOn('a')).toEqual([]);
	});
});

describe('with the mock socket', () => {
	it('loads the P0 mock data into Teamspaces, Shared and Private', async () => {
		const { store, server } = setup();
		await ready(store);
		expect(store.teamspaceRoots('ts_engineering').map((p) => p.title)).toEqual(['Architecture overview', 'Roadmap']);
		expect(store.teamspaceRoots('ts_design').map((p) => p.title)).toEqual(['Brand guidelines']);
		expect(store.sharedRoots().map((p) => p.title)).toEqual(['Launch plan']);
		expect(store.privateRoots().map((p) => p.title)).toEqual(['Getting started', 'Reading list']);
		expect(store.seq).toBe(server.seq);
		expect(store.properties.map((p) => p.id)).toContain('status');
		store.dispose();
	});

	it('expanding a branch subscribes to it and loads its children', async () => {
		const { store, server } = setup();
		await ready(store);
		expect(store.children('getting-started')).toEqual([]);
		expect(store.page('getting-started')?.hasChildren).toBe(true);
		store.expand('getting-started');
		expect(store.branchState('getting-started')).toBe('loading');
		await vi.waitFor(() => expect(store.branchState('getting-started')).toBe('ready'));
		expect(store.children('getting-started').map((p) => p.title)).toEqual(['Meeting notes']);
		const sub = server.clientMessages.filter((m) => m.t === 'subscribe' && m.id === 'tree').at(-1);
		expect(sub).toMatchObject({ sub: { kind: 'tree', parents: [null, 'getting-started'] } });
		store.dispose();
	});

	it('applies a mutation optimistically, then drops the layer once the socket delivers its seq', async () => {
		const { store, server } = setup();
		await ready(store);
		const release = store.openPage('roadmap');
		await vi.waitFor(() => expect(store.pageStatus('roadmap')).toBe('ready'));
		server.holdDelivery();
		const op: Op = { op: 'setProp', page: 'roadmap', prop: 'status', value: 'done' };
		const done = store.mutate([op]);
		expect(store.page('roadmap')?.values.status).toBe('done'); // before any answer
		const { seq } = await done;
		expect(store.layerCount).toBe(1); // sent and committed, but the socket has not delivered it
		expect(store.seq).toBeLessThan(seq);
		server.releaseDelivery();
		await vi.waitFor(() => expect(store.layerCount).toBe(0));
		expect(store.seq).toBeGreaterThanOrEqual(seq);
		expect(store.page('roadmap')?.values.status).toBe('done'); // now the server's value
		release();
		store.dispose();
	});

	it('drops the layer at once when the socket delivered the seq before the call returned', async () => {
		const { store, server } = setup();
		await ready(store);
		store.openPage('roadmap');
		await vi.waitFor(() => expect(store.pageStatus('roadmap')).toBe('ready'));
		const op: Op = { op: 'setProp', page: 'roadmap', prop: 'status', value: 'review' };
		await store.mutate([op], async () => {
			const seq = server.commit([op]);
			await vi.waitFor(() => expect(store.seq).toBe(seq));
			return { seq };
		});
		expect(store.layerCount).toBe(0);
		expect(store.page('roadmap')?.values.status).toBe('review');
		store.dispose();
	});

	it('rolls back and raises a toast when the call fails', async () => {
		const { store, server, notices } = setup();
		await ready(store);
		store.openPage('roadmap');
		await vi.waitFor(() => expect(store.pageStatus('roadmap')).toBe('ready'));
		const before = store.page('roadmap')?.values.status;
		server.failNext = { code: 'VALIDATION_FAILED', message: 'Validation failed', data: { issues: [{ message: 'Unknown option' }] } };
		const p = store.mutate([{ op: 'setProp', page: 'roadmap', prop: 'status', value: 'done' }]);
		expect(store.page('roadmap')?.values.status).toBe('done');
		await expect(p).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
		expect(store.page('roadmap')?.values.status).toBe(before);
		expect(store.layerCount).toBe(0);
		expect(notices[0]).toMatchObject({ kind: 'error', title: 'That change was rejected', description: 'Unknown option' });
		store.dispose();
	});

	it('sends the same mutation again when the workspace answers busy (503), and only then keeps the edit', async () => {
		const { store, server, notices } = setup();
		await ready(store);
		store.openPage('roadmap');
		await vi.waitFor(() => expect(store.pageStatus('roadmap')).toBe('ready'));
		server.failNext = { code: 'SERVICE_UNAVAILABLE', message: 'This workspace is busy. Try again in a moment.' };
		const done = store.mutate([{ op: 'setProp', page: 'roadmap', prop: 'status', value: 'done' }]);
		// Busy once: the edit stays on screen, nothing is raised, and the second try goes through.
		const { seq } = await done;
		expect(seq).toBeGreaterThan(0);
		expect(notices).toEqual([]);
		await vi.waitFor(() => expect(store.layerCount).toBe(0));
		expect(store.page('roadmap')?.values.status).toBe('done');
		store.dispose();
	});

	it('refuses a value the registry rejects, before sending anything', async () => {
		const { store, server, notices } = setup();
		await ready(store);
		const sent = server.log.length;
		await expect(store.mutate([{ op: 'setProp', page: 'roadmap', prop: 'status', value: 'not-an-option' }])).rejects.toThrow();
		expect(server.log.length).toBe(sent);
		expect(notices.at(-1)?.kind).toBe('error');
		store.dispose();
	});

	it('applies a create and a trash optimistically', async () => {
		const { store, server } = setup();
		await ready(store);
		server.holdDelivery();
		const id = await store.createPage({ parentId: null, teamspaceId: 'ts_design', title: 'Moodboard' });
		expect(store.teamspaceRoots('ts_design').map((p) => p.title)).toEqual(['Brand guidelines', 'Moodboard']);
		server.releaseDelivery();
		await vi.waitFor(() => expect(store.layerCount).toBe(0));
		expect(store.page(id)?.title).toBe('Moodboard'); // the server's row now
		const t = store.mutate([{ op: 'trash', page: id }]);
		expect(store.page(id)).toBeUndefined();
		await t;
		await vi.waitFor(() => expect(store.layerCount).toBe(0));
		expect(store.page(id)).toBeUndefined();
		store.dispose();
	});

	it('sends one debounced setProp for a burst of title edits and shows the text at once', async () => {
		const { store, server } = setup();
		await ready(store);
		const before = server.log.length;
		store.setTitle('roadmap', 'R');
		store.setTitle('roadmap', 'Ro');
		store.setTitle('roadmap', 'Roadmap 2027');
		expect(store.page('roadmap')?.title).toBe('Roadmap 2027');
		expect(server.log.length).toBe(before);
		await vi.waitFor(() => expect(server.log.length).toBe(before + 1));
		expect(server.log.at(-1)?.ops).toEqual([{ op: 'setProp', page: 'roadmap', prop: TITLE_PROP_ID, value: 'Roadmap 2027' }]);
		await vi.waitFor(() => expect(store.layerCount).toBe(0));
		expect(store.page('roadmap')?.title).toBe('Roadmap 2027');
		store.dispose();
	});

	it('refuses property edits and new pages while offline', async () => {
		const { store, server, notices } = setup();
		await ready(store);
		store.status = 'offline';
		const sent = server.log.length;
		await expect(store.mutate([{ op: 'setProp', page: 'roadmap', prop: 'status', value: 'done' }])).rejects.toBeInstanceOf(OfflineError);
		await expect(store.createPage({ parentId: null })).rejects.toBeInstanceOf(OfflineError);
		store.setTitle('roadmap', 'Nope');
		expect(store.page('roadmap')?.title).toBe('Roadmap');
		expect(server.log.length).toBe(sent);
		expect(store.canEdit).toBe(false);
		expect(notices.length).toBe(3);
		store.dispose();
	});

	it('resends subscriptions and its last seq after a reconnect, and applies what it missed', async () => {
		const { store, server } = setup();
		await ready(store);
		store.expand('getting-started');
		await vi.waitFor(() => expect(store.branchState('getting-started')).toBe('ready'));
		const release = store.openPage('roadmap');
		await vi.waitFor(() => expect(store.pageStatus('roadmap')).toBe('ready'));
		const seqBefore = store.seq!;
		server.dropConnections(1006);
		await vi.waitFor(() => expect(store.status).toBe('connecting'));
		await vi.waitFor(() => expect(store.status).toBe('online'));
		const hellos = server.clientMessages.filter((m) => m.t === 'hello');
		expect(hellos).toHaveLength(2);
		expect(hellos[0]).toMatchObject({ lastSeq: null });
		expect(hellos[1]).toMatchObject({ lastSeq: seqBefore });
		const second = hellos[1] as Extract<(typeof hellos)[number], { t: 'hello' }>;
		expect(second.subs.map((s) => s.id).sort()).toEqual(['bl:roadmap', 'pg:roadmap', 'tree']);
		// Behind the log: the server answers with snapshots and the store converges.
		server.dropConnections(1006);
		server.commit([{ op: 'setProp', page: 'roadmap', prop: TITLE_PROP_ID, value: 'While you were away' }]);
		await vi.waitFor(() => expect(store.page('roadmap')?.title).toBe('While you were away'));
		release();
		store.dispose();
	});

	it('starts instantly from the IndexedDB cache and then confirms with the server', async () => {
		const first = setup();
		await ready(first.store);
		await vi.waitFor(() => expect(first.cache.data.size).toBe(1));
		await first.store.saveCache();
		first.store.dispose();
		const cached = first.cache.data.get(MOCK_WORKSPACE.id)!;
		expect(cached.tree.length).toBeGreaterThan(5);

		const server = new MockServer({ deliveryDelayMs: 0, rpcLatencyMs: 0, openDelayMs: 50 });
		server.holdDelivery(); // the socket never answers during this check
		const store = new WorkspaceStore({
			workspace: MOCK_WORKSPACE,
			user: MOCK_USER,
			rpc: createMockRpc(server),
			socketFactory: server.factory,
			cache: first.cache,
			storage: memoryStorage(),
			clock: fastClock
		});
		await store.start();
		expect(store.ready).toBe(true);
		expect(store.stale).toBe(true);
		expect(store.privateRoots().map((p) => p.title)).toEqual(['Getting started', 'Reading list']);
		expect(store.seq).toBe(cached.seq);
		server.releaseDelivery();
		await vi.waitFor(() => expect(store.stale).toBe(false));
		store.dispose();
		void MemoryCache;
	});

	it('keeps recents and favorites per user in storage', async () => {
		const storage = memoryStorage();
		const a = setup({ store: { storage } });
		a.store.visit('roadmap');
		a.store.visit('launch-plan');
		a.store.toggleFavorite('roadmap');
		expect(a.store.recent.map((r) => r.id)).toEqual(['launch-plan', 'roadmap']);
		const b = setup({ store: { storage } });
		await b.store.start();
		expect(b.store.recent.map((r) => r.id)).toEqual(['launch-plan', 'roadmap']);
		expect(b.store.isFavorite('roadmap')).toBe(true);
		a.store.dispose();
		b.store.dispose();
		await tick();
	});

	it('searches titles by prefix over the pages it knows', async () => {
		const { store } = setup();
		await ready(store);
		expect(store.searchPages('ro').map((p) => p.title)).toEqual(['Roadmap']);
		expect(store.searchPages('re').map((p) => p.title)).toEqual(['Reading list']);
		expect(store.searchPages('plan').map((p) => p.title)).toEqual(['Launch plan']); // a word prefix
		store.dispose();
	});
});
