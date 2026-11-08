/**
 * Reusable transport layer for the Workspace Durable Object socket: oRPC v1 `RPCHandler` over
 * hibernatable WebSockets with the hibernation plugin (docs/spikes/p0-orpc-hibernation.md).
 *
 * What survives hibernation (the object is evicted, memory is gone, the socket stays open):
 *  - the socket attachment `{ socketId, actor }`, capped at 2,048 bytes (enforced here);
 *  - anything the owner keeps in storage, e.g. the subscription table keyed by (socketId, requestId).
 * What does not: the oRPC server peer (rebuilt lazily on the next message) and every in-memory
 * iterator. That is why event-iterator procedures return a `HibernationEventIterator`: oRPC sends the
 * response head, hands the request id to a callback, and never holds the stream open. The owner
 * persists that id and later pushes events with `transport.send(ws, requestId, payload)`.
 *
 * Wiring in a Durable Object class:
 *   fetch(request)                 -> transport.accept(actor)
 *   webSocketMessage(ws, message)  -> transport.message(ws, message)
 *   webSocketClose/Error(ws, ...)  -> transport.close(ws, code, reason)
 */
import type { Context, Router } from '@orpc/server';
import {
	HibernationPlugin,
	encodeHibernationRPCEvent,
	type EncodeHibernationRPCEventOptions
} from '@orpc/server/hibernation';
import { RPCHandler } from '@orpc/server/websocket';

/** Workerd rejects hibernatable socket attachments above this many bytes. */
export const MAX_ATTACHMENT_BYTES = 2048;

/** Header the Worker sets on the forwarded upgrade request. Always overwritten, never trusted from clients. */
export const ACTOR_HEADER = 'x-flarion-actor';

export interface SocketActor {
	userId: string;
}

export interface SocketAttachment<TActor = SocketActor> {
	socketId: string;
	actor: TActor;
}

export class AttachmentTooLargeError extends Error {
	constructor(
		readonly bytes: number,
		readonly limit = MAX_ATTACHMENT_BYTES
	) {
		super(`Socket attachment is ${bytes} bytes, the limit is ${limit}`);
		this.name = 'AttachmentTooLargeError';
	}
}

/** Size of the attachment as stored. JSON UTF-8 length is a close upper bound of the structured clone size. */
export function attachmentSize(attachment: unknown): number {
	return new TextEncoder().encode(JSON.stringify(attachment)).byteLength;
}

