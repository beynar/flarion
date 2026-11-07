/**
 * The raw JSON protocol of `src/lib/shared/protocol.ts` on the workspace socket: what the app's socket
 * client speaks (string-`t` frames), next to the oRPC frames (numeric `t`) that share the connection.
 */
import { evictDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { serverMessageSchema, type ServerMessage } from '../../../src/lib/shared/protocol';
import * as v from 'valibot';
import { batch, createOp, createWorkspace, ranks } from '../workspace/helpers';
import { connect } from './helpers';

const dev = (user: string) => ({ 'x-flarion-dev-actor': user });

test('hello, subscribe, diff, head, ping and unsubscribe as raw frames; every message satisfies the schema', async () => {
	const ws = await createWorkspace('raw');
	const c = await connect(ws.id, dev('alice'));
	const log = c.rawHello({ subs: [{ id: 'tree', sub: { kind: 'tree', parents: [null] } }] });
	await log.wait((m) => m.t === 'head');
	expect(log.messages.map((m) => m.t)).toEqual(['welcome', 'snapshot', 'head']);

	c.send({ t: 'ping' });
	await log.wait((m) => m.t === 'pong');
	c.send({ t: 'subscribe', id: 'page', sub: { kind: 'page', pageIds: [] } });
	await log.wait((m) => m.t === 'snapshot' && m.id === 'page');

	const [rank] = ranks(1);
	const from = log.messages.length;
	const { seq } = await ws.stub.apply(ws.owner, batch([createOp('p1', null, rank + '5', { teamspaceId: ws.generalId })]));
	const diff = await log.wait((m) => m.t === 'diff', from);
	expect(diff).toMatchObject({ t: 'diff', seq, subs: [{ id: 'tree', ops: [{ op: 'add' }, { op: 'count', total: 2 }] }] });

	c.send({ t: 'unsubscribe', id: 'tree' });
	await vi.waitFor(async () => expect((await ws.stub.liveStats()).units).toBe(0));
	const from2 = log.messages.length;
	const { seq: seq2 } = await ws.stub.apply(ws.owner, batch([createOp('p2', null, rank + '6')]));
	// The tree is gone: this commit only advances the head.
	expect(await log.wait((m) => m.t === 'head' && m.seq === seq2, from2)).toEqual({ t: 'head', seq: seq2 });

	for (const m of log.messages) expect(v.safeParse(serverMessageSchema, m).success, JSON.stringify(m)).toBe(true);
	c.ws.close();
});

test('raw frames and oRPC frames share one socket', async () => {
	const ws = await createWorkspace('mixed');
	const c = await connect(ws.id, dev('alice'));
	const log = c.rawHello({});
	await log.wait((m) => m.t === 'head');
	// An oRPC call on the same connection still works.
	const pong = await c.client.ping();
	expect(pong).toMatchObject({ pong: true, actor: { userId: 'alice' } });
	c.send({ t: 'ping' });
	await log.wait((m) => m.t === 'pong');
	c.ws.close();
});

test('malformed protocol frames close the socket with BAD_MESSAGE; subscribing before hello is an error frame', async () => {
	const ws = await createWorkspace('raw-bad');
	const bad = await connect(ws.id, dev('alice'));
	bad.ws.send('{"t":"subscribe","id":"x","sub":{"kind":"nope"}}');
	expect((await bad.closed).code).toBe(4400);
	const unknown = await connect(ws.id, dev('alice'));
	unknown.ws.send('{"t":"launch-missiles"}');
	expect((await unknown.closed).code).toBe(4400);

	const early = await connect(ws.id, dev('bob'));
	early.send({ t: 'subscribe', id: 's', sub: { kind: 'tree', parents: [null] } });
	expect(await early.log.wait((m) => m.t === 'error')).toMatchObject({ t: 'error', code: 'bad_subscription' });
	early.ws.close();
});

test('an outdated build is closed with RELOAD_REQUIRED on a raw hello', async () => {
	const ws = await createWorkspace('raw-skew');
	const c = await connect(ws.id, dev('alice'));
	c.rawHello({ appVersion: '0.0.0' });
	expect((await c.closed).code).toBe(4426);
});

test('raw streams survive hibernation, and a reconnect resumes with its last seq', async () => {
	const ws = await createWorkspace('raw-hib');
	const c = await connect(ws.id, dev('alice'));
	const log = c.rawHello({ subs: [{ id: 'tree', sub: { kind: 'tree', parents: [null] } }] });
	await log.wait((m) => m.t === 'head');
	const lastSeq = (log.of('head')[0] as Extract<ServerMessage, { t: 'head' }>).seq;

	await evictDurableObject(ws.stub);
	expect(c.ws.readyState).toBe(WebSocket.OPEN);
	const from = log.messages.length;
	const [rank] = ranks(1);
	const { seq } = await ws.stub.apply(ws.owner, batch([createOp('p1', null, rank + '5', { teamspaceId: ws.generalId })]));
	expect(await log.wait((m) => m.t === 'diff', from)).toMatchObject({ seq });
	// Ping still answers on the new instance.
	c.send({ t: 'ping' });
	await log.wait((m) => m.t === 'pong', from);

	c.ws.close();
	await evictDurableObject(ws.stub);
	const back = await connect(ws.id, dev('alice'));
	const again = back.rawHello({ lastSeq, subs: [{ id: 'tree', sub: { kind: 'tree', parents: [null] } }] });
	await again.wait((m) => m.t === 'head');
	expect(again.of('resumed')).toMatchObject([{ mode: 'replay', fromSeq: lastSeq, seq }]);
	expect(again.of('snapshot')).toEqual([]);
	expect(JSON.stringify(again.of('diff'))).toContain('"p1"');
	back.ws.close();
});
