/**
 * Live views (docs/PLAN.md "Databases": "Live updates (incremental view maintenance)"): a `view` subscription is
 * a live query through the engine. Rows enter at their sorted position, leave (and the window refills), move when
 * their sort value changes, get cell updates and counts; grouped views have per-group windows; identical queries
 * share one evaluation; bulk edits send one message per socket.
 */
import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { DiffOp, ServerMessage, Subscription } from '../../../src/lib/shared/protocol';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { connect, type StreamLog } from '../socket/helpers';
import { SocketModel } from '../live/model';
import { actorOf, batch, createOp, createWorkspace, ranks, type Fixture } from './helpers';

type ViewSub = Extract<Subscription, { kind: 'view' }>;
const dev = (user: string, role = 'member') => ({ 'x-flarion-dev-actor': user, 'x-flarion-dev-role': role });
const opt = (id: string) => ({ id, name: id.toUpperCase(), color: 'default' as const });

/** A workspace with a database "db" whose rows are its children, and the properties the tests use. */
async function database(label: string, rows: { id: string; amount?: number; prio?: string; title?: string; done?: boolean }[], extra: Op[] = []): Promise<Fixture> {
	const ws = await createWorkspace(label);
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } },
			{ op: 'createProperty', property: { id: 'prio', name: 'Priority', type: 'select', config: { options: ['p1', 'p2', 'p3'].map(opt) } } },
			{ op: 'createProperty', property: { id: 'done', name: 'Done', type: 'checkbox', config: {} } },
			{ op: 'createProperty', property: { id: 'who', name: 'Who', type: 'person', config: {} } },
			{ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } }
		])
	);
	const rk = ranks(rows.length + 2);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('db', null, rk[0], { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
			{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } },
			...rows.map((r, i) => createOp(r.id, 'db', rk[i + 1], { values: { title: r.title ?? r.id, ...(r.amount !== undefined ? { amount: r.amount } : {}), ...(r.prio ? { prio: r.prio } : {}), ...(r.done !== undefined ? { done: r.done } : {}) } })),
			...extra
		])
	);
	return ws;
}

async function open(ws: Fixture, user: string, subs: Record<string, ViewSub>, role = 'member') {
	const conn = await connect(ws.id, dev(user, role));
	const log = await conn.hello({ subs: Object.entries(subs).map(([id, sub]) => ({ id, sub })) });
	await log.wait((m) => m.t === 'head');
	const model = new SocketModel();
	let cursor = model.follow(log.messages, 0);
	return {
		conn,
		log,
		model,
		/** Applies what arrived since the last call. */
		pump() {
			cursor = model.follow(log.messages, cursor);
			return model;
		},
		ids: (id: string) => model.windows.get(id)?.ids ?? [],
		async reached(seq: number) {
			await vi.waitFor(() => expect(this.pump().lastSeq).toBeGreaterThanOrEqual(seq), { timeout: 3000, interval: 10 });
		}
	};
}

const diffsAfter = (log: StreamLog, from: number) => log.messages.slice(from).filter((m): m is Extract<ServerMessage, { t: 'diff' }> => m.t === 'diff');
const opsOf = (log: StreamLog, from: number, id: string): DiffOp[] => diffsAfter(log, from).flatMap((d) => d.subs.filter((s) => s.id === id).flatMap((s) => s.ops));
const view = (extra: Partial<ViewSub> = {}): ViewSub => ({ kind: 'view', collectionId: 'c1', limit: 3, ...extra });

