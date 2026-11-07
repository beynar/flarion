/**
 * The Sync core's `/rpc` handlers (`mutate`, `page.*`, `workspace.teamspaces.*`) through the real oRPC
 * router, with the session seam stubbed: session and membership come from the test, everything else
 * (the middleware, the DO stub, the error mapping) is production code.
 */
import { createRouterClient, ORPCError } from '@orpc/server';
import { env } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { WORKSPACE_HEADER, APP_VERSION_HEADER } from '../../../src/lib/shared/protocol';
import { createWorkspace, ranks } from './helpers';

const members = new Map<string, string>();
vi.mock('../../../src/server/auth/session', () => ({
	resolveSession: async (request: Request) => {
		const userId = request.headers.get('x-test-user');
		return userId ? { userId, sessionId: `s-${userId}`, name: userId, email: `${userId}@x`, emailVerified: true } : null;
	},
	resolveMembership: async (_env: unknown, userId: string, workspaceId: string) => (members.get(`${workspaceId}:${userId}`) as never) ?? null
}));

const { router } = await import('../../../src/server/rpc/private/router');

function clientFor(workspaceId: string, userId: string | null, appVersion = '0.0.1') {
	const headers = new Headers({ [WORKSPACE_HEADER]: workspaceId, [APP_VERSION_HEADER]: appVersion });
	if (userId) headers.set('x-test-user', userId);
	return createRouterClient(router, {
		context: { request: new Request('http://localhost/rpc', { headers }), env: env as unknown as Env, ctx: { waitUntil() {} } }
	});
}

async function failure(promise: Promise<unknown>): Promise<ORPCError<string, any>> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ORPCError) return error;
		throw error;
	}
	throw new Error('expected the call to fail');
}

async function setup() {
	const ws = await createWorkspace('rpc');
	members.set(`${ws.id}:owner-1`, 'owner');
	members.set(`${ws.id}:ann`, 'member');
	members.set(`${ws.id}:gus`, 'guest');
	await ws.stub.syncMember({ userId: 'ann', role: 'member', name: 'Ann' });
	return { ws, owner: clientFor(ws.id, 'owner-1'), ann: clientFor(ws.id, 'ann') };
}

const [r1, r2] = ranks(2);

describe('mutate', () => {
	test('applies a batch and returns its seq', async () => {
		const { ws, owner } = await setup();
		const { seq } = await owner.mutate({
			mid: 'rpc-1',
			appVersion: '0.0.1',
			ops: [{ op: 'create', id: 'a', parentId: null, rank: r1, teamspaceId: ws.generalId, values: { title: 'Via RPC' } }]
		});
		expect(seq).toBeGreaterThan(0);
		expect((await owner.page.get({ id: 'a' })).title).toBe('Via RPC');
	});

	test('maps the DO errors: VALIDATION_FAILED with issues, APP_OUTDATED, FORBIDDEN, UNAUTHORIZED', async () => {
		const { ws, owner } = await setup();
		const invalid = await failure(
			owner.mutate({ mid: 'bad', appVersion: '0.0.1', ops: [{ op: 'create', id: 'x', parentId: 'ghost', rank: r1 }] })
		);
		expect(invalid.code).toBe('VALIDATION_FAILED');
		expect(invalid.status).toBe(422);
		expect(invalid.data).toEqual({ issues: [expect.objectContaining({ path: '/ops/0/parentId', code: 'not_found' })] });

		const outdated = await failure(
			owner.mutate({ mid: 'old', appVersion: '0.0.0', ops: [{ op: 'create', id: 'y', parentId: null, rank: r1 }] })
		);
		expect(outdated.code).toBe('APP_OUTDATED');
		expect(outdated.status).toBe(426);

		const guest = clientFor(ws.id, 'gus');
		expect((await failure(guest.mutate({ mid: 'g', appVersion: '0.0.1', ops: [{ op: 'create', id: 'z', parentId: null, rank: r1 }] }))).code).toBe('FORBIDDEN');
		const nobody = clientFor(ws.id, null);
		expect((await failure(nobody.mutate({ mid: 'n', appVersion: '0.0.1', ops: [{ op: 'trash', page: 'a' }] }))).code).toBe('UNAUTHORIZED');
		// A user who is not a member of this workspace is refused before the DO is reached.
		const stranger = clientFor(ws.id, 'stranger');
		expect((await failure(stranger.page.get({ id: 'a' }))).code).toBe('FORBIDDEN');
	});
});

