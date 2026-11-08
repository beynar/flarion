/**
 * `WorkspaceDO.ssrRead`, the server render's read: the windows it returns are the snapshots a socket subscribing to the same things would
 * be sent (same rows, same order, same totals), under the permissions of the actor it is called as, at one `seq`.
 */
import { expect, test } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { ServerMessage, Subscription } from '../../../src/lib/shared/protocol';
import { subKey, TREE_ID } from '../../../src/lib/shared/sub-key';
import type { Actor } from '../../../src/server/auth/session';
import { connect } from '../socket/helpers';
import { actorOf, batch, createOp, createWorkspace, ranks, type Fixture } from './helpers';

const dev = (user: string, role = 'member') => ({ 'x-flarion-dev-actor': user, 'x-flarion-dev-role': role });

const opt = (id: string) => ({ id, name: id, color: 'gray' });

/** A workspace with a teamspace tree, a page with a backlink, a private page and a database with rows. */
async function seeded(label: string): Promise<{ ws: Fixture; member: Actor }> {
	const ws = await createWorkspace(label);
	const member = actorOf(ws.id, 'member-1', 'member');
	await ws.stub.syncMember({ userId: member.userId, role: 'member', name: 'Member' });
	const rk = ranks(8);
	await ws.stub.apply(
		ws.owner,
		batch([
			{ op: 'createProperty', property: { id: 'prio', name: 'Priority', type: 'select', config: { options: ['p1', 'p2'].map(opt) } } },
			{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } }
		])
	);
	await ws.stub.apply(
		ws.owner,
		batch([
			createOp('top', null, rk[0], { teamspaceId: ws.generalId, values: { title: 'Top' } }),
			createOp('kid', 'top', rk[1], { values: { title: 'Kid' } }),
			createOp('deep', 'kid', rk[2], { values: { title: 'Deep' } }),
			createOp('secret', null, rk[3], { teamspaceId: null, values: { title: 'Owner only' } }),
			createOp('db', null, rk[4], { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
			{ op: 'createCollection', id: 'db', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } },
			...['r1', 'r2', 'r3', 'r4'].map((id, i) => createOp(id, 'db', rk[5] + String(i), { values: { title: id, prio: i % 2 ? 'p1' : 'p2', amount: i } }))
		])
	);
	return { ws, member };
}

/** What a socket is sent for `subs`, by id. */
async function viaSocket(ws: Fixture, user: string, subs: { id: string; sub: Subscription }[]) {
	const conn = await connect(ws.id, dev(user));
	const log = await conn.hello({ subs });
	await log.wait((m) => m.t === 'head');
	const out = new Map<string, Extract<ServerMessage, { t: 'snapshot' }>>();
	for (const m of log.messages) if (m.t === 'snapshot') out.set(m.id, m);
	conn.ws.close();
	return out;
}

const strip = (m: Extract<ServerMessage, { t: 'snapshot' }>) => ({ kind: m.kind, total: m.total, rows: m.rows, ...('groups' in m && m.groups ? { groups: m.groups } : {}) });

test('the tree, a page, its backlinks and a view are what a socket would be sent', async () => {
	const { ws, member } = await seeded('ssr-parity');
	const view: Subscription = { kind: 'view', collectionId: 'db', props: ['prio', 'amount'], limit: 3 };
	const subs = [
		{ id: TREE_ID, sub: { kind: 'tree', parents: [null, 'top'] } as Subscription },
		{ id: subKey('pg', 'kid'), sub: { kind: 'page', pageIds: ['kid'] } as Subscription },
		{ id: subKey('bl', 'kid'), sub: { kind: 'backlinks', pageId: 'kid' } as Subscription },
		{ id: 'vw:x', sub: view }
	];
	const socket = await viaSocket(ws, member.userId, subs);
	const read = await ws.stub.ssrRead(member, { subs });
	expect(read.windows.map((w) => w.id).sort()).toEqual(subs.map((s) => s.id).sort());
	for (const w of read.windows) {
		expect(strip(w.snapshot), w.id).toEqual(strip(socket.get(w.id)!));
		expect(w.sub).toEqual(subs.find((s) => s.id === w.id)!.sub);
		expect(w.snapshot.seq).toBe(read.seq);
	}
});

