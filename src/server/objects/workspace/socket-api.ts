/**
 * The Workspace DO's side of the socket protocol: what each `socketRouter` procedure does. Everything is
 * synchronous on the object's SQLite, so a `hello`, a `subscribe` and a commit's fan-out each run in one
 * turn and can never observe one another half done.
 */
import { ORPCError } from '@orpc/server';
import {
	CLOSE,
	MAX_SUBSCRIPTIONS_PER_SOCKET,
	PROTOCOL_VERSION,
	type PresenceUser,
	type RegistryScope,
	type ServerMessage,
	type Subscription
} from '../../../lib/shared/protocol';
import { KINDS_VERSION } from '../../../lib/shared/blocks/kinds';
import type { LiveHub } from './live';
import type { Presence } from './presence';
import { presenceColor } from './presence';
import type { HelloInput, SocketApi, SubscribeInput, WindowInput, WorkspaceSocket } from './socket-router';
import { checkVersions, MIN_APP_VERSION } from './versions';

/**
 * The stream id of a socket that speaks the protocol as raw JSON frames (`{ "t": "hello", ... }`, what the
 * app's socket client sends). Sockets that opened their stream with the oRPC `hello` procedure store the
 * oRPC request id instead and receive iterator events.
 */
export const RAW_STREAM = '';

export interface SocketApiDeps {
	env: Pick<Env, 'APP_VERSION'> & { ENVIRONMENT?: string };
	hub: LiveHub;
	presence: Presence;
	/** Pushes a message on a socket's stream (false: gone). */
	send(socketId: string, message: ServerMessage): boolean;
	/** Every socket with a stream. */
	streams(): string[];
	now(): number;
	/** Runs `work` in the Workspace DO's queue of commits and socket messages. */
	serialize?<T>(work: () => Promise<T>): Promise<T>;
	/** Why a view subscription is refused (a primary sort that reads the clock...), or nothing. */
	checkView?(sub: Extract<Subscription, { kind: 'view' }>): Promise<string | null | undefined>;
}

export class WorkspaceSocketApi implements SocketApi {
	readonly #d: SocketApiDeps;

	constructor(deps: SocketApiDeps) {
		this.#d = deps;
	}