describe('page', () => {
	test('create, get, move, trash, restore and the trash list', async () => {
		const { ws, owner, ann } = await setup();
		const created = await ann.page.create({ parentId: null, teamspaceId: ws.generalId, values: { title: 'Notes' }, icon: '📝' });
		expect(created).toMatchObject({ id: expect.any(String), num: expect.any(Number), seq: expect.any(Number) });
		const page = await owner.page.get({ id: created.id });
		expect(page).toMatchObject({ title: 'Notes', icon: '📝', parentId: null, teamspaceId: ws.generalId, createdBy: 'ann', access: 'full' });
		// The client may choose the id (optimistic UI) and the rank.
		const child = await owner.page.create({ id: 'child-1', parentId: created.id, rank: r2 });
		expect(child.id).toBe('child-1');
		expect((await owner.page.get({ id: 'child-1' })).parentId).toBe(created.id);

		const moved = await owner.page.move({ id: 'child-1', parentId: null, rank: r1, teamspaceId: ws.generalId });
		expect(moved.seq).toBeGreaterThan(child.seq);
		expect((await owner.page.get({ id: 'child-1' })).parentId).toBeNull();

		const trashed = await owner.page.trash({ id: created.id });
		expect(trashed.seq).toBeGreaterThan(moved.seq);
		expect((await failure(owner.page.get({ id: created.id }))).code).toBe('NOT_FOUND');
		const list = await owner.page.trashList({});
		expect(list.items).toMatchObject([{ id: created.id, title: 'Notes', pageCount: 1, deletedBy: 'owner-1' }]);
		await owner.page.restore({ id: created.id });
		expect((await owner.page.get({ id: created.id })).title).toBe('Notes');
		expect((await owner.page.trashList({})).items).toEqual([]);
	});

	test('page.purge deletes a trashed page for good, and refuses a live one, an unknown one and a caller without full access', async () => {
		const { ws, owner, ann } = await setup();
		await owner.mutate({ mid: 'purge-1', appVersion: '0.0.1', ops: [{ op: 'create', id: 'doomed', parentId: null, rank: r1, teamspaceId: ws.generalId, values: { title: 'Doomed' } }] });
		expect((await failure(owner.page.purge({ id: 'nope' }))).code).toBe('NOT_FOUND');
		expect((await failure(owner.page.purge({ id: 'doomed' }))).status).toBe(422);
		await owner.page.trash({ id: 'doomed' });
		// Ann can read it (a member of General) but has only `update`: she cannot delete it forever.
		expect((await failure(ann.page.purge({ id: 'doomed' }))).status).toBe(403);
		await owner.page.purge({ id: 'doomed' });
		expect((await owner.page.trashList({})).items).toEqual([]);
		expect((await failure(owner.page.get({ id: 'doomed' }))).code).toBe('NOT_FOUND');
		expect(await ws.stub.pagesAfter(0)).not.toContainEqual(expect.objectContaining({ id: 'doomed' }));
	});
});

describe('workspace.teamspaces', () => {
	test('list, create, update, members, archive', async () => {
		const { ws, owner, ann } = await setup();
		expect((await owner.workspace.teamspaces.list()).map((t) => t.name)).toEqual(['General']);
		const ts = await ann.workspace.teamspaces.create({ name: 'Design', privacy: 'open', defaultLevel: 'update' });
		expect(ts).toMatchObject({ name: 'Design', myRole: 'owner', createdBy: 'ann' });
		const renamed = await ann.workspace.teamspaces.update({ id: ts.id, name: 'Design team', icon: '🎨' });
		expect(renamed).toMatchObject({ name: 'Design team', icon: '🎨' });

		const added = await ann.workspace.teamspaces.members.add({ teamspaceId: ts.id, userId: 'owner-1', role: 'member' });
		expect(added).toMatchObject({ userId: 'owner-1', role: 'member' });
		expect(await owner.workspace.teamspaces.members.list({ teamspaceId: ts.id })).toHaveLength(2);
		await ann.workspace.teamspaces.members.setRole({ teamspaceId: ts.id, userId: 'owner-1', role: 'owner' });
		expect(await ann.workspace.teamspaces.members.remove({ teamspaceId: ts.id, userId: 'owner-1' })).toEqual({});
		expect((await failure(ann.workspace.teamspaces.members.remove({ teamspaceId: ts.id, userId: 'ann' }))).code).toBe('CONFLICT');

		const page = await ann.page.create({ parentId: null, teamspaceId: ts.id });
		const { seq } = await ann.workspace.teamspaces.archive({ id: ts.id });
		expect(seq).toBeGreaterThan(page.seq);
		expect((await owner.workspace.teamspaces.list()).map((t) => t.name)).toEqual(['General']);
		expect((await failure(ann.page.get({ id: page.id }))).code).toBe('NOT_FOUND');
		// Guests cannot create teamspaces.
		const guest = clientFor(ws.id, 'gus');
		expect((await failure(guest.workspace.teamspaces.create({ name: 'No', privacy: 'open', defaultLevel: 'read' }))).code).toBe('FORBIDDEN');
	});
});
