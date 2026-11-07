import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE, type ClientMessage, type ServerMessage } from '#lib/shared/protocol.ts';
import { backoffDelay, DEFAULT_BACKOFF, WorkspaceSocket, WS_CLOSED, WS_OPEN, type SocketStatus, type Transport } from '#lib/client/socket.ts';
import { MockServer, diffRows } from '#lib/client/mock-socket.ts';
import { treeRow } from './helpers.ts';

describe('backoffDelay', () => {
	it('grows exponentially with jitter and is capped', () => {
		const lo = (n: number) => backoffDelay(n, DEFAULT_BACKOFF, () => 0);
		const hi = (n: number) => backoffDelay(n, DEFAULT_BACKOFF, () => 1);
		expect(lo(0)).toBe(250);
		expect(hi(0)).toBe(500);
		expect(lo(1)).toBe(500);
		expect(hi(1)).toBe(1000);
		expect(lo(3)).toBe(2000);
		expect(hi(30)).toBe(DEFAULT_BACKOFF.capMs);
		expect(lo(30)).toBe(DEFAULT_BACKOFF.capMs / 2);
		for (let i = 0; i < 50; i++) {
			const d = backoffDelay(4);
			expect(d).toBeGreaterThanOrEqual(4000);
			expect(d).toBeLessThanOrEqual(8000);
		}
	});
});

