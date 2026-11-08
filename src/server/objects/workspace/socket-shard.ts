/**
 * `SocketShardDO`: holds a share of one workspace's hibernatable sockets and does the `ws.send` loop for them
 * (docs/spikes/p4-scale.md "Socket shards"). The Workspace DO stays the single source of truth: every write, subscription,
 * window and presence still runs there. A shard only
 *   - accepts the upgrade the Workspace DO forwards to it (the Workspace DO has already checked the user, the role and the build),
 *   - forwards every client frame to the Workspace DO (`shardFrame`; pings are answered here),
 *   - tells it when a socket closed (`shardClosed`),
 *   - and executes what the Workspace DO pushes (`push`): frames for lists of sockets, closes, attachment updates.
 *
 * One batch per commit and shard reaches `push`: a frame is encoded once by the Workspace DO and listed with the sockets of this shard
 * that get it, so a commit costs the Workspace DO a handful of calls instead of a thousand `ws.send`s, and the sends of N shards run in
 * parallel on N threads.
 *
 * Hibernation: nothing lives here but the sockets and their attachments (`{ socketId, actor }`); the map from socket id to socket is
 * read back from `ctx.getWebSockets()` when the object wakes. The Workspace DO keeps its own table of remote sockets (SQL), so it
 * survives hibernation too.
 *
 * Keep this module's imports minimal: it is part of every isolate's script.
 */
import { DurableObject } from 'cloudflare:workers';

/** What a shard is told to do, in order: send `text` to each of `ids`; close one socket; replace one socket's attachment. */
export type ShardOp =
	| readonly [kind: 0, text: string | ArrayBuffer, ids: readonly string[]]
	| readonly [kind: 1, id: string, code: number, reason: string]
	| readonly [kind: 2, id: string, attachment: unknown];

export const OP_SEND = 0;
export const OP_CLOSE = 1;
export const OP_ATTACH = 2;

/** Set by the Workspace DO on the upgrade it forwards: the attachment (`{ socketId, actor }`) of the socket to accept. */
export const SHARD_ATTACHMENT_HEADER = 'x-flarion-shard-attachment';

/** The attachment every shard socket carries. */
export interface ShardAttachment {
	socketId: string;
	/** The shard's index: the Workspace DO needs it back with every frame. */
	shard: number;
	/** The person; `workspaceId` is how a shard finds the Workspace DO (the object's own name is not always known to it: `ctx.id.name`). */
	actor: { userId: string; workspaceId: string };
}

/** The name of shard `index` of a workspace. */
export const shardName = (workspaceId: string, index: number): string => `${workspaceId}:${index}`;

/** `{"t":"ping"}` (the one client frame a shard answers by itself). */
const PING = /^\s*\{\s*"t"\s*:\s*"ping"\s*\}\s*$/;
const PONG = '{"t":"pong"}';

/** The data center this object runs in (Cloudflare's trace endpoint), for diagnostics. */
export async function coloOf(): Promise<string> {
	try {
		const text = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
		return /^colo=(\w+)/m.exec(text)?.[1] ?? '?';
	} catch {
		return '?';
	}
}

/** What a shard calls on the Workspace DO (see `WorkspaceDO.shardFrame` and `shardClosed`). */
interface WorkspaceStub {
	shardFrame(shard: number, attachment: ShardAttachment, data: string | ArrayBuffer): Promise<void>;
	shardClosed(shard: number, attachment: ShardAttachment, code: number, reason: string): Promise<void>;
}

