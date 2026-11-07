/**
 * Soft delete, trash and restore (docs/PLAN.md "Soft delete and trash"): a subtree is tombstoned with one shared
 * `deletedAt`, hidden everywhere, and comes back lossless.
 */
import { describe, expect, test, vi } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { Subscription } from '../../../src/lib/shared/protocol';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { connect } from '../socket/helpers';
import { SocketModel } from '../live/model';
import { actorOf, batch, createOp, createWorkspace, inside, ranks, type Fixture } from '../workspace/helpers';
import { claimsFor, connect as connectRoom, mint, uniqueId, waitSaved, seed } from '../rooms/helpers';

const dev = (user: string, role = 'member') => ({ 'x-flarion-dev-actor': user, 'x-flarion-dev-role': role });
const [r1, r2, r3, r4, r5] = ranks(5);

interface Row extends Record<string, SqlStorageValue> {
	id: string;
	deleted_at: string | null;
	trash_root: string | null;
	parent_id: string | null;
	deleted_by: string | null;
}
const pageRows = (ws: Fixture) => inside(ws.stub, (sql) => sql.exec<Row>('SELECT id, deleted_at, trash_root, parent_id, deleted_by FROM page ORDER BY num').toArray());
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]));

/** p (with children c1, c2; c2 has g) and an older trashed child c3 of p; a database whose view lists them all. */
async function tree(label: string) {
	const ws = await createWorkspace(label);
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } },
			{ op: 'createProperty', property: { id: 'friend', name: 'Friend', type: 'relation', config: { limit: 'one' } } }
		])
	);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('p', null, r1, { teamspaceId: ws.generalId, values: { title: 'Parent', amount: 1 } }),
			createOp('c1', 'p', r1, { values: { title: 'Child one', amount: 2 } }),
			createOp('c2', 'p', r2, { values: { title: 'Child two', amount: 3 } }),
			createOp('g', 'c2', r1, { values: { title: 'Grandchild', amount: 4 } }),
			createOp('c3', 'p', r3, { values: { title: 'Old child', amount: 5 } }),
			createOp('other', null, r2, { teamspaceId: ws.generalId, values: { title: 'Other', amount: 6 } })
		])
	);
	return ws;
}