test('a grouped view is read with its groups and per-group windows', async () => {
	const { ws, member } = await seeded('ssr-groups');
	const sub: Subscription = { kind: 'view', collectionId: 'db', groupBy: { prop: 'prio' }, props: ['prio'], limit: 1 };
	const socket = await viaSocket(ws, member.userId, [{ id: 'vw:g', sub }]);
	const read = await ws.stub.ssrRead(member, { subs: [{ id: 'vw:g', sub }] });
	expect(strip(read.windows[0].snapshot)).toEqual(strip(socket.get('vw:g')!));
});

test('the sidebar opens down to the page being revealed, as far as the actor can see', async () => {
	const { ws, member } = await seeded('ssr-reveal');
	const read = await ws.stub.ssrRead(member, { subs: [{ id: TREE_ID, sub: { kind: 'tree', parents: [null] } }], reveal: 'deep' });
	const tree = read.windows.find((w) => w.id === TREE_ID)!;
	expect(tree.sub).toEqual({ kind: 'tree', parents: [null, 'top', 'kid'] });
	expect(tree.snapshot.rows.map((r) => r.id)).toContain('deep');
	// A private page is not the member's: nothing above it is theirs either.
	const hidden = await ws.stub.ssrRead(member, { subs: [{ id: TREE_ID, sub: { kind: 'tree', parents: [null] } }], reveal: 'r1' });
	expect((hidden.windows[0].sub as { parents: unknown[] }).parents).toEqual([null, 'db']);
});

test('nothing the actor cannot read is ever returned', async () => {
	const { ws, member } = await seeded('ssr-private');
	const read = await ws.stub.ssrRead(member, {
		subs: [
			{ id: TREE_ID, sub: { kind: 'tree', parents: [null] } },
			{ id: 'pg:secret', sub: { kind: 'page', pageIds: ['secret'] } }
		],
		collection: 'secret'
	});
	const ids = read.windows.flatMap((w) => w.snapshot.rows.map((r) => r.id));
	expect(ids).not.toContain('secret');
	expect(read.windows.find((w) => w.id === 'pg:secret')!.snapshot.rows).toEqual([]);
	// The owner sees it.
	const owned = await ws.stub.ssrRead(ws.owner, { subs: [{ id: 'pg:secret', sub: { kind: 'page', pageIds: ['secret'] } }] });
	expect(owned.windows[0].snapshot.rows.map((r) => r.id)).toEqual(['secret']);
	// A view of a database the actor cannot read is left out, not an error.
	const priv = await ws.stub.apply(
		ws.owner,
		batch([
			createOp('pdb', null, ranks(1)[0] + 'z', { teamspaceId: null, isDatabase: true, values: { title: 'Private DB' } }),
			{ op: 'createCollection', id: 'pdb', pageId: 'pdb', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'pdb' }] } } as Op
		])
	);
	expect(priv.seq).toBeGreaterThan(0);
	const viewRead = await ws.stub.ssrRead(member, { subs: [{ id: 'vw:p', sub: { kind: 'view', collectionId: 'pdb', limit: 10 } }], collection: 'pdb' });
	expect(viewRead.windows).toEqual([]);
	expect(viewRead.collection).toBeNull();
});

test('the registry and the teamspaces come with the person\'s own rank in each', async () => {
	const { ws, member } = await seeded('ssr-directory');
	const read = await ws.stub.ssrRead(member, { properties: true, teamspaces: true, collection: 'db' });
	expect(read.properties?.map((p) => p.id)).toEqual(expect.arrayContaining(['prio', 'amount']));
	expect(read.teamspaces?.list.map((t) => t.id)).toContain(ws.generalId);
	expect(Object.keys(read.teamspaces?.ranks ?? {})).toContain(ws.generalId);
	expect(read.collection?.collection.id).toBe('db');
	expect(read.seq).toBeGreaterThan(0);
});