describe('a flat view', () => {
	test('rows enter at their sorted position, leave, move, update, and the window refills', async () => {
		const ws = await database('flat', [
			{ id: 'a', amount: 10 },
			{ id: 'b', amount: 30 },
			{ id: 'c', amount: 20 },
			{ id: 'd', amount: 40 },
			{ id: 'e', amount: 50 }
		]);
		const sorted = view({ sorts: [{ prop: 'amount', dir: 'asc' }], filter: { and: [{ prop: 'amount', op: 'gt', value: 5 }] } });
		const c = await open(ws, 'owner-1', { v: sorted }, 'owner');
		expect(c.ids('v')).toEqual(['a', 'c', 'b']);
		expect(c.model.windows.get('v')?.total).toBe(5);

		// A new row enters in the middle of the window: it pushes the last one out.
		let from = c.log.messages.length;
		let { seq } = await ws.stub.apply(ws.owner, batch([createOp('n', 'db', ranks(1)[0], { values: { title: 'n', amount: 15 } })]));
		await c.reached(seq);
		expect(c.ids('v')).toEqual(['a', 'n', 'c']);
		expect(opsOf(c.log, from, 'v').map((o) => o.op)).toEqual(['remove', 'add', 'count']);
		expect(opsOf(c.log, from, 'v')).toContainEqual({ op: 'count', total: 6 });

		// A sort value changes: the row moves, with no add and no remove.
		from = c.log.messages.length;
		({ seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'c', prop: 'amount', value: 12 }])));
		await c.reached(seq);
		expect(c.ids('v')).toEqual(['a', 'c', 'n']);
		expect(opsOf(c.log, from, 'v')).toEqual([
			{ op: 'move', id: 'c', index: 1 },
			{ op: 'update', id: 'c', prop: 'amount', value: 12 }
		]);

		// A row leaves (it no longer matches the filter): the window refills from below, the count drops.
		from = c.log.messages.length;
		({ seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'amount', value: 1 }])));
		await c.reached(seq);
		expect(c.ids('v')).toEqual(['c', 'n', 'b']);
		expect(opsOf(c.log, from, 'v').map((o) => o.op)).toEqual(['remove', 'add', 'update'.replace('update', 'count')].filter(Boolean));
		expect(c.model.windows.get('v')?.total).toBe(5);

		// Trashing a row removes it everywhere; restoring brings it back at its place.
		({ seq } = await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'c' }])));
		await c.reached(seq);
		expect(c.ids('v')).toEqual(['n', 'b', 'd']);
		({ seq } = await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'c' }])));
		await c.reached(seq);
		expect(c.ids('v')).toEqual(['c', 'n', 'b']);
		expect((await ws.stub.liveStats()).stale).toEqual([]);
		c.conn.ws.close();
	});

	test('a cell update reaches the window that shows the property, and only that one', async () => {
		const ws = await database('cells', [{ id: 'a', amount: 1 }, { id: 'b', amount: 2 }]);
		const c = await open(ws, 'owner-1', { all: view(), few: view({ props: ['amount'] }), other: view({ props: ['prio'] }) }, 'owner');
		const from = c.log.messages.length;
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'amount', value: 9 }]));
		await c.reached(seq);
		expect(opsOf(c.log, from, 'all')).toEqual([{ op: 'update', id: 'a', prop: 'amount', value: 9 }]);
		expect(opsOf(c.log, from, 'few')).toEqual([{ op: 'update', id: 'a', prop: 'amount', value: 9 }]);
		expect(opsOf(c.log, from, 'other')).toEqual([]);
		c.conn.ws.close();
	});

	test('a window grows with window({ id, limit }); rows beyond it are never sent', async () => {
		const ws = await database('grow', ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, amount: i })));
		const c = await open(ws, 'owner-1', { v: view({ sorts: [{ prop: 'amount', dir: 'asc' }], limit: 2 }) }, 'owner');
		expect(c.ids('v')).toEqual(['a', 'b']);
		const sent = JSON.stringify(c.log.messages);
		expect(sent).not.toContain('"id":"c"');
		c.conn.send({ t: 'window', id: 'v', limit: 4 });
		await vi.waitFor(() => expect(c.pump().windows.get('v')?.ids).toEqual(['a', 'b', 'c', 'd']));
		// A write at the front pushes a row out of the window, not into view of the rest.
		const from = c.log.messages.length;
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'f', prop: 'amount', value: -1 }]));
		await c.reached(seq);
		expect(c.ids('v')).toEqual(['f', 'a', 'b', 'c']);
		expect(opsOf(c.log, from, 'v').map((o) => o.op)).toEqual(['remove', 'add']);
		expect(JSON.stringify(c.log.messages.slice(from))).not.toContain('"id":"e"');
		c.conn.ws.close();
	});

	test('the subscription filter (a database_view block\'s local filter) is ANDed with the view\'s', async () => {
		const ws = await database('local', [{ id: 'a', amount: 1, done: true }, { id: 'b', amount: 2, done: false }, { id: 'c', amount: 3, done: true }], [
			{ op: 'createView', id: 'v1', collectionId: 'c1', type: 'table', name: 'Big', filter: { and: [{ prop: 'amount', op: 'gt', value: 1 }] }, rank: ranks(1)[0] } as Op
		]);
		const c = await open(ws, 'owner-1', { all: view({ viewId: 'v1' }), local: view({ viewId: 'v1', filter: { and: [{ prop: 'done', op: 'is', value: true }] } }) }, 'owner');
		expect(c.ids('all')).toEqual(['b', 'c']);
		expect(c.ids('local')).toEqual(['c']);
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'b', prop: 'done', value: true }, { op: 'setProp', page: 'a', prop: 'amount', value: 7 }]));
		await c.reached(seq);
		expect(c.ids('all')).toEqual(['a', 'b', 'c'].filter((id) => id !== 'x'));
		expect(new Set(c.ids('local'))).toEqual(new Set(['a', 'b', 'c']));
		c.conn.ws.close();
	});

	test('what a view shows depends on the actor: pages they cannot read never enter their window', async () => {
		const ws = await database('visibility', [{ id: 'a', amount: 1 }, { id: 'b', amount: 2 }]);
		await ws.stub.syncMember({ userId: 'g1', role: 'guest', name: 'g1' });
		const guest = await open(ws, 'g1', { v: view() }, 'guest');
		const owner = await open(ws, 'owner-1', { v: view() }, 'owner');
		expect(guest.ids('v')).toEqual([]);
		expect(new Set(owner.ids('v'))).toEqual(new Set(['a', 'b']));
		const { seq } = await ws.stub.setGrant(ws.owner, { pageId: 'a', subjectKind: 'user', subjectId: 'g1', level: 'read' }).then(async () => ({ seq: (await ws.stub.liveStats()).head }));
		await guest.reached(seq);
		expect(guest.ids('v')).toEqual(['a']);
		const next = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'b', prop: 'amount', value: 5 }]));
		await guest.reached(next.seq);
		expect(guest.ids('v')).toEqual(['a']);
		guest.conn.ws.close();
		owner.conn.ws.close();
	});
});

