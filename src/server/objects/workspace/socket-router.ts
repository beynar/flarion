/**
 * The real workspace socket router (replaces the P0 demo router): the messages of
 * `src/lib/shared/protocol.ts` as oRPC v1 procedures over the hibernatable socket.
 *
 * One event iterator carries everything the server pushes. The client opens it with `hello`
 * (`{ appVersion, kindsVersion?, clientId, lastSeq, subs }`); from then on every `ServerMessage`
 * (`welcome`, `resumed`, `snapshot`, `diff`, `head`, `presence`, `notification`, `error`) arrives on
 * that iterator, tagged with the commit `seq`. The other procedures are plain request/response acks:
 * their effects (a `snapshot` for `subscribe`, a `diff` for `window`) are pushed on the stream.
 *
 *   hello({ appVersion, clientId, lastSeq, subs })   -> AsyncIterable<ServerMessage>
 *   subscribe({ id, sub })     unsubscribe({ id })     window({ id, limit })
 *   presence({ pageId })       notificationsRead({ ids })      ping()
 */
import { os } from '@orpc/server';
import { HibernationEventIterator } from '@orpc/server/hibernation';
import * as v from 'valibot';
import {
	clientMessageSchema,
	subscriptionSchema,
	type ServerMessage
} from '../../../lib/shared/protocol';
import type { WorkspaceSocketActor } from './actor';
import type { SocketHandle } from './socket';

const [helloMessage, , , windowMessage, presenceMessage, notificationsMessage] = clientMessageSchema.options;

export const helloInputSchema = v.omit(helloMessage, ['t']);
export const subscribeInputSchema = v.object({
	id: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
	sub: subscriptionSchema
});
export const unsubscribeInputSchema = v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(40)) });
export const windowInputSchema = v.omit(windowMessage, ['t']);
export const presenceInputSchema = v.omit(presenceMessage, ['t']);
export const notificationsReadInputSchema = v.omit(notificationsMessage, ['t']);

export type HelloInput = v.InferOutput<typeof helloInputSchema>;
export type SubscribeInput = v.InferOutput<typeof subscribeInputSchema>;
export type WindowInput = v.InferOutput<typeof windowInputSchema>;

export type WorkspaceSocket = SocketHandle<WorkspaceSocketActor>;

/** What the router needs from the Workspace DO (implemented by `WorkspaceSocketApi`). */
export interface SocketApi {
	hello(socket: WorkspaceSocket, requestId: string, input: HelloInput): void | Promise<void>;
	subscribe(socket: WorkspaceSocket, input: SubscribeInput): void | Promise<void>;
	unsubscribe(socket: WorkspaceSocket, id: string): void;
	window(socket: WorkspaceSocket, input: WindowInput): void | Promise<void>;
	presence(socket: WorkspaceSocket, pageId: string | null): void;
	notificationsRead(socket: WorkspaceSocket, ids: string[]): void;
}

export interface SocketContext {
	socket: WorkspaceSocket;
	api: SocketApi;
	instanceId: string;
}

const base = os.$context<SocketContext>();
const ack = { ok: true as const };

export const socketRouter = {
	/** Liveness and identity: which object instance answered, and the identity stored in the attachment. */
	ping: base.handler(({ context }) => ({
		t: 'pong' as const,
		pong: true as const,
		instanceId: context.instanceId,
		socketId: context.socket.socketId,
		actor: context.socket.actor
	})),
	hello: base
		.input(helloInputSchema)
		.handler(
			({ input, context }) =>
				new HibernationEventIterator<ServerMessage>((requestId) => {
					void Promise.resolve(context.api.hello(context.socket, requestId, input)).catch((error) => console.error('[workspace] hello failed:', error));
				})
		),
	subscribe: base.input(subscribeInputSchema).handler(async ({ input, context }) => {
		await context.api.subscribe(context.socket, input);
		return ack;
	}),
	unsubscribe: base.input(unsubscribeInputSchema).handler(({ input, context }) => {
		context.api.unsubscribe(context.socket, input.id);
		return ack;
	}),
	window: base.input(windowInputSchema).handler(async ({ input, context }) => {
		await context.api.window(context.socket, input);
		return ack;
	}),
	presence: base.input(presenceInputSchema).handler(({ input, context }) => {
		context.api.presence(context.socket, input.pageId);
		return ack;
	}),
	notificationsRead: base.input(notificationsReadInputSchema).handler(({ input, context }) => {
		context.api.notificationsRead(context.socket, input.ids);
		return ack;
	})
};

export type WorkspaceSocketRouter = typeof socketRouter;
