import { DurableObject } from 'cloudflare:workers';
import { demoRouter, type DemoContext, type DemoEvent } from './demo-router';
import {
	ACTOR_HEADER,
	AttachmentTooLargeError,
	decodeActorHeader,
	HibernatableSocketTransport,
	type SocketActor
} from './socket';
import { SubscriptionStore } from './subscriptions';

export class WorkspaceDO extends DurableObject<App.Platform['env']> {
	/** Number of instances constructed in this isolate: tests use it to prove a re-create after eviction. */
	static constructed = 0;
	/** Per-instance, in memory only: changes whenever the object is evicted and woken again. */
	readonly instanceId = crypto.randomUUID();
	readonly #subscriptions: SubscriptionStore;
	readonly #transport: HibernatableSocketTransport<DemoContext>;
	#seq = 0;

	constructor(ctx: DurableObjectState, env: App.Platform['env']) {
		super(ctx, env);
		WorkspaceDO.constructed++;
		this.#subscriptions = new SubscriptionStore(ctx.storage.sql);
		this.#transport = new HibernatableSocketTransport(ctx, demoRouter, {
			createContext: (socket) => ({
				socket,
				instanceId: this.instanceId,
				subscribe: (s, requestId, topic) => this.#subscriptions.add(s.socketId, requestId, topic)
			}),
			onClose: (socket) => this.#subscriptions.removeSocket(socket.socketId),
			onIteratorAbort: (socket, requestId) => this.#subscriptions.remove(socket.socketId, requestId)
		});
	}

	async ping() {
		return 'workspace';
	}

	/** Push a demo event to every subscription on `topic`; returns how many sockets received it. */
	async publish(topic: string, data: unknown): Promise<number> {
		const event: DemoEvent = { topic, seq: ++this.#seq, data };
		let delivered = 0;
		for (const row of this.#subscriptions.forTopic(topic)) {
			const socket = this.#transport.socketById(row.socketId);
			if (socket && this.#transport.send(socket.ws, row.requestId, event)) delivered++;
			else this.#subscriptions.remove(row.socketId, row.requestId);
		}
		return delivered;
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		}
		const actor = decodeActorHeader<SocketActor>(request.headers.get(ACTOR_HEADER));
		if (!actor) return new Response('Missing actor', { status: 401 });
		try {
			return this.#transport.accept(actor);
		} catch (error) {
			if (error instanceof AttachmentTooLargeError) return new Response(error.message, { status: 413 });
			throw error;
		}
	}

	override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		return this.#transport.message(ws, message);
	}

	override webSocketClose(ws: WebSocket, code: number, reason: string): void {
		this.#transport.close(ws, code, reason);
	}

	override webSocketError(ws: WebSocket): void {
		this.#transport.close(ws, 1011, 'socket error');
	}
}
