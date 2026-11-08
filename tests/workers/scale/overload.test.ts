/**
 * The "Workspace DO overloaded" runbook (docs/PLAN.md "Security and reliability"): hidden tabs stop being re-evaluated and
 * get fresh snapshots when they come back, commits waiting behind other work share one fan-out, nothing is dropped, and
 * the object says so. `forceOverload` stands in for load the test box cannot produce.
 */
import { describe, expect, test } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { ServerMessage, Subscription } from '../../../src/lib/shared/protocol';
import { rng } from '../../unit/shared/helpers';
import { connect, type Connection } from '../socket/helpers';
import { batch, createOp, createWorkspace, ranks, type Fixture } from '../workspace/helpers';

const ROWS = 40;

async function seed(): Promise<Fixture> {
	const ws = await createWorkspace('overload');
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'status', name: 'Status', type: 'status', config: { options: [], groups: [] } } },
			{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } }
		] as Op[])
	);
	const rk = ranks(ROWS + 1);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('db', null, rk[0], { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
			{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } } as Op,
			...Array.from({ length: ROWS }, (_, i) => createOp(`r${i}`, 'db', rk[i + 1], { values: { title: `Row ${i}`, status: i % 2 ? 'done' : 'not_started', amount: i } }))
		])
	);
	return ws;
}

const view: Subscription = { kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'status', op: 'is', value: 'done' }] }, sorts: [{ prop: 'amount', dir: 'asc' }], limit: 100 };

async function tab(ws: Fixture, user: string): Promise<Connection> {
	const conn = await connect(ws.id, { 'x-flarion-dev-actor': user, 'x-flarion-dev-role': user === 'owner-1' ? 'owner' : 'member' });
	await conn.rawHello({ subs: [{ id: 'v', sub: view }] }).wait((m) => m.t === 'head');
	return conn;
}

/** The ids a tab holds for the view, rebuilt from its snapshot and every diff after it. */
function windowOf(messages: ServerMessage[]): string[] {
	let ids: string[] = [];
	for (const m of messages) {
		if (m.t === 'snapshot' && m.id === 'v' && m.kind === 'view') ids = m.rows.map((r) => r.id);
		if (m.t === 'diff') {
			for (const sub of m.subs) {
				if (sub.id !== 'v') continue;
				for (const op of sub.ops) {
					if (op.op === 'remove') ids = ids.filter((id) => id !== op.id);
					if (op.op === 'add') ids.splice(op.index, 0, (op.row as { id: string }).id);
					if (op.op === 'move') {
						ids = ids.filter((id) => id !== op.id);
						ids.splice(op.index, 0, op.id);
					}
				}
			}
		}
	}
	return ids;
}

const truth = async (ws: Fixture): Promise<string[]> => (await ws.stub.queryView(ws.owner, { collectionId: 'c1', spec: { filter: view.filter, sorts: view.sorts }, window: { limit: 100 } })).rows.map((r) => r.id);

