import { beforeAll, describe, expect, test } from 'vitest';
import { createDirectoryClient, globalClient } from '../../../src/server/db/global.client';
import { firstLink } from '../../../src/server/mail';
import { reconcileGuests } from '../../../src/server/share/guests';
import { clearDevMails, createWorld, mails, signUpPerson, verifyEmail, type Person, type TestWorld } from '../auth/helpers';

let world: TestWorld;
let ada: Person;
let workspace: { id: string; name: string; slug: string };

const PAGE = 'page-roadmap';
const SECRET = 'page-secret';

beforeAll(async () => {
	world = createWorld();
	ada = await signUpPerson(world, 'Ada Lovelace', 'ada-guests@example.com');
	await verifyEmail(world, ada);
	workspace = await ada.client.rpc.workspace.create({ name: 'Guest Club' });
	world.workspaces.fakeGrants.addPage(workspace.id, PAGE, 'Roadmap 2027', '🗺️');
	world.workspaces.fakeGrants.addPage(workspace.id, SECRET, 'Secret plans');
});

const owner = () => ada.client.rpcWithWorkspace(workspace.id);
const doGrants = () => world.workspaces.fakeGrants.grants.get(workspace.id) ?? [];
const accessOf = (userId: string, pageId: string, role = 'guest') =>
	world.workspaces.getByName(workspace.id).pageAccess({ userId, role } as never, pageId);
const tokenOf = (link: string) => decodeURIComponent(link.split('/invite/')[1]!);

describe('guest invite by email, end to end', () => {
	let inviteToken: string;
	let guest: Person;

	test('sharing with a stranger creates a guest invite, a pending grant and an email', async () => {
		await clearDevMails(world.env);
		const grant = await owner().page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: null, level: 'comment', email: 'Gus@Example.com' });
		expect(grant).toMatchObject({ pending: true, email: 'gus@example.com', subjectId: null, level: 'comment', pageId: PAGE });

		const invite = await createDirectoryClient(world.env.DB).invite.findFirstOrThrow({ where: { email: 'gus@example.com' } });
		expect(invite.role).toBe('guest');
		expect(await globalClient(world.env.DB).pendingGrant.findMany({ where: { inviteId: invite.id } })).toMatchObject([{ pageId: PAGE, level: 'comment', appliedAt: null }]);
		expect(doGrants()).toHaveLength(0); // nothing in the DO until the invite is accepted

		const mail = (await mails(world)).find((m) => m.to === 'gus@example.com')!;
		expect(mail.subject).toBe('Ada Lovelace shared "Roadmap 2027" with you on Flarion');
		expect(mail.text).toContain('view and comment on');
		expect(mail.html).toContain('Flarion');
		inviteToken = tokenOf(firstLink(mail)!);

		const listed = await owner().page.grants.list({ id: PAGE });
		expect(listed).toContainEqual(expect.objectContaining({ pending: true, email: 'gus@example.com', id: grant.id }));
	});

	test('accepting applies the pending grant: only the granted page is visible', async () => {
		guest = await signUpPerson(world, 'Gus', 'gus@example.com', inviteToken);
		const joined = await guest.client.rpc.workspace.invites.accept({ token: inviteToken });
		expect(joined).toMatchObject({ id: workspace.id, role: 'guest' });
		expect(world.workspaces.members.get(workspace.id)?.get(guest.userId)).toBe('guest');

		expect(doGrants()).toMatchObject([{ pageId: PAGE, subjectKind: 'user', subjectId: guest.userId, level: 'comment', createdBy: ada.userId }]);
		expect(await accessOf(guest.userId, PAGE)).toBe('comment');
		expect(await accessOf(guest.userId, SECRET)).toBeNull();

		expect(await globalClient(world.env.DB).pendingGrant.findMany({ where: { workspaceId: workspace.id } })).toEqual([]);
		expect(await globalClient(world.env.DB).guestGrant.findMany({ where: { userId: guest.userId } })).toMatchObject([{ pageId: PAGE, grantId: doGrants()[0]!.id }]);
		// The pending entry is gone and the real grant is listed instead.
		const listed = await owner().page.grants.list({ id: PAGE });
		expect(listed.filter((g) => g.pending)).toEqual([]);
		expect(listed).toContainEqual(expect.objectContaining({ subjectId: guest.userId, level: 'comment' }));
	});

	test('guests cannot see the members list, invite, or share', async () => {
		const rpc = guest.client.rpcWithWorkspace(workspace.id);
		await expect(rpc.workspace.members.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(rpc.workspace.invites.create({ email: 'x@example.com', role: 'guest' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(rpc.workspace.invites.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(rpc.page.grants.set({ pageId: PAGE, subjectKind: 'workspace', subjectId: null, level: 'read' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(rpc.page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: null, level: 'read', email: 'friend@example.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(rpc.page.grants.revoke({ grantId: doGrants()[0]!.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		// A member still sees the list.
		await expect(owner().workspace.members.list()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'guest', userId: guest.userId })]));
	});

	test('converting a guest to a member removes their grants', async () => {
		await owner().workspace.members.setRole({ userId: guest.userId, role: 'member' });
		expect(doGrants()).toEqual([]);
		expect(await globalClient(world.env.DB).guestGrant.findMany({ where: { userId: guest.userId } })).toEqual([]);
		expect(world.workspaces.members.get(workspace.id)?.get(guest.userId)).toBe('member');
	});
});

describe('guests who already have an account', () => {
	let eve: Person;

	test('an existing user becomes a guest membership mirrored to the DO, then gets the grant and a mail', async () => {
		eve = await signUpPerson(world, 'Eve', 'eve-guests@example.com');
		await clearDevMails(world.env);
		const before = world.workspaces.syncs.length;
		const grant = await owner().page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: null, level: 'update', email: 'eve-guests@example.com' });
		expect(grant).toMatchObject({ subjectKind: 'user', subjectId: eve.userId, level: 'update' });
		expect(grant.pending).toBeUndefined();

		expect(await createDirectoryClient(world.env.DB).membership.findFirst({ where: { workspaceId: workspace.id, userId: eve.userId } })).toMatchObject({ role: 'guest' });
		expect(world.workspaces.syncs.slice(before)).toContainEqual({ workspaceId: workspace.id, userId: eve.userId, role: 'guest', name: 'Eve' });
		expect(await accessOf(eve.userId, PAGE)).toBe('update');
		expect(await accessOf(eve.userId, SECRET)).toBeNull();

		const mail = (await mails(world)).find((m) => m.to === 'eve-guests@example.com')!;
		expect(mail.subject).toContain('Roadmap 2027');
		expect(firstLink(mail)).toBe(`http://localhost:5173/${workspace.slug}/${PAGE}`);
	});

	test('a second page for the same guest adds a grant; removing the guest removes both', async () => {
		await owner().page.grants.set({ pageId: SECRET, subjectKind: 'user', subjectId: null, level: 'read', email: 'eve-guests@example.com' });
		expect(doGrants().filter((g) => g.subjectId === eve.userId)).toHaveLength(2);
		expect(await globalClient(world.env.DB).guestGrant.findMany({ where: { userId: eve.userId } })).toHaveLength(2);

		await owner().workspace.members.remove({ userId: eve.userId });
		expect(doGrants().filter((g) => g.subjectId === eve.userId)).toHaveLength(0);
		expect(await globalClient(world.env.DB).guestGrant.findMany({ where: { userId: eve.userId } })).toEqual([]);
		expect(world.workspaces.members.get(workspace.id)?.has(eve.userId)).toBe(false);
	});

	test('a failed inline revoke is finished by the nightly reconcile', async () => {
		const frank = await signUpPerson(world, 'Frank', 'frank-guests@example.com');
		await owner().page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: null, level: 'read', email: frank.email });
		world.workspaces.fakeGrants.failRevoke = true;
		await owner().workspace.members.remove({ userId: frank.userId });
		world.workspaces.fakeGrants.failRevoke = false;
		expect(doGrants().filter((g) => g.subjectId === frank.userId)).toHaveLength(1);
		expect(await globalClient(world.env.DB).guestGrant.findMany({ where: { userId: frank.userId } })).toHaveLength(1);

		expect(await reconcileGuests(world.env)).toMatchObject({ grantsRevoked: 1 });
		expect(doGrants().filter((g) => g.subjectId === frank.userId)).toHaveLength(0);
	});
});