describe('trashing a subtree', () => {
	test('one shared deletedAt on the whole live subtree, trash_root on it, one change row, an older entry untouched', async () => {
		const ws = await tree('subtree');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'c3' }]));
		const earlier = byId(await pageRows(ws)).get('c3')!.deleted_at;
		await new Promise((r) => setTimeout(r, 5));
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		const rows = byId(await pageRows(ws));
		const stamp = rows.get('p')!.deleted_at;
		expect(stamp).toBeTruthy();
		for (const id of ['p', 'c1', 'c2', 'g']) expect(rows.get(id)).toMatchObject({ deleted_at: stamp, trash_root: 'p', deleted_by: 'owner-1' });
		// The child trashed before keeps its own entry and stamp.
		expect(rows.get('c3')).toMatchObject({ deleted_at: earlier, trash_root: 'c3' });
		expect(rows.get('other')!.deleted_at).toBeNull();
		const changes = await inside(ws.stub, (sql) => sql.exec<{ kind: string; page: string }>("SELECT kind, page FROM change WHERE seq = ?", seq).toArray());
		expect(changes).toEqual([{ kind: 'trash', page: 'p' }]);
		// The trash lists the two roots, not their descendants.
		const list = await ws.stub.listTrash(ws.owner, {});
		expect(list.items.map((i) => [i.id, i.pageCount])).toEqual([['p', 4], ['c3', 1]]);
	});

	test('it needs full access on the root', async () => {
		const ws = await tree('forbid');
		await ws.stub.syncMember({ userId: 'ann', role: 'member', name: 'Ann' });
		try {
			await ws.stub.apply(actorOf(ws.id, 'ann', 'member'), batch([{ op: 'trash', page: 'p' }]));
			throw new Error('expected a refusal');
		} catch (error) {
			expect(decodeWorkspaceError(error)?.code).toBe('FORBIDDEN');
		}
		expect(byId(await pageRows(ws)).get('p')!.deleted_at).toBeNull();
	});

	test('the live loop removes the pages from the tree, every view and backlinks, and a restore puts them back', async () => {
		const ws = await tree('loop');
		await ws.stub.apply(ws.owner, batch([{ op: 'createCollection', id: 'cx', pageId: 'other', sourceAst: { and: [{ prop: 'amount', op: 'gt', value: 0 }] } } as Op]));
		const subs: Record<string, Subscription> = {
			root: { kind: 'tree', parents: [null, 'p', 'c2'] },
			view: { kind: 'view', collectionId: 'cx', sorts: [{ prop: 'amount', dir: 'asc' }], limit: 20 },
			grouped: { kind: 'view', collectionId: 'cx', groupBy: { prop: 'amount' } as never, limit: 20 }
		};
		const conn = await connect(ws.id, dev('owner-1', 'owner'));
		const log = await conn.hello({ subs: Object.entries(subs).map(([id, sub]) => ({ id, sub })) });
		await log.wait((m) => m.t === 'head');
		const model = new SocketModel();
		let cursor = model.follow(log.messages, 0);
		expect(model.windows.get('view')!.ids).toEqual(['p', 'c1', 'c2', 'g', 'c3', 'other']);
		const reached = async (seq: number) => {
			await vi.waitFor(() => {
				cursor = model.follow(log.messages, cursor);
				expect(model.lastSeq).toBeGreaterThanOrEqual(seq);
			});
		};
		let { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		await reached(seq);
		expect(model.windows.get('view')!.ids).toEqual(['other']);
		expect(model.windows.get('view')!.total).toBe(1);
		expect(log.of('diff').at(-1)!.subs.find((s) => s.id === 'view')!.ops.filter((o) => o.op === 'remove')).toHaveLength(5);
		({ seq } = await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'p' }])));
		await reached(seq);
		expect(model.windows.get('view')!.ids).toEqual(['p', 'c1', 'c2', 'g', 'c3', 'other']);
		expect((await ws.stub.liveStats()).stale).toEqual([]);
		conn.ws.close();
	});
});

describe('restore', () => {
	test('is lossless: values, relations, grants and the tree come back exactly', async () => {
		const ws = await tree('lossless');
		await ws.stub.syncMember({ userId: 'ann', role: 'member', name: 'Ann' });
		await ws.stub.setGrant(ws.owner, { pageId: 'c1', subjectKind: 'user', subjectId: 'ann', level: 'full' });
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'c1', prop: 'friend', value: ['other'] }, { op: 'setProp', page: 'other', prop: 'friend', value: ['p'] }]));
		const snapshot = () =>
			inside(ws.stub, (sql) => ({
				pages: sql.exec('SELECT id, parent_id, rank, teamspace_id, title, props_json, created_by FROM page ORDER BY id').toArray(),
				eav: ['p_text', 'p_num', 'p_date', 'p_ref'].map((t) => sql.exec(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).toArray()),
				grants: sql.exec('SELECT id, page_id, subject_key, level, deleted_at FROM "grant" ORDER BY id').toArray()
			}));
		const before = await snapshot();
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		// Under the tombstone nothing is touched.
		expect(await snapshot()).toEqual(before);
		await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'p' }]));
		expect(await snapshot()).toEqual(before);
		const rows = await pageRows(ws);
		expect(rows.every((r) => r.deleted_at === null && r.trash_root === null)).toBe(true);
		// The grant still works for Ann.
		expect(await ws.stub.pageAccess({ userId: 'ann' }, 'c1')).toBe('full');
	});

	test('a page whose parent is still in the trash goes to the workspace root (its teamspace root); undo is a restore', async () => {
		const ws = await tree('orphan');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'c2' }]));
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		// c2 sits under p, which is in the trash too: restoring c2 puts it at the root of its teamspace.
		await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'c2' }]));
		const rows = byId(await pageRows(ws));
		expect(rows.get('c2')).toMatchObject({ deleted_at: null, parent_id: null });
		expect(rows.get('g')!.deleted_at).toBeNull();
		expect(rows.get('p')!.deleted_at).not.toBeNull();
		expect((await ws.stub.getPage(ws.owner, 'c2')).teamspaceId).toBe(ws.generalId);
		// Only a trash root can be restored: the shared timestamp is the undo of the delete.
		try {
			await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'c1' }]));
			throw new Error('expected a refusal');
		} catch (error) {
			expect(decodeWorkspaceError(error)?.code).toBe('VALIDATION_FAILED');
		}
		await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'p' }]));
		expect((await pageRows(ws)).filter((r) => r.deleted_at !== null)).toEqual([]);
	});
});