describe('a grouped view', () => {
	test('rows change group, groups appear and empty, counts follow, and each group has its own window', async () => {
		const ws = await database('board', [
			{ id: 'a', prio: 'p1', amount: 1 },
			{ id: 'b', prio: 'p1', amount: 2 },
			{ id: 'c', prio: 'p1', amount: 3 },
			{ id: 'd', prio: 'p2', amount: 4 },
			{ id: 'e', amount: 5 }
		]);
		const board = view({ groupBy: { prop: 'prio' }, sorts: [{ prop: 'amount', dir: 'asc' }], limit: 2 });
		const c = await open(ws, 'owner-1', { board }, 'owner');
		const snap = c.log.of('snapshot').find((m) => m.id === 'board');
		expect(snap).toMatchObject({ kind: 'view', total: 5, rows: [] });
		const groups = () => c.pump().windows.get('board')!.groups!.map((g) => [g.key, g.total, g.ids]);
		// Option columns are listed even when empty, then the empty group.
		expect(groups()).toEqual([['p1', 3, ['a', 'b']], ['p2', 1, ['d']], ['p3', 0, []], ['$empty', 1, ['e']]]);

		// A card moves to another column: a remove in one group, an add in the other, both counts.
		let from = c.log.messages.length;
		let { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'prio', value: 'p3' }]));
		await c.reached(seq);
		expect(groups()).toEqual([['p1', 2, ['b', 'c']], ['p2', 1, ['d']], ['p3', 1, ['a']], ['$empty', 1, ['e']]]);
		const ops = opsOf(c.log, from, 'board');
		expect(ops).toContainEqual({ op: 'remove', id: 'a', group: 'p1' });
		expect(ops).toContainEqual(expect.objectContaining({ op: 'add', group: 'p3', index: 0 }));
		expect(ops).toContainEqual({ op: 'count', total: 1, group: 'p3' });
		expect(ops).toContainEqual({ op: 'count', total: 2, group: 'p1' });
		// The page count of the whole view did not change: no group-less count.
		expect(ops.filter((o) => o.op === 'count' && o.group === undefined)).toEqual([]);
		// The refill: c slid into the window of p1.
		expect(ops).toContainEqual(expect.objectContaining({ op: 'add', group: 'p1', row: expect.objectContaining({ id: 'c' }) }));

		// One group grows on its own.
		c.conn.send({ t: 'window', id: 'board', limit: 5, group: 'p1' });
		await vi.waitFor(() => expect(c.pump().windows.get('board')?.groups?.find((g) => g.key === 'p1')?.ids).toEqual(['b', 'c']));

		// Clearing the value empties a column; an option edit adds a column: `groups` carries the new order.
		from = c.log.messages.length;
		({ seq } = await ws.stub.apply(ws.owner, batch([{ op: 'updateProperty', id: 'prio', config: { options: ['p3', 'p1', 'p2', 'p4'].map(opt) } } as Op])));
		await c.reached(seq);
		expect(c.pump().windows.get('board')!.groups!.map((g) => g.key)).toEqual(['p3', 'p1', 'p2', 'p4', '$empty']);
		expect(opsOf(c.log, from, 'board')).toContainEqual({ op: 'groups', keys: ['p3', 'p1', 'p2', 'p4', '$empty'] });
		expect((await ws.stub.liveStats()).stale).toEqual([]);
		c.conn.ws.close();
	});

	test('a multi-select page sits in several groups; the total counts it once', async () => {
		const ws = await database('multi', [{ id: 'a' }, { id: 'b' }], [{ op: 'createProperty', property: { id: 'tags', name: 'Tags', type: 'multi_select', config: { options: ['t1', 't2'].map(opt) } } } as Op]);
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'tags', value: ['t1', 't2'] }, { op: 'setProp', page: 'b', prop: 'tags', value: ['t2'] }]));
		const c = await open(ws, 'owner-1', { v: view({ groupBy: { prop: 'tags' }, limit: 5 }) }, 'owner');
		const w = () => c.pump().windows.get('v')!;
		expect(w().total).toBe(2);
		expect(w().groups!.map((g) => [g.key, g.total])).toEqual([['t1', 1], ['t2', 2]]);
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'removeOption', page: 'a', prop: 'tags', option: 't2' }]));
		await c.reached(seq);
		expect(w().groups!.map((g) => [g.key, g.total])).toEqual([['t1', 1], ['t2', 1]]);
		expect(w().total).toBe(2);
		c.conn.ws.close();
	});
});

