/**
 * Enforcement in the Workspace DO: every call runs on `db.$as(actor)`, so what each level, role and
 * teamspace membership may do is decided by the policy, not by the caller. Complements the matrix (which
 * checks what each actor can SEE) with what each actor can DO.
 */
import { describe, expect, test } from 'vitest';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import type { Actor } from '../../../src/server/auth/session';
import { actorOf, batch, createOp, createWorkspace, ranks, rows, type Fixture } from '../workspace/helpers';

const [r1, r2, r3] = ranks(3);

async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		return decodeWorkspaceError(error);
	}
	throw new Error('expected the call to fail');
}
const code = async (promise: Promise<unknown>) => (await failure(promise))?.code;

const LEVELS = ['read', 'comment', 'update', 'full'] as const;

/** A workspace with the owner's Private page "doc" (and a subpage), shared with one member per level. */
async function leveled(label: string) {
	const ws = await createWorkspace(label);
	const users: Record<string, Actor> = {};
	await ws.stub.apply(ws.owner, batch([createOp('doc', null, r2, { values: { title: 'Doc' } }), createOp('sub', 'doc', r1)]));
	for (const level of LEVELS) {
		const id = `u-${level}`;
		await ws.stub.syncMember({ userId: id, role: 'member', name: id });
		await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: id, level });
		users[level] = actorOf(ws.id, id, 'member');
	}
	return { ws, users };
}

