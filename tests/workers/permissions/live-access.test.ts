/**
 * Visibility reaches open sockets: a grant, a move, a membership or a role change gives the affected
 * sockets the right diffs (pages entering get `add`, pages leaving `remove`, a changed level an `$access`
 * update), untouched sockets only a head, and the cached sets survive hibernation.
 */
import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { CLOSE, type DiffOp, type ServerMessage, type Subscription } from '../../../src/lib/shared/protocol';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { connect, type StreamLog } from '../socket/helpers';
import { actorOf, batch, createOp, createWorkspace, ranks, type Fixture } from '../workspace/helpers';

const [r1, r2, r3] = ranks(3);
const tree = (...parents: (string | null)[]): Subscription => ({ kind: 'tree', parents });
const dev = (user: string, role = 'member') => ({ 'x-flarion-dev-actor': user, 'x-flarion-dev-role': role });

async function open(ws: Fixture, user: string, subs: Record<string, Subscription>, role = 'member') {
	await ws.stub.syncMember({ userId: user, role: role as 'member', name: user });
	const conn = await connect(ws.id, dev(user, role));
	const log = await conn.hello({ subs: Object.entries(subs).map(([id, sub]) => ({ id, sub })) });
	await log.wait((m) => m.t === 'head');
	return { conn, log };
}

async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return decodeWorkspaceError(error);
	}
	throw new Error('expected the call to fail');
}

const diffsSince = (log: StreamLog, from: number) =>
	log.messages.slice(from).filter((m): m is Extract<ServerMessage, { t: 'diff' }> => m.t === 'diff');
const opsOf = (log: StreamLog, from: number, id: string): DiffOp[] => diffsSince(log, from).flatMap((d) => d.subs.filter((s) => s.id === id).flatMap((s) => s.ops));
const kinds = (ops: DiffOp[]) => ops.map((o) => (o.op === 'add' || o.op === 'remove' || o.op === 'move' ? `${o.op}:${o.op === 'add' ? o.row.id : o.id}` : o.op === 'update' ? `update:${o.id}:${o.prop}=${String(o.value)}` : `${o.op}:${o.total}`));
const settled = async (log: StreamLog) => {
	const n = await log.settle();
	return n;
};

/** A workspace with a Private page of the owner's, shared with nobody. */
async function secretWorkspace(label: string) {
	const ws = await createWorkspace(label);
	await ws.stub.apply(ws.owner, batch([createOp('secret', null, r2, { values: { title: 'Secret' } }), createOp('kid', 'secret', r1, { values: { title: 'Kid' } })]));
	return ws;
}