describe('sharing and cost', () => {
	test('identical queries share one unit; a write evaluates it once, and not at all when it reads other properties', async () => {
		const ws = await database('share', [{ id: 'a', amount: 1, prio: 'p1' }, { id: 'b', amount: 2 }]);
		const sub = view({ sorts: [{ prop: 'amount', dir: 'asc' }] });
		const people = [];
		for (const u of ['u1', 'u2', 'u3', 'u4', 'u5']) people.push(await open(ws, u, { v: sub, w: { ...sub, limit: 10 } }));
		const before = await ws.stub.liveStats();
		// One unit: same query, same scope (window size is not part of the query).
		expect(before.units).toBe(1);
		let { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'amount', value: 5 }]));
		for (const p of people) await p.reached(seq);
		const after = await ws.stub.liveStats();
		expect(after.evaluations - before.evaluations).toBe(1);
		// A property the view does not read: the unit is not even looked at.
		({ seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'prio', value: 'p2' }])));
		for (const p of people) await p.reached(seq);
		expect((await ws.stub.liveStats()).evaluations).toBe(after.evaluations);
		// Everyone got the same ops.
		const frames = people.map((p) => JSON.stringify(p.log.of('diff').at(-1)));
		expect(new Set(frames).size).toBe(1);
		for (const p of people) p.conn.ws.close();
	});

	test('a query that reads "is me" is evaluated per user', async () => {
		const ws = await database('me', [{ id: 'a' }, { id: 'b' }]);
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'who', value: ['u1'] }, { op: 'setProp', page: 'b', prop: 'who', value: ['u2'] }]));
		const mine = view({ filter: { and: [{ prop: 'who', op: 'is_me' }] } });
		const u1 = await open(ws, 'u1', { v: mine });
		const u2 = await open(ws, 'u2', { v: mine });
		expect(u1.ids('v')).toEqual(['a']);
		expect(u2.ids('v')).toEqual(['b']);
		expect((await ws.stub.liveStats()).units).toBe(2);
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'who', value: ['u1', 'u2'] }]));
		await u2.reached(seq);
		expect(new Set(u2.ids('v'))).toEqual(new Set(['a', 'b']));
		expect(u1.ids('v')).toEqual(['a']);
		u1.conn.ws.close();
		u2.conn.ws.close();
	});

	test('a bulk edit runs the loop once and sends one message per socket', async () => {
		const ws = await database('bulk', ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, amount: i })));
		const c = await open(ws, 'owner-1', { v: view({ sorts: [{ prop: 'amount', dir: 'desc' }], limit: 4 }), g: view({ groupBy: { prop: 'prio' }, limit: 3 }) }, 'owner');
		const before = (await ws.stub.liveStats()).evaluations;
		const from = c.log.messages.length;
		const { seq } = await ws.stub.apply(
			ws.owner,
			batch([
				...['a', 'b', 'c', 'd', 'e', 'f'].map((page, i) => ({ op: 'setProp', page, prop: 'amount', value: (i * 7) % 5 }) as Op),
				...['a', 'b', 'c'].map((page) => ({ op: 'setProp', page, prop: 'prio', value: 'p2' }) as Op),
				{ op: 'trash', page: 'f' }
			])
		);
		await c.reached(seq);
		expect(c.log.messages.slice(from).filter((m) => m.t === 'diff' || m.t === 'head')).toHaveLength(1);
		// Each unit evaluated at most once for the whole batch.
		expect((await ws.stub.liveStats()).evaluations - before).toBeLessThanOrEqual(2);
		expect((await ws.stub.liveStats()).stale).toEqual([]);
		c.conn.ws.close();
	});
});

