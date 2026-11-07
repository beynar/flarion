/**
 * The workspace socket client: one WebSocket per tab to `/ws/:workspaceId`.
 *
 * - Speaks `src/lib/shared/protocol.ts`: a `hello` first (build, `lastSeq`, every subscription to
 *   restore), then snapshots, diffs and heads, which it hands to the store through `onMessage`.
 * - Reconnects with exponential backoff and jitter. Close codes go through `closeAction`:
 *   `reload` (build too old), `reauth` (session expired: refresh, then reconnect), `backoff`
 *   (rate limited or restarting: wait longer), `stop` (no access, workspace gone) and `reconnect`.
 * - Reports `online`, `connecting` or `offline` so the shell can drive entasis' network indicator
 *   and the store can disable property edits while offline.
 * - The transport is injectable (`TransportFactory`): the browser WebSocket in the app, the mock
 *   socket in `mock-socket.ts` for development and tests, with timers injectable through `clock`.
 * - Frames whose `t` is not a string belong to oRPC's WebSocket protocol; `rpcClient()` runs a v1
 *   `RPCLink` over the same connection for them.
 */
import { createORPCClient, type NestedClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import * as v from 'valibot';
import {
	closeAction,
	encodeClientMessage,
	serverMessageSchema,
	type ClientMessage,
	type ServerMessage,
	type SubscriptionEntry
} from '#lib/shared/protocol.ts';

export type SocketStatus = 'connecting' | 'online' | 'offline';

/** The slice of the WebSocket API the client uses. The browser WebSocket satisfies it. */
export interface Transport {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev?: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: ((ev: { code: number; reason?: string }) => void) | null;
	onerror: ((ev?: unknown) => void) | null;
}
export type TransportFactory = (url: string) => Transport;

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSED = 3;

export interface Clock {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	random(): number;
}
export const realClock: Clock = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	random: () => Math.random()
};

export interface BackoffOptions {
	baseMs: number;
	capMs: number;
	/** Floor used after a `backoff` close (rate limited, restarting). */
	slowMs: number;
}
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, capMs: 30_000, slowMs: 5_000 };

/** "Equal jitter": half the exponential delay, plus a random half. */
export function backoffDelay(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF, random = Math.random): number {
	const exp = Math.min(opts.capMs, opts.baseMs * 2 ** Math.min(attempt, 20));
	return Math.round(exp / 2 + random() * (exp / 2));
}

export interface HelloState {
	/** The position to resume from, or null for a fresh start. */
	lastSeq: number | null;
	/** Subscriptions the store still holds state for (restored by the server's replay). */
	subs: SubscriptionEntry[];
	/** Sent right after `hello`: subscribe frames for subscriptions the store holds no state for. */
	extra?: ClientMessage[];
}

export type FatalAction = 'reload' | 'reauth' | 'stop';

export interface SocketOptions {
	url: string | (() => string);
	appVersion: string;
	kindsVersion?: number;
	clientId: string;
	factory?: TransportFactory;
	clock?: Clock;
	backoff?: Partial<BackoffOptions>;
	/** Heartbeat: a `ping` this often while online, a reconnect if nothing answers within `timeout`. */
	heartbeatMs?: number;
	heartbeatTimeoutMs?: number;
	hello(): HelloState;
	onMessage(msg: ServerMessage): void;
	onStatus?(status: SocketStatus, info: { attempt: number; retryInMs: number | null; reason?: string }): void;
	/** The socket will not reconnect by itself. */
	onFatal?(action: FatalAction, code: number, reason: string): void;
	/** Refresh the session; resolves true when a reconnect is worth trying. */
	reauth?(): Promise<boolean>;
	/** Listen to `online`, `offline` and `visibilitychange` on the window. Default true when there is one. */
	watchNetwork?: boolean;
}

const browserFactory: TransportFactory = (url) => new WebSocket(url) as unknown as Transport;

/** `wss://host/ws/<id>` for the page's own origin. */
export function workspaceSocketUrl(workspaceId: string, appVersion: string): string {
	const u = new URL(`/ws/${encodeURIComponent(workspaceId)}`, window.location.href);
	u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
	// Browsers cannot set headers on a WebSocket: the build travels in the query string.
	u.searchParams.set('v', appVersion);
	return u.toString();
}

export class WorkspaceSocket {
	readonly #o: SocketOptions;
	readonly #clock: Clock;
	readonly #backoff: BackoffOptions;
	#ws: Transport | null = null;
	#generation = 0;
	#status: SocketStatus = 'offline';
	#attempt = 0;
	#retryTimer: unknown = null;
	#beat: unknown = null;
	#beatDeadline: unknown = null;
	#reauthFailures = 0;
	#disposed = false;
	#started = false;
	#stopped = false;
	#rpcFacade: RpcFacade | null = null;
	#rpcLink: RPCLink<Record<never, never>> | null = null;
	#detachWindow: (() => void) | null = null;

	constructor(options: SocketOptions) {
		this.#o = options;
		this.#clock = options.clock ?? realClock;
		this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
	}