export class SocketShardDO extends DurableObject<Env> {
	readonly #sockets = new Map<string, WebSocket>();
	readonly #attachments = new WeakMap<WebSocket, ShardAttachment>();
	/** The last frame of each socket handed to the Workspace DO: the next waits for it, so one socket's frames are handled in order. */
	readonly #chain = new Map<string, Promise<unknown>>();
	#pushes = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		for (const ws of ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as ShardAttachment | null;
			if (!attachment || typeof attachment.socketId !== 'string') continue;
			this.#attachments.set(ws, attachment);
			this.#sockets.set(attachment.socketId, ws);
		}
	}

	#workspace(attachment: ShardAttachment): WorkspaceStub {
		return this.env.WORKSPACE.getByName(attachment.actor.workspaceId) as unknown as WorkspaceStub;
	}

	#attachment(ws: WebSocket): ShardAttachment | null {
		let attachment = this.#attachments.get(ws);
		if (!attachment) {
			attachment = (ws.deserializeAttachment() as ShardAttachment | null) ?? undefined;
			if (!attachment || typeof attachment.socketId !== 'string') return null;
			this.#attachments.set(ws, attachment);
		}
		return attachment;
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
		let attachment: ShardAttachment;
		try {
			attachment = JSON.parse(decodeURIComponent(request.headers.get(SHARD_ATTACHMENT_HEADER) ?? '')) as ShardAttachment;
		} catch {
			return new Response('Missing attachment', { status: 400 });
		}
		if (typeof attachment?.socketId !== 'string' || typeof attachment.shard !== 'number' || typeof attachment.actor?.userId !== 'string' || typeof attachment.actor.workspaceId !== 'string') return new Response('Bad attachment', { status: 400 });
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(attachment);
		this.#attachments.set(server, attachment);
		this.#sockets.set(attachment.socketId, server);
		return new Response(null, { status: 101, webSocket: client });
	}

	override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> | void {
		const attachment = this.#attachment(ws);
		if (!attachment) return void ws.close(1011, 'missing attachment');
		if (typeof message === 'string' && message.length < 32 && PING.test(message)) {
			ws.send(PONG);
			return;
		}
		const id = attachment.socketId;
		const previous = this.#chain.get(id);
		const run = () => this.#workspace(attachment).shardFrame(attachment.shard, attachment, message);
		const next = previous ? previous.then(run, run) : run();
		// The map holds only a socket's last pending call.
		const settled = next.then(
			() => undefined,
			() => undefined
		);
		this.#chain.set(id, settled);
		void settled.then(() => {
			if (this.#chain.get(id) === settled) this.#chain.delete(id);
		});
		return next as Promise<void>;
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		await this.#closed(ws, code, reason);
	}

	override async webSocketError(ws: WebSocket): Promise<void> {
		await this.#closed(ws, 1011, 'socket error');
	}

	async #closed(ws: WebSocket, code: number, reason: string): Promise<void> {
		const attachment = this.#attachment(ws);
		try {
			// 1005, 1006 and 1015 are reserved: they can be received but never sent.
			ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason);
		} catch {
			// already closed
		}
		if (!attachment) return;
		this.#sockets.delete(attachment.socketId);
		this.#chain.delete(attachment.socketId);
		await this.#workspace(attachment).shardClosed(attachment.shard, attachment, code, reason);
	}

	/**
	 * Executes a batch from the Workspace DO, in order. Returns the sockets it could not reach (closed or unknown here): the
	 * Workspace DO forgets them.
	 */
	push(ops: readonly ShardOp[]): string[] {
		this.#pushes++;
		let dead: string[] | null = null;
		for (const op of ops) {
			switch (op[0]) {
				case OP_SEND: {
					const [, text, ids] = op;
					for (const id of ids) {
						const ws = this.#sockets.get(id);
						if (!ws) {
							(dead ??= []).push(id);
							continue;
						}
						try {
							ws.send(text);
						} catch {
							(dead ??= []).push(id);
						}
					}
					break;
				}
				case OP_CLOSE: {
					const ws = this.#sockets.get(op[1]);
					if (!ws) break;
					try {
						ws.close(op[2], op[3]);
					} catch {
						// already closed
					}
					break;
				}
				case OP_ATTACH: {
					const ws = this.#sockets.get(op[1]);
					if (!ws) break;
					try {
						ws.serializeAttachment(op[2]);
						this.#attachments.set(ws, op[2] as ShardAttachment);
					} catch {
						// a socket that closed meanwhile
					}
					break;
				}
			}
		}
		return dead ?? [];
	}

	/** Closes every socket this shard holds (the Workspace DO lost track of them and asks them to reconnect). */
	closeAll(code: number, reason: string): void {
		for (const ws of this.#sockets.values()) {
			try {
				ws.close(code, reason);
			} catch {
				// already closed
			}
		}
	}

	/** Sockets held (tests and diagnostics). */
	count(): number {
		return this.#sockets.size;
	}

	/** Sockets, batches received and the data center this shard runs in (diagnostics: `liveStats().shards` and the load tool). */
	async stats(): Promise<{ sockets: number; pushes: number; colo: string }> {
		return { sockets: this.#sockets.size, pushes: this.#pushes, colo: await coloOf() };
	}
}
