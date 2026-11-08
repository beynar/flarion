/** Guests and public links against the real Workspace DO and its policy (the Sync core's grant methods). */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, test } from 'vitest';
import { firstLink } from '../../../src/server/mail';
import { resolveShare } from '../../../src/server/share';
import { handleSharePage } from '../../../src/server/share/route';
import { clearDevMails, createWorld, mails, signUpPerson, verifyEmail, type Person, type TestWorld } from '../auth/helpers';

let world: TestWorld;
let ada: Person;
let workspaceId: string;
let teamspaceId: string;
let pageA: string;
let pageB: string;

const owner = () => ada.client.rpcWithWorkspace(workspaceId);
const doStub = () => (env as unknown as Env).WORKSPACE.getByName(workspaceId);

beforeAll(async () => {
	world = createWorld({ WORKSPACE: (env as unknown as Env).WORKSPACE });
	ada = await signUpPerson(world, 'Ada', 'ada-share-do@example.com');
	await verifyEmail(world, ada);
	workspaceId = (await ada.client.rpc.workspace.create({ name: 'Share Real' })).id;
	teamspaceId = (await owner().workspace.teamspaces.list()).find((t) => t.name === 'General')!.id;
	pageA = (await owner().page.create({ parentId: null, teamspaceId, values: { title: 'Shared page' }, icon: '🤝' })).id;
	pageB = (await owner().page.create({ parentId: null, teamspaceId, values: { title: 'Private page' } })).id;
});

describe('a guest by email', () => {
	let guest: Person;

	test('invite, accept, and only the granted page is visible', async () => {
		await clearDevMails(world.env);
		const pending = await owner().page.grants.set({ pageId: pageA, subjectKind: 'user', subjectId: null, level: 'comment', email: 'gwen-share-do@example.com' });
		expect(pending.pending).toBe(true);
		const token = decodeURIComponent(firstLink((await mails(world)).find((m) => m.to === 'gwen-share-do@example.com')!)!.split('/invite/')[1]!);
		guest = await signUpPerson(world, 'Gwen', 'gwen-share-do@example.com', token);
		await expect(guest.client.rpc.workspace.invites.accept({ token })).resolves.toMatchObject({ role: 'guest' });

		const rpc = guest.client.rpcWithWorkspace(workspaceId);
		await expect(rpc.page.get({ id: pageA })).resolves.toMatchObject({ title: 'Shared page', access: 'comment' });
		await expect(rpc.page.get({ id: pageB })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		expect(await doStub().pageAccess({ userId: guest.userId }, pageB)).toBeNull();
	});

	test('guests cannot create teamspaces, invite, see the members list or share', async () => {
		const rpc = guest.client.rpcWithWorkspace(workspaceId);
		await expect(rpc.workspace.teamspaces.create({ name: 'Mine', privacy: 'open', defaultLevel: 'update' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(rpc.workspace.members.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(rpc.workspace.invites.create({ email: 'z@example.com', role: 'guest' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(rpc.page.grants.set({ pageId: pageA, subjectKind: 'workspace', subjectId: null, level: 'read' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	test('the grant list marks inherited grants; converting the guest removes their grants', async () => {
		const child = (await owner().page.create({ parentId: pageA, teamspaceId, values: { title: 'Child' } })).id;
		const listed = await owner().page.grants.list({ id: child });
		expect(listed.filter((g) => g.subjectId === guest.userId)).toMatchObject([{ inherited: true, fromPageId: pageA, level: 'comment' }]);
		expect((await owner().page.grants.list({ id: pageA })).filter((g) => g.subjectId === guest.userId)).toMatchObject([{ level: 'comment' }]);

		await owner().workspace.members.setRole({ userId: guest.userId, role: 'member' });
		const after = await owner().page.grants.list({ id: pageA });
		expect(after.filter((g) => g.subjectId === guest.userId)).toEqual([]);
	});
});

describe('a public link', () => {
	test('create, resolve, serve the title and icon to an anonymous visitor, revoke', async () => {
		const grant = await owner().page.grants.set({ pageId: pageA, subjectKind: 'public', subjectId: null, level: 'read' });
		expect(grant.token).toBeTruthy();
		expect(await resolveShare(world.env, grant.token!)).toEqual({ workspaceId, pageId: pageA, level: 'read' });

		const response = (await handleSharePage(new Request(`http://localhost:5173/share/${grant.token}`), world.env)) as Response;
		expect(response.status).toBe(200);
		expect(response.headers.get('x-robots-tag')).toContain('noindex');
		const html = await response.text();
		expect(html).toContain('<h1 class="page-title">Shared page</h1>');
		expect(html).toContain('🤝');
		expect(html).toContain('<meta name="robots" content="noindex, nofollow">');

		await owner().page.grants.revoke({ grantId: grant.id });
		expect(await resolveShare(world.env, grant.token!)).toBeNull();
		expect(await doStub().grantByToken(grant.token!)).toBeNull();
		const gone = (await handleSharePage(new Request(`http://localhost:5173/share/${grant.token}`), world.env)) as Response;
		expect(gone.status).toBe(404);
	});

	test('the token opens its page and nothing else', async () => {
		const grant = await owner().page.grants.set({ pageId: pageA, subjectKind: 'public', subjectId: null, level: 'read' });
		expect(await doStub().pageAccess({ role: 'anonymous', shareToken: grant.token! }, pageA)).toBe('read');
		expect(await doStub().pageAccess({ role: 'anonymous', shareToken: grant.token! }, pageB)).toBeNull();
		expect(await doStub().pageAccess({ role: 'anonymous' }, pageA)).toBeNull();
	});
});
