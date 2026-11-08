/**
 * The server render hands the store its first screen (`WorkspaceStore.seed`, `src/server/ssr/`): what is seeded is on screen with no
 * message, a `subscribe` for a seeded window is a claim and not a request, and the socket's `hello` resumes at the seeded position.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockServer, MOCK_USER, MOCK_WORKSPACE, createMockRpc } from '#lib/client/mock-socket.ts';
import { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
import type { StoreSeed } from '#lib/shared/seed.ts';
import { subKey } from '#lib/shared/sub-key.ts';
import { fastClock, memoryStorage, pageRow, treeRow } from './helpers.ts';

const treeSub = { kind: 'tree' as const, parents: [null, 'a'] };
const seedOf = (seq = 10): StoreSeed => ({
	windows: [
		{
			id: 'tree',
			sub: treeSub,
			snapshot: { t: 'snapshot', kind: 'tree', id: 'tree', total: 3, seq, rows: [treeRow('a', null, '01', 'Alpha', { hasChildren: true }), treeRow('b', null, '02', 'Beta'), treeRow('a1', 'a', '01', 'Child')] }
		},
		{
			id: subKey('pg', 'b'),
			sub: { kind: 'page', pageIds: ['b'] },
			snapshot: { t: 'snapshot', kind: 'page', id: subKey('pg', 'b'), total: 1, seq: seq + 2, rows: [pageRow('b', { title: 'Beta', values: { title: 'Beta' } })] }
		}
	],
	expanded: ['a'],
	prefs: { favorites: ['b'], recent: [{ id: 'b', at: 1_700_000_000_000 }] }
});

function build(options: { renderingOnServer?: boolean } = {}) {
	const server = new MockServer({ deliveryDelayMs: 0, rpcLatencyMs: 0, openDelayMs: 0 });
	const rpc = createMockRpc(server);
	const reads = [vi.spyOn(rpc.property, 'list'), vi.spyOn(rpc.workspace.members, 'list'), vi.spyOn(rpc.workspace.teamspaces, 'list')];
	const store = new WorkspaceStore({
		workspace: MOCK_WORKSPACE,
		user: MOCK_USER,
		rpc,
		socketFactory: server.factory,
		cache: null,
		storage: memoryStorage(),
		appVersion: 'dev',
		clock: fastClock,
		...options
	});
	return { server, store, rpcCalls: () => reads.reduce((n, spy) => n + spy.mock.calls.length, 0) };
}

describe('seeding the store from the server render', () => {
	it('puts the sidebar, the open branches and the page on screen with no message', () => {
		const { store, server } = build({ renderingOnServer: true });
		store.seed(seedOf());
		expect(store.ready).toBe(true);
		expect(store.stale).toBe(false);
		expect(store.seq).toBe(10);
		expect(store.children(null).map((p) => p.title)).toEqual(['Alpha', 'Beta']);
		expect(store.children('a').map((p) => p.title)).toEqual(['Child']);
		expect([...store.expanded]).toEqual(['a']);
		expect(store.branchState('a')).toBe('ready');
		expect(store.pageStatus('b')).toBe('ready');
		expect(store.page('b')?.partial).toBe(false);
		expect(store.favorites).toEqual(['b']);
		expect(store.recent).toEqual([{ id: 'b', at: 1_700_000_000_000 }]);
		expect(server.clientMessages).toEqual([]);
	});

	it('resumes the socket at the oldest seeded position with the seeded windows, and never asks for them again', async () => {
		const { store, server } = build();
		store.seed(seedOf(server.seq));
		// The page's component subscribes (its effect runs before the layout's, which starts the store): a claim, not a request.
		const release = store.subscribe(subKey('pg', 'b'), { kind: 'page', pageIds: ['b'] });
		await store.start();
		await vi.waitFor(() => expect(store.status).toBe('online'));
		const hello = server.clientMessages.find((m) => m.t === 'hello');
		expect(hello).toMatchObject({ t: 'hello', lastSeq: server.seq });
		expect((hello as { subs: { id: string }[] }).subs.map((s) => s.id).sort()).toEqual(['pg:b', 'tree']);
		expect(server.clientMessages.filter((m) => m.t === 'subscribe')).toEqual([]);
		// The window stayed ready throughout: no flash of an empty page.
		expect(store.pageStatus('b')).toBe('ready');
		release();
		store.dispose();
	});

	it('does not read the registry or the directory when the server render has them, and skips the cache', async () => {
		const { store, rpcCalls, server } = build();
		store.seed({ ...seedOf(server.seq), properties: [], members: [], teamspaces: { list: [], ranks: {} } });
		await store.start();
		await vi.waitFor(() => expect(store.status).toBe('online'));
		expect(rpcCalls()).toBe(0);
		store.dispose();
	});

	it('subscribes normally when the subscription differs from the seeded one', async () => {
		const { store, server } = build();
		store.seed(seedOf(server.seq));
		await store.start();
		await vi.waitFor(() => expect(store.status).toBe('online'));
		const release = store.subscribe(subKey('pg', 'b'), { kind: 'page', pageIds: ['b', 'a'] });
		expect(server.clientMessages.filter((m) => m.t === 'subscribe')).toHaveLength(1);
		release();
		store.dispose();
	});

	it('drops a seeded window nobody subscribed to when the socket says hello (the server holds none of it)', async () => {
		const { store, server } = build();
		store.seed(seedOf(server.seq));
		await store.start();
		await vi.waitFor(() => expect(store.status).toBe('online'));
		expect(store.windows.has(subKey('pg', 'b'))).toBe(false);
		store.dispose();
	});

	it('reads the registry and the directory again when the log moved on between the render and the first welcome', async () => {
		const { store, rpcCalls, server } = build();
		store.seed({ ...seedOf(server.seq - 5), properties: [], members: [], teamspaces: { list: [], ranks: {} } });
		await store.start();
		await vi.waitFor(() => expect(rpcCalls()).toBe(3));
		store.dispose();
	});

	it('leaves a window the store holds at the same position or later alone', () => {
		const { store } = build({ renderingOnServer: true });
		store.seed(seedOf(10));
		const held = store.windows.get('tree');
		store.seed(seedOf(10));
		expect(store.windows.get('tree')).toBe(held);
	});

	it('schedules nothing while rendering on the server', () => {
		const { store } = build({ renderingOnServer: true });
		store.seed(seedOf());
		// a page in a teamspace the directory does not list would normally schedule a directory read (a timer and a request)
		store.receive({ t: 'registry', scopes: ['properties', 'directory', 'collections'], seq: 20 });
		store.expand('b');
		store.dispose();
	});
});

describe('a window read earlier stays current across a head', () => {
	it('moves a held window to the head, so a resize answered at the head is applied, not taken for a duplicate', () => {
		const { store } = build({ renderingOnServer: true });
		store.seed(seedOf(10));
		const release = store.subscribe(subKey('pg', 'b'), { kind: 'page', pageIds: ['b'] });
		expect(store.windows.get(subKey('pg', 'b'))?.seq).toBe(12);
		store.receive({ t: 'head', seq: 20 });
		expect(store.windows.get(subKey('pg', 'b'))?.seq).toBe(20);
		expect(store.windows.get('tree')?.seq).toBe(20);
		release();
	});
});