describe('a grant reaches the sockets it affects', () => {
	test('the grantee gets the page and its subtree; a revoke takes them away; others hear only a head', async () => {
		const ws = await secretWorkspace('live-grant');
		const ann = await open(ws, 'ann', { root: tree(null, 'secret'), page: { kind: 'page', pageIds: ['secret', 'kid'] } });
		const bob = await open(ws, 'bob', { root: tree(null, 'secret') });
		// Nobody but the owner sees the Private page.
		const snap = ann.log.of('snapshot').find((m) => m.id === 'root')!;
		expect(snap.rows.map((r) => r.id)).not.toContain('secret');
		expect(ann.log.of('snapshot').find((m) => m.id === 'page')).toMatchObject({ total: 0, rows: [] });

		const fromAnn = ann.log.messages.length;
		const fromBob = bob.log.messages.length;
		const grant = await ws.stub.setGrant(ws.owner, { pageId: 'secret', subjectKind: 'user', subjectId: 'ann', level: 'comment' });
		expect(grant).toMatchObject({ pageId: 'secret', subjectKind: 'user', subjectId: 'ann', level: 'comment', token: null });

		await vi.waitFor(() => expect(kinds(opsOf(ann.log, fromAnn, 'root'))).toEqual(expect.arrayContaining(['add:secret', 'add:kid'])));
		const rootOps = opsOf(ann.log, fromAnn, 'root');
		expect(rootOps.find((o) => o.op === 'add' && o.row.id === 'secret')).toMatchObject({ row: { access: 'comment', parentId: null, title: 'Secret' } });
		expect(rootOps.find((o) => o.op === 'add' && o.row.id === 'kid')).toMatchObject({ row: { access: 'comment', parentId: 'secret' } });
		expect(kinds(opsOf(ann.log, fromAnn, 'page')).filter((k) => k.startsWith('add'))).toEqual(['add:secret', 'add:kid']);
		// Bob is not affected: a head, nothing else.
		await settled(bob.log);
		expect(bob.log.messages.slice(fromBob).every((m) => m.t === 'head')).toBe(true);

		// A higher level changes `$access` on the pages she keeps seeing.
		const fromUp = ann.log.messages.length;
		await ws.stub.setGrant(ws.owner, { pageId: 'secret', subjectKind: 'user', subjectId: 'ann', level: 'update' });
		await vi.waitFor(() => expect(kinds(opsOf(ann.log, fromUp, 'root'))).toEqual(expect.arrayContaining(['update:secret:$access=update', 'update:kid:$access=update'])));
		expect(opsOf(ann.log, fromUp, 'root').some((o) => o.op === 'add' || o.op === 'remove')).toBe(false);

		// Revoke: both pages leave her windows, and the counts follow.
		const fromRevoke = ann.log.messages.length;
		const { seq } = await ws.stub.revokeGrant(ws.owner, grant.id);
		expect(seq).toBeGreaterThan(0);
		await vi.waitFor(() => expect(kinds(opsOf(ann.log, fromRevoke, 'root'))).toEqual(expect.arrayContaining(['remove:secret', 'remove:kid'])));
		expect(kinds(opsOf(ann.log, fromRevoke, 'page')).filter((k) => k.startsWith('remove')).sort()).toEqual(['remove:kid', 'remove:secret']);
		for (const c of [ann, bob]) c.conn.ws.close();
	});

	test('a workspace grant reaches members, never guests; a teamspace grant reaches its members', async () => {
		const ws = await secretWorkspace('live-kinds');
		const ann = await open(ws, 'ann', { root: tree('secret') });
		const gus = await open(ws, 'gus', { root: tree('secret') }, 'guest');
		const from = [ann.log.messages.length, gus.log.messages.length];
		await ws.stub.setGrant(ws.owner, { pageId: 'secret', subjectKind: 'workspace', subjectId: null, level: 'read' });
		await vi.waitFor(() => expect(kinds(opsOf(ann.log, from[0]!, 'root'))).toContain('add:kid'));
		await settled(gus.log);
		expect(opsOf(gus.log, from[1]!, 'root')).toEqual([]);

		for (const c of [ann, gus]) c.conn.ws.close();
	});

	test("a teamspace grant reaches the teamspace's members, and whoever joins later", async () => {
		const ws = await secretWorkspace('live-team-grant');
		const ann = await open(ws, 'ann', { root: tree('secret') });
		const bob = await open(ws, 'bob', { root: tree('secret') });
		const design = await ws.stub.createTeamspace(actorOf(ws.id, 'ann', 'member'), { name: 'Design', privacy: 'closed', defaultLevel: 'read' });
		const from = [ann.log.messages.length, bob.log.messages.length];
		await ws.stub.setGrant(ws.owner, { pageId: 'secret', subjectKind: 'teamspace', subjectId: design.id, level: 'comment' });
		await vi.waitFor(() => expect(kinds(opsOf(ann.log, from[0]!, 'root'))).toContain('add:kid'));
		expect(opsOf(ann.log, from[0]!, 'root').find((o) => o.op === 'add')).toMatchObject({ row: { access: 'comment' } });
		await bob.log.settle();
		expect(opsOf(bob.log, from[1]!, 'root')).toEqual([]);
		// Bob joins the teamspace: the share reaches him too.
		await ws.stub.addTeamspaceMember(actorOf(ws.id, 'ann', 'member'), { teamspaceId: design.id, userId: 'bob' });
		await vi.waitFor(() => expect(kinds(opsOf(bob.log, from[1]!, 'root'))).toContain('add:kid'));
		for (const c of [ann, bob]) c.conn.ws.close();
	});
});