describe('what each level may do on a page', () => {
	test('read and comment: nothing that writes', async () => {
		const { ws, users } = await leveled('enf-low');
		for (const level of ['read', 'comment'] as const) {
			const who = users[level]!;
			const title = batch([{ op: 'setProp', page: 'doc', prop: 'title', value: 'Mine' }]);
			expect(await code(ws.stub.apply(who, title)), `${level}: set a property`).toBe('FORBIDDEN');
			expect(await code(ws.stub.apply(who, batch([createOp(`kid-${level}`, 'doc', r3)]))), `${level}: add a subpage`).toBe('FORBIDDEN');
			expect(await code(ws.stub.apply(who, batch([{ op: 'setPage', page: 'doc', icon: '🔥' }]))), `${level}: set the icon`).toBe('FORBIDDEN');
			expect(await code(ws.stub.apply(who, batch([{ op: 'move', page: 'sub', parentId: null, rank: r3, teamspaceId: ws.generalId }]))), `${level}: move`).toBe('FORBIDDEN');
			expect(await code(ws.stub.apply(who, batch([{ op: 'trash', page: 'doc' }]))), `${level}: trash`).toBe('FORBIDDEN');
			expect(await code(ws.stub.setGrant(who, { pageId: 'doc', subjectKind: 'workspace', subjectId: null, level: 'read' })), `${level}: share`).toBe('FORBIDDEN');
		}
		expect(await rows(ws.stub, "SELECT title, icon FROM page WHERE id = 'doc'")).toEqual([{ title: 'Doc', icon: null }]);
	});

	test('update edits the page and adds subpages, but cannot move, delete or share', async () => {
		const { ws, users } = await leveled('enf-update');
		const who = users.update!;
		await ws.stub.apply(who, batch([{ op: 'setProp', page: 'doc', prop: 'title', value: 'Edited' }, { op: 'setPage', page: 'doc', icon: '🔥' }]));
		await ws.stub.apply(who, batch([createOp('kid', 'doc', r3, { values: { title: 'Kid' } })]));
		// The subpage was made by `u-update`, inside a page shared with them: they keep access to it.
		expect((await ws.stub.getPage(who, 'kid')).access).toBe('update');
		expect(await rows(ws.stub, "SELECT title, icon FROM page WHERE id = 'doc'")).toEqual([{ title: 'Edited', icon: '🔥' }]);
		// Reordering among the same siblings is an edit...
		await ws.stub.apply(who, batch([{ op: 'move', page: 'kid', parentId: 'doc', rank: r1 }]));
		// ...changing the parent or teamspace is not.
		expect(await code(ws.stub.apply(who, batch([{ op: 'move', page: 'kid', parentId: 'sub', rank: r1 }])))).toBe('FORBIDDEN');
		expect(await code(ws.stub.apply(who, batch([{ op: 'trash', page: 'doc' }])))).toBe('FORBIDDEN');
		expect(await code(ws.stub.setGrant(who, { pageId: 'doc', subjectKind: 'workspace', subjectId: null, level: 'read' }))).toBe('FORBIDDEN');
		expect(await rows(ws.stub, "SELECT parent_id FROM page WHERE id = 'kid'")).toEqual([{ parent_id: 'doc' }]);
	});

	test('full moves, deletes, restores and shares; a move needs somewhere the mover may add pages', async () => {
		const { ws, users } = await leveled('enf-full');
		const who = users.full!;
		await ws.stub.setGrant(who, { pageId: 'doc', subjectKind: 'workspace', subjectId: null, level: 'read' });
		// Out of the owner's Private section into a teamspace the mover may add pages to (not into someone else's Private section).
		expect(await code(ws.stub.apply(who, batch([{ op: 'move', page: 'sub', parentId: null, rank: r3 }])))).toBe('FORBIDDEN');
		await ws.stub.apply(who, batch([{ op: 'move', page: 'sub', parentId: null, rank: r3, teamspaceId: ws.generalId }]));
		// Into a page they can only read: refused.
		await ws.stub.apply(ws.owner, batch([createOp('ro-target', null, r1)]));
		await ws.stub.setGrant(ws.owner, { pageId: 'ro-target', subjectKind: 'user', subjectId: 'u-full', level: 'read' });
		expect(await code(ws.stub.apply(who, batch([{ op: 'move', page: 'doc', parentId: 'ro-target', rank: r1 }])))).toBe('FORBIDDEN');
		// Into the General teamspace's root: members of an `update` teamspace may add pages there, and the subtree follows.
		await ws.stub.apply(who, batch([{ op: 'move', page: 'doc', parentId: null, rank: r1, teamspaceId: ws.generalId }]));
		expect(await rows(ws.stub, "SELECT id, teamspace_id FROM page WHERE id IN ('doc', 'sub') ORDER BY id")).toEqual([
			{ id: 'doc', teamspace_id: ws.generalId },
			{ id: 'sub', teamspace_id: ws.generalId }
		]);
		await ws.stub.apply(who, batch([{ op: 'trash', page: 'doc' }]));
		await ws.stub.apply(who, batch([{ op: 'restore', page: 'doc' }]));
		const g = (await ws.stub.listGrants(who, 'doc')).find((x) => x.subjectKind === 'workspace')!;
		await ws.stub.revokeGrant(who, g.id);
		expect((await ws.stub.listGrants(who, 'doc')).some((x) => x.subjectKind === 'workspace')).toBe(false);
	});

	test('a page the caller cannot see does not exist for them', async () => {
		const { ws } = await leveled('enf-hidden');
		await ws.stub.syncMember({ userId: 'nosy', role: 'member', name: 'Nosy' });
		const nosy = actorOf(ws.id, 'nosy', 'member');
		expect(await code(ws.stub.getPage(nosy, 'doc'))).toBe('NOT_FOUND');
		expect(await code(ws.stub.listGrants(nosy, 'doc'))).toBe('NOT_FOUND');
		const edit = await failure(ws.stub.apply(nosy, batch([{ op: 'setProp', page: 'doc', prop: 'title', value: 'x' }])));
		expect(edit).toMatchObject({ code: 'VALIDATION_FAILED' });
		expect(edit?.issues[0]).toMatchObject({ path: '/ops/0/page', code: 'not_found' });
		expect(await code(ws.stub.setGrant(nosy, { pageId: 'doc', subjectKind: 'workspace', subjectId: null, level: 'full' }))).toBe('NOT_FOUND');
		expect(await ws.stub.pageAccess(nosy, 'doc')).toBeNull();
		expect(await ws.stub.can(nosy, ['doc', 'sub'], 'read')).toEqual({ doc: false, sub: false });
		expect(await ws.stub.visibleNums(nosy)).not.toContain(2);
	});
});