describe('sharing rules', () => {
	test('a member without full access cannot share; the unverified cannot invite by email', async () => {
		const mia = await signUpPerson(world, 'Mia', 'mia-guests@example.com');
		await createDirectoryClient(world.env.DB).membership.create({
			data: { id: crypto.randomUUID(), workspaceId: workspace.id, userId: mia.userId, role: 'member', joinedAt: new Date() }
		});
		world.workspaces.members.get(workspace.id)!.set(mia.userId, 'member');
		await owner().page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: mia.userId, level: 'update' });
		const rpc = mia.client.rpcWithWorkspace(workspace.id);
		await expect(rpc.page.grants.set({ pageId: PAGE, subjectKind: 'workspace', subjectId: null, level: 'read' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		// A page nobody shared with her is not even visible.
		await expect(rpc.page.grants.set({ pageId: SECRET, subjectKind: 'workspace', subjectId: null, level: 'read' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		await owner().page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: mia.userId, level: 'full' });
		await expect(rpc.page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: null, level: 'read', email: 'who@example.com' })).rejects.toMatchObject({
			code: 'FORBIDDEN',
			message: expect.stringContaining('Verify your email')
		});
	});

	test('sharing with a non-member id is refused; teamspace needs an id; workspace grants pass through', async () => {
		await expect(owner().page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: 'nobody', level: 'read' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await expect(owner().page.grants.set({ pageId: PAGE, subjectKind: 'teamspace', subjectId: null, level: 'read' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		await expect(owner().page.grants.set({ pageId: PAGE, subjectKind: 'workspace', subjectId: null, level: 'read' })).resolves.toMatchObject({ subjectKind: 'workspace' });
	});

	test('re-sharing a page with a pending email replaces its level and keeps one invite; revoking drops the pending grant', async () => {
		const first = await owner().page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: null, level: 'read', email: 'pending@example.com' });
		const second = await owner().page.grants.set({ pageId: SECRET, subjectKind: 'user', subjectId: null, level: 'update', email: 'pending@example.com' });
		const again = await owner().page.grants.set({ pageId: PAGE, subjectKind: 'user', subjectId: null, level: 'comment', email: 'pending@example.com' });
		const invites = (await owner().workspace.invites.list()).filter((i) => i.email === 'pending@example.com');
		expect(invites).toHaveLength(1);
		const pendings = await globalClient(world.env.DB).pendingGrant.findMany({ where: { workspaceId: workspace.id } });
		expect(pendings.filter((p) => p.pageId === PAGE).map((p) => p.level)).toEqual(['comment']);
		expect(pendings.filter((p) => p.pageId === SECRET)).toHaveLength(1);
		expect(first.id).not.toBe(again.id);

		await owner().page.grants.revoke({ grantId: second.id });
		expect((await owner().page.grants.list({ id: SECRET })).filter((g) => g.pending)).toEqual([]);
		// Revoking the invite itself takes its pending grants with it.
		await owner().workspace.invites.revoke({ id: invites[0]!.id });
		expect((await owner().page.grants.list({ id: PAGE })).filter((g) => g.pending)).toEqual([]);
	});
});
