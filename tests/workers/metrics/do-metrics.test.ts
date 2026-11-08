/**
 * What the Workspace DO writes to Analytics Engine: a `mutation` and a `fanout` point per commit (edit to diff, fan-out
 * size), a `reconnect` point per socket `hello` (`resume` when it carries a last seq), and the hourly `storage` and
 * `subs` gauges. The object reads its own `env.METRICS`, so the metrics module is replaced by a recorder here.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const written: { name: string; point: { labels: readonly string[]; value: number; extra: readonly number[] } }[] = [];
globalThis.__flarionMetricsTap = (p) => written.push({ name: p.indexes![0] as string, point: { labels: p.blobs as string[], value: p.doubles![0] as number, extra: (p.doubles as number[]).slice(1) } });

import { actorOf, batch, createOp, createWorkspace, freshId, inside, rankAfter } from '../workspace/helpers';
import { connect, workspaceStub } from '../socket/helpers';

beforeEach(() => void (written.length = 0));
const named = (name: string) => written.filter((w) => w.name === name);

afterAll(() => void (globalThis.__flarionMetricsTap = undefined));

describe('Workspace DO metrics', () => {
	it('writes the commit latency, the operation count and the fan-out for every commit', async () => {
		const ws = await createWorkspace('metrics');
		written.length = 0;
		await ws.stub.apply(ws.owner, batch([createOp('m1', null, rankAfter(null), { teamspaceId: ws.generalId, values: { title: 'One' } })]));
		const mutation = named('mutation');
		expect(mutation).toHaveLength(1);
		expect(mutation[0]!.point.labels).toEqual(['ok']);
		expect(mutation[0]!.point.value).toBeGreaterThanOrEqual(0);
		expect(mutation[0]!.point.extra[0]!).toBeGreaterThan(0); // change rows
		const fanout = named('fanout');
		expect(fanout).toHaveLength(1);
		expect(fanout[0]!.point.value).toBe(0); // nobody listening
		void actorOf;
	});

	it('counts the sockets a commit reached, and tells a first connection from a reconnect', async () => {
		const id = freshId('metrics-socket');
		const ws = await createWorkspace('metrics-socket');
		void id;
		const a = await connect(ws.id, { 'x-flarion-dev-actor': ws.owner.userId, 'x-flarion-dev-role': 'owner' });
		a.rawHello();
		const b = await connect(ws.id, { 'x-flarion-dev-actor': ws.owner.userId, 'x-flarion-dev-role': 'owner' });
		b.rawHello({ lastSeq: 0 });
		await vi.waitFor(() => expect(named('reconnect').map((r) => r.point.labels[0]).sort()).toEqual(['fresh', 'resume']), { timeout: 5000 });
		written.length = 0;
		await ws.stub.apply(ws.owner, batch([createOp('m2', null, rankAfter(null), { teamspaceId: ws.generalId, values: { title: 'Two' } })]));
		expect(named('fanout')[0]!.point.value).toBe(2);
		a.ws.close();
		b.ws.close();
	});

	it('writes the storage and live-loop gauges when the alarm fires', async () => {
		const ws = await createWorkspace('metrics-gauges');
		written.length = 0;
		await inside(ws.stub, async (_sql, _state, instance) => void (await instance.alarm()));
		const storage = named('storage');
		expect(storage).toHaveLength(1);
		expect(storage[0]!.point.labels).toEqual([ws.id]);
		expect(storage[0]!.point.value).toBeGreaterThan(0);
		const subs = named('subs');
		expect(subs).toHaveLength(1);
		expect(subs[0]!.point.labels).toEqual([ws.id]);
		void workspaceStub;
	});
});