describe('workspace roles', () => {
	test('owners and admins hold full access to every page, Private ones included', async () => {
		const { ws } = await leveled('enf-admin');
		await ws.stub.syncMember({ userId: 'adm', role: 'admin', name: 'Adm' });
		const admin = actorOf(ws.id, 'adm', 'admin');
		expect(await ws.stub.pageAccess(admin, 'doc')).toBe('full');
		await ws.stub.apply(admin, batch([{ op: 'setProp', page: 'doc', prop: 'title', value: 'By admin' }]));
		await ws.stub.apply(admin, batch([createOp('admin-root', null, r3, { teamspaceId: ws.generalId })]));
		expect((await ws.stub.listGrants(admin, 'doc')).length).toBe(4);
	});

	test('guests see and edit only what is shared with them directly, and own no teamspace', async () => {
		const ws = await createWorkspace('enf-guest');
		await ws.stub.apply(ws.owner, batch([createOp('open', null, r1, { teamspaceId: ws.generalId }), createOp('shared', null, r2, { teamspaceId: ws.generalId })]));
		await ws.stub.syncMember({ userId: 'gus', role: 'guest', name: 'Gus' });
		const gus = actorOf(ws.id, 'gus', 'guest');
		expect(await ws.stub.pageAccess(gus, 'open')).toBeNull();
		expect(await ws.stub.teamspaces(gus)).toEqual([]);
		// A workspace-wide share is not for guests...
		await ws.stub.setGrant(ws.owner, { pageId: 'open', subjectKind: 'workspace', subjectId: null, level: 'full' });
		expect(await ws.stub.pageAccess(gus, 'open')).toBeNull();
		// ...a direct one is.
		await ws.stub.setGrant(ws.owner, { pageId: 'shared', subjectKind: 'user', subjectId: 'gus', level: 'update' });
		expect(await ws.stub.pageAccess(gus, 'shared')).toBe('update');
		await ws.stub.apply(gus, batch([{ op: 'setProp', page: 'shared', prop: 'title', value: 'Guest edit' }, createOp('guest-kid', 'shared', r1)]));
		// No root pages, no teamspaces, no registry edits, no teamspace membership.
		expect(await code(ws.stub.apply(gus, batch([createOp('g-root', null, r3)])))).toBe('FORBIDDEN');
		expect(await code(ws.stub.apply(gus, batch([createOp('g-root', null, r3, { teamspaceId: ws.generalId })])))).toBe('FORBIDDEN');
		expect(await code(ws.stub.createTeamspace(gus, { name: 'No', privacy: 'open', defaultLevel: 'read' }))).toBe('FORBIDDEN');
		expect(await code(ws.stub.apply(gus, batch([{ op: 'createProperty', property: { id: 'p-x', name: 'X', type: 'text', config: {} } as never }])))).toBe('FORBIDDEN');
		expect(await code(ws.stub.addTeamspaceMember(ws.owner, { teamspaceId: ws.generalId, userId: 'gus' }))).toBe('VALIDATION_FAILED');
		expect(await code(ws.stub.apply(gus, batch([{ op: 'trash', page: 'shared' }])))).toBe('FORBIDDEN');
	});

	test('the Private section belongs to its creator, subpages included, whoever adds them', async () => {
		const ws = await createWorkspace('enf-private');
		for (const id of ['ann', 'bob']) await ws.stub.syncMember({ userId: id, role: 'member', name: id });
		const ann = actorOf(ws.id, 'ann', 'member');
		const bob = actorOf(ws.id, 'bob', 'member');
		await ws.stub.apply(ann, batch([createOp('mine', null, r1, { values: { title: 'Mine' } })]));
		expect(await ws.stub.pageAccess(ann, 'mine')).toBe('full');
		expect(await ws.stub.pageAccess(bob, 'mine')).toBeNull();
		// Shared with Bob, who adds a subpage: Ann still owns the whole branch.
		await ws.stub.setGrant(ann, { pageId: 'mine', subjectKind: 'user', subjectId: 'bob', level: 'update' });
		await ws.stub.apply(bob, batch([createOp('bobs-kid', 'mine', r1)]));
		expect(await ws.stub.pageAccess(ann, 'bobs-kid')).toBe('full');
		// Bob's subpage is in Ann's branch: through the share he edits it, he does not own it.
		expect(await ws.stub.pageAccess(bob, 'bobs-kid')).toBe('update');
		await ws.stub.revokeGrant(ann, (await ws.stub.listGrants(ann, 'mine'))[0]!.id);
		expect(await ws.stub.pageAccess(bob, 'bobs-kid')).toBeNull();
		expect(await ws.stub.pageAccess(ann, 'bobs-kid')).toBe('full');
	});
});

