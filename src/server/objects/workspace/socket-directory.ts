/**
 * The Workspace DO's in-memory list of its live sockets: id, WebSocket and the actor read from its attachment.
 *
 * Reading attachments back (`getWebSockets()` + `deserializeAttachment()`) costs a structured clone per socket, so doing it
 * once per commit (to settle the actors' visibility) and once per `send` turn made a commit O(sockets) in clones: 1,000
 * tabs paid about a thousand per commit and per await of a fan-out. The directory reads them once after the object wakes
 * and is kept current by `add` (an accepted socket) and `remove` (a closed one).
 */
export interface DirectorySocket<A extends { userId: string; role: string }> {
	ws: WebSocket;
	socketId: string;
	actor: A;
}

export class SocketDirectory<A extends { userId: string; role: string }> {
	readonly #byId = new Map<string, DirectorySocket<A>>();
	/** Distinct actors (user and role) with how many sockets each holds: what a commit settles. */
	readonly #actors = new Map<string, { actor: A; sockets: number }>();

	constructor(initial: readonly DirectorySocket<A>[] = []) {
		for (const socket of initial) this.add(socket);
	}

	get size(): number {
		return this.#byId.size;
	}

	get(socketId: string): DirectorySocket<A> | null {
		return this.#byId.get(socketId) ?? null;
	}

	add(socket: DirectorySocket<A>): void {
		if (this.#byId.has(socket.socketId)) this.remove(socket.socketId);
		this.#byId.set(socket.socketId, socket);
		const key = `${socket.actor.userId}|${socket.actor.role}`;
		const held = this.#actors.get(key);
		if (held) held.sockets++;
		else this.#actors.set(key, { actor: socket.actor, sockets: 1 });
	}

	remove(socketId: string): void {
		const socket = this.#byId.get(socketId);
		if (!socket) return;
		this.#byId.delete(socketId);
		const key = `${socket.actor.userId}|${socket.actor.role}`;
		const held = this.#actors.get(key);
		if (held && --held.sockets <= 0) this.#actors.delete(key);
	}

	all(): DirectorySocket<A>[] {
		return [...this.#byId.values()];
	}

	/** One actor per distinct (user, role). */
	actors(): A[] {
		return [...this.#actors.values()].map((h) => h.actor);
	}
}
