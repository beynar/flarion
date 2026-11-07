/** `page.roomToken` through the real oRPC router: the room access is what the page's permissions give the caller. */
import { createRouterClient, ORPCError } from '@orpc/server';
import { env } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { APP_VERSION_HEADER, WORKSPACE_HEADER } from '../../../src/lib/shared/protocol';
import { verifyRoomToken } from '../../../src/server/rooms/token';
import { batch, createOp, createWorkspace, ranks } from '../workspace/helpers';

const members = new Map<string, string>();
vi.mock('../../../src/server/auth/session', () => ({
	resolveSession: async (request: Request) => {
		const userId = request.headers.get('x-test-user');
		return userId ? { userId, sessionId: `s-${userId}`, name: userId, email: `${userId}@x`, emailVerified: true } : null;
	},
	resolveMembership: async (_env: unknown, userId: string, workspaceId: string) => (members.get(`${workspaceId}:${userId}`) as never) ?? null
}));

const { router } = await import('../../../src/server/rpc/private/router');

const clientFor = (workspaceId: string, userId: string) =>
	createRouterClient(router, {
		context: {
			request: new Request('http://localhost/rpc', { headers: { [WORKSPACE_HEADER]: workspaceId, [APP_VERSION_HEADER]: '0.0.1', 'x-test-user': userId } }),
			env: env as unknown as Env,
			ctx: { waitUntil() {} }
		}
	});

async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ORPCError) return error;
		throw error;
	}
	throw new Error('expected the call to fail');
}

test('the token carries the access the page gives the caller, and a caller with none gets no token', async () => {
	const ws = await createWorkspace('room-token');
	const [r1] = ranks(1);
	await ws.stub.apply(ws.owner, batch([createOp('doc', null, r1, { values: { title: 'Doc' } })]));
	const roles = { ann: 'member', bob: 'member', gus: 'guest' } as const;
	members.set(`${ws.id}:owner-1`, 'owner');
	for (const [id, role] of Object.entries(roles)) {
		members.set(`${ws.id}:${id}`, role);
		await ws.stub.syncMember({ userId: id, role, name: id });
	}
	const claims = async (userId: string) => {
		const { token, access } = await clientFor(ws.id, userId).page.roomToken({ id: 'doc' });
		const verified = await verifyRoomToken(env as unknown as Env, token);
		expect(verified.ok && verified.claims.access).toBe(access);
		return access;
	};

	expect((await failure(clientFor(ws.id, 'ann').page.roomToken({ id: 'doc' }))).code).toBe('NOT_FOUND');
	expect(await claims('owner-1')).toBe('write');

	await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'ann', level: 'comment' });
	await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'bob', level: 'update' });
	await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'gus', level: 'read' });
	expect(await claims('ann')).toBe('comment');
	expect(await claims('bob')).toBe('write');
	// A guest with an edit share edits; their role alone (guest = read) is not what decides.
	expect(await claims('gus')).toBe('read');
	await ws.stub.setGrant(ws.owner, { pageId: 'doc', subjectKind: 'user', subjectId: 'gus', level: 'full' });
	expect(await claims('gus')).toBe('write');
});
