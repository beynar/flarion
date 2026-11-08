/**
 * The page value cache (docs/ops/load-test.md "Fourth pass"): a warm cache is patched from the change rows, so hundreds of value writes
 * (single, queued in groups, no-ops, nulls) keep every unit equal to a fresh SQL evaluation while the units are maintained from memory,
 * and anything that is not a plain value write (a trash, a definition) empties it and the next fan-out reads SQL again.
 */
import { describe, expect, test } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { Subscription } from '../../../src/lib/shared/protocol';
import { rng } from '../../unit/shared/helpers';
import { connect } from '../socket/helpers';
import { batch, createOp, createWorkspace, ranks, type Fixture } from '../workspace/helpers';

const ROWS = 60;

async function seed(): Promise<Fixture> {
	const ws = await createWorkspace('pcache');
	const opts = ['p1', 'p2', 'p3'].map((id) => ({ id, name: id.toUpperCase(), color: 'default' }));
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } },
			{ op: 'createProperty', property: { id: 'prio', name: 'Prio', type: 'select', config: { options: opts } } },
			{ op: 'createProperty', property: { id: 'done', name: 'Done', type: 'checkbox', config: {} } },
			{ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } },
			{ op: 'createProperty', property: { id: 'tags', name: 'Tags', type: 'multi_select', config: { options: ['t1', 't2', 't3'].map((id) => ({ id, name: id, color: 'default' })) } } }
		] as Op[])
	);
	const rk = ranks(ROWS + 1);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('db', null, rk[0], { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
			{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } } as Op,
			...Array.from({ length: ROWS }, (_, i) => createOp(`r${i}`, 'db', rk[i + 1], { values: { title: `Row ${i}`, amount: i, prio: opts[i % 3].id, done: i % 4 === 0, notes: `n${i}` } }))
		])
	);
	return ws;
}

const views: Subscription[] = [
	{ kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'amount', op: 'gte', value: 20 }] }, sorts: [{ prop: 'amount', dir: 'asc' }], limit: 30 },
	{ kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'done', op: 'is', value: false }] }, sorts: [{ prop: 'title', dir: 'desc' }], groupBy: { prop: 'prio' }, limit: 20 },
	{ kind: 'view', collectionId: 'c1', filter: { or: [{ prop: 'prio', op: 'is', value: 'p2' }, { prop: 'tags', op: 'contains', value: 't1' }] }, sorts: [{ prop: 'notes', dir: 'asc' }, { prop: 'amount', dir: 'desc' }], limit: 25 },
	{ kind: 'view', collectionId: 'c1', sorts: [{ prop: 'prio', dir: 'asc' }, { prop: 'title', dir: 'asc' }], groupBy: { prop: 'tags' }, limit: 15 }
] as Subscription[];

describe('page value cache', () => {
	test('value writes keep every unit equal to a fresh evaluation, from memory; a structural write empties the cache', { timeout: 120_000 }, async () => {
		const ws = await seed();
		const tab = await connect(ws.id, { 'x-flarion-dev-actor': 'owner-1', 'x-flarion-dev-role': 'owner' });
		await tab.rawHello({ subs: views.map((sub, i) => ({ id: `v${i}`, sub })) }).wait((m) => m.t === 'head');
		const r = rng(11);
		const value = (prop: string): unknown =>
			r.bool(0.1) ? null : prop === 'amount' ? r.int(0, 60) : prop === 'prio' ? r.pick(['p1', 'p2', 'p3']) : prop === 'done' ? r.bool() : prop === 'notes' ? `n${r.int(0, 9)}` : prop === 'title' ? `T${r.int(0, 20)}` : r.shuffle(['t1', 't2', 't3']).slice(0, r.int(0, 3));
		const write = (): Op => {
			const prop = r.pick(['amount', 'prio', 'done', 'notes', 'tags', 'title']);
			return { op: 'setProp', page: `r${r.int(0, ROWS - 1)}`, prop, value: value(prop) } as Op;
		};
		const before = (await ws.stub.liveStats({ stale: false })).memory!;
		for (let round = 0; round < 25; round++) {
			if (round % 2 === 0) {
				// queued: the group path
				void ws.stub.holdQueue(15);
				await new Promise((res) => setTimeout(res, 3));
				await Promise.all(Array.from({ length: r.int(2, 6) }, () => ws.stub.apply(ws.owner, batch([write()]))));
			} else for (let i = 0; i < 4; i++) await ws.stub.apply(ws.owner, batch([write()]));
			const stats = await ws.stub.liveStats();
			expect(stats.stale, `round ${round}`).toEqual([]);
		}
		const warm = (await ws.stub.liveStats({ stale: false })).memory!;
		expect(warm.units - before.units).toBeGreaterThan(50);
		expect(warm.patches).toBeGreaterThan(0);
		// the cache stayed warm through value writes: it was not emptied by them
		expect(warm.clears - before.clears).toBe(0);
		// A trash empties it, and the next write reads SQL again and is still right.
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'r7' } as Op]));
		const cold = (await ws.stub.liveStats({ stale: false })).memory!;
		expect(cold.clears).toBeGreaterThan(warm.clears);
		for (let i = 0; i < 6; i++) await ws.stub.apply(ws.owner, batch([write()]));
		expect((await ws.stub.liveStats()).stale).toEqual([]);
	});
});