describe('faults and definitions', () => {
	test('hibernation: a new instance carries on from the stored units', async () => {
		const ws = await database('hibernate', [{ id: 'a', amount: 1 }, { id: 'b', amount: 2 }]);
		const c = await open(ws, 'owner-1', { v: view({ sorts: [{ prop: 'amount', dir: 'asc' }] }), g: view({ groupBy: { prop: 'prio' } }) }, 'owner');
		await evictDurableObject(ws.stub);
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'amount', value: 9 }, { op: 'setProp', page: 'b', prop: 'prio', value: 'p1' }]));
		await c.reached(seq);
		expect(c.ids('v')).toEqual(['b', 'a']);
		expect(c.model.windows.get('g')!.groups!.find((g) => g.key === 'p1')?.ids).toEqual(['b']);
		c.conn.ws.close();
	});

	test('a failed batch changes nothing and tells no one', async () => {
		const ws = await database('failed', [{ id: 'a', amount: 1 }]);
		const c = await open(ws, 'owner-1', { v: view() }, 'owner');
		const from = c.log.messages.length;
		try {
			await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'amount', value: 5 }, { op: 'setProp', page: 'ghost', prop: 'amount', value: 1 }]));
			throw new Error('expected the batch to fail');
		} catch (error) {
			expect(decodeWorkspaceError(error)?.code).toBe('VALIDATION_FAILED');
		}
		await new Promise((r) => setTimeout(r, 60));
		expect(c.log.messages.slice(from)).toEqual([]);
		expect((await ws.stub.getPage(ws.owner, 'a')).values.amount).toBe(1);
		c.conn.ws.close();
	});

	test('a reconnect from a seq gets fresh windows for the views the gap touched, and nothing for the others', async () => {
		const ws = await database('resume', [{ id: 'a', amount: 1 }]);
		const subs = { v: view(), other: view({ filter: { and: [{ prop: 'amount', op: 'gt', value: 100 }] }, groupBy: undefined }) };
		const first = await open(ws, 'owner-1', subs, 'owner');
		const lastSeq = first.pump().lastSeq;
		first.conn.ws.close();
		await ws.stub.apply(ws.owner, batch([createOp('b', 'db', ranks(1)[0], { values: { title: 'b', amount: 2 } })]));
		const conn = await connect(ws.id, dev('owner-1', 'owner'));
		const log = await conn.hello({ lastSeq, subs: Object.entries(subs).map(([id, sub]) => ({ id, sub })) });
		await log.wait((m) => m.t === 'head');
		expect(log.of('resumed')[0].mode).toBe('replay');
		expect(log.of('snapshot').map((s) => s.id).sort()).toEqual(['other', 'v']);
		conn.ws.close();
	});

	test('editing the view (its sorts) re-sorts the live window, and grouping it sends a fresh snapshot', async () => {
		const ws = await database('redefine', [{ id: 'a', amount: 3, prio: 'p1' }, { id: 'b', amount: 1, prio: 'p2' }, { id: 'c', amount: 2, prio: 'p1' }], [
			{ op: 'createView', id: 'v1', collectionId: 'c1', type: 'table', name: 'T', sorts: [{ prop: 'amount', dir: 'asc' }], rank: ranks(1)[0] } as Op
		]);
		const c = await open(ws, 'owner-1', { v: view({ viewId: 'v1', limit: 10 }) }, 'owner');
		expect(c.ids('v')).toEqual(['b', 'c', 'a']);
		let { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'updateView', id: 'v1', sorts: [{ prop: 'amount', dir: 'desc' }] } as Op]));
		await c.reached(seq);
		expect(c.ids('v')).toEqual(['a', 'c', 'b']);
		({ seq } = await ws.stub.apply(ws.owner, batch([{ op: 'updateView', id: 'v1', groupBy: { prop: 'prio' } } as Op])));
		await c.reached(seq);
		await vi.waitFor(() => expect(c.pump().windows.get('v')?.groups?.map((g) => g.key)).toEqual(['p1', 'p2', 'p3', '$empty'].filter((k) => k !== '$empty')));
		c.conn.ws.close();
	});

	test('a saved view edited to read "is me" gives each user their own rows (their units are told apart again)', async () => {
		const ws = await database('rescope', [{ id: 'a' }, { id: 'b' }], [{ op: 'createView', id: 'v1', collectionId: 'c1', type: 'table', name: 'T', rank: ranks(1)[0] } as Op]);
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'a', prop: 'who', value: ['u1'] }, { op: 'setProp', page: 'b', prop: 'who', value: ['u2'] }]));
		const u1 = await open(ws, 'u1', { v: view({ viewId: 'v1', limit: 10 }) });
		const u2 = await open(ws, 'u2', { v: view({ viewId: 'v1', limit: 10 }) });
		expect(new Set(u1.ids('v'))).toEqual(new Set(['a', 'b']));
		expect((await ws.stub.liveStats()).units).toBe(1);
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'updateView', id: 'v1', filter: { and: [{ prop: 'who', op: 'is_me' }] } } as Op]));
		await u1.reached(seq);
		await u2.reached(seq);
		await vi.waitFor(() => {
			expect(u1.pump().windows.get('v')?.ids).toEqual(['a']);
			expect(u2.pump().windows.get('v')?.ids).toEqual(['b']);
		});
		expect((await ws.stub.liveStats()).units).toBe(2);
		expect((await ws.stub.liveStats()).stale).toEqual([]);
		u1.conn.ws.close();
		u2.conn.ws.close();
	});

	test('a view whose primary sort reads the clock is refused', async () => {
		const ws = await database('now-sort', [{ id: 'a', amount: 1 }]);
		await ws.stub.apply(ws.owner, batch([{ op: 'createProperty', property: { id: 'age', name: 'Age', type: 'formula', config: { expression: 'now()', resultType: 'date' } } } as Op]));
		const conn = await connect(ws.id, dev('owner-1', 'owner'));
		const log = await conn.hello();
		await conn.client.subscribe({ id: 'bad', sub: view({ sorts: [{ prop: 'age', dir: 'asc' }] }) });
		expect(await log.wait((m) => m.t === 'error')).toMatchObject({ code: 'bad_subscription', id: 'bad' });
		// As a second sort key it is allowed.
		const from = log.messages.length;
		await conn.client.subscribe({ id: 'ok', sub: view({ sorts: [{ prop: 'amount', dir: 'asc' }, { prop: 'age', dir: 'asc' }] }) });
		await log.wait((m) => m.t === 'snapshot' && m.id === 'ok', from);
		conn.ws.close();
	});
});

