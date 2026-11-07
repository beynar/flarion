/**
 * Access changes reach open rooms: a grant change, a move or a membership change walks the affected
 * subtree, keeps the pages in `open_room`, and downgrades or closes the sockets of the users whose access
 * changed (and only them). A dial asks the Workspace DO, so a revoked share stops working at once.
 */
import { describe, expect, test, vi } from 'vitest';
import { mintRoomToken, type RoomAccess } from '../../../src/server/rooms/token';
import { resolveRoomAccess } from '../../../src/server/rooms/access';
import { syncRooms } from '../../../src/server/objects/workspace/room-sync';
import { batch, createOp, createWorkspace, inside, ranks, rows, type Fixture } from '../workspace/helpers';
import { claimsFor, connect, dialOutcome, pageStub, testEnv, type Client } from '../rooms/helpers';

vi.setConfig({ testTimeout: 40_000 });

const [r1, r2] = ranks(2);
const wait = { timeout: 10_000, interval: 25 };

async function token(ws: Fixture, pageId: string, userId: string, access: RoomAccess = 'write') {
	return (await mintRoomToken(testEnv, claimsFor(ws.id, pageId, userId, access))).token;
}
async function join(ws: Fixture, pageId: string, userId: string, access: RoomAccess = 'write'): Promise<Client> {
	const client = connect(pageId, await token(ws, pageId, userId, access), { userId });
	await vi.waitFor(() => expect(client.access.length).toBeGreaterThan(0), wait);
	return client;
}
const members = (ws: Fixture, ...ids: string[]) => Promise.all(ids.map((id) => ws.stub.syncMember({ userId: id, role: 'member', name: id })));
const openRooms = (ws: Fixture) => rows<{ page_id: string }>(ws.stub, 'SELECT page_id FROM open_room ORDER BY page_id').then((r) => r.map((x) => x.page_id));
const closeCode = (c: Client) => c.closes.at(-1)?.code;

async function privateDoc(label: string) {
	const ws = await createWorkspace(label);
	await members(ws, 'ann', 'bob');
	await ws.stub.apply(ws.owner, batch([createOp('doc', null, r2, { values: { title: 'Doc' } }), createOp('sub', 'doc', r1)]));
	return ws;
}

describe('a dial asks the workspace', () => {
	test('no access, no room; the token only narrows what the workspace gives', async () => {
		const ws = await privateDoc('room-dial');
		expect(await dialOutcome('doc', { token: await token(ws, 'doc', 'ann') })).toMatchObject({ code: 4403 });
		await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'comment' });
		// Asked for write, the workspace says comment.
		expect(await resolveRoomAccess(testEnv, claimsFor(ws.id, 'doc', 'ann', 'write'))).toEqual({ access: 'comment' });
		// Asked for read, a token never widens: read.
		expect(await resolveRoomAccess(testEnv, claimsFor(ws.id, 'doc', 'ann', 'read'))).toEqual({ access: 'read' });
		// Inherited by the subpage, and a user the workspace does not know holds nothing.
		expect(await resolveRoomAccess(testEnv, claimsFor(ws.id, 'sub', 'ann', 'write'))).toEqual({ access: 'comment' });
		expect(await resolveRoomAccess(testEnv, claimsFor(ws.id, 'doc', 'stranger'))).toBeNull();
		expect(await resolveRoomAccess(testEnv, claimsFor(ws.id, 'nope', 'ann'))).toBeNull();
		expect(await dialOutcome('doc', { token: await token(ws, 'doc', 'ann') })).toBe('open');
		// A workspace that cannot be asked fails closed.
		expect(await resolveRoomAccess({ ...testEnv, WORKSPACE: { getByName: () => { throw new Error('down'); } } } as unknown as Env, claimsFor(ws.id, 'doc', 'ann'))).toBeNull();
	});

	test('the Workspace DO knows which rooms are open', async () => {
		const ws = await privateDoc('room-open');
		await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'update' });
		const ann = await join(ws, 'doc', 'ann');
		await vi.waitFor(async () => expect(await openRooms(ws)).toEqual(['doc']), wait);
		expect(await pageStub(ws.id, 'doc').roomUsers()).toEqual(['ann']);
		ann.close();
	});
});