describe('WorkspaceSocket', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function make(server: MockServer, extra: Partial<ConstructorParameters<typeof WorkspaceSocket>[0]> = {}) {
		const statuses: SocketStatus[] = [];
		const messages: ServerMessage[] = [];
		const fatal: string[] = [];
		const state = { lastSeq: null as number | null };
		const socket = new WorkspaceSocket({
			url: 'ws://test/ws/ws_acme',
			appVersion: 'dev',
			clientId: 'c1',
			factory: server.factory,
			clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as never), random: () => 0.5 },
			hello: () => ({ lastSeq: state.lastSeq, subs: [{ id: 'tree', sub: { kind: 'tree', parents: [null] } }] }),
			onMessage: (m) => {
				messages.push(m);
				if (m.t === 'snapshot') state.lastSeq = m.seq;
			},
			onStatus: (s) => statuses.push(s),
			onFatal: (a) => fatal.push(a),
			watchNetwork: false,
			heartbeatMs: 0,
			...extra
		});
		return { socket, statuses, messages, fatal, state };
	}

	it('says hello, goes online on welcome and delivers snapshots', async () => {
		const server = new MockServer({ deliveryDelayMs: 0, openDelayMs: 0 });
		const { socket, statuses, messages } = make(server);
		socket.start();
		await vi.advanceTimersByTimeAsync(5);
		expect(statuses[0]).toBe('connecting');
		expect(socket.status).toBe('online');
		expect(server.clientMessages[0]).toMatchObject({ t: 'hello', appVersion: 'dev', clientId: 'c1', lastSeq: null, subs: [{ id: 'tree' }] });
		expect(messages.map((m) => m.t)).toEqual(['welcome', 'snapshot']);
		socket.dispose();
	});

	it('reconnects with growing delays, then resends hello with the last seq', async () => {
		const server = new MockServer({ deliveryDelayMs: 0, openDelayMs: 0 });
		const { socket, state } = make(server);
		socket.start();
		await vi.advanceTimersByTimeAsync(5);
		expect(state.lastSeq).toBe(server.seq);

		server.rejectWith = 1006; // every new connection fails
		server.dropConnections(1006);
		const delays: number[] = [];
		let last = server.connections;
		for (let step = 0; step < 4; step++) {
			const t0 = Date.now();
			while (server.connections === last && Date.now() - t0 < 40_000) await vi.advanceTimersByTimeAsync(50);
			delays.push(Math.round((Date.now() - t0) / 100) * 100);
			last = server.connections;
			await vi.advanceTimersByTimeAsync(1);
		}
		// random() is 0.5: delay = 0.75 * min(cap, 500 * 2^attempt)
		expect(delays[1]).toBeGreaterThan(delays[0]);
		expect(delays[2]).toBeGreaterThan(delays[1]);
		expect(delays[3]).toBeGreaterThan(delays[2]);
		expect(socket.status).toBe('connecting');

		server.rejectWith = null;
		await vi.advanceTimersByTimeAsync(40_000);
		expect(socket.status).toBe('online');
		const hellos = server.clientMessages.filter((m): m is Extract<ClientMessage, { t: 'hello' }> => m.t === 'hello');
		expect(hellos.at(-1)).toMatchObject({ lastSeq: state.lastSeq, subs: [{ id: 'tree' }] });
		expect(socket.attempt).toBe(0);
		socket.dispose();
	});

	it('reloads (no reconnect) when the build is too old', async () => {
		const server = new MockServer({ deliveryDelayMs: 0, openDelayMs: 0 });
		const { socket, fatal } = make(server);
		socket.start();
		await vi.advanceTimersByTimeAsync(5);
		server.dropConnections(CLOSE.RELOAD_REQUIRED);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fatal).toEqual(['reload']);
		expect(server.connections).toBe(1);
		expect(socket.status).toBe('offline');
		socket.dispose();
	});

	it('stops for access and workspace-gone closes', async () => {
		for (const code of [CLOSE.FORBIDDEN, CLOSE.WORKSPACE_GONE]) {
			const server = new MockServer({ deliveryDelayMs: 0, openDelayMs: 0 });
			const { socket, fatal } = make(server);
			socket.start();
			await vi.advanceTimersByTimeAsync(5);
			server.dropConnections(code);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(fatal).toEqual(['stop']);
			expect(server.connections).toBe(1);
			socket.dispose();
		}
	});

	it('refreshes the session on 4401 and reconnects at once; gives up when it cannot', async () => {
		const server = new MockServer({ deliveryDelayMs: 0, openDelayMs: 0 });
		let ok = true;
		const reauth = vi.fn(async () => ok);
		const { socket, fatal } = make(server, { reauth });
		socket.start();
		await vi.advanceTimersByTimeAsync(5);
		server.dropConnections(CLOSE.AUTH_EXPIRED);
		await vi.advanceTimersByTimeAsync(5);
		expect(reauth).toHaveBeenCalledTimes(1);
		expect(server.connections).toBe(2);
		expect(socket.status).toBe('online');
		ok = false;
		server.dropConnections(CLOSE.AUTH_EXPIRED);
		await vi.advanceTimersByTimeAsync(5);
		expect(fatal).toEqual(['reauth']);
		expect(server.connections).toBe(2);
		socket.dispose();
	});

	it('waits longer after a rate-limit or restart close', async () => {
		const server = new MockServer({ deliveryDelayMs: 0, openDelayMs: 0 });
		const { socket } = make(server);
		socket.start();
		await vi.advanceTimersByTimeAsync(5);
		server.dropConnections(CLOSE.RATE_LIMITED);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(server.connections).toBe(1); // still waiting: at least slowMs
		await vi.advanceTimersByTimeAsync(11_000);
		expect(server.connections).toBe(2);
		socket.dispose();
	});

	it('reconnects when pings go unanswered', async () => {
		const server = new MockServer({ deliveryDelayMs: 0, openDelayMs: 0 });
		const { socket, statuses } = make(server, { heartbeatMs: 1000, heartbeatTimeoutMs: 500 });
		socket.start();
		await vi.advanceTimersByTimeAsync(5);
		expect(socket.status).toBe('online');
		// Swallow pongs: the connection looks open but is dead.
		for (const s of server.sockets) {
			const original = s.push.bind(s);
			s.push = (m) => (m.t === 'pong' ? undefined : original(m));
		}
		await vi.advanceTimersByTimeAsync(1600);
		expect(statuses.at(-1)).toBe('connecting');
		await vi.advanceTimersByTimeAsync(2000);
		expect(server.connections).toBe(2);
		expect(socket.status).toBe('online');
		socket.dispose();
	});

	it('is injectable: it runs on any transport', async () => {
		const sent: string[] = [];
		let t!: Transport & { fire(data: unknown): void };
		const factory = () => {
			const tr: Transport & { fire(data: unknown): void } = {
				readyState: WS_OPEN,
				send: (d) => void sent.push(d),
				close: () => void ((tr as { readyState: number }).readyState = WS_CLOSED),
				onopen: null,
				onmessage: null,
				onclose: null,
				onerror: null,
				fire(data) {
					tr.onmessage?.({ data });
				}
			};
			t = tr;
			queueMicrotask(() => tr.onopen?.());
			return tr;
		};
		const got: ServerMessage[] = [];
		const socket = new WorkspaceSocket({
			url: 'x',
			appVersion: '1.0.0',
			clientId: 'c',
			factory,
			hello: () => ({ lastSeq: 7, subs: [] }),
			onMessage: (m) => got.push(m),
			watchNetwork: false,
			heartbeatMs: 0
		});
		socket.start();
		await vi.advanceTimersByTimeAsync(1);
		expect(JSON.parse(sent[0])).toMatchObject({ t: 'hello', lastSeq: 7, appVersion: '1.0.0' });
		t.fire(JSON.stringify({ t: 'welcome', protocol: 1, appVersion: '1', minAppVersion: '0', kindsVersion: 1, userId: 'u', seq: 7 }));
		t.fire('{"t":"nonsense"}'); // invalid frames are dropped
		t.fire(JSON.stringify({ i: '1', t: 2, p: {} })); // oRPC frames are not ours
		expect(got.map((m) => m.t)).toEqual(['welcome']);
		expect(socket.status).toBe('online');
		socket.dispose();
	});
});

describe('diffRows (the mock server)', () => {
	it('emits removes, adds, moves, updates and counts', () => {
		const a = treeRow('a', null, '01');
		const b = treeRow('b', null, '02');
		const c = treeRow('c', null, '03');
		const ops = diffRows([a, b, c], [{ ...c, rank: '00' }, { ...a, title: 'A!' }, treeRow('d', null, '04')]);
		expect(ops).toEqual([
			{ op: 'remove', id: 'b' },
			{ op: 'move', id: 'c', index: 0 },
			{ op: 'update', id: 'c', prop: '$rank', value: '00' },
			{ op: 'update', id: 'a', prop: 'title', value: 'A!' },
			{ op: 'add', index: 2, row: treeRow('d', null, '04') }
		]);
		expect(diffRows([a], [a, b, c]).at(-1)).toEqual({ op: 'count', total: 3 });
	});
});
