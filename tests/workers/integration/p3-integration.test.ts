/**
 * P3 integration seams between the tracks: the manual-order rank on view rows, server-side defaults of a row made
 * from a view, archived teamspaces coming back, and purge feeding the dependency graph.
 */
import { describe, expect, test, vi } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { ServerMessage, Subscription } from '../../../src/lib/shared/protocol';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { connect } from '../socket/helpers';
import { SocketModel } from '../live/model';
import { actorOf, APP_VERSION, batch, createOp, createWorkspace, inside, rankBetween, ranks, type Fixture } from '../workspace/helpers';

type ViewSub = Extract<Subscription, { kind: 'view' }>;
const dev = (user: string, role = 'member') => ({ 'x-flarion-dev-actor': user, 'x-flarion-dev-role': role });
const opt = (id: string) => ({ id, name: id.toUpperCase(), color: 'default' as const });

async function world(label: string): Promise<Fixture> {
	const ws = await createWorkspace(label);
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } },
			{ op: 'createProperty', property: { id: 'prio', name: 'Priority', type: 'select', config: { options: ['p1', 'p2', 'p3'].map(opt) } } },
			{ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } },
			{ op: 'createProperty', property: { id: 'rel', name: 'Related', type: 'relation', config: { limit: 'many' } } },
			{ op: 'createProperty', property: { id: 'total', name: 'Total', type: 'rollup', config: { relationProp: 'rel', targetProp: 'amount', fn: 'sum', resultType: 'number' } } },
			{ op: 'createProperty', property: { id: 'plus', name: 'Plus', type: 'formula', config: { expression: 'prop("Total") + 1', resultType: 'number' } } }
		])
	);
	return ws;
}

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		return decodeWorkspaceError(e)?.code ?? String(e);
	}
	return 'ok';
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
		pump() {
			cursor = model.follow(log.messages, cursor);
			return model;
		},
		async reached(seq: number) {
			await vi.waitFor(() => expect(this.pump().lastSeq).toBeGreaterThanOrEqual(seq), { timeout: 3000, interval: 10 });
		}
	};
}
const opsAfter = (log: { messages: ServerMessage[] }, from: number) => log.messages.slice(from).flatMap((m) => (m.t === 'diff' ? m.subs.flatMap((s) => s.ops) : []));

describe('the manual-order rank of view rows', () => {
	test('a source-AST collection sends the page rank and parent, and follows a move with $rank', async () => {
		const ws = await world('rank-source');
		const rk = ranks(5);
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('db', null, rk[0]!, { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
				{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } },
				createOp('a', 'db', rk[1]!, { values: { title: 'A' } }),
				createOp('b', 'db', rk[2]!, { values: { title: 'B' } }),
				createOp('c', 'db', rk[3]!, { values: { title: 'C' } })
			])
		);
		const t = await open(ws, 'owner-1', { v: { kind: 'view', collectionId: 'c1', limit: 10 } }, 'owner');
		const rows = t.model.windows.get('v')!.rows;
		expect(t.model.windows.get('v')!.ids).toEqual(['a', 'b', 'c']);
		expect(rows.get('a')).toMatchObject({ rank: rk[1], parentId: 'db' });
		expect(rows.get('c')).toMatchObject({ rank: rk[3], parentId: 'db' });

		const from = t.log.messages.length;
		const rank = rankBetween(rk[3]!, null);
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'a', parentId: 'db', rank }]));
		await t.reached(seq);
		expect(t.model.windows.get('v')!.ids).toEqual(['b', 'c', 'a']);
		expect(opsAfter(t.log, from)).toContainEqual({ op: 'update', id: 'a', prop: '$rank', value: rank });
		expect(t.model.windows.get('v')!.rows.get('a')!.rank).toBe(rank);
		t.conn.ws.close();
	});

	test('a hand-picked collection sends the member rank, and moveMember changes it live', async () => {
		const ws = await world('rank-hand');
		const rk = ranks(8);
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('db', null, rk[0]!, { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
				createOp('a', null, rk[1]!, { teamspaceId: ws.generalId, values: { title: 'A' } }),
				createOp('b', null, rk[2]!, { teamspaceId: ws.generalId, values: { title: 'B' } }),
				createOp('c', null, rk[3]!, { teamspaceId: ws.generalId, values: { title: 'C' } }),
				{ op: 'createCollection', id: 'pick', pageId: 'db' },
				// The members' order is not the pages' sibling order.
				{ op: 'addMember', collection: 'pick', page: 'c', rank: rk[4]! },
				{ op: 'addMember', collection: 'pick', page: 'a', rank: rk[5]! },
				{ op: 'addMember', collection: 'pick', page: 'b', rank: rk[6]! }
			])
		);
		const t = await open(ws, 'owner-1', { v: { kind: 'view', collectionId: 'pick', limit: 10 } }, 'owner');
		expect(t.model.windows.get('v')!.ids).toEqual(['c', 'a', 'b']);
		expect(t.model.windows.get('v')!.rows.get('c')!.rank).toBe(rk[4]);
		expect(t.model.windows.get('v')!.rows.get('b')!.rank).toBe(rk[6]);

		const from = t.log.messages.length;
		const rank = rankBetween(rk[4]!, rk[5]!);
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'moveMember', collection: 'pick', page: 'b', rank }]));
		await t.reached(seq);
		expect(t.model.windows.get('v')!.ids).toEqual(['c', 'b', 'a']);
		expect(opsAfter(t.log, from)).toContainEqual({ op: 'update', id: 'b', prop: '$rank', value: rank });
		expect(t.model.windows.get('v')!.rows.get('b')!.rank).toBe(rank);

		// The one-shot read (collection.query) carries the same ranks.
		const fresh = await ws.stub.queryView(ws.owner, { collectionId: 'pick', window: { limit: 10 } });
		expect(fresh.rows.map((r) => [r.id, r.rank])).toEqual([['c', rk[4]], ['b', rank], ['a', rk[5]]]);
		t.conn.ws.close();
	});
});

