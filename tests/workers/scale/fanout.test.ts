/**
 * The fan-out at the scale the plan names (docs/PLAN.md "Performance, limits and scaling": one workspace, 1,000 tabs, most of
 * them on a handful of shared views), and the behaviours the load test on staging (docs/ops/load-test.md) taught:
 *
 *   - **A derivation per person and view shape, not per tab or per commit.** Counters, not clocks: the number of derivations
 *     of a commit is bounded by (people x shapes), and the window of an unchanged unit is not derived again for a commit that
 *     only edits a cell of it. A loose time ceiling guards the rest (the measured cost is a tenth of it).
 *   - **Heads are batched past `headCoalescing.min` recipients.** The tab of the person who wrote gets its head at once (it drops
 *     its optimistic layer on it); the others get the head of the last finished fan-out with the next batch. Nothing is lost.
 */
import { describe, expect, test } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { Subscription } from '../../../src/lib/shared/protocol';
import { connect, type Connection } from '../socket/helpers';
import { batch, createOp, createWorkspace, ranks, type Fixture } from '../workspace/helpers';

const ROWS = 60;
const PEOPLE = 10;

async function seed(label: string): Promise<Fixture> {
	const ws = await createWorkspace(label);
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'status', name: 'Status', type: 'status', config: { options: [], groups: [] } } },
			{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } },
			{ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } }
		] as Op[])
	);
	const rk = ranks(ROWS + 1);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('db', null, rk[0], { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
			{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } } as Op,
			...Array.from({ length: ROWS }, (_, i) => createOp(`r${i}`, 'db', rk[i + 1], { values: { title: `Row ${i}`, status: i % 2 ? 'done' : 'not_started', amount: i, notes: `n${i}` } }))
		])
	);
	return ws;
}

const view = (extra: Record<string, unknown>): Subscription => ({ kind: 'view', collectionId: 'c1', ...extra }) as Subscription;
const person = (i: number) => (i === 0 ? 'owner-1' : `u${i}`);

async function tab(ws: Fixture, user: string, subs: { id: string; sub: Subscription }[]): Promise<Connection> {
	const conn = await connect(ws.id, { 'x-flarion-dev-actor': user, 'x-flarion-dev-role': user === 'owner-1' ? 'owner' : 'member' });
	await conn.rawHello({ subs }).wait((m) => m.t === 'head');
	return conn;
}

describe('fan-out to many tabs', () => {
	test('derives once per person and view shape, and not at all for the window of a unit a commit does not change', async () => {
		const ws = await seed('fanout-derive');
		const subs = [
			{ id: 'v0', sub: view({ sorts: [{ prop: 'amount', dir: 'desc' }], limit: 30 }) },
			{ id: 'v1', sub: view({ filter: { and: [{ prop: 'status', op: 'is', value: 'done' }] }, sorts: [{ prop: 'title', dir: 'asc' }], limit: 30 }) },
			{ id: 'v2', sub: view({ props: ['title', 'notes'], limit: 20 }) }
		];
		const tabs: Connection[] = [];
		for (let t = 0; t < 120; t++) tabs.push(await tab(ws, person(t % PEOPLE), subs));
		await ws.stub.liveStats({ resetPerf: true, stale: false });

		// Edits of a cell that no view sorts or filters by: no unit changes, only cells of the pages in a window.
		const WRITES = 8;
		for (let i = 0; i < WRITES; i++) await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: `r${i}`, prop: 'notes', value: `edit ${i}` } as Op]));
		const { perf } = await ws.stub.liveStats({ resetPerf: true, stale: false });
		expect(perf.fanOuts).toBe(WRITES);
		// Tabs of one person with the same views are one audience: at most 3 views x 10 people subscriptions are derived per
		// commit (360 would be one per tab and view), and `framesSent` still counts every tab.
		expect(perf.subsDerived / WRITES).toBeLessThanOrEqual(subs.length * PEOPLE);
		expect(perf.framesSent).toBe(WRITES * 120);
		// A derivation costs microseconds; 120 tabs never cost anything like this per commit (the measured fan-out is a few ms).
		expect(perf.totalMs / WRITES).toBeLessThan(60);
		for (const t of tabs) t.ws.close();
	}, 60_000);

	test('a window is correct after cells change, rows move in and out, and a person gains and loses a page', async () => {
		const ws = await seed('fanout-correct');
		const filter = { and: [{ prop: 'status', op: 'is', value: 'done' }] };
		const sorts = [{ prop: 'amount', dir: 'asc' }];
		const sub = view({ filter, sorts, limit: 12 });
		const a = await tab(ws, 'owner-1', [{ id: 'v', sub }]);
		const b = await tab(ws, 'u1', [{ id: 'v', sub }]);
		const idsOf = (c: Connection): string[] => {
			let ids: string[] = [];
			for (const m of c.log.messages) {
				if (m.t === 'snapshot' && m.kind === 'view') ids = m.rows.map((r) => r.id);
				if (m.t !== 'diff') continue;
				for (const s of m.subs)
					for (const op of s.ops) {
						if (op.op === 'remove') ids = ids.filter((id) => id !== op.id);
						if (op.op === 'add') ids.splice(op.index, 0, (op.row as { id: string }).id);
						if (op.op === 'move') {
							ids = ids.filter((id) => id !== op.id);
							ids.splice(op.index, 0, op.id);
						}
					}
			}
			return ids;
		};
		const truth = async () => (await ws.stub.queryView(ws.owner, { collectionId: 'c1', spec: { filter, sorts } as never, window: { limit: 12 } })).rows.map((r) => r.id);
		const steps: Op[][] = [
			[{ op: 'setProp', page: 'r1', prop: 'notes', value: 'a' } as Op],
			[{ op: 'setProp', page: 'r3', prop: 'notes', value: 'b' } as Op],
			[{ op: 'setProp', page: 'r0', prop: 'status', value: 'done' } as Op],
			[{ op: 'setProp', page: 'r5', prop: 'notes', value: 'c' } as Op],
			[{ op: 'setProp', page: 'r7', prop: 'amount', value: -5 } as Op],
			[{ op: 'setProp', page: 'r1', prop: 'status', value: 'not_started' } as Op],
			[{ op: 'setProp', page: 'r0', prop: 'notes', value: 'd' } as Op]
		];
		for (const ops of steps) {
			const { seq } = await ws.stub.apply(ws.owner, batch(ops));
			for (const c of [a, b]) await c.log.wait((m) => (m.t === 'diff' || m.t === 'head') && m.seq >= seq);
			expect(idsOf(a)).toEqual(await truth());
			expect(idsOf(b)).toEqual(await truth());
		}
		a.ws.close();
		b.ws.close();
	}, 30_000);
});

