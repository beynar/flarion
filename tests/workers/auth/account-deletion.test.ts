/**
 * Account deletion (docs/PLAN.md "Security rules") and ownership transfer, through the real RPC stack: memberships and
 * passkeys go, tokens die, the Workspace DO forgets the member, the user stays in history as "Deleted user", and the last
 * owner of a workspace must hand it over (or delete it) first.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDirectoryClient } from '../../../src/server/db/global.client';
import { DELETED_USER_NAME, deletedEmail } from '../../../src/server/auth/account-deletion';
import { api, issueToken } from '../api/helpers';
import { addMember, createFixture } from '../files/helpers';

vi.setConfig({ testTimeout: 40_000 });

async function joined(fx: Awaited<ReturnType<typeof createFixture>>, name: string, role: 'member' | 'guest' | 'admin' = 'member') {
	const person = await addMember(fx, name, role);
	await createDirectoryClient(fx.world.env.DB).membership.create({ data: { id: crypto.randomUUID(), workspaceId: fx.workspaceId, userId: person.userId, role, joinedAt: new Date() } });
	return person;
}

describe('account deletion', () => {
	it('removes memberships, passkeys, sessions and tokens, and leaves the user as "Deleted user"', async () => {
		const fx = await createFixture();
		const bob = await joined(fx, 'Bob');
		const token = (await issueToken(fx, bob, ['user.read'])).token;
		const db = createDirectoryClient(fx.world.env.DB);
		expect(await db.passkey.count({ where: { userId: bob.userId } })).toBeGreaterThan(0);
		expect((await api(fx, '/users/me', { token })).status).toBe(200);
		const bobsPage = await bob.client.rpcWithWorkspace(fx.workspaceId).page.create({ parentId: null, teamspaceId: (await fx.rpc.workspace.teamspaces.list()).find((t) => t.name === 'General')?.id ?? null });

		await expect(bob.client.rpc.account.delete({ confirmEmail: 'someone@else.com' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await bob.client.rpc.account.delete({ confirmEmail: bob.email.toUpperCase() });

		expect(await db.passkey.count({ where: { userId: bob.userId } })).toBe(0);
		expect(await db.session.count({ where: { userId: bob.userId } })).toBe(0);
		expect(await db.membership.count({ where: { userId: bob.userId } })).toBe(0);
		const row = await db.user.findFirst({ where: { id: bob.userId } });
		expect(row).toMatchObject({ name: DELETED_USER_NAME, email: deletedEmail(bob.userId), emailVerified: false, image: null });
		expect(await fx.stub.getMemberRole(bob.userId)).toBeNull();
		// Their token is dead, and so is their access to the page they made.
		expect((await api(fx, '/users/me', { token })).status).toBe(401);
		await expect(bob.client.rpcWithWorkspace(fx.workspaceId).page.get({ id: bobsPage.id })).rejects.toBeTruthy();
		// The page they wrote is still there, attributed to the anonymised user.
		expect((await fx.rpc.page.get({ id: bobsPage.id })).createdBy).toBe(bob.userId);
		expect((await fx.rpc.workspace.members.list()).map((m) => m.userId)).not.toContain(bob.userId);
	});

	it('a deleted account\'s lingering session cannot make a workspace', async () => {
		const fx = await createFixture();
		const bob = await joined(fx, 'Bob');
		const rpc = bob.client.rpc;
		const cookie = bob.client.jar.header;
		await rpc.account.delete({ confirmEmail: bob.email });
		// Replay the cookie the browser still holds (the cookie cache outlives the session row by minutes).
		bob.client.jar.cookies = new Map(cookie.split('; ').map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)] as [string, string]));
		await expect(rpc.workspace.create({ name: 'Ghost' })).rejects.toBeTruthy();
		const db = createDirectoryClient(fx.world.env.DB);
		expect(await db.workspace.count({ where: { name: 'Ghost' } })).toBe(0);
	});

	it('refuses while the person owns a workspace, naming it, until ownership moves', async () => {
		const fx = await createFixture();
		const bob = await joined(fx, 'Bob');
		const guest = await joined(fx, 'Gus', 'guest');
		await expect(fx.ada.client.rpc.account.delete({ confirmEmail: fx.ada.email })).rejects.toMatchObject({
			code: 'CONFLICT',
			data: { code: 'OWNS_WORKSPACES', workspaces: [{ id: fx.workspaceId }] }
		});
		expect(await fx.ada.client.rpc.account.owned()).toEqual([{ id: fx.workspaceId, name: expect.any(String) }]);

		await expect(fx.rpc.workspace.transferOwnership({ userId: guest.userId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await expect(bob.client.rpcWithWorkspace(fx.workspaceId).workspace.transferOwnership({ userId: fx.ada.userId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(fx.rpc.workspace.transferOwnership({ userId: 'nobody' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await fx.rpc.workspace.transferOwnership({ userId: bob.userId });

		const roles = Object.fromEntries((await bob.client.rpcWithWorkspace(fx.workspaceId).workspace.members.list()).map((m) => [m.userId, m.role]));
		expect(roles).toMatchObject({ [bob.userId]: 'owner', [fx.ada.userId]: 'admin' });
		expect(await fx.stub.getMemberRole(bob.userId)).toBe('owner');
		expect(await fx.stub.getMemberRole(fx.ada.userId)).toBe('admin');

		await fx.ada.client.rpc.account.delete({ confirmEmail: fx.ada.email });
		expect(await createDirectoryClient(fx.world.env.DB).membership.count({ where: { userId: fx.ada.userId } })).toBe(0);
		// Bob still owns it, so he is the one who cannot leave now.
		await expect(bob.client.rpc.account.delete({ confirmEmail: bob.email })).rejects.toMatchObject({ code: 'CONFLICT' });
	});

	it('lets the owner delete the workspace first, then the account', async () => {
		const fx = await createFixture();
		const name = (await fx.rpc.workspace.get()).name;
		await fx.rpc.workspace.delete({ confirmName: name });
		expect(await fx.ada.client.rpc.account.owned()).toEqual([]);
		await fx.ada.client.rpc.account.delete({ confirmEmail: fx.ada.email });
		expect(await createDirectoryClient(fx.world.env.DB).passkey.count({ where: { userId: fx.ada.userId } })).toBe(0);
	});

	it('frees the email address for a new sign-up', async () => {
		const fx = await createFixture();
		const bob = await joined(fx, 'Bob');
		await bob.client.rpc.account.delete({ confirmEmail: bob.email });
		const db = createDirectoryClient(fx.world.env.DB);
		expect(await db.user.count({ where: { email: bob.email } })).toBe(0);
	});
});
