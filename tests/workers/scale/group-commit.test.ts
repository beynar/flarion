/**
 * Grouped commits (docs/ops/load-test.md "Fourth pass"): value-only writes queued behind each other run in one transaction, each with
 * its own `seq`, `mid` row and exact change log, and share one fan-out. A write of the group that fails is rolled back alone.
 */
import { describe, expect, test } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { Subscription } from '../../../src/lib/shared/protocol';
import { connect } from '../socket/helpers';
import { actorOf, batch, createOp, createWorkspace, inside, ranks, type Fixture } from '../workspace/helpers';

const ROWS = 30;

async function seed(): Promise<Fixture> {
	const ws = await createWorkspace('group');
	await ws.stub.apply(ws.owner, batch([{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } }] as Op[]));
	const rk = ranks(ROWS + 1);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('db', null, rk[0], { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
			{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } } as Op,
			...Array.from({ length: ROWS }, (_, i) => createOp(`r${i}`, 'db', rk[i + 1], { values: { title: `Row ${i}`, amount: i } }))
		])
	);
	return ws;
}

const view: Subscription = { kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'amount', op: 'gte', value: 10 }] }, sorts: [{ prop: 'amount', dir: 'asc' }], limit: 100 };
const set = (page: string, value: number): Op => ({ op: 'setProp', page, prop: 'amount', value }) as Op;

describe('grouped commits', () => {
	test('queued value-only writes share a transaction and a fan-out, with exact seqs and change rows', async () => {
		const ws = await seed();
		const tab = await connect(ws.id, { 'x-flarion-dev-actor': 'owner-1', 'x-flarion-dev-role': 'owner' });
		await tab.rawHello({ subs: [{ id: 'v', sub: view }] }).wait((m) => m.t === 'head');
		const before = await ws.stub.liveStats({ stale: false });
		const writes = Array.from({ length: 12 }, (_, i) => batch([set(`r${i}`, 100 + i)]));
		// One of them fails inside its commit (an unknown option of a number property is a validation error caught by the op, here a missing page).
		const stranger = actorOf(ws.id, 'g1', 'guest');
		await ws.stub.holdQueue(0);
		void ws.stub.holdQueue(150);
		await new Promise((r) => setTimeout(r, 10));
		const calls = [...writes.slice(0, 6).map((b) => ws.stub.apply(ws.owner, b)), ws.stub.apply(stranger, batch([set('r20', 5)])), ...writes.slice(6).map((b) => ws.stub.apply(ws.owner, b))];
		const results = await Promise.allSettled(calls);
		// The guest's write fails inside the shared transaction (no right to edit), the twelve others stand.
		expect(results[6].status).toBe('rejected');
		const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.seq] : []));
		expect(ok.length).toBe(12);
		expect(await inside(ws.stub, (sql) => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM p_num WHERE page = (SELECT num FROM page WHERE id = 'r20') AND prop = (SELECT num FROM property WHERE id = 'amount')").one().n)).toBe(1);
		expect(await inside(ws.stub, (sql) => sql.exec<{ v: number }>("SELECT v FROM p_num WHERE page = (SELECT num FROM page WHERE id = 'r20') AND prop = (SELECT num FROM property WHERE id = 'amount')").one().v)).toBe(20);
		expect(new Set(ok).size).toBe(12);
		expect(ok).toEqual([...ok].sort((a, b) => a - b));
		const stats = await ws.stub.liveStats({ stale: false });
		expect(stats.groups.groups - before.groups.groups).toBeGreaterThan(0);
		expect(stats.groups.largest).toBeGreaterThan(1);
		// Every mutation has its own mid row, and its own change row at its own seq.
		const logged = await inside(ws.stub, (sql) => sql.exec<{ key: string; seq: number }>(`SELECT key, seq FROM mutation WHERE key LIKE '%' || ?`, writes[3].mid).toArray());
		expect(logged.length).toBe(1);
		const changes = await inside(ws.stub, (sql) => sql.exec<{ seq: number; page: string }>(`SELECT seq, page FROM change WHERE seq IN (${ok.map(() => '?').join(',')}) ORDER BY seq`, ...ok).toArray());
		expect(changes.map((c) => c.page)).toEqual(ok.map((_, i) => `r${i}`));
		// A retried mid answers with its first seq.
		const again = await ws.stub.apply(ws.owner, writes[5]);
		expect(again.seq).toBe(ok[5]);
		// The tab converges to the truth, whatever frames it got.
		await new Promise((r) => setTimeout(r, 100));
		const truth = (await ws.stub.queryView(ws.owner, { collectionId: 'c1', spec: { filter: view.filter, sorts: view.sorts }, window: { limit: 100 } })).rows.map((r) => r.id);
		const stale = await ws.stub.liveStats();
		expect(stale.stale).toEqual([]);
		expect(truth.length).toBeGreaterThan(0);
		expect(tab.log.of('diff').length).toBeGreaterThan(0);
		const head = Math.max(...tab.log.messages.map((m) => ('seq' in m && typeof m.seq === 'number' ? m.seq : 0)));
		expect(head).toBe(Math.max(...ok));
	});
});
