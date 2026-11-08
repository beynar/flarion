/**
 * The Workspace DO's side of the socket shards (`socket-shard.ts`).
 *
 * A socket held by a shard is a `RemoteSocket` here: it looks like the part of a `WebSocket` the Workspace DO uses (`send`, `close`,
 * `serializeAttachment`, `deserializeAttachment`), so the live loop, the oRPC transport and the access code do not know the
 * difference. What `send` does is put the frame in the shard's outgoing batch; the batch leaves at the end of the turn (a microtask), so a
 * commit's thousand sends are a handful of calls: consecutive sends of the same text to one shard share one entry
 * (`[text, ids]`), which is the shape of a fan-out (one frame per audience, every socket of it in turn).
 *
 * Order: a shard receives its batches one at a time, in the order they were made: the next call waits for the previous to be answered,
 * and what accumulates meanwhile leaves together. That is what keeps a socket's frames in `seq` order, and it batches by itself when a
 * shard is slow.
 */
import { OP_ATTACH, OP_CLOSE, OP_SEND, shardName, type ShardAttachment, type ShardOp } from './socket-shard';

/** What the Workspace DO needs from a shard. */
export interface ShardStub {
	push(ops: readonly ShardOp[]): Promise<string[]>;
	closeAll?(code: number, reason: string): Promise<void>;
}

export interface ShardRouterOptions {
	/** The shard `index` of this workspace. Stubs are made per call: a stub belongs to the request that made it. */
	stubOf(index: number): ShardStub;
	/** Sockets the shard could not reach (they are gone). */
	onDead(index: number, ids: readonly string[]): void;
	/** A batch could not be delivered: what the shard held is lost to this object. */
	onFailure(index: number, error: unknown): void;
}

/** The part of a `WebSocket` the Workspace DO uses on a socket a shard holds. */
export class RemoteSocket {
	/** True once the shard said the socket is gone: later sends are dropped. */
	gone = false;
	readonly readyState = 1;

	constructor(
		private readonly router: ShardRouter,
		readonly shard: number,
		private attachment: ShardAttachment,
		/** Called when the attachment changes (a renamed person): the Workspace DO records it. */
		private readonly onAttachment?: (value: unknown) => void
	) {}

	get socketId(): string {
		return this.attachment.socketId;
	}

	send(data: string | ArrayBuffer): void {
		if (this.gone) throw new Error('socket is closed');
		this.router.send(this.shard, data, this.attachment.socketId);
	}

	close(code = 1000, reason = ''): void {
		if (this.gone) return;
		this.router.close(this.shard, this.attachment.socketId, code, reason);
	}

	serializeAttachment(value: unknown): void {
		this.attachment = value as ShardAttachment;
		this.onAttachment?.(value);
		if (!this.gone) this.router.attach(this.shard, this.attachment.socketId, value);
	}

	deserializeAttachment(): ShardAttachment {
		return this.attachment;
	}

	// The rest of the `WebSocket` surface is never used on the Workspace DO's side.
	addEventListener(): void {}
	removeEventListener(): void {}
}

interface Outbox {
	ops: ShardOp[];
	/** The last send entry, to grow it while the same text goes out to more sockets. */
	last: { text: string | ArrayBuffer; ids: string[] } | null;
	inFlight: boolean;
}

export class ShardRouter {
	readonly #options: ShardRouterOptions;
	readonly #boxes = new Map<number, Outbox>();
	#scheduled = false;
	/** Batches sent and the sends they carried, for diagnostics. */
	batches = 0;
	sends = 0;

	constructor(options: ShardRouterOptions) {
		this.#options = options;
	}

	#box(shard: number): Outbox {
		let box = this.#boxes.get(shard);
		if (!box) this.#boxes.set(shard, (box = { ops: [], last: null, inFlight: false }));
		return box;
	}

	#schedule(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.flush();
		});
	}

	send(shard: number, text: string | ArrayBuffer, id: string): void {
		const box = this.#box(shard);
		this.sends++;
		if (box.last && box.last.text === text) box.last.ids.push(id);
		else {
			const entry = { text, ids: [id] };
			box.last = entry;
			box.ops.push([OP_SEND, text, entry.ids]);
		}
		this.#schedule();
	}

	close(shard: number, id: string, code: number, reason: string): void {
		const box = this.#box(shard);
		box.last = null;
		box.ops.push([OP_CLOSE, id, code, reason]);
		this.#schedule();
	}

	attach(shard: number, id: string, attachment: unknown): void {
		const box = this.#box(shard);
		box.last = null;
		box.ops.push([OP_ATTACH, id, attachment]);
		this.#schedule();
	}

	/** Sends what is waiting, shard by shard (a shard with a call in flight gets its batch when that call is answered). */
	flush(): void {
		for (const [shard, box] of this.#boxes) {
			if (box.inFlight || box.ops.length === 0) continue;
			const ops = box.ops;
			box.ops = [];
			box.last = null;
			box.inFlight = true;
			this.batches++;
			let call: Promise<string[]>;
			try {
				call = Promise.resolve(this.#options.stubOf(shard).push(ops));
			} catch (error) {
				call = Promise.reject(error);
			}
			void call.then(
				(dead) => {
					box.inFlight = false;
					if (dead.length) this.#options.onDead(shard, dead);
					if (box.ops.length) this.flush();
				},
				(error) => {
					box.inFlight = false;
					box.ops = [];
					box.last = null;
					this.#options.onFailure(shard, error);
				}
			);
		}
	}

	/** Forgets what is queued for a shard (its sockets are being dropped). */
	reset(shard: number): void {
		const box = this.#boxes.get(shard);
		if (!box) return;
		box.ops = [];
		box.last = null;
	}
}

export { shardName };
