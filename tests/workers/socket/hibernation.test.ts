/**
 * Hibernation (docs/spikes/p0-orpc-hibernation.md) on the real workspace socket router: the object is
 * evicted (memory gone, storage kept) while the sockets stay open, and a new instance answers on them.
 * The subscription registry lives in SQL, so pushes keep flowing to the streams opened before the eviction.
 */
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';
import { batch, createOp, createWorkspace, ranks } from '../workspace/helpers';
import { connect, workspaceStub } from './helpers';

const instanceIdOf = (stub: ReturnType<typeof workspaceStub>) =>
	runInDurableObject(stub, (instance: WorkspaceDO) => instance.instanceId);

test('a socket survives hibernation: a new instance answers on the same socket with the same attachment', async () => {
	const { ws, client } = await connect('hib-ping');
	const stub = workspaceStub('hib-ping');

	const before = await client.ping();
	expect(before.pong).toBe(true);
	expect(before.actor).toMatchObject({ userId: 'user-1', workspaceId: 'hib-ping', role: 'member' });
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

test('the hello event iterator keeps receiving pushed frames after hibernation (through the real oRPC client)', async () => {
	const fixture = await createWorkspace('hib-stream');
	const { ws, client } = await connect(fixture.id);
	const events = await client.hello({
		appVersion: '0.0.1',
		clientId: 'tab-1',
		lastSeq: null,
		subs: [{ id: 'tree', sub: { kind: 'tree', parents: [null] } }]
	});
	const iterator = events[Symbol.asyncIterator]();

	// welcome, the tree snapshot, then a head.
	const first = await iterator.next();
	expect(first.value).toMatchObject({ t: 'welcome', userId: 'user-1' });
	expect((await iterator.next()).value).toMatchObject({ t: 'snapshot', id: 'tree', kind: 'tree', total: 1 });
	expect((await iterator.next()).value).toMatchObject({ t: 'head' });

	const instanceBefore = await instanceIdOf(fixture.stub);
	await evictDurableObject(fixture.stub);
	expect(ws.readyState).toBe(WebSocket.OPEN);

	// A commit on a fresh instance finds the subscription in SQL and the socket via getWebSockets(), and
	// pushes to the iterator the client opened before the eviction.
	const [rank] = ranks(1);
	const { seq } = await fixture.stub.apply(fixture.owner, batch([createOp('after', null, rank, { teamspaceId: fixture.generalId })]));
	expect(await instanceIdOf(fixture.stub)).not.toBe(instanceBefore);
	const diff = await iterator.next();
	expect(diff.value).toMatchObject({ t: 'diff', seq, subs: [{ id: 'tree', ops: [{ op: 'add', row: { id: 'after' } }, { op: 'count', total: 2 }] }] });
	await iterator.return?.(undefined as never);
	ws.close();
});

test('cancelling the stream and closing the socket remove the stored subscriptions', async () => {
	const { ws, client, closed } = await connect('hib-cleanup');
	const stub = workspaceStub('hib-cleanup');
	const count = (table: string) =>
		runInDurableObject(
			stub,
			(_i: WorkspaceDO, state: DurableObjectState) =>
				state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n
		);

	const events = await client.hello({
		appVersion: '0.0.1',
		clientId: 'tab-1',
		lastSeq: null,
		subs: [
			{ id: 'a', sub: { kind: 'tree', parents: [null] } },
			{ id: 'b', sub: { kind: 'page', pageIds: ['x'] } }
		]
	});
	expect(await count('socket_stream')).toBe(1);
	expect(await count('socket_sub')).toBe(2);

	// The client cancels its stream (`return()` sends the abort frame): the session is over.
	await events.return?.(undefined as never);
	await vi.waitFor(async () => {
		expect(await count('socket_stream')).toBe(0);
		expect(await count('socket_sub')).toBe(0);
		expect(await count('sub_unit')).toBe(0);
	});

	// A second session, ended by closing the socket.
	await client.hello({ appVersion: '0.0.1', clientId: 'tab-1', lastSeq: null, subs: [{ id: 'a', sub: { kind: 'tree', parents: [null] } }] });
	expect(await count('socket_sub')).toBe(1);
	ws.close(1000, 'bye');
	await closed;
	await vi.waitFor(async () => {
		expect(await count('socket_stream')).toBe(0);
		expect(await count('socket_sub')).toBe(0);
		expect(await count('sub_link')).toBe(0);
	});
});

test('two sockets of one workspace are independent, both survive hibernation', async () => {
	const a = await connect('hib-two', { 'x-flarion-dev-actor': 'alice' });
	const b = await connect('hib-two', { 'x-flarion-dev-actor': 'bob' });
	const stub = workspaceStub('hib-two');
	const [pa, pb] = [await a.client.ping(), await b.client.ping()];
	expect(pa.socketId).not.toBe(pb.socketId);

	await evictDurableObject(stub);
	const [qa, qb] = [await a.client.ping(), await b.client.ping()];
	expect(qa.actor.userId).toBe('alice');
	expect(qb.actor.userId).toBe('bob');
	expect(qa.socketId).toBe(pa.socketId);
	expect(qb.socketId).toBe(pb.socketId);
	a.ws.close();
	b.ws.close();
});