describe('moves, memberships and roles', () => {
	test('moving a page into a teamspace the viewer is not in removes it from their window, and back adds it', async () => {
		const ws = await createWorkspace('live-move');
		const secretTs = await ws.stub.createTeamspace(ws.owner, { name: 'Secret club', privacy: 'private', defaultLevel: 'update' });
		await ws.stub.apply(ws.owner, batch([createOp('open', null, r1, { teamspaceId: ws.generalId, values: { title: 'Open' } })]));
		const ann = await open(ws, 'ann', { roots: tree(null), page: { kind: 'page', pageIds: ['open'] } });
		expect(ann.log.of('snapshot').find((m) => m.id === 'roots')!.rows.map((r) => r.id)).toContain('open');

		let from = ann.log.messages.length;
		await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'open', parentId: null, rank: r3, teamspaceId: secretTs.id }]));
		await vi.waitFor(() => expect(kinds(opsOf(ann.log, from, 'roots'))).toContain('remove:open'));
		expect(kinds(opsOf(ann.log, from, 'page'))).toContain('remove:open');

		from = ann.log.messages.length;
		await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'open', parentId: null, rank: r3, teamspaceId: ws.generalId }]));
		await vi.waitFor(() => expect(kinds(opsOf(ann.log, from, 'roots'))).toContain('add:open'));
		ann.conn.ws.close();
	});

	test('joining and leaving a teamspace adds and removes its pages; a default level change moves `$access`', async () => {
		const ws = await createWorkspace('live-member');
		const ts = await ws.stub.createTeamspace(ws.owner, { name: 'Club', privacy: 'closed', defaultLevel: 'read' });
		await ws.stub.apply(ws.owner, batch([createOp('club-page', null, r1, { teamspaceId: ts.id, values: { title: 'Club page' } })]));
		const ann = await open(ws, 'ann', { roots: tree(null) });
		expect(ann.log.of('snapshot').find((m) => m.id === 'roots')!.rows.map((r) => r.id)).not.toContain('club-page');

		// Open teamspaces are joined in one click; a closed one needs an owner to add you.
		const ana = actorOf(ws.id, 'ann', 'member');
		expect((await failure(ws.stub.addTeamspaceMember(ana, { teamspaceId: ts.id, userId: 'ann' })))?.code).toBe('FORBIDDEN');
		let from = ann.log.messages.length;
		await ws.stub.addTeamspaceMember(ws.owner, { teamspaceId: ts.id, userId: 'ann' });
		await vi.waitFor(() => expect(kinds(opsOf(ann.log, from, 'roots'))).toContain('add:club-page'));
		expect(opsOf(ann.log, from, 'roots').find((o) => o.op === 'add')).toMatchObject({ row: { access: 'read' } });

		from = ann.log.messages.length;
		await ws.stub.updateTeamspace(ws.owner, { id: ts.id, defaultLevel: 'update' });
		await vi.waitFor(() => expect(kinds(opsOf(ann.log, from, 'roots'))).toContain('update:club-page:$access=update'));

		from = ann.log.messages.length;
		await ws.stub.removeTeamspaceMember(ws.owner, { teamspaceId: ts.id, userId: 'ann' });
		await vi.waitFor(() => expect(kinds(opsOf(ann.log, from, 'roots'))).toContain('remove:club-page'));
		ann.conn.ws.close();
	});

	test('a role change reconnects the member; a removal closes with FORBIDDEN and empties their set', async () => {
		const ws = await createWorkspace('live-role');
		const ann = await open(ws, 'ann', { roots: tree(null) });
		await ws.stub.syncMember({ userId: 'ann', role: 'guest', name: 'ann' });
		expect((await ann.conn.closed).code).toBe(CLOSE.TRY_AGAIN);
		// As a guest she sees nothing of the General teamspace.
		const again = await connect(ws.id, dev('ann', 'guest'));
		const log = await again.hello({ subs: [{ id: 'roots', sub: tree(null) }] });
		await log.wait((m) => m.t === 'head');
		expect(log.of('snapshot').find((m) => m.id === 'roots')).toMatchObject({ total: 0, rows: [] });
		expect(await ws.stub.visibleNums({ userId: 'ann', role: 'guest' })).toEqual(new Set());
		await ws.stub.syncMember({ userId: 'ann', role: null });
		expect((await again.closed).code).toBe(CLOSE.FORBIDDEN);
		expect(await ws.stub.visibleNums({ userId: 'ann' })).toEqual(new Set());
	});
});

describe('hibernation', () => {
	test('the sets are rebuilt after eviction; a grant after wake-up either diffs or reconnects the socket, never leaks', async () => {
		const ws = await secretWorkspace('live-hib');
		const ann = await open(ws, 'ann', { root: tree(null, 'secret') });
		await evictDurableObject(ws.stub);
		expect(await ws.stub.visibilityCached({ userId: 'ann', role: 'member' })).toBe(false);
		await ws.stub.setGrant(ws.owner, { pageId: 'secret', subjectKind: 'user', subjectId: 'ann', level: 'read' });
		// The socket lost its set with the object: it is told to reconnect (a fresh snapshot includes the grant).
		expect((await ann.conn.closed).code).toBe(CLOSE.TRY_AGAIN);
		const again = await open(ws, 'ann', { root: tree(null, 'secret') });
		expect(again.log.of('snapshot').find((m) => m.id === 'root')!.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['secret', 'kid']));
		// Warm again: the next change is a diff, not a reconnect.
		const from = again.log.messages.length;
		await ws.stub.setGrant(ws.owner, { pageId: 'secret', subjectKind: 'user', subjectId: 'ann', level: 'full' });
		await vi.waitFor(() => expect(kinds(opsOf(again.log, from, 'root'))).toContain('update:secret:$access=full'));
		again.conn.ws.close();
	});

	test('a reconnect with a lastSeq that spans an access change gets fresh snapshots, not a replay', async () => {
		const ws = await secretWorkspace('live-resume');
		const ann = await open(ws, 'ann', { root: tree(null, 'secret') });
		const seq = Math.max(...ann.log.messages.flatMap((m) => (m.t === 'head' || m.t === 'snapshot' || m.t === 'diff' ? [m.seq] : [])));
		ann.conn.ws.close();
		await ws.stub.setGrant(ws.owner, { pageId: 'secret', subjectKind: 'user', subjectId: 'ann', level: 'read' });
		const back = await connect(ws.id, dev('ann'));
		const log = await back.hello({ lastSeq: seq, subs: [{ id: 'root', sub: tree(null, 'secret') }] });
		await log.wait((m) => m.t === 'head');
		expect(log.of('resumed')[0]).toMatchObject({ mode: 'snapshot' });
		expect(log.of('snapshot').find((m) => m.id === 'root')!.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['secret', 'kid']));
		back.ws.close();
	});
});