export function assertAttachmentSize(attachment: unknown): void {
	const bytes = attachmentSize(attachment);
	if (bytes > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(bytes);
}

export function encodeActorHeader(actor: unknown): string {
	return encodeURIComponent(JSON.stringify(actor));
}

export function decodeActorHeader<TActor = SocketActor>(value: string | null): TActor | null {
	if (!value) return null;
	try {
		return JSON.parse(decodeURIComponent(value)) as TActor;
	} catch {
		return null;
	}
}

/** What procedures can reach: the live socket plus its persisted identity. */
export interface SocketHandle<TActor = SocketActor> {
	ws: WebSocket;
	socketId: string;
	actor: TActor;
}

export interface SocketTransportOptions<TContext extends Context, TActor> {
	/** Builds the oRPC context for each message from the socket that sent it. */
	createContext: (socket: SocketHandle<TActor>) => TContext;
	/** A socket closed or errored: drop everything keyed by `socketId`. */
	onClose?: (socket: SocketHandle<TActor>, code: number, reason: string) => void;
	/** The client cancelled an event iterator (`t: 4` abort message) for `requestId`. */
	onIteratorAbort?: (socket: SocketHandle<TActor>, requestId: string) => void;
	/** Tag applied to accepted sockets so `getWebSockets(tag)` can select them. */
	tag?: string;
}

const ABORT_SIGNAL = 4;

export class HibernatableSocketTransport<TContext extends Context, TActor = SocketActor> {
	readonly #ctx: DurableObjectState;
	readonly #handler: RPCHandler<TContext>;
	readonly #options: SocketTransportOptions<TContext, TActor>;

	constructor(
		ctx: DurableObjectState,
		router: Router<any, TContext>,
		options: SocketTransportOptions<TContext, TActor>
	) {
		this.#ctx = ctx;
		this.#options = options;
		this.#handler = new RPCHandler<TContext>(router, { plugins: [new HibernationPlugin<TContext>()] });
	}

	/** Accept an upgrade: returns the 101 response. Throws `AttachmentTooLargeError` before accepting. */
	accept(actor: TActor): Response {
		return this.acceptSocket(actor).response;
	}

	/** Like `accept`, with the handle of the accepted socket (so an owner that keeps its own directory does not read attachments back). */
	acceptSocket(actor: TActor): { response: Response; handle: SocketHandle<TActor> } {
		const attachment: SocketAttachment<TActor> = { socketId: crypto.randomUUID(), actor };
		assertAttachmentSize(attachment);
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.#ctx.acceptWebSocket(server, this.#options.tag ? [this.#options.tag] : undefined);
		server.serializeAttachment(attachment);
		return { response: new Response(null, { status: 101, webSocket: client }), handle: { ws: server, socketId: attachment.socketId, actor } };
	}

	/** The persisted identity of a socket. Works on a socket that survived hibernation. */
	attachment(ws: WebSocket): SocketAttachment<TActor> | null {
		const value = ws.deserializeAttachment() as SocketAttachment<TActor> | null;
		return value && typeof value.socketId === 'string' ? value : null;
	}

	handle(ws: WebSocket): SocketHandle<TActor> | null {
		const attachment = this.attachment(ws);
		return attachment ? { ws, socketId: attachment.socketId, actor: attachment.actor } : null;
	}

	/** Every live socket of this object, including hibernated ones. */
	sockets(): SocketHandle<TActor>[] {
		const handles: SocketHandle<TActor>[] = [];
		for (const ws of this.#ctx.getWebSockets(this.#options.tag)) {
			const handle = this.handle(ws);
			if (handle) handles.push(handle);
		}
		return handles;
	}

	socketById(socketId: string): SocketHandle<TActor> | null {
		return this.sockets().find((s) => s.socketId === socketId) ?? null;
	}

	/** Delegate one frame to the oRPC handler. Call from `webSocketMessage`. */
	async message(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
		const socket = this.handle(ws);
		if (!socket) {
			ws.close(1011, 'missing attachment');
			return;
		}
		if (typeof data === 'string' && this.#options.onIteratorAbort) this.#notifyAbort(socket, data);
		await this.#handler.message(ws, data, { context: this.#options.createContext(socket) } as never);
	}

	/** Call from `webSocketClose` and `webSocketError`. */
	close(ws: WebSocket, code = 1000, reason = ''): void {
		const socket = this.handle(ws);
		this.#handler.close(ws);
		if (socket) this.#options.onClose?.(socket, code, reason);
		try {
			// 1005, 1006 and 1015 are reserved: they can be received but never sent.
			ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason);
		} catch {
			// already closed
		}
	}

	/** Push one iterator event to `requestId` on `ws`. Returns false if the socket is gone. */
	send(
		ws: WebSocket,
		requestId: string,
		payload: unknown,
		options?: EncodeHibernationRPCEventOptions
	): boolean {
		try {
			ws.send(encodeHibernationRPCEvent(requestId, payload, options));
			return true;
		} catch {
			return false;
		}
	}

	#notifyAbort(socket: SocketHandle<TActor>, data: string): void {
		// Abort frames are tiny JSON objects `{ i, t: 4 }`; skip the parse for anything larger.
		if (data.length > 64 || !data.includes('"t":4')) return;
		try {
			const frame = JSON.parse(data) as { i?: unknown; t?: unknown };
			if (frame.t === ABORT_SIGNAL && frame.i !== undefined) {
				this.#options.onIteratorAbort?.(socket, String(frame.i));
			}
		} catch {
			// not JSON: let the handler deal with it
		}
	}
}