	get status(): SocketStatus {
		return this.#status;
	}
	get attempt(): number {
		return this.#attempt;
	}
	/** True while a frame can be sent. */
	get isOpen(): boolean {
		return this.#ws?.readyState === WS_OPEN;
	}

	/** Connects, and keeps the connection alive until `dispose()`. */
	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		if (this.#o.watchNetwork ?? typeof window !== 'undefined') this.#watchWindow();
		if (typeof navigator !== 'undefined' && navigator.onLine === false) this.#setStatus('offline', 'navigator offline');
		else this.#connect();
	}

	/** Sends one protocol frame; false when the socket is not open (the registry resends on reconnect). */
	send(msg: ClientMessage): boolean {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WS_OPEN) return false;
		try {
			ws.send(encodeClientMessage(msg));
			return true;
		} catch {
			return false;
		}
	}

	/** Drops the connection (if any) and connects again at once, resetting the backoff. */
	reconnectNow(): void {
		if (this.#disposed) return;
		this.#attempt = 0;
		this.#stopped = false;
		this.#teardown(1000, 'reconnect');
		this.#clearRetry();
		this.#connect();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#clearRetry();
		this.#detachWindow?.();
		this.#teardown(1000, 'dispose');
		this.#status = 'offline';
	}

	/** An oRPC client over this socket's connection (oRPC frames are the ones with a numeric `t`). */
	rpcClient<T extends NestedClient<any>>(): T {
		return createORPCClient<T>({
			call: (path: readonly string[], input: unknown, options: never) => this.#currentRpcLink().call(path, input, options)
		} as never);
	}

	// ───────────────────────────── connection ─────────────────────────────

	#connect(): void {
		if (this.#disposed) return;
		this.#clearRetry();
		this.#setStatus('connecting');
		const generation = ++this.#generation;
		const url = typeof this.#o.url === 'function' ? this.#o.url() : this.#o.url;
		let ws: Transport;
		try {
			ws = (this.#o.factory ?? browserFactory)(url);
		} catch {
			this.#scheduleRetry('slow');
			return;
		}
		this.#ws = ws;
		this.#rpcFacade = new RpcFacade(ws);
		this.#rpcLink = null;
		ws.onopen = () => {
			if (generation !== this.#generation) return;
			this.#rpcFacade?.dispatch('open', {});
			const hello = this.#o.hello();
			this.send({
				t: 'hello',
				appVersion: this.#o.appVersion,
				kindsVersion: this.#o.kindsVersion,
				clientId: this.#o.clientId,
				lastSeq: hello.lastSeq,
				subs: hello.subs
			});
			for (const m of hello.extra ?? []) this.send(m);
		};
		ws.onmessage = (ev) => {
			if (generation !== this.#generation) return;
			this.#onFrame(ev.data);
		};
		ws.onerror = () => {
			// A close always follows; it carries the code.
		};
		ws.onclose = (ev) => {
			if (generation !== this.#generation) return;
			this.#onClosed(ev.code, ev.reason ?? '');
		};
	}

	#onFrame(data: unknown): void {
		try {
			this.#route(data);
		} finally {
			this.#armHeartbeat();
		}
	}

	#route(data: unknown): void {
		if (typeof data === 'string') {
			let obj: unknown;
			try {
				obj = JSON.parse(data);
			} catch {
				this.#rpcFacade?.dispatch('message', { data });
				return;
			}
			const t = (obj as { t?: unknown } | null)?.t;
			if (typeof t !== 'string') {
				this.#rpcFacade?.dispatch('message', { data });
				return;
			}
			const parsed = v.safeParse(serverMessageSchema, obj);
			if (!parsed.success) {
				console.warn('[socket] dropped an invalid frame', parsed.issues[0]?.message);
				return;
			}
			this.#handle(parsed.output);
		} else {
			this.#rpcFacade?.dispatch('message', { data });
		}
	}

	#handle(msg: ServerMessage): void {
		if (msg.t === 'welcome') {
			this.#attempt = 0;
			this.#reauthFailures = 0;
			this.#setStatus('online');
		}
		this.#o.onMessage(msg);
	}

	#onClosed(code: number, reason: string): void {
		this.#stopBeat();
		this.#rpcFacade?.dispatch('close', { code, reason });
		this.#ws = null;
		if (this.#disposed) return;
		const action = closeAction(code);
		switch (action) {
			case 'reload':
				this.#stopped = true;
				this.#setStatus('offline', 'reload');
				this.#o.onFatal?.('reload', code, reason);
				return;
			case 'stop':
				this.#stopped = true;
				this.#setStatus('offline', 'stop');
				this.#o.onFatal?.('stop', code, reason);
				return;
			case 'reauth':
				void this.#reauth(code, reason);
				return;
			case 'backoff':
				this.#scheduleRetry('slow');
				return;
			default:
				this.#scheduleRetry('normal');
		}
	}

	async #reauth(code: number, reason: string): Promise<void> {
		this.#setStatus('connecting', 'reauth');
		let ok = false;
		try {
			ok = (await this.#o.reauth?.()) ?? false;
		} catch {
			ok = false;
		}
		if (this.#disposed) return;
		if (ok && ++this.#reauthFailures <= 2) {
			this.#connect();
			return;
		}
		this.#stopped = true;
		this.#setStatus('offline', 'reauth');
		this.#o.onFatal?.('reauth', code, reason);
	}

	#scheduleRetry(mode: 'normal' | 'slow'): void {
		if (this.#disposed || this.#stopped) return;
		let delay = backoffDelay(this.#attempt, this.#backoff, this.#clock.random);
		if (mode === 'slow') delay = Math.max(delay, this.#backoff.slowMs + Math.round(this.#clock.random() * this.#backoff.slowMs));
		this.#attempt++;
		this.#setStatus('connecting', undefined, delay);
		this.#clearRetry();
		this.#retryTimer = this.#clock.setTimeout(() => {
			this.#retryTimer = null;
			this.#connect();
		}, delay);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== null) this.#clock.clearTimeout(this.#retryTimer);
		this.#retryTimer = null;
	}

	/** Closes the current transport without triggering the reconnect logic. */
	#teardown(code: number, reason: string): void {
		this.#stopBeat();
		const ws = this.#ws;
		this.#generation++;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(code, reason);
			} catch {
				// already closed
			}
			this.#rpcFacade?.dispatch('close', { code, reason });
		}
	}

	#setStatus(status: SocketStatus, reason?: string, retryInMs: number | null = null): void {
		this.#status = status;
		this.#o.onStatus?.(status, { attempt: this.#attempt, retryInMs, reason });
	}

	// ───────────────────────────── heartbeat ─────────────────────────────

	#armHeartbeat(): void {
		const every = this.#o.heartbeatMs ?? 25_000;
		if (!every) return;
		this.#stopBeat();
		if (this.#status !== 'online') return;
		this.#beat = this.#clock.setTimeout(() => {
			this.#beat = null;
			if (!this.send({ t: 'ping' })) return;
			this.#beatDeadline = this.#clock.setTimeout(() => {
				this.#beatDeadline = null;
				// Nothing answered: the connection is dead even if the browser has not noticed.
				this.#teardown(4000, 'heartbeat timeout');
				this.#scheduleRetry('normal');
			}, this.#o.heartbeatTimeoutMs ?? 10_000);
		}, every);
	}

	#stopBeat(): void {
		if (this.#beat !== null) this.#clock.clearTimeout(this.#beat);
		if (this.#beatDeadline !== null) this.#clock.clearTimeout(this.#beatDeadline);
		this.#beat = this.#beatDeadline = null;
	}

	// ───────────────────────────── window events ─────────────────────────────

	#watchWindow(): void {
		if (typeof window === 'undefined') return;
		const online = () => {
			if (this.#disposed || this.#stopped) return;
			if (this.#status !== 'online') this.reconnectNow();
		};
		const offline = () => {
			if (this.#disposed) return;
			this.#clearRetry();
			this.#teardown(1000, 'offline');
			this.#setStatus('offline', 'navigator offline');
		};
		const visible = () => {
			if (document.visibilityState === 'visible' && this.#status !== 'online' && !this.#stopped) online();
		};
		window.addEventListener('online', online);
		window.addEventListener('offline', offline);
		document.addEventListener('visibilitychange', visible);
		this.#detachWindow = () => {
			window.removeEventListener('online', online);
			window.removeEventListener('offline', offline);
			document.removeEventListener('visibilitychange', visible);
		};
	}

	// ───────────────────────────── oRPC over the same socket ─────────────────────────────

	#currentRpcLink(): RPCLink<Record<never, never>> {
		if (!this.#rpcFacade) throw new Error('The workspace socket is not connected');
		return (this.#rpcLink ??= new RPCLink({ websocket: this.#rpcFacade as never }));
	}
}

/**
 * What oRPC's WebSocket link needs from a socket, bound to one connection. Protocol frames never
 * reach it; its own frames (a numeric `t`, or binary) do.
 */
class RpcFacade {
	readonly #listeners = new Map<string, Set<(ev: unknown) => void>>();
	readonly #ws: Transport;
	constructor(ws: Transport) {
		this.#ws = ws;
	}
	get readyState(): number {
		return this.#ws.readyState;
	}
	send(data: string): void {
		this.#ws.send(data);
	}
	addEventListener(type: string, fn: (ev: unknown) => void, opts?: { once?: boolean }): void {
		const set = this.#listeners.get(type) ?? new Set();
		this.#listeners.set(type, set);
		if (opts?.once) {
			const once = (ev: unknown) => {
				set.delete(once);
				fn(ev);
			};
			set.add(once);
		} else set.add(fn);
	}
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		this.#listeners.get(type)?.delete(fn);
	}
	dispatch(type: 'open' | 'close' | 'message', ev: unknown): void {
		for (const fn of [...(this.#listeners.get(type) ?? [])]) fn(ev);
	}
}

export { browserFactory };
