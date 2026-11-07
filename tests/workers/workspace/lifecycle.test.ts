import { describe, expect, test } from 'vitest';
import type { PageIndexItem } from '../../../src/server/queues/types';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { connect, workspaceStub } from '../socket/helpers';
import { actorOf, batch, createOp, createWorkspace, freshId, inside, ranks, rows } from './helpers';

const [r1, r2] = ranks(2);

async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return decodeWorkspaceError(error);
	}
	throw new Error('expected the call to fail');
}

describe('init', () => {
	test('creates the owner, the open General teamspace and a Getting started page', async () => {
		const ws = await createWorkspace('init');
		expect(await ws.stub.getMemberRole('owner-1')).toBe('owner');
		const teamspaces = await ws.stub.teamspaces(ws.owner);
		expect(teamspaces).toMatchObject([{ id: ws.generalId, name: 'General', privacy: 'open', myRole: 'owner' }]);
		expect(await ws.stub.teamspaceMembers(ws.owner, ws.generalId)).toMatchObject([{ userId: 'owner-1', role: 'owner' }]);
		const pages = await rows<{ id: string; title: string; teamspace_id: string; parent_id: string | null }>(
			ws.stub,
			'SELECT id, title, teamspace_id, parent_id FROM page'
		);
		expect(pages).toMatchObject([{ title: 'Getting started', teamspace_id: ws.generalId, parent_id: null }]);
	});

	test('is idempotent: a second call changes nothing', async () => {
		const ws = await createWorkspace('init-twice');
		const before = {
			pages: await rows(ws.stub, 'SELECT id, num FROM page'),
			teamspaces: await rows(ws.stub, 'SELECT id FROM teamspace'),
			changes: await rows(ws.stub, 'SELECT seq FROM change')
		};
		const again = await ws.stub.init({ workspaceId: ws.id, name: 'Renamed', ownerId: 'someone-else', ownerName: 'X' });
		expect(again).toEqual({ created: false, teamspaceId: ws.generalId });
		expect({
			pages: await rows(ws.stub, 'SELECT id, num FROM page'),
			teamspaces: await rows(ws.stub, 'SELECT id FROM teamspace'),
			changes: await rows(ws.stub, 'SELECT seq FROM change')
		}).toEqual(before);
		expect(await ws.stub.getMemberRole('someone-else')).toBeNull();
		// Two concurrent first calls create one workspace.
		const id = freshId('init-race');
		const stub = workspaceStub(id);
		const args = { workspaceId: id, name: 'R', ownerId: 'o', ownerName: 'O' };
		const results = await Promise.all([stub.init(args), stub.init(args), stub.init(args)]);
		expect(results.filter((r) => r.created)).toHaveLength(1);
		expect(await rows(stub, 'SELECT id FROM teamspace')).toHaveLength(1);
		expect(await rows(stub, 'SELECT id FROM page')).toHaveLength(1);
	});
});

describe('rename', () => {
	test('keeps the display name in meta, idempotently', async () => {
		const ws = await createWorkspace('rename');
		const name = async () => JSON.parse((await rows<{ value: string }>(ws.stub, "SELECT value FROM meta WHERE key = 'workspace'"))[0]!.value);
		expect(await name()).toEqual({ id: ws.id, name: 'Test' });
		await ws.stub.rename({ name: 'Acme Corp' });
		await ws.stub.rename({ name: 'Acme Corp' });
		expect(await name()).toEqual({ id: ws.id, name: 'Acme Corp' });
	});
});

describe('membership mirror', () => {
	test('syncMember mirrors role changes and removals; getMemberRole answers from the mirror', async () => {
		const ws = await createWorkspace('members');
		expect(await ws.stub.getMemberRole('ana')).toBeNull();
		await ws.stub.syncMember({ userId: 'ana', role: 'member', name: 'Ana' });
		expect(await ws.stub.getMemberRole('ana')).toBe('member');
		await ws.stub.syncMember({ userId: 'ana', role: 'admin', name: 'Ana B' });
		expect(await ws.stub.getMemberRole('ana')).toBe('admin');
		expect(await rows(ws.stub, "SELECT role, name, removed_at FROM member WHERE user_id = 'ana'")).toEqual([
			{ role: 'admin', name: 'Ana B', removed_at: null }
		]);
		await ws.stub.syncMember({ userId: 'ana', role: 'admin', name: 'Ana B', removed: true });
		expect(await ws.stub.getMemberRole('ana')).toBeNull();
		// A removed user can come back; `role: null` is a removal too (the Accounts track's shape).
		await ws.stub.syncMember({ userId: 'ana', role: 'guest', name: 'Ana B' });
		expect(await ws.stub.getMemberRole('ana')).toBe('guest');
		await ws.stub.syncMember({ userId: 'ana', role: null });
		expect(await ws.stub.getMemberRole('ana')).toBeNull();
		expect(await rows(ws.stub, "SELECT name FROM member WHERE user_id = 'ana'")).toEqual([{ name: 'Ana B' }]);
	});

	test('removing a member closes their sockets with FORBIDDEN; a role change reaches the attachment', async () => {
		const ws = await createWorkspace('members-socket');
		await ws.stub.syncMember({ userId: 'bob', role: 'member', name: 'Bob' });
		const bob = await connect(ws.id, { 'x-flarion-dev-actor': 'bob', 'x-flarion-dev-role': 'member' });
		await bob.hello();
		await ws.stub.syncMember({ userId: 'bob', role: 'admin', name: 'Bob' });
		const attached = await inside(ws.stub, (_sql, state) => state.getWebSockets().map((s) => s.deserializeAttachment()));
		expect(attached[0].actor.role).toBe('admin');
		await ws.stub.syncMember({ userId: 'bob', role: null });
		expect((await bob.closed).code).toBe(4403);
	});
});