describe('the trash list', () => {
	test('is searchable, sortable by deletion date, paged, and shows only what the caller may read', async () => {
		const ws = await createWorkspace('list');
		await ws.stub.syncMember({ userId: 'ann', role: 'member', name: 'Ann' });
		const names = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
		await ws.stub.apply(ws.owner, batch(names.map((n, i) => createOp(n.toLowerCase(), null, [r1, r2, r3, r4][i], { teamspaceId: ws.generalId, values: { title: n } }))));
		for (const n of ['bravo', 'alpha', 'delta', 'charlie']) {
			await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: n }]));
			await new Promise((r) => setTimeout(r, 3));
		}
		const ids = async (input: Parameters<typeof ws.stub.listTrash>[1], actor = ws.owner) => (await ws.stub.listTrash(actor, input)).items.map((i) => i.id);
		expect(await ids({})).toEqual(['charlie', 'delta', 'alpha', 'bravo']);
		expect(await ids({ sort: 'deleted_asc' })).toEqual(['bravo', 'alpha', 'delta', 'charlie']);
		expect(await ids({ sort: 'title' })).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
		expect(await ids({ q: 'ra' })).toEqual(['bravo']);
		const first = await ws.stub.listTrash(ws.owner, { limit: 3 });
		expect(first.items).toHaveLength(3);
		expect(first.nextCursor).not.toBeNull();
		expect((await ws.stub.listTrash(ws.owner, { limit: 3, cursor: first.nextCursor! })).items.map((i) => i.id)).toEqual(['bravo']);
		// A page Ann cannot read stays out of her trash: move one into a private teamspace's section by hand.
		const secret = await ws.stub.createTeamspace(ws.owner, { name: 'Secret', icon: null, privacy: 'private', defaultLevel: 'update' });
		await ws.stub.apply(ws.owner, batch([createOp('hidden', null, r5, { teamspaceId: secret.id, values: { title: 'Hidden' } })]));
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'hidden' }]));
		expect(await ids({}, ws.owner)).toContain('hidden');
		expect(await ids({}, actorOf(ws.id, 'ann', 'member'))).not.toContain('hidden');
	});
});

describe('what readers see', () => {
	test('a to-one relation to a trashed page reads null in rows and updates both ways', async () => {
		const ws = await tree('relation');
		await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page: 'other', prop: 'friend', value: ['c1'] }, createOp('holder', null, r4, { teamspaceId: ws.generalId, values: { title: 'Holder' } }), { op: 'setProp', page: 'holder', prop: 'friend', value: ['p'] }]));
		const conn = await connect(ws.id, dev('owner-1', 'owner'));
		const log = await conn.hello({ subs: [{ id: 'pg', sub: { kind: 'page', pageIds: ['other', 'holder'] } }] });
		await log.wait((m) => m.t === 'head');
		expect(await ws.stub.getPage(ws.owner, 'other').then((r) => r.values.friend)).toEqual(['c1']);
		let from = log.messages.length;
		const { seq } = await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'p' }]));
		await log.wait((m) => m.t === 'diff' && m.seq === seq, from);
		const ops = log.messages.slice(from).flatMap((m) => (m.t === 'diff' ? m.subs.flatMap((s) => s.ops) : []));
		// holder -> p (trashed): its cell reads null; other -> c1 (trashed with p): null too.
		expect(ops).toContainEqual({ op: 'update', id: 'holder', prop: 'friend', value: null });
		expect(ops).toContainEqual({ op: 'update', id: 'other', prop: 'friend', value: null });
		expect((await ws.stub.getPage(ws.owner, 'holder')).values.friend ?? null).toBeNull();
		// The link itself is still there (a restore is lossless).
		from = log.messages.length;
		const back = await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: 'p' }]));
		await log.wait((m) => m.t === 'diff' && m.seq === back.seq, from);
		expect(log.messages.slice(from).flatMap((m) => (m.t === 'diff' ? m.subs.flatMap((s) => s.ops) : []))).toContainEqual({ op: 'update', id: 'holder', prop: 'friend', value: ['p'] });
		conn.ws.close();
	});
});