describe('a row created from a view', () => {
	async function board(label: string) {
		const ws = await world(label);
		const rk = ranks(4);
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('db', null, rk[0]!, { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
				createOp('sub', 'db', rk[1]!, { isDatabase: true, values: { title: 'Elsewhere' } }),
				{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] }, defaults: { notes: 'from defaults' } },
				{ op: 'createView', id: 'urgent', collectionId: 'c1', type: 'table', name: 'Urgent', filter: { and: [{ prop: 'prio', op: 'is', value: 'p1' }] }, rank: rk[2]! },
				{ op: 'createView', id: 'plain', collectionId: 'c1', type: 'table', name: 'Plain', rank: rk[3]! }
			])
		);
		return ws;
	}
	const created = (ws: Fixture, id: string) => ws.stub.getPage(ws.owner, id);

	test('page.create with a viewId derives the parent and the values that keep the row in the view', async () => {
		const ws = await board('create-view');
		await ws.stub.createPage(ws.owner, { id: 'r1', viewId: 'urgent', appVersion: APP_VERSION, values: { title: 'First' } });
		const r1 = await created(ws, 'r1');
		expect(r1.parentId).toBe('db');
		expect(r1.values).toMatchObject({ prio: 'p1', notes: 'from defaults' });
		expect(r1.title).toBe('First');

		// A block's local filter counts too, and explicit values win over derived ones.
		await ws.stub.createPage(ws.owner, {
			id: 'r2',
			viewId: 'urgent',
			localFilter: { and: [{ prop: 'amount', op: 'eq', value: 5 }] },
			appVersion: APP_VERSION,
			values: { notes: 'mine' }
		});
		expect((await created(ws, 'r2')).values).toMatchObject({ prio: 'p1', amount: 5, notes: 'mine' });

		// The plain view has no filter: only the collection's defaults.
		await ws.stub.createPage(ws.owner, { id: 'r3', viewId: 'plain', appVersion: APP_VERSION });
		const r3 = await created(ws, 'r3');
		expect(r3.parentId).toBe('db');
		expect(r3.values.prio ?? null).toBeNull();
		expect(r3.values.notes).toBe('from defaults');

		// An explicit parent is kept (placement is authorized on it).
		await ws.stub.createPage(ws.owner, { id: 'r4', parentId: 'sub', viewId: 'urgent', appVersion: APP_VERSION });
		expect((await created(ws, 'r4')).parentId).toBe('sub');
	});

	test('a `create` op carries the same derivation, and a bad view or filter is refused', async () => {
		const ws = await board('create-op');
		const rk = ranks(3);
		await ws.stub.apply(ws.owner, batch([createOp('o1', 'db', rk[0]!, { viewId: 'urgent', localFilter: { and: [{ prop: 'amount', op: 'eq', value: 7 }] }, values: { title: 'Op' } })]));
		expect((await created(ws, 'o1')).values).toMatchObject({ prio: 'p1', amount: 7, notes: 'from defaults' });
		expect(await code(ws.stub.apply(ws.owner, batch([createOp('o2', 'db', rk[1]!, { viewId: 'nope' })])))).toBe('VALIDATION_FAILED');
		expect(await code(ws.stub.apply(ws.owner, batch([createOp('o3', 'db', rk[2]!, { viewId: 'urgent', localFilter: { and: [{ prop: 'ghost', op: 'eq', value: 1 }] } })])))).toBe('VALIDATION_FAILED');
		expect(await code(ws.stub.createPage(ws.owner, { id: 'o4', viewId: 'nope', appVersion: APP_VERSION }))).toBe('NOT_FOUND');
		expect(await code(ws.stub.createPage(ws.owner, { id: 'o5', appVersion: APP_VERSION }))).toBe('VALIDATION_FAILED');
	});

	test('a database the caller cannot read does not exist for them', async () => {
		const ws = await board('create-hidden');
		const secret = await ws.stub.createTeamspace(ws.owner, { name: 'Secret', icon: null, privacy: 'private', defaultLevel: 'update' });
		const rk = ranks(2);
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('hdb', null, rk[0]!, { teamspaceId: secret.id, isDatabase: true, values: { title: 'Hidden' } }),
				{ op: 'createCollection', id: 'hc', pageId: 'hdb', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'hdb' }] } },
				{ op: 'createView', id: 'hv', collectionId: 'hc', type: 'table', name: 'T', rank: rk[1]! }
			])
		);
		await ws.stub.syncMember({ userId: 'bob', role: 'member', name: 'Bob' });
		const bob = actorOf(ws.id, 'bob', 'member');
		expect(await code(ws.stub.createPage(bob, { id: 'x', viewId: 'hv', appVersion: APP_VERSION }))).toBe('NOT_FOUND');
		expect(await code(ws.stub.apply(bob, batch([createOp('y', 'hdb', rk[0]!, { viewId: 'hv' })])))).not.toBe('ok');
		expect((await inside(ws.stub, (sql) => sql.exec('SELECT id FROM page WHERE id IN (?, ?)', 'x', 'y').toArray())).length).toBe(0);
	});
});