describe('teamspaces', () => {
	async function club(label: string, privacy: 'open' | 'closed' | 'private', defaultLevel: 'read' | 'comment' | 'update' | 'full') {
		const ws = await createWorkspace(label);
		for (const id of ['own', 'mem', 'out', 'gus']) await ws.stub.syncMember({ userId: id, role: id === 'gus' ? 'guest' : 'member', name: id });
		const own = actorOf(ws.id, 'own', 'member');
		const ts = await ws.stub.createTeamspace(own, { name: 'Club', privacy, defaultLevel });
		await ws.stub.addTeamspaceMember(own, { teamspaceId: ts.id, userId: 'mem' });
		return { ws, ts, own, mem: actorOf(ws.id, 'mem', 'member'), out: actorOf(ws.id, 'out', 'member'), gus: actorOf(ws.id, 'gus', 'guest') };
	}

	test('members get the default level; a read-only member cannot add pages, an editor can', async () => {
		const ro = await club('ts-ro', 'closed', 'read');
		expect(await code(ro.ws.stub.apply(ro.mem, batch([createOp('x', null, r1, { teamspaceId: ro.ts.id })])))).toBe('FORBIDDEN');
		await ro.ws.stub.apply(ro.own, batch([createOp('p', null, r1, { teamspaceId: ro.ts.id })]));
		expect(await ro.ws.stub.pageAccess(ro.mem, 'p')).toBe('read');
		expect(await ro.ws.stub.pageAccess(ro.own, 'p')).toBe('full');
		expect(await ro.ws.stub.pageAccess(ro.out, 'p')).toBeNull();
		const rw = await club('ts-rw', 'open', 'update');
		await rw.ws.stub.apply(rw.mem, batch([createOp('x', null, r1, { teamspaceId: rw.ts.id })]));
		expect(await rw.ws.stub.pageAccess(rw.mem, 'x')).toBe('update');
		// A non-member cannot add pages to it, open or not.
		expect(await code(rw.ws.stub.apply(rw.out, batch([createOp('y', null, r1, { teamspaceId: rw.ts.id })])))).toBe('FORBIDDEN');
	});

	test('private teamspaces are invisible to non-members; open and closed ones are listed (never to guests)', async () => {
		const priv = await club('ts-priv', 'private', 'update');
		const names = async (who: Actor) => (await priv.ws.stub.teamspaces(who)).map((t) => t.name);
		expect(await names(priv.own)).toContain('Club');
		expect(await names(priv.mem)).toContain('Club');
		expect(await names(priv.out)).not.toContain('Club');
		expect(await code(priv.ws.stub.teamspaceMembers(priv.out, priv.ts.id))).toBe('NOT_FOUND');
		expect(await code(priv.ws.stub.addTeamspaceMember(priv.out, { teamspaceId: priv.ts.id, userId: 'out' }))).toBe('NOT_FOUND');
		const open = await club('ts-open', 'closed', 'read');
		expect(await open.ws.stub.teamspaces(open.out)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Club', myRole: null })]));
		expect((await open.ws.stub.teamspaces(open.gus)).map((t) => t.name)).toEqual([]);
	});

	test('owners manage the teamspace and its members; anyone joins an open one and leaves any', async () => {
		const open = await club('ts-manage', 'open', 'update');
		const { ws, ts } = open;
		expect(await code(ws.stub.updateTeamspace(open.mem, { id: ts.id, name: 'Mine now' }))).toBe('FORBIDDEN');
		expect(await code(ws.stub.archiveTeamspace(open.mem, ts.id))).toBe('FORBIDDEN');
		expect(await code(ws.stub.setTeamspaceMemberRole(open.mem, { teamspaceId: ts.id, userId: 'mem', role: 'owner' }))).toBe('FORBIDDEN');
		expect(await code(ws.stub.addTeamspaceMember(open.mem, { teamspaceId: ts.id, userId: 'out' }))).toBe('FORBIDDEN');
		// One click joins an open teamspace, as a member only.
		expect(await ws.stub.addTeamspaceMember(open.out, { teamspaceId: ts.id, userId: 'out' })).toMatchObject({ userId: 'out', role: 'member' });
		expect(await code(ws.stub.setTeamspaceMemberRole(open.out, { teamspaceId: ts.id, userId: 'out', role: 'owner' }))).toBe('FORBIDDEN');
		// A member removes themselves, not others.
		expect(await code(ws.stub.removeTeamspaceMember(open.out, { teamspaceId: ts.id, userId: 'mem' }))).toBe('FORBIDDEN');
		await ws.stub.removeTeamspaceMember(open.out, { teamspaceId: ts.id, userId: 'out' });
		// Owners rename, change the default level, add and remove members.
		await ws.stub.updateTeamspace(open.own, { id: ts.id, name: 'Renamed', defaultLevel: 'comment' });
		expect((await ws.stub.teamspaces(open.own)).find((t) => t.id === ts.id)).toMatchObject({ name: 'Renamed', defaultLevel: 'comment', myRole: 'owner' });
		await ws.stub.removeTeamspaceMember(open.own, { teamspaceId: ts.id, userId: 'mem' });
		// A closed teamspace is joined by invitation only.
		const closed = await club('ts-closed', 'closed', 'update');
		expect(await code(closed.ws.stub.addTeamspaceMember(closed.out, { teamspaceId: closed.ts.id, userId: 'out' }))).toBe('FORBIDDEN');
		await closed.ws.stub.addTeamspaceMember(closed.own, { teamspaceId: closed.ts.id, userId: 'out' });
		expect(await closed.ws.stub.pageAccess(closed.out, 'nothing')).toBeNull();
	});
});

describe('grants', () => {
	test('set creates or updates, public mints a token, list hides tokens below full, revoke tombstones', async () => {
		const ws = await createWorkspace('grants');
		for (const id of ['ann', 'bob']) await ws.stub.syncMember({ userId: id, role: 'member', name: id });
		await ws.stub.apply(ws.owner, batch([createOp('doc', null, r1, { teamspaceId: ws.generalId })]));
		const ann = actorOf(ws.id, 'ann', 'member');
		const a = await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'bob', level: 'read' });
		const again = await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'bob', level: 'comment' });
		expect(again.id).toBe(a.id);
		expect(again.level).toBe('comment');
		const link = await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'public', subjectId: null, level: 'read' });
		expect(link.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
		expect((await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'public', subjectId: null, level: 'comment' })).token).toBe(link.token);
		// Ann edits through General's default level: she sees the grants, not the secret link.
		const seen = await ws.stub.listGrants(ann, 'doc');
		expect(seen.find((g) => g.subjectKind === 'public')).toMatchObject({ token: null });
		expect((await ws.stub.listGrants(ws.owner, 'doc')).find((g) => g.subjectKind === 'public')?.token).toBe(link.token);
		// The link opens the page, at its level, until it is revoked.
		expect(await ws.stub.grantByToken(link.token!)).toEqual({ pageId: 'doc', level: 'comment' });
		expect(await ws.stub.grantByToken('x'.repeat(40))).toBeNull();
		expect(await ws.stub.grantByToken('short')).toBeNull();
		const { seq } = await ws.stub.revokeGrant(ws.owner, link.id);
		expect(seq).toBeGreaterThan(0);
		expect(await ws.stub.grantByToken(link.token!)).toBeNull();
		expect(await rows(ws.stub, `SELECT deleted_at IS NOT NULL AS gone FROM "grant" WHERE id = '${link.id}'`)).toEqual([{ gone: 1 }]);
		expect(await code(ws.stub.revokeGrant(ws.owner, link.id))).toBe('NOT_FOUND');
		// An anonymous visitor with the old link holds nothing; a trashed page's link is dead too.
		expect(await ws.stub.pageAccess({ role: 'anonymous', shareToken: link.token! }, 'doc')).toBeNull();
		const second = await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'public', subjectId: null, level: 'read' });
		expect(await ws.stub.pageAccess({ role: 'anonymous', shareToken: second.token! }, 'doc')).toBe('read');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'doc' }]));
		expect(await ws.stub.grantByToken(second.token!)).toBeNull();
	});

	test('subjects are validated', async () => {
		const ws = await createWorkspace('grants-bad');
		await ws.stub.apply(ws.owner, batch([createOp('doc', null, r1, { teamspaceId: ws.generalId })]));
		const set = (subjectKind: 'user' | 'teamspace' | 'workspace' | 'public', subjectId: string | null) =>
			code(ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind, subjectId, level: 'read' }));
		expect(await set('user', 'ghost')).toBe('VALIDATION_FAILED');
		expect(await set('user', null)).toBe('VALIDATION_FAILED');
		expect(await set('teamspace', 'nope')).toBe('VALIDATION_FAILED');
		expect(await set('workspace', 'x')).toBe('VALIDATION_FAILED');
		expect(await set('public', 'x')).toBe('VALIDATION_FAILED');
		expect(await code(ws.stub.setGrant(ws.owner, { pageId: 'missing', subjectKind: 'workspace', subjectId: null, level: 'read' }))).toBe('NOT_FOUND');
	});
});