describe('heads at scale', () => {
	test('past the threshold the person who wrote gets the head at once and the others with the next batch', async () => {
		const ws = await seed('fanout-heads');
		await ws.stub.setHeadCoalescing({ min: 6, ms: 120 });
		// Nothing in this view reads `amount`: a write of it touches no unit and no cell it shows.
		const quiet = [{ id: 'q', sub: view({ filter: { and: [{ prop: 'status', op: 'is', value: 'done' }] }, props: ['title'], limit: 20 }) }];
		const writer = [await tab(ws, 'owner-1', quiet), await tab(ws, 'owner-1', quiet)];
		const others: Connection[] = [];
		for (let t = 0; t < 8; t++) others.push(await tab(ws, `u${1 + (t % 4)}`, quiet));

		const marks = [...writer, ...others].map((c) => c.log.messages.length);
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'r2', prop: 'amount', value: 99 } as Op]));
		// `apply` returns after the fan-out: the writer's tabs have their heads, the others do not yet.
		for (const [i, c] of writer.entries()) expect(c.log.messages.slice(marks[i]).some((m) => m.t === 'head' && m.seq === seq)).toBe(true);
		for (const [i, c] of others.entries()) expect(c.log.messages.slice(marks[writer.length + i]).some((m) => m.t === 'head' && m.seq === seq)).toBe(false);
		// One closes before the batch goes out: the batch skips it without a fuss.
		others[0].ws.close();
		// Then everyone who is still there is told how far the log has come, once.
		for (const [i, c] of others.entries().drop(1)) {
			const head = await c.log.wait((m) => m.t === 'head' && m.seq >= seq, marks[writer.length + i]);
			expect((head as { seq: number }).seq).toBe(seq);
		}
		// Two commits inside one window of time share the batch: the head that arrives is the last one.
		const first = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'r4', prop: 'amount', value: 1 } as Op]));
		const second = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'r6', prop: 'amount', value: 2 } as Op]));
		const heads = others.slice(1).map((c) => c.log.messages.length);
		const tail = await others[1].log.wait((m) => m.t === 'head' && m.seq >= second.seq, heads[0] - 1);
		expect((tail as { seq: number }).seq).toBe(second.seq);
		expect(second.seq).toBeGreaterThan(first.seq);

		// A commit that does change what the tabs show reaches every one of them at once, whatever the threshold.
		const before = others.slice(1).map((c) => c.log.messages.length);
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'r0', prop: 'status', value: 'done' } as Op]));
		for (const [i, c] of others.slice(1).entries()) expect(c.log.messages.slice(before[i]).some((m) => m.t === 'diff')).toBe(true);
		for (const c of [...writer, ...others]) c.ws.close();
	}, 30_000);
});