describe('the hourly alarm', () => {
	test('recomputes now() formulas and publishes the results like a write', async () => {
		const ws = await database('hourly', [{ id: 'a', amount: 1 }]);
		await ws.stub.apply(ws.owner, batch([{ op: 'createProperty', property: { id: 'stamp', name: 'Stamp', type: 'formula', config: { expression: 'now()', resultType: 'date' } } } as Op]));
		const c = await open(ws, 'owner-1', { v: view() }, 'owner');
		const before = c.model.windows.get('v')!.rows.get('a')!.values.stamp;
		await new Promise((r) => setTimeout(r, 15));
		const from = c.log.messages.length;
		const out = await ws.stub.hourly();
		expect(out.recomputed).toBeGreaterThan(0);
		await c.reached(out.seq as number);
		expect(opsOf(c.log, from, 'v')).toContainEqual(expect.objectContaining({ op: 'update', id: 'a', prop: 'stamp' }));
		expect(c.model.windows.get('v')!.rows.get('a')!.values.stamp).not.toEqual(before);
		// Nothing is stamped as edited by the clock.
		expect(actorOf(ws.id).userId).toBe('owner-1');
		expect((await ws.stub.getPage(ws.owner, 'a')).updatedBy).toBe('owner-1');
		c.conn.ws.close();
	});

	test('a workspace with nothing that reads the clock has nothing to publish', async () => {
		const ws = await database('hourly-none', [{ id: 'a' }]);
		expect(await ws.stub.hourly()).toEqual({ recomputed: 0, seq: null });
	});
});