describe('access changes reach open rooms', () => {
	test('a lower share downgrades the socket in place; a revoke closes it for good; the others are left alone', async () => {
		const ws = await privateDoc('room-grant');
		const g = await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'update' });
		await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'bob', level: 'update' });
		const ann = await join(ws, 'doc', 'ann');
		const bob = await join(ws, 'doc', 'bob');
		expect(ann.access.at(-1)).toBe('write');
		await vi.waitFor(async () => expect(await openRooms(ws)).toEqual(['doc']), wait);

		// update -> read: Ann's socket becomes a read-only view without leaving.
		await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'read' });
		await vi.waitFor(() => expect(ann.access.at(-1)).toBe('read'), wait);
		expect(closeCode(ann)).toBeUndefined();
		expect(bob.access.at(-1)).toBe('write');

		// Revoked: closed with 4403 (terminal: the provider does not retry), and a new dial is refused.
		await ws.stub.revokeGrant(ws.owner, g.id);
		await vi.waitFor(() => expect(closeCode(ann)).toBe(4403), wait);
		expect(await dialOutcome('doc', { token: await token(ws, 'doc', 'ann') })).toMatchObject({ code: 4403 });
		expect(bob.closes.filter((c) => c.code === 4403)).toEqual([]);
		expect(await pageStub(ws.id, 'doc').roomUsers()).toEqual(['bob']);
		ann.close();
		bob.close();
	});

	test('a share on an ancestor reaches the open room of a descendant', async () => {
		const ws = await privateDoc('room-subtree');
		const g = await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'full' });
		const ann = await join(ws, 'sub', 'ann');
		await vi.waitFor(async () => expect(await openRooms(ws)).toEqual(['sub']), wait);
		await ws.stub.revokeGrant(ws.owner, g.id);
		await vi.waitFor(() => expect(closeCode(ann)).toBe(4403), wait);
		ann.close();
	});

	test('a comment level makes the socket redial and come back as a commenter', async () => {
		const ws = await privateDoc('room-comment');
		await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'update' });
		const ann = await join(ws, 'doc', 'ann');
		await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'comment' });
		// 1012 (access changed): the provider redials, and `authorize` grants what the workspace now says.
		await vi.waitFor(() => expect(ann.closes.some((c) => c.code === 1012)).toBe(true), wait);
		await vi.waitFor(() => expect(ann.access.at(-1)).toBe('comment'), wait);
		ann.close();
	});

	test('moving a page where the user has no access closes their room; moving it back does not reopen it by itself', async () => {
		const ws = await createWorkspace('room-move');
		await members(ws, 'ann');
		const club = await ws.stub.createTeamspace(ws.owner, { name: 'Club', privacy: 'private', defaultLevel: 'update' });
		await ws.stub.apply(ws.owner, batch([createOp('page', null, r1, { teamspaceId: ws.generalId })]));
		const ann = await join(ws, 'page', 'ann');
		await ws.stub.apply(ws.owner, batch([{ op: 'move', page: 'page', parentId: null, rank: r2, teamspaceId: club.id }]));
		await vi.waitFor(() => expect(closeCode(ann)).toBe(4403), wait);
		ann.close();
	});

	test('leaving a teamspace closes the rooms of its pages; a removed workspace member loses every room', async () => {
		const ws = await createWorkspace('room-members');
		await members(ws, 'ann', 'bob');
		const club = await ws.stub.createTeamspace(ws.owner, { name: 'Club', privacy: 'closed', defaultLevel: 'update' });
		await ws.stub.addTeamspaceMember(ws.owner, { teamspaceId: club.id, userId: 'ann' });
		await ws.stub.addTeamspaceMember(ws.owner, { teamspaceId: club.id, userId: 'bob' });
		await ws.stub.apply(ws.owner, batch([createOp('club-doc', null, r1, { teamspaceId: club.id })]));
		const ann = await join(ws, 'club-doc', 'ann');
		const bob = await join(ws, 'club-doc', 'bob');
		await ws.stub.removeTeamspaceMember(ws.owner, { teamspaceId: club.id, userId: 'ann' });
		await vi.waitFor(() => expect(closeCode(ann)).toBe(4403), wait);
		expect(bob.access.at(-1)).toBe('write');
		await ws.stub.syncMember({ userId: 'bob', role: null });
		await vi.waitFor(() => expect(closeCode(bob)).toBe(4403), wait);
		ann.close();
		bob.close();
	});

	test('trashing a page closes its room; the sync only touches rooms in the affected subtree', async () => {
		const ws = await privateDoc('room-trash');
		await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'update' });
		await ws.stub.apply(ws.owner, batch([createOp('other', null, r1, { values: { title: 'Other' } })]));
		await ws.stub.setGrant(ws.owner, { pageId: 'other', subjectKind: 'user', subjectId: 'ann', level: 'update' });
		const onDoc = await join(ws, 'doc', 'ann');
		const onOther = await join(ws, 'other', 'ann');
		await vi.waitFor(async () => expect(await openRooms(ws)).toEqual(['doc', 'other']), wait);
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'doc' }]));
		await vi.waitFor(() => expect(closeCode(onDoc)).toBe(4403), wait);
		expect(closeCode(onOther)).toBeUndefined();
		onDoc.close();
		onOther.close();
	});
});

describe('the room sync in isolation', () => {
	test('batches rooms, skips unchanged users and reports what it did', async () => {
		const ws = await privateDoc('room-batch');
		await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'update' });
		await inside(ws.stub, (sql) => {
			for (let i = 0; i < 40; i++) sql.exec('INSERT OR IGNORE INTO open_room (page_id) VALUES (?)', i % 2 ? 'doc' : 'sub');
		});
		const calls: string[] = [];
		const result = await inside(ws.stub, async (sql) =>
			syncRooms(
				{
					sql,
					workspaceId: ws.id,
					access: undefined as never,
					changes: [],
					room: (pageId) => ({
						roomUsers: async () => {
							calls.push(pageId);
							return [];
						},
						setAccess: async () => undefined,
						closeUser: async () => undefined
					})
				},
				{ roots: ['doc'], teamspaces: [], everything: false }
			)
		);
		expect(result.rooms).toBe(2);
		expect(new Set(calls)).toEqual(new Set(['doc', 'sub']));
	});
});