	#error(socket: WorkspaceSocket, code: Extract<ServerMessage, { t: 'error' }>['code'], message: string, id?: string): void {
		this.#d.send(socket.socketId, { t: 'error', code, message, ...(id ? { id } : {}) });
	}

	#userOf(socket: WorkspaceSocket): PresenceUser {
		return { userId: socket.actor.userId, name: socket.actor.name, color: presenceColor(socket.actor.userId), avatar: null };
	}

	async hello(socket: WorkspaceSocket, requestId: string, input: HelloInput): Promise<void> {
		// A raw `hello` frame already runs in the commits' queue; the oRPC `hello` hands its stream over to a
		// callback after the message was handled, so it takes its place in the queue here.
		if (requestId !== RAW_STREAM && this.#d.serialize) return this.#d.serialize(() => this.#hello(socket, requestId, input));
		return this.#hello(socket, requestId, input);
	}

	async #hello(socket: WorkspaceSocket, requestId: string, input: HelloInput): Promise<void> {
		const { hub } = this.#d;
		if (checkVersions(this.#d.env, input.appVersion, input.kindsVersion) === 'reload') {
			try {
				socket.ws.close(CLOSE.RELOAD_REQUIRED, 'reload');
			} catch {
				// already closed
			}
			return;
		}
		// A new hello starts the session over: its subscriptions replace every earlier one.
		hub.dropSocket(socket.socketId);
		hub.bindStream(socket.socketId, requestId, input.clientId, this.#d.now());
		const head = hub.headSeq();
		this.#d.send(socket.socketId, {
			t: 'welcome',
			protocol: PROTOCOL_VERSION,
			appVersion: String(this.#d.env.APP_VERSION),
			minAppVersion: MIN_APP_VERSION,
			kindsVersion: KINDS_VERSION,
			userId: socket.actor.userId,
			seq: head
		});

		const entries = input.subs.filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
		const resume = input.lastSeq === null ? null : hub.planResume(input.lastSeq, hub.changesSince(input.lastSeq));
		if (input.lastSeq !== null && resume) {
			this.#d.send(socket.socketId, { t: 'resumed', mode: resume.mode, fromSeq: input.lastSeq, seq: head });
		}
		for (const entry of entries) {
			if (!(await this.#register(socket, entry.id, entry.sub))) continue;
			const message =
				resume?.mode === 'replay' && resume.touch
					? await hub.replaySub(socket.socketId, entry.id, socket.actor, resume.touch, head)
					: await hub.snapshot(socket.socketId, entry.id, socket.actor, head);
			if (message) this.#d.send(socket.socketId, message);
		}
		this.#d.send(socket.socketId, { t: 'head', seq: head });
		const occupied = this.#d.presence.occupied();
		if (occupied.length) this.#d.send(socket.socketId, { t: 'presence', entries: this.#d.presence.entries(occupied) });
	}

	/** Validates and registers one subscription. Sends an `error` message and returns false when refused. */
	async #register(socket: WorkspaceSocket, id: string, sub: Subscription): Promise<boolean> {
		const { hub } = this.#d;
		const holds = hub.subscriptions(socket.socketId).some((s) => s.id === id);
		if (!holds && hub.subCount(socket.socketId) >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
			this.#error(socket, 'too_many_subscriptions', `A socket holds at most ${MAX_SUBSCRIPTIONS_PER_SOCKET} subscriptions`, id);
			return false;
		}
		if (sub.kind === 'view' && !hub.reader.collectionExists(sub.collectionId)) {
			this.#error(socket, 'not_found', `Collection "${sub.collectionId}" does not exist`, id);
			return false;
		}
		if (sub.kind === 'view') {
			const refusal = await this.#d.checkView?.(sub);
			if (refusal) {
				this.#error(socket, 'bad_subscription', refusal, id);
				return false;
			}
		}
		await hub.register(socket.socketId, id, sub, socket.actor);
		return true;
	}

	async subscribe(socket: WorkspaceSocket, input: SubscribeInput): Promise<void> {
		const { hub } = this.#d;
		if (hub.streamOf(socket.socketId) === null) throw new ORPCError('BAD_REQUEST', { message: 'Send hello first' });
		if (!(await this.#register(socket, input.id, input.sub))) return;
		const message = await hub.snapshot(socket.socketId, input.id, socket.actor, hub.headSeq());
		if (message) this.#d.send(socket.socketId, message);
	}

	unsubscribe(socket: WorkspaceSocket, id: string): void {
		this.#d.hub.unregister(socket.socketId, id);
	}

	async window(socket: WorkspaceSocket, input: WindowInput): Promise<void> {
		const { hub } = this.#d;
		const known = hub.subscriptions(socket.socketId).find((s) => s.id === input.id);
		if (!known) return this.#error(socket, 'not_found', `No subscription "${input.id}"`, input.id);
		if (known.sub.kind !== 'view' && known.sub.kind !== 'backlinks') {
			return this.#error(socket, 'bad_subscription', `A ${known.sub.kind} subscription has no window`, input.id);
		}
		const ops = await hub.resizeWindow(socket.socketId, input.id, input.limit, socket.actor, input.group);
		if (ops) this.#d.send(socket.socketId, { t: 'diff', seq: hub.headSeq(), subs: [{ id: input.id, ops }] });
	}

	presence(socket: WorkspaceSocket, pageId: string | null): void {
		const changed = this.#d.presence.set(socket.socketId, this.#userOf(socket), pageId);
		this.broadcastPresence(changed);
	}

	/** Called when a socket closes. */
	closed(socket: WorkspaceSocket): void {
		this.#d.hub.dropSocket(socket.socketId);
		this.broadcastPresence(this.#d.presence.remove(socket.socketId));
	}

	broadcastPresence(pageIds: readonly string[]): void {
		if (pageIds.length === 0) return;
		const message: ServerMessage = { t: 'presence', entries: this.#d.presence.entries(pageIds) };
		for (const socketId of this.#d.streams()) this.#d.send(socketId, message);
	}

	/** Tells every connected tab that workspace definitions changed (see the `registry` message). */
	broadcastRegistry(scopes: readonly RegistryScope[], seq: number): void {
		if (scopes.length === 0) return;
		const message: ServerMessage = { t: 'registry', scopes: [...scopes], seq };
		for (const socketId of this.#d.streams()) this.#d.send(socketId, message);
	}

	notificationsRead(_socket: WorkspaceSocket, _ids: string[]): void {
		// Notifications arrive with P2/P4 (mentions, shares); nothing is stored yet.
	}
}
