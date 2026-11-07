import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import type { RouterClient } from '@orpc/server';
import { env, SELF } from 'cloudflare:test';
import { vi } from 'vitest';
import { encodeClientMessage, type ClientMessage, type ServerMessage, type SubscriptionEntry } from '../../../src/lib/shared/protocol';
import type { WorkspaceSocketRouter } from '../../../src/server/objects/workspace/socket-router';
import type { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';

const testEnv = env as unknown as Env;
export const ORIGIN = 'http://localhost:5173';

export function upgradeRequest(workspaceId: string, headers: Record<string, string> = {}, query = '') {
	return SELF.fetch(`http://example.com/ws/${workspaceId}${query}`, {
		headers: { Upgrade: 'websocket', Origin: ORIGIN, 'x-flarion-dev-actor': 'user-1', 'x-app-version': '0.0.1', ...headers }
	});
}

/**
 * Everything the server pushes on a socket's stream, in order: raw protocol frames (`{ "t": "snapshot", ... }`)
 * and the event frames of an oRPC `hello` iterator (`{ i, t: 3, p: { d: { json } } }`, what oRPC's client
 * decodes). It reads the raw socket instead of iterating the client's async iterator, so a server-initiated
 * close leaves no pending `next()` behind.
 */
export class StreamLog {
	readonly messages: ServerMessage[] = [];

	constructor(ws: WebSocket) {
		ws.addEventListener('message', (event) => {
			if (typeof event.data !== 'string') return;
			try {
				const frame = JSON.parse(event.data) as { t?: number | string; p?: { e?: string; d?: { json?: ServerMessage } } };
				// A raw protocol frame (string `t`) is the message itself; an oRPC event frame (`t: 3`) wraps it.
				if (typeof frame.t === 'string') this.messages.push(frame as unknown as ServerMessage);
				else if (frame.t === 3 && frame.p?.e === 'message' && frame.p.d?.json) this.messages.push(frame.p.d.json);
			} catch {
				// not ours
			}
		});
	}

	of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
		return this.messages.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
	}

	/** Resolves with the first message after `from` (an index into `messages`) that satisfies `test`. */
	async wait(test: (m: ServerMessage) => boolean, from = 0): Promise<ServerMessage> {
		let found: ServerMessage | undefined;
		await vi.waitFor(
			() => {
				found = this.messages.slice(from).find(test);
				if (!found) throw new Error(`no matching message among ${this.messages.length}`);
			},
			{ timeout: 3000, interval: 10 }
		);
		return found as ServerMessage;
	}

	/** Lets pending frames arrive, then returns how many messages there are. */
	async settle(): Promise<number> {
		await new Promise((r) => setTimeout(r, 40));
		return this.messages.length;
	}
}

/** A socket view that delivers only oRPC frames (a numeric `t`, or anything that is not a protocol frame). */
function oRpcOnly(ws: WebSocket) {
	return {
		get readyState() {
			return ws.readyState;
		},
		send: (data: string) => ws.send(data),
		addEventListener(type: string, listener: (event: any) => void, options?: unknown) {
			if (type !== 'message') return ws.addEventListener(type as 'close', listener, options as never);
			ws.addEventListener('message', (event) => {
				if (typeof event.data === 'string' && /^\s*\{\s*"t"\s*:\s*"/.test(event.data)) return;
				listener(event);
			});
		},
		removeEventListener: (type: string, listener: (event: any) => void) => ws.removeEventListener(type as 'close', listener)
	};
}

export interface Connection {
	ws: WebSocket;
	readonly client: RouterClient<WorkspaceSocketRouter>;
	closed: Promise<{ code: number; reason: string }>;
	/** Everything pushed on this socket's stream since it opened. */
	log: StreamLog;
	/** Sends a protocol message as a raw JSON frame. */
	send(message: ClientMessage): void;
	/** Sends `hello` as a raw protocol frame (what the app's socket client does); messages land in `log`. */
	rawHello(options?: { lastSeq?: number | null; subs?: SubscriptionEntry[]; appVersion?: string; clientId?: string }): StreamLog;
	/** Sends `hello` through the oRPC procedure; the stream's messages land in `log`. */
	hello(options?: { lastSeq?: number | null; subs?: SubscriptionEntry[]; appVersion?: string; clientId?: string }): Promise<StreamLog>;
}

/** Opens `/ws/:workspaceId` through the Worker route and wraps the socket in the oRPC v1 WebSocket link. */
export async function connect(workspaceId: string, headers: Record<string, string> = {}): Promise<Connection> {
	// A real caller is a workspace member the Accounts track mirrored into the object (`syncMember`); the dev
	// actor of a test is made one unless the workspace already knows them, so the policy has a user to judge.
	const devUser = headers['x-flarion-dev-actor'] ?? 'user-1';
	if (devUser && (await workspaceStub(workspaceId).getMemberRole(devUser)) === null) {
		await workspaceStub(workspaceId).syncMember({ userId: devUser, role: (headers['x-flarion-dev-role'] ?? 'member') as 'member', name: devUser });
	}
	const response = await upgradeRequest(workspaceId, headers);
	if (response.status !== 101 || !response.webSocket) throw new Error(`upgrade failed: ${response.status}`);
	const ws = response.webSocket;
	ws.accept();
	const closed = new Promise<{ code: number; reason: string }>((resolve) =>
		ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))
	);
	const log = new StreamLog(ws);
	let client: RouterClient<WorkspaceSocketRouter> | undefined;
	const connection: Connection = {
		ws,
		// Created on first use, over a facade that hides raw protocol frames from oRPC (as the app's socket
		// client does): the same connection carries both.
		get client() {
			return (client ??= createORPCClient(new RPCLink({ websocket: oRpcOnly(ws) as unknown as WebSocket })));
		},
		closed,
		log,
		send(message) {
			ws.send(encodeClientMessage(message));
		},
		rawHello(options = {}) {
			ws.send(
				encodeClientMessage({
					t: 'hello',
					appVersion: options.appVersion ?? '0.0.1',
					clientId: options.clientId ?? crypto.randomUUID(),
					lastSeq: options.lastSeq ?? null,
					subs: options.subs ?? []
				})
			);
			return log;
		},
		async hello(options = {}) {
			await connection.client.hello({
				appVersion: options.appVersion ?? '0.0.1',
				clientId: options.clientId ?? crypto.randomUUID(),
				lastSeq: options.lastSeq ?? null,
				subs: options.subs ?? []
			});
			return log;
		}
	};
	return connection;
}

export const workspaceStub = (workspaceId: string) => testEnv.WORKSPACE.getByName(workspaceId);
export type WorkspaceStub = ReturnType<typeof workspaceStub>;
export type { WorkspaceDO };