describe('open rooms', () => {
	test('trashing a page closes its Page DO sockets with "moved to Trash"', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const claims = claimsFor(ws, page, 'room-owner');
		const client = connectRoom(page, await mint(claims), { userId: 'room-owner', value: seed('hello') });
		await waitSaved(client);
		const { env } = await import('cloudflare:test');
		const stub = (env as unknown as Env).WORKSPACE.getByName(ws);
		await vi.waitFor(async () => expect((await inside(stub as never, (sql) => sql.exec('SELECT page_id FROM open_room').toArray())).length).toBe(1));
		await stub.apply({ userId: 'room-owner', sessionId: 's', workspaceId: ws, role: 'owner', name: 'Owner' }, batch([{ op: 'trash', page }]));
		await vi.waitFor(() => expect(client.closes.at(-1)).toMatchObject({ code: 4403, reason: 'moved to Trash' }), { timeout: 5000 });
		client.close();
	});
});

describe('archiving a teamspace', () => {
	test('tombstones it and all its pages with one shared timestamp, and the views drop them', async () => {
		const ws = await createWorkspace('archive');
		const secret = await ws.stub.createTeamspace(ws.owner, { name: 'Gone', icon: null, privacy: 'open', defaultLevel: 'update' });
		await ws.stub.apply(ws.owner, batch([createOp('t1', null, r1, { teamspaceId: secret.id, values: { title: 'T1' } }), createOp('t1a', 't1', r1), createOp('keep', null, r2, { teamspaceId: ws.generalId, values: { title: 'Keep' } })]));
		await ws.stub.apply(ws.owner, batch([{ op: 'createCollection', id: 'all', pageId: 'keep', sourceAst: { and: [] } } as Op]));
		const conn = await connect(ws.id, dev('owner-1', 'owner'));
		const log = await conn.hello({ subs: [{ id: 'v', sub: { kind: 'view', collectionId: 'all', limit: 20 } }] });
		await log.wait((m) => m.t === 'head');
		const model = new SocketModel();
		let cursor = model.follow(log.messages, 0);
		expect(new Set(model.windows.get('v')!.ids)).toEqual(new Set(['t1', 't1a', 'keep', ...(await pageRows(ws)).map((r) => r.id).filter((id) => !['t1', 't1a', 'keep'].includes(id))]));
		const { seq } = await ws.stub.archiveTeamspace(ws.owner, secret.id);
		await vi.waitFor(() => {
			cursor = model.follow(log.messages, cursor);
			expect(model.lastSeq).toBeGreaterThanOrEqual(seq);
		});
		expect(model.windows.get('v')!.ids).not.toContain('t1');
		expect(model.windows.get('v')!.ids).not.toContain('t1a');
		expect(model.windows.get('v')!.ids).toContain('keep');
		const rows = byId(await pageRows(ws));
		expect(rows.get('t1')!.deleted_at).toBe(rows.get('t1a')!.deleted_at);
		expect(rows.get('t1')!.deleted_at).not.toBeNull();
		expect(rows.get('keep')!.deleted_at).toBeNull();
		conn.ws.close();
	});
});