describe('overload governor', () => {
	test('a hidden tab is skipped while overloaded and gets fresh snapshots when it is visible again', async () => {
		const ws = await seed();
		const active = await tab(ws, 'owner-1');
		const hidden = await tab(ws, 'u1');
		hidden.send({ t: 'visibility', hidden: true });
		await new Promise((r) => setTimeout(r, 30));
		await ws.stub.forceOverload(60_000);
		const before = hidden.log.messages.length;
		for (const row of ['r0', 'r2', 'r4', 'r1']) await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: row, prop: 'status', value: row === 'r1' ? 'not_started' : 'done' } as Op]));
		// The visible tab saw every write; the hidden one nothing at all (no diff, not even a head).
		expect(active.log.of('diff').length).toBeGreaterThanOrEqual(1);
		expect(hidden.log.messages.length).toBe(before);
		expect(windowOf(active.log.messages)).toEqual(await truth(ws));
		expect((await ws.stub.liveStats({ stale: false })).governor.overloaded).toBe(true);

		// Back on the tab: `resumed` (snapshot) and a fresh snapshot of every subscription, equal to a fresh query.
		hidden.send({ t: 'visibility', hidden: false });
		await hidden.log.wait((m) => m.t === 'resumed', before);
		await hidden.log.wait((m) => m.t === 'head', before);
		const mine = hidden.log.messages.slice(before);
		expect(windowOf(mine)).toEqual(await truth(ws));
		// And it is live again.
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'r6', prop: 'status', value: 'done' } as Op]));
		await hidden.log.wait((m) => m.t === 'diff', before + mine.length);
		expect(windowOf(hidden.log.messages.slice(before))).toEqual(await truth(ws));
		active.ws.close();
		hidden.ws.close();
	});

	test('a hidden tab keeps receiving everything when the object is not overloaded', async () => {
		const ws = await seed();
		const hidden = await tab(ws, 'u1');
		hidden.send({ t: 'visibility', hidden: true });
		await new Promise((r) => setTimeout(r, 30));
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'r0', prop: 'status', value: 'done' } as Op]));
		await hidden.log.wait((m) => m.t === 'diff');
		expect(windowOf(hidden.log.messages)).toEqual(await truth(ws));
		// Becoming visible costs nothing: it was never skipped.
		const count = hidden.log.messages.length;
		hidden.send({ t: 'visibility', hidden: false });
		await new Promise((r) => setTimeout(r, 60));
		expect(hidden.log.messages.length).toBe(count + 0);
		hidden.ws.close();
	});

	test('commits waiting behind other work share one fan-out, and every socket ends exact', async () => {
		const ws = await seed();
		const a = await tab(ws, 'owner-1');
		const b = await tab(ws, 'u1');
		await ws.stub.forceOverload(60_000);
		await ws.stub.liveStats({ resetPerf: true, stale: false });
		const r = rng(5);
		const N = 30;
		// A busy object: the queue is occupied while the writes arrive, so they wait behind it (and behind each other).
		const busy = ws.stub.holdQueue(150);
		await new Promise((r) => setTimeout(r, 20));
		const seqs = await Promise.all(
			Array.from({ length: N }, (_, i) => ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: `r${i}`, prop: 'status', value: r.pick(['done', 'not_started', 'in_progress']) } as Op])))
		);
		await busy;
		const last = Math.max(...seqs.map((s) => s.seq));
		await a.log.wait((m) => (m.t === 'diff' || m.t === 'head') && m.seq === last);
		await b.log.wait((m) => (m.t === 'diff' || m.t === 'head') && m.seq === last);
		const stats = await ws.stub.liveStats({ stale: true });
		// Merged: fewer fan-outs than commits, none dropped (the units equal a fresh evaluation, so do the windows).
		expect(stats.perf.fanOuts).toBeLessThan(N);
		expect(stats.stale).toEqual([]);
		const want = await truth(ws);
		expect(windowOf(a.log.messages)).toEqual(want);
		expect(windowOf(b.log.messages)).toEqual(want);
		expect(stats.governor.merged).toBeGreaterThan(0);
		a.ws.close();
		b.ws.close();
	});

	test('a tab that connects while fan-outs are held back gets a snapshot that is not older than the commits before it', async () => {
		const ws = await seed();
		const a = await tab(ws, 'owner-1');
		await ws.stub.forceOverload(60_000);
		const busy = ws.stub.holdQueue(200);
		await new Promise((r) => setTimeout(r, 20));
		const writes = Promise.all(
			Array.from({ length: 12 }, (_, i) => ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: `r${i}`, prop: 'status', value: i % 3 === 0 ? 'done' : 'not_started' } as Op])))
		);
		// The late tab dials while the commits wait in the queue; its hello is queued behind them.
		const late = await connect(ws.id, { 'x-flarion-dev-actor': 'u1', 'x-flarion-dev-role': 'member' });
		late.rawHello({ subs: [{ id: 'v', sub: view }] });
		await Promise.all([busy, writes]);
		await late.log.wait((m) => m.t === 'head');
		await new Promise((r) => setTimeout(r, 100));
		const want = await truth(ws);
		expect(windowOf(late.log.messages)).toEqual(want);
		expect(windowOf(a.log.messages)).toEqual(want);
		expect((await ws.stub.liveStats({ stale: true })).stale).toEqual([]);
		a.ws.close();
		late.ws.close();
	});

	test('a commit with nothing waiting behind it has its own fan-out', async () => {
		const ws = await seed();
		const a = await tab(ws, 'owner-1');
		await ws.stub.liveStats({ resetPerf: true, stale: false });
		// One at a time: no commit ever waits behind another, so none is merged (the governor is not involved either way).
		const N = 4;
		for (let i = 0; i < N; i++) await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: `r${i}`, prop: 'amount', value: 100 + i } as Op]));
		const stats = await ws.stub.liveStats({ stale: false });
		expect(stats.perf.fanOuts).toBe(N);
		expect(stats.governor.merged).toBe(0);
		expect(stats.governor.overloaded).toBe(false);
		a.ws.close();
	});

	test('commits that cluster share fan-outs without any overload, and every socket ends exact', async () => {
		const ws = await seed();
		const a = await tab(ws, 'owner-1');
		await ws.stub.liveStats({ resetPerf: true, stale: false });
		// Five: fewer than the six queued tasks that would make the governor call it an overload.
		const N = 5;
		const busy = ws.stub.holdQueue(100);
		await new Promise((r) => setTimeout(r, 15));
		const seqs = await Promise.all(Array.from({ length: N }, (_, i) => ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: `r${i}`, prop: 'amount', value: 200 + i } as Op]))));
		await busy;
		const last = Math.max(...seqs.map((s) => s.seq));
		await a.log.wait((m) => (m.t === 'diff' || m.t === 'head') && m.seq === last);
		const stats = await ws.stub.liveStats({ stale: true });
		expect(stats.governor.overloaded).toBe(false);
		expect(stats.perf.fanOuts).toBeLessThan(N);
		expect(stats.governor.merged).toBeGreaterThan(0);
		expect(stats.stale).toEqual([]);
		expect(windowOf(a.log.messages)).toEqual(await truth(ws));
		a.ws.close();
	});
});