describe('teamspaces', () => {
	test('create, update, members, archive', async () => {
		const ws = await createWorkspace('teamspaces');
		await ws.stub.syncMember({ userId: 'ana', role: 'member', name: 'Ana' });
		const ana = actorOf(ws.id, 'ana', 'member');
		const ts = await ws.stub.createTeamspace(ana, { name: 'Design', privacy: 'closed', defaultLevel: 'comment', description: 'Pixels' });
		expect(ts).toMatchObject({ name: 'Design', myRole: 'owner', description: 'Pixels', createdBy: 'ana' });
		// Owner sees it listed; closed teamspaces are listed to every non-guest member.
		expect((await ws.stub.teamspaces(ws.owner)).map((t) => t.name).sort()).toEqual(['Design', 'General']);
		expect((await ws.stub.teamspaces(ws.owner)).find((t) => t.id === ts.id)?.myRole).toBeNull();

		const updated = await ws.stub.updateTeamspace(ana, { id: ts.id, name: 'Design team', privacy: 'private' });
		expect(updated).toMatchObject({ name: 'Design team', privacy: 'private' });
		// Private ones are invisible to non-members.
		expect((await ws.stub.teamspaces(ws.owner)).map((t) => t.name)).toEqual(['General']);
		expect((await failure(ws.stub.teamspaceMembers(ws.owner, ts.id)))?.code).toBe('NOT_FOUND');

		// Members.
		const added = await ws.stub.addTeamspaceMember(ana, { teamspaceId: ts.id, userId: 'owner-1' });
		expect(added).toMatchObject({ userId: 'owner-1', role: 'member' });
		expect(added.rank).toMatch(/^\d+$/);
		expect((await failure(ws.stub.addTeamspaceMember(ana, { teamspaceId: ts.id, userId: 'ghost' })))?.code).toBe('VALIDATION_FAILED');
		await ws.stub.setTeamspaceMemberRole(ana, { teamspaceId: ts.id, userId: 'owner-1', role: 'owner' });
		await ws.stub.setTeamspaceMemberRole(ana, { teamspaceId: ts.id, userId: 'ana', role: 'member' });
		// The last owner cannot leave.
		expect((await failure(ws.stub.setTeamspaceMemberRole(ana, { teamspaceId: ts.id, userId: 'owner-1', role: 'member' })))?.code).toBe('CONFLICT');
		expect((await failure(ws.stub.removeTeamspaceMember(ana, { teamspaceId: ts.id, userId: 'owner-1' })))?.code).toBe('CONFLICT');
		await ws.stub.removeTeamspaceMember(ws.owner, { teamspaceId: ts.id, userId: 'ana' });
		expect((await ws.stub.teamspaceMembers(ws.owner, ts.id)).map((m) => m.userId)).toEqual(['owner-1']);

		// Archive tombstones the teamspace and every page in it with one timestamp.
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r1, { teamspaceId: ts.id }), createOp('b', 'a', r1), createOp('keep', null, r2, { teamspaceId: ws.generalId })]));
		const { seq } = await ws.stub.archiveTeamspace(ws.owner, ts.id);
		expect(seq).toBeGreaterThan(0);
		const stamps = await rows<{ id: string; deleted_at: string | null }>(ws.stub, "SELECT id, deleted_at FROM page WHERE id IN ('a','b','keep') ORDER BY id");
		expect(stamps[0].deleted_at).toBeTruthy();
		expect(stamps[1].deleted_at).toBe(stamps[0].deleted_at);
		expect(stamps[2].deleted_at).toBeNull();
		expect((await ws.stub.teamspaces(ws.owner)).map((t) => t.name)).toEqual(['General']);
		expect((await failure(ws.stub.updateTeamspace(ws.owner, { id: ts.id, name: 'x' })))?.code).toBe('NOT_FOUND');
	});

	test('guests cannot create teamspaces and see only the ones they belong to', async () => {
		const ws = await createWorkspace('teamspaces-guest');
		const guest = actorOf(ws.id, 'g', 'guest');
		expect((await failure(ws.stub.createTeamspace(guest, { name: 'No', privacy: 'open', defaultLevel: 'read' })))?.code).toBe('FORBIDDEN');
		expect(await ws.stub.teamspaces(guest)).toEqual([]);
	});

	test('a page can only be created in a live teamspace', async () => {
		const ws = await createWorkspace('teamspaces-pages');
		const error = await failure(ws.stub.apply(ws.owner, batch([createOp('a', null, r1, { teamspaceId: 'nope' })])));
		expect(error?.issues[0]).toMatchObject({ path: '/ops/0/teamspaceId', code: 'not_found' });
	});
});

