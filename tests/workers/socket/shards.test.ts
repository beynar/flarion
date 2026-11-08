/**
 * Socket shards (`SocketShardDO`, docs/spikes/p4-scale.md "Socket shards"): sockets held by shard objects behave like the
 * Workspace DO's own, through hello, pings, diffs, closes, role changes and the hibernation of either side.
 */
import { env, evictDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { batch, createOp, createWorkspace, ranks } from '../workspace/helpers';
import { connect } from './helpers';

const dev = (user: string) => ({ 'x-flarion-dev-actor': user });
const shardStub = (workspaceId: string, index: number) => (env as unknown as Env).SOCKET_SHARD.getByName(`${workspaceId}:${index}`);
const tree = [{ id: 'tree', sub: { kind: 'tree' as const, parents: [null] } }];

test('sockets beyond the local ones go to the least loaded shard; frames reach them in order, pings are answered by the shard', async () => {
	const ws = await createWorkspace('shard-basic');
	await ws.stub.configureShards({ count: 2, localMax: 1 });
	const sockets = [];
	for (let i = 0; i < 5; i++) {
		const c = await connect(ws.id, dev(i % 2 ? 'alice' : 'bob'));
		c.rawHello({ subs: tree });
		await c.log.wait((m) => m.t === 'head');
		sockets.push(c);
	}
	const stats = await ws.stub.liveStats();
	expect(stats.shards.local).toBe(1);
	expect(stats.shards.sockets).toEqual([2, 2]);
	expect(stats.streams).toBe(5);
	expect(await shardStub(ws.id, 0).count()).toBe(2);
	expect(await shardStub(ws.id, 1).count()).toBe(2);

	for (const c of sockets) {
		expect(c.log.messages.slice(0, 3).map((m) => m.t)).toEqual(['welcome', 'snapshot', 'head']);
		c.send({ t: 'ping' });
	}
	for (const c of sockets) await c.log.wait((m) => m.t === 'pong');

	const [rank] = ranks(1);
	const froms = sockets.map((c) => c.log.messages.length);
	const seqs: number[] = [];
	for (let i = 0; i < 3; i++) seqs.push((await ws.stub.apply(ws.owner, batch([createOp(`p${i}`, null, rank + String(i + 1), { teamspaceId: ws.generalId })]))).seq);
	for (const [i, c] of sockets.entries()) {
		await c.log.wait((m) => (m.t === 'diff' || m.t === 'head') && m.seq === seqs[2], froms[i]);
		const seen = c.log.messages.slice(froms[i]).flatMap((m) => (m.t === 'diff' || m.t === 'head' ? [m.seq] : []));
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		const diffs = c.log.messages.slice(froms[i]).filter((m) => m.t === 'diff');
		expect(diffs.length).toBeGreaterThan(0);
	}
	expect((await ws.stub.liveStats()).shards.batches).toBeGreaterThan(0);
	for (const c of sockets) c.ws.close();
});

test('a closed socket is forgotten by the Workspace DO and the shard', async () => {
	const ws = await createWorkspace('shard-close');
	await ws.stub.configureShards({ count: 1, localMax: 0 });
	const c = await connect(ws.id, dev('alice'));
	c.rawHello({ subs: tree });
	await c.log.wait((m) => m.t === 'head');
	expect((await ws.stub.liveStats()).shards.sockets).toEqual([1]);
	c.ws.close(1000, 'bye');
	await vi.waitFor(async () => {
		const stats = await ws.stub.liveStats();
		expect(stats.streams).toBe(0);
		expect(stats.shards.sockets).toEqual([0]);
		expect(await shardStub(ws.id, 0).count()).toBe(0);
	});
});

test('both the Workspace DO and a shard can hibernate while sockets stay open and keep receiving', async () => {
	const ws = await createWorkspace('shard-hib');
	await ws.stub.configureShards({ count: 2, localMax: 0 });
	const a = await connect(ws.id, dev('alice'));
	const b = await connect(ws.id, dev('bob'));
	for (const c of [a, b]) {
		c.rawHello({ subs: tree });
		await c.log.wait((m) => m.t === 'head');
	}
	const [rank] = ranks(1);
	let n = 0;
	const write = async () => (await ws.stub.apply(ws.owner, batch([createOp(`h${++n}`, null, rank + String(n), { teamspaceId: ws.generalId })]))).seq;
	const delivered = async (seq: number) => {
		for (const c of [a, b]) await c.log.wait((m) => (m.t === 'diff' || m.t === 'head') && m.seq >= seq);
	};

	await evictDurableObject(ws.stub);
	await delivered(await write());
	await evictDurableObject(shardStub(ws.id, 0));
	await evictDurableObject(shardStub(ws.id, 1));
	await delivered(await write());
	// A frame after both woke: the Workspace DO rebuilt its remote sockets from SQL, the shards theirs from the attachments.
	a.send({ t: 'subscribe', id: 'page', sub: { kind: 'page', pageIds: [] } });
	await a.log.wait((m) => m.t === 'snapshot' && m.id === 'page');
	await evictDurableObject(ws.stub);
	await evictDurableObject(shardStub(ws.id, 0));
	await delivered(await write());
	expect((await ws.stub.liveStats()).shards.sockets.reduce((x, y) => x + y, 0)).toBe(2);
	a.ws.close();
	b.ws.close();
});

test('the oRPC procedures and their hello stream work on a shard socket', async () => {
	const ws = await createWorkspace('shard-orpc');
	await ws.stub.configureShards({ count: 1, localMax: 0 });
	const c = await connect(ws.id, dev('alice'));
	expect(await c.client.ping()).toMatchObject({ pong: true, actor: { userId: 'alice' } });
	const log = await c.hello({ subs: tree });
	await log.wait((m) => m.t === 'head');
	const from = log.messages.length;
	const [rank] = ranks(1);
	const { seq } = await ws.stub.apply(ws.owner, batch([createOp('o1', null, rank + '1', { teamspaceId: ws.generalId })]));
	expect(await log.wait((m) => m.t === 'diff', from)).toMatchObject({ seq });
	c.ws.close();
});

test('a role change closes the socket; a rename updates the attachment the shard holds', async () => {
	const ws = await createWorkspace('shard-role');
	await ws.stub.configureShards({ count: 1, localMax: 0 });
	await ws.stub.syncMember({ userId: 'carol', role: 'member', name: 'Carol' });
	const c = await connect(ws.id, { ...dev('carol'), 'x-flarion-dev-role': 'member' });
	expect(await c.client.ping()).toMatchObject({ actor: { userId: 'carol' } });
	await ws.stub.syncMember({ userId: 'carol', role: 'member', name: 'Caroline' });
	await vi.waitFor(async () => expect((await c.client.ping()).actor).toMatchObject({ name: 'Caroline' }));
	await ws.stub.syncMember({ userId: 'carol', role: 'guest', name: 'Caroline' });
	expect((await c.closed).code).toBe(4503);
});

test('removing a member closes the sockets they hold on shards', async () => {
	const ws = await createWorkspace('shard-remove');
	await ws.stub.configureShards({ count: 2, localMax: 0 });
	await ws.stub.syncMember({ userId: 'dave', role: 'member', name: 'Dave' });
	const c = await connect(ws.id, dev('dave'));
	c.rawHello({ subs: tree });
	await c.log.wait((m) => m.t === 'head');
	await ws.stub.syncMember({ userId: 'dave', role: null, removed: true });
	expect((await c.closed).code).toBe(4403);
	await vi.waitFor(async () => expect((await ws.stub.liveStats()).shards.sockets.reduce((x, y) => x + y, 0)).toBe(0));
});
