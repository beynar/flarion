/** The same flows against the real Workspace Durable Object (the Sync core's `init`/`syncMember`/`getMemberRole`). */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { resolveMembership } from '../../../src/server/auth/session';
import { createDirectoryClient } from '../../../src/server/db/global.client';
import { firstLink } from '../../../src/server/mail';
import { clearDevMails, createWorld, mails, signUpPerson, verifyEmail, type Person, type TestWorld } from '../auth/helpers';

let world: TestWorld;
let ada: Person;
let workspaceId: string;
const roleInDo = (userId: string) => (env as unknown as Env).WORKSPACE.getByName(workspaceId).getMemberRole(userId);

beforeAll(async () => {
	world = createWorld({ WORKSPACE: (env as unknown as Env).WORKSPACE });
	ada = await signUpPerson(world, 'Ada Lovelace', 'ada-real-do@example.com');
	await verifyEmail(world, ada);
});

describe('identity against the real WorkspaceDO', () => {
	test('create initialises the DO and membership resolves through its cache', async () => {
		const created = await ada.client.rpc.workspace.create({ name: 'Real Co' });
		workspaceId = created.id;
		expect(await roleInDo(ada.userId)).toBe('owner');
		expect(await resolveMembership(world.env, ada.userId, workspaceId)).toBe('owner');
		expect((await ada.client.rpcWithWorkspace(workspaceId).workspace.get()).name).toBe('Real Co');
	});

	test('an invited member is mirrored, then removed from the mirror', async () => {
		await clearDevMails(world.env);
		await ada.client.rpcWithWorkspace(workspaceId).workspace.invites.create({ email: 'grace-real-do@example.com', role: 'member' });
		const token = decodeURIComponent(firstLink((await mails(world))[0]!)!.split('/invite/')[1]!);
		const grace = await signUpPerson(world, 'Grace Hopper', 'grace-real-do@example.com', token);
		await grace.client.rpc.workspace.invites.accept({ token });
		expect(await roleInDo(grace.userId)).toBe('member');

		await ada.client.rpcWithWorkspace(workspaceId).workspace.members.setRole({ userId: grace.userId, role: 'admin' });
		expect(await roleInDo(grace.userId)).toBe('admin');

		await ada.client.rpcWithWorkspace(workspaceId).workspace.members.remove({ userId: grace.userId });
		expect(await roleInDo(grace.userId)).toBeNull();
		expect(await resolveMembership(world.env, grace.userId, workspaceId)).toBeNull();
	});

	test('deleting the workspace drops every mirror row', async () => {
		await ada.client.rpcWithWorkspace(workspaceId).workspace.delete({ confirmName: 'Real Co' });
		expect(await roleInDo(ada.userId)).toBeNull();
		expect(await resolveMembership(world.env, ada.userId, workspaceId)).toBeNull();
		expect(await createDirectoryClient(world.env.DB).workspace.findFirst({ where: { id: workspaceId } })).toBeNull();
	});
});