describe('index ingestion', () => {
	const item = (pageId: string, extra: Partial<PageIndexItem> = {}): PageIndexItem => ({
		pageId,
		version: 1,
		text: 'hello world',
		outline: [{ level: 1, text: 'Intro', blockId: 'b1' }],
		links: [],
		mentions: [],
		editedAt: Date.parse('2026-11-07T10:00:00Z'),
		editedBy: 'ana',
		...extra
	});

	test('stores text, links and edit stamps; newer versions win; unknown pages are skipped', async () => {
		const ws = await createWorkspace('ingest');
		await ws.stub.apply(ws.owner, batch([createOp('a', null, r1), createOp('b', null, r2), createOp('c', 'a', r1)]));
		const result = await ws.stub.ingestPages([
			item('a', {
				text: 'links to b',
				links: [
					{ to: 'b', kind: 'mention' },
					{ to: 'b', kind: 'link' },
					{ to: 'c', kind: 'subpage' },
					{ to: 'ghost', kind: 'link' },
					{ to: 'a', kind: 'link' }
				]
			}),
			item('zzz')
		]);
		expect(result).toEqual({ indexed: 1, skipped: 1 });
		const nums = Object.fromEntries((await rows<{ id: string; num: number }>(ws.stub, 'SELECT id, num FROM page')).map((p) => [p.id, p.num]));
		expect(await rows(ws.stub, 'SELECT to_page, kind FROM link WHERE from_page = ? ORDER BY to_page, kind', nums.a)).toEqual([
			{ to_page: nums.b, kind: 'link' },
			{ to_page: nums.b, kind: 'mention' },
			{ to_page: nums.c, kind: 'subpage' }
		]);
		expect(await rows(ws.stub, 'SELECT text, version FROM page_text WHERE page_num = ?', nums.a)).toEqual([{ text: 'links to b', version: 1 }]);
		expect(await rows(ws.stub, "SELECT updated_at, updated_by FROM page WHERE id = 'a'")).toEqual([
			{ updated_at: '2026-11-07T10:00:00.000Z', updated_by: 'ana' }
		]);

		// A stale version is skipped; a new one replaces text and links.
		expect(await ws.stub.ingestPages([item('a', { version: 0, text: 'old' })])).toEqual({ indexed: 0, skipped: 1 });
		await ws.stub.ingestPages([item('a', { version: 2, text: 'now only c', links: [{ to: 'c', kind: 'link' }] })]);
		expect(await rows(ws.stub, 'SELECT to_page, kind FROM link WHERE from_page = ?', nums.a)).toEqual([{ to_page: nums.c, kind: 'link' }]);
		expect(await rows(ws.stub, 'SELECT text FROM page_text WHERE page_num = ?', nums.a)).toEqual([{ text: 'now only c' }]);
	});
});

describe('rooms', () => {
	test('openRoom and closeRoom maintain open_room', async () => {
		const ws = await createWorkspace('rooms');
		await ws.stub.openRoom('p1');
		await ws.stub.openRoom('p1');
		await ws.stub.openRoom('p2');
		expect((await rows<{ page_id: string }>(ws.stub, 'SELECT page_id FROM open_room ORDER BY page_id')).map((r) => r.page_id)).toEqual(['p1', 'p2']);
		await ws.stub.closeRoom('p1');
		await ws.stub.closeRoom('never-opened');
		expect((await rows<{ page_id: string }>(ws.stub, 'SELECT page_id FROM open_room')).map((r) => r.page_id)).toEqual(['p2']);
	});
});
