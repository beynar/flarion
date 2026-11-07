import { MemoryCache } from '#lib/client/idb.ts';
import { MockServer, MOCK_USER, MOCK_WORKSPACE, createMockRpc, type MockServerOptions } from '#lib/client/mock-socket.ts';
import { WorkspaceStore, type Toasty, type WorkspaceStoreOptions } from '#lib/client/workspace.svelte.ts';
import type { Clock } from '#lib/client/socket.ts';
import type { PageRow, ServerMessage, TreeRow } from '#lib/shared/protocol.ts';

export const fastClock: Clock = {
	setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	random: () => 0
};

export function memoryStorage() {
	const data = new Map<string, string>();
	return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

export function setup(opts: { server?: MockServerOptions; store?: Partial<WorkspaceStoreOptions> } = {}) {
	const server = new MockServer({ deliveryDelayMs: 0, rpcLatencyMs: 0, openDelayMs: 0, ...opts.server });
	const rpc = createMockRpc(server);
	const notices: Toasty[] = [];
	const cache = new MemoryCache();
	const store = new WorkspaceStore({
		workspace: MOCK_WORKSPACE,
		user: MOCK_USER,
		rpc,
		socketFactory: server.factory,
		cache,
		notify: (t) => notices.push(t),
		storage: memoryStorage(),
		appVersion: 'dev',
		titleDebounceMs: 10,
		cacheDebounceMs: 5,
		clock: fastClock,
		...opts.store
	});
	return { server, rpc, store, notices, cache };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export function treeRow(id: string, parentId: string | null, rank: string, title = id, extra: Partial<TreeRow> = {}): TreeRow {
	return { id, parentId, rank, title, icon: null, isDatabase: false, teamspaceId: null, hasChildren: false, access: 'full', ...extra };
}

export function pageRow(id: string, extra: Partial<PageRow> = {}): PageRow {
	return {
		...treeRow(id, null, '01', id),
		cover: null,
		values: { title: id },
		createdBy: 'u_ada',
		createdAt: '2026-01-01T00:00:00Z',
		updatedBy: 'u_ada',
		updatedAt: '2026-01-01T00:00:00Z',
		...extra
	};
}

export const snapshot = (id: string, rows: TreeRow[], seq: number): ServerMessage => ({ t: 'snapshot', kind: 'tree', id, rows, total: rows.length, seq });
