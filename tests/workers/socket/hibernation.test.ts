import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import type { DemoEvent } from '../../../src/server/objects/workspace/demo-router';
import { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';
import { connectDemo, workspaceStub } from './helpers';

const instanceIdOf = (stub: ReturnType<typeof workspaceStub>) =>
	runInDurableObject(stub, (instance: WorkspaceDO) => instance.instanceId);

test('a socket survives hibernation: a new instance answers on the same socket with the same attachment', async () => {
	const { ws, client } = await connectDemo('hib-ping');
	const stub = workspaceStub('hib-ping');

	const before = await client.ping();
	expect(before.pong).toBe(true);
	expect(before.actor).toEqual({ userId: 'user-1' });
	const constructedBefore = WorkspaceDO.constructed;

	// Tear the instance down (memory gone, storage kept) while the socket stays open and hibernates.
	await evictDurableObject(stub);
	expect(ws.readyState).toBe(WebSocket.OPEN);

	const after = await client.ping();
	expect(after.pong).toBe(true);
	// The object really was re-created: new instance id, exactly one more constructor call.
	expect(after.instanceId).not.toBe(before.instanceId);
	expect(WorkspaceDO.constructed).toBe(constructedBefore + 1);
	// The attachment came back from storage, unchanged.
	expect(after.socketId).toBe(before.socketId);
	expect(after.actor).toEqual(before.actor);
	// And the instance that answered is the one now running.
	expect(await instanceIdOf(stub)).toBe(after.instanceId);

	// Repeated eviction keeps working.
	await evictDurableObject(stub);
	const third = await client.ping();
	expect(third.instanceId).not.toBe(after.instanceId);
	expect(third.socketId).toBe(before.socketId);
	ws.close();
});

test('an event iterator keeps receiving pushed events after hibernation', async () => {
	const { ws, client } = await connectDemo('hib-subscribe');
	const stub = workspaceStub('hib-subscribe');

	const events = await client.subscribe({ topic: 'tree' });
	const iterator = events[Symbol.asyncIterator]();

	expect(await stub.publish('tree', 'before')).toBe(1);
	const first = await iterator.next();
	expect(first.value).toMatchObject({ topic: 'tree', data: 'before' });

	const instanceBefore = await instanceIdOf(stub);
	await evictDurableObject(stub);
	expect(ws.readyState).toBe(WebSocket.OPEN);

	// publish() runs on a fresh instance: it must find the subscription in SQL and the socket via
	// getWebSockets(), then push to the iterator the client opened before the eviction.
	expect(await stub.publish('tree', 'after')).toBe(1);
	expect(await instanceIdOf(stub)).not.toBe(instanceBefore);
	const second = await iterator.next();
	expect(second.value).toMatchObject({ topic: 'tree', data: 'after' });
	expect((second.value as DemoEvent).seq).toBeGreaterThanOrEqual(1);

	// Other topics are not delivered.
	expect(await stub.publish('other', 'x')).toBe(0);
	ws.close();
});

test('cancelling an iterator and closing the socket remove the stored subscriptions', async () => {
	const { ws, client, closed } = await connectDemo('hib-cleanup');
	const stub = workspaceStub('hib-cleanup');
	const count = () =>
		runInDurableObject(
			stub,
			(_i: WorkspaceDO, state: DurableObjectState) =>
				state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM socket_subscription').one().n
		);

	const a = await client.subscribe({ topic: 'a' });
	await client.subscribe({ topic: 'b' });
	expect(await count()).toBe(2);

	await a.return?.(undefined as never);
	await vi.waitFor(async () => expect(await count()).toBe(1));

	ws.close(1000, 'bye');
	await closed;
	await vi.waitFor(async () => expect(await count()).toBe(0));
});

test('two sockets of one workspace are independent, both survive hibernation', async () => {
	const a = await connectDemo('hib-two', { 'x-flarion-dev-actor': 'alice' });
	const b = await connectDemo('hib-two', { 'x-flarion-dev-actor': 'bob' });
	const stub = workspaceStub('hib-two');
	const [pa, pb] = [await a.client.ping(), await b.client.ping()];
	expect(pa.socketId).not.toBe(pb.socketId);

	await evictDurableObject(stub);
	const [qa, qb] = [await a.client.ping(), await b.client.ping()];
	expect(qa.actor).toEqual({ userId: 'alice' });
	expect(qb.actor).toEqual({ userId: 'bob' });
	expect(qa.socketId).toBe(pa.socketId);
	expect(qb.socketId).toBe(pb.socketId);
	a.ws.close();
	b.ws.close();
});