describe('trash and reads', () => {
	test('the trash lists only what the caller may read; trashed pages have no access; reads of collections follow the page', async () => {
		const { ws, users } = await leveled('enf-trash');
		await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: 'doc' }]));
		const trashed = (who: Actor) => ws.stub.listTrash(who, { sort: 'deleted_desc' } as never).then((r) => r.items.map((i) => i.id));
		expect(await trashed(ws.owner)).toEqual(['doc']);
		// A grant survives the trash, so its grantee sees the page in Trash; a stranger does not.
		expect(await trashed(users.full!)).toEqual(['doc']);
		await ws.stub.syncMember({ userId: 'stranger', role: 'member', name: 's' });
		expect(await trashed(actorOf(ws.id, 'stranger', 'member'))).toEqual([]);
		// ...but a trashed page is not a page anyone can open.
		expect(await ws.stub.pageAccess(ws.owner, 'doc')).toBeNull();
		expect(await ws.stub.can(ws.owner, ['doc'], 'read')).toEqual({ doc: false });
		expect(await code(ws.stub.getPage(ws.owner, 'doc'))).toBe('NOT_FOUND');
		await ws.stub.apply(users.full!, batch([{ op: 'restore', page: 'doc' }]));
		expect(await ws.stub.pageAccess(users.read!, 'doc')).toBe('read');
		void (null as unknown as Fixture);
	});
});