describe('archived teamspaces', () => {
	async function archived(label: string) {
		const ws = await world(label);
		const team = await ws.stub.createTeamspace(ws.owner, { name: 'Design', icon: '🎨', privacy: 'open', defaultLevel: 'update' });
		const rk = ranks(8);
		await ws.stub.syncMember({ userId: 'bob', role: 'member', name: 'Bob' });
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('home', null, rk[0]!, { teamspaceId: ws.generalId, values: { title: 'Home' } }),
				createOp('d1', null, rk[1]!, { teamspaceId: team.id, values: { title: 'Design 1', amount: 5, notes: 'keep me' } }),
				createOp('d1a', 'd1', rk[2]!, { values: { title: 'Design 1a' } }),
				createOp('d2', null, rk[3]!, { teamspaceId: team.id, values: { title: 'Design 2' } }),
				createOp('old', null, rk[4]!, { teamspaceId: team.id, values: { title: 'Trashed before' } }),
				{ op: 'createCollection', id: 'all', pageId: 'home', sourceAst: { and: [] } }
			])
		);
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'home', prop: 'rel', value: ['d1'] }, { op: 'trash', page: 'old' }]));
		return { ws, team };
	}

	test('lists for its owner only, restores the pages the archive took (and not earlier trash), losslessly', async () => {
		const { ws, team } = await archived('ts-restore');
		const t = await open(ws, 'owner-1', { v: { kind: 'view', collectionId: 'all', limit: 50 } }, 'owner');
		expect(t.model.windows.get('v')!.ids).toEqual(expect.arrayContaining(['d1', 'd1a', 'd2']));
		const before = await ws.stub.getPage(ws.owner, 'd1');
		const stamp = await ws.stub.archiveTeamspace(ws.owner, team.id);
		await t.reached(stamp.seq);
		expect(t.model.windows.get('v')!.ids).not.toContain('d1');

		// A dependent in another teamspace dropped the archived page from its rollup, and gets it back.
		expect((await ws.stub.getPage(ws.owner, 'home')).values.total ?? 0).toBe(0);
		const listed = await ws.stub.archivedTeamspaces(ws.owner);
		expect(listed).toEqual([expect.objectContaining({ id: team.id, name: 'Design', icon: '🎨', pageCount: 3 })]);
		await ws.stub.syncMember({ userId: 'carol', role: 'member', name: 'Carol' });
		expect(await ws.stub.archivedTeamspaces(actorOf(ws.id, 'carol', 'member'))).toEqual([]);
		expect(await code(ws.stub.restoreTeamspace(actorOf(ws.id, 'carol', 'member'), team.id))).toBe('FORBIDDEN');
		expect(await code(ws.stub.restoreTeamspace(ws.owner, 'ghost'))).toBe('NOT_FOUND');

		const restored = await ws.stub.restoreTeamspace(ws.owner, team.id);
		await t.reached(restored.seq);
		expect(await ws.stub.archivedTeamspaces(ws.owner)).toEqual([]);
		expect(t.model.windows.get('v')!.ids).toEqual(expect.arrayContaining(['d1', 'd1a', 'd2']));
		expect(t.model.windows.get('v')!.ids).not.toContain('old');
		const after = await ws.stub.getPage(ws.owner, 'd1');
		expect(after.values).toEqual(before.values);
		expect(after.title).toBe(before.title);
		expect((await ws.stub.getPage(ws.owner, 'home')).values.total).toBe(5);
		expect((await ws.stub.teamspaces(ws.owner)).map((x: { id: string }) => x.id)).toContain(team.id);

		const state = await inside(ws.stub, (sql) => sql.exec<{ id: string; deleted_at: string | null; trash_root: string | null }>('SELECT id, deleted_at, trash_root FROM page WHERE teamspace_id = ?', team.id).toArray());
		expect(state.filter((r) => r.deleted_at).map((r) => r.id)).toEqual(['old']);
		// A second restore has nothing to restore.
		expect(await code(ws.stub.restoreTeamspace(ws.owner, team.id))).toBe('NOT_FOUND');
		t.conn.ws.close();
	});
});

