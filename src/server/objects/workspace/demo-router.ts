/**
 * P0 demo router for the hibernation spike: `ping` (request/response) and `subscribe` (event iterator
 * that survives hibernation). Replaced by the real protocol (src/lib/shared/protocol.ts) in P1.
 */
import { os } from '@orpc/server';
import { HibernationEventIterator } from '@orpc/server/hibernation';
import * as v from 'valibot';
import type { SocketActor, SocketHandle } from './socket';

export interface DemoEvent {
	topic: string;
	seq: number;
	data: unknown;
}

export interface DemoContext {
	socket: SocketHandle<SocketActor>;
	instanceId: string;
	subscribe(socket: SocketHandle<SocketActor>, requestId: string, topic: string): void;
}

const base = os.$context<DemoContext>();

export const demoRouter = {
	/** Reports which object instance answered, and the identity stored in the socket attachment. */
	ping: base.handler(({ context }) => ({
		pong: true as const,
		instanceId: context.instanceId,
		socketId: context.socket.socketId,
		actor: context.socket.actor
	})),
	subscribe: base
		.input(v.object({ topic: v.pipe(v.string(), v.minLength(1), v.maxLength(128)) }))
		.handler(
			({ input, context }) =>
				new HibernationEventIterator<DemoEvent>((requestId) =>
					context.subscribe(context.socket, requestId, input.topic)
				)
		)
};

export type DemoRouter = typeof demoRouter;