describe('purge feeds the dependency graph', () => {
	test('purging a relation target recomputes the rollups and formulas that read it', async () => {
		const ws = await world('purge-deps');
		const rk = ranks(4);
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('holder', null, rk[0]!, { teamspaceId: ws.generalId, values: { title: 'Holder' } }),
				createOp('t1', null, rk[1]!, { teamspaceId: ws.generalId, values: { title: 'T1', amount: 4 } }),
				createOp('t2', null, rk[2]!, { teamspaceId: ws.generalId, values: { title: 'T2', amount: 6 } })
			])
		);
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'holder', prop: 'rel', value: ['t1', 't2'] }]));
		let holder = await ws.stub.getPage(ws.owner, 'holder');
		expect(holder.values).toMatchObject({ total: 10, plus: 11 });

		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 't1' }]));
		holder = await ws.stub.getPage(ws.owner, 'holder');
		expect(holder.values).toMatchObject({ total: 6, plus: 7 });

		const { pages } = await ws.stub.purgeTrash(ws.owner, 't1');
		expect(pages.map((p: { id: string }) => p.id)).toEqual(['t1']);
		holder = await ws.stub.getPage(ws.owner, 'holder');
		expect(holder.values).toMatchObject({ total: 6, plus: 7, rel: ['t2'] });

		// The workflow path (purgePages) does the same for a page trashed with its teamspace.
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 't2' }]));
		await ws.stub.purgePages([{ id: 't2', num: (await inside(ws.stub, (sql) => sql.exec<{ num: number }>('SELECT num FROM page WHERE id = ?', 't2').one().num)) }]);
		holder = await ws.stub.getPage(ws.owner, 'holder');
		expect(holder.values.total ?? 0).toBe(0);
		expect(holder.values.plus).toBe(1);
		expect(holder.values.rel ?? null).toBeNull();
	});
});

describe('growing a window', () => {
	test('the answer restates the totals, so a client that counts adds does not count the rows twice', async () => {
		const ws = await world('window-count');
		const rk = ranks(8);
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('db', null, rk[0]!, { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
				{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } },
				...['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => createOp(id, 'db', rk[i + 1]!, { values: { title: id, amount: i, prio: i % 2 ? 'p2' : 'p1' } }))
			])
		);
		const flat = await open(ws, 'owner-1', { v: { kind: 'view', collectionId: 'c1', sorts: [{ prop: 'amount', dir: 'asc' }], limit: 2 } }, 'owner');
		let from = flat.log.messages.length;
		flat.conn.send({ t: 'window', id: 'v', limit: 5 });
		await vi.waitFor(() => expect(flat.pump().windows.get('v')?.ids).toEqual(['a', 'b', 'c', 'd', 'e']));
		const ops = opsAfter(flat.log, from);
		expect(ops.filter((o) => o.op === 'add')).toHaveLength(3);
		expect(ops.at(-1)).toEqual({ op: 'count', total: 6 });
		expect(flat.model.windows.get('v')!.total).toBe(6);

		const board = await open(ws, 'owner-1', { b: { kind: 'view', collectionId: 'c1', groupBy: { prop: 'prio' }, limit: 1 } }, 'owner');
		from = board.log.messages.length;
		board.conn.send({ t: 'window', id: 'b', limit: 3, group: 'p1' });
		await vi.waitFor(() => expect(board.pump().windows.get('b')?.groups?.find((g) => g.key === 'p1')?.ids).toHaveLength(3));
		expect(opsAfter(board.log, from)).toEqual(expect.arrayContaining([{ op: 'count', total: 3, group: 'p1' }, { op: 'count', total: 6 }]));
		flat.conn.ws.close();
		board.conn.ws.close();
	});
});
