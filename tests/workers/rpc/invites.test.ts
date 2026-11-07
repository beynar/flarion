import { beforeAll, describe, expect, test } from 'vitest';
import { resolveMembership } from '../../../src/server/auth/session';
import { createDirectoryClient } from '../../../src/server/db/global.client';
import { firstLink } from '../../../src/server/mail';
import { Client, clearDevMails, createWorld, mails, signUpPerson, verifyEmail, type Person, type TestWorld } from '../auth/helpers';

let world: TestWorld;
let ada: Person;
let workspace: { id: string; name: string };

beforeAll(async () => {
	world = createWorld();
	ada = await signUpPerson(world, 'Ada Lovelace', 'ada-invites@example.com');
	await verifyEmail(world, ada);
	workspace = await ada.client.rpc.workspace.create({ name: 'Invite Club' });
});

const owner = () => ada.client.rpcWithWorkspace(workspace.id);
const db = () => createDirectoryClient(world.env.DB);
const tokenOf = (link: string) => decodeURIComponent(link.split('/invite/')[1]!);

async function inviteMail(to: string) {
	const mail = (await mails(world)).find((m) => m.to === to);
	expect(mail, `a mail to ${to}`).toBeTruthy();
	return { mail: mail!, token: tokenOf(firstLink(mail!)!) };
}

describe('creating invites', () => {
	test('stores a token hash, mails the link and lists the invite', async () => {
		await clearDevMails(world.env);
		const invite = await owner().workspace.invites.create({ email: 'Linus@Example.com', role: 'member' });
		expect(invite).toMatchObject({ email: 'linus@example.com', role: 'member', createdBy: ada.userId, acceptedAt: null });
		expect(new Date(invite.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);

		const { mail, token } = await inviteMail('linus@example.com');
		expect(mail.subject).toContain('Invite Club');
		expect(mail.text).toContain(`http://localhost:5173/invite/${token}`);
		const row = await db().invite.findFirstOrThrow({ where: { id: invite.id } });
		expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(row)).not.toContain(token);

		expect((await owner().workspace.invites.list()).map((i) => i.email)).toContain('linus@example.com');
	});

	test('only owners and admins invite, and the inviter needs a verified email', async () => {
		const unverified = await signUpPerson(world, 'Unverified', 'unverified-admin@example.com');
		const member = await signUpPerson(world, 'Member', 'member-invites@example.com');
		await verifyEmail(world, member);
		for (const [person, role] of [[unverified, 'admin'], [member, 'member']] as const) {
			await db().membership.create({ data: { id: crypto.randomUUID(), workspaceId: workspace.id, userId: person.userId, role, joinedAt: new Date() } });
		}
		await expect(
			unverified.client.rpcWithWorkspace(workspace.id).workspace.invites.create({ email: 'x@example.com', role: 'member' })
		).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('Verify your email') });
		await expect(
			member.client.rpcWithWorkspace(workspace.id).workspace.invites.create({ email: 'x@example.com', role: 'member' })
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(member.client.rpcWithWorkspace(workspace.id).workspace.invites.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
		// An admin who verifies their email can invite.
		await verifyEmail(world, unverified);
		await expect(unverified.client.rpcWithWorkspace(workspace.id).workspace.invites.create({ email: 'by-admin@example.com', role: 'guest' })).resolves.toMatchObject({ role: 'guest' });
	});

	test('inviting a current member conflicts; re-inviting replaces the earlier link', async () => {
		await expect(owner().workspace.invites.create({ email: 'ada-invites@example.com', role: 'member' })).rejects.toMatchObject({ code: 'CONFLICT' });
		await clearDevMails(world.env);
		await owner().workspace.invites.create({ email: 'again@example.com', role: 'member' });
		const first = (await inviteMail('again@example.com')).token;
		await clearDevMails(world.env);
		await owner().workspace.invites.create({ email: 'again@example.com', role: 'admin' });
		const second = (await inviteMail('again@example.com')).token;
		expect(second).not.toBe(first);
		const stranger = await signUpPerson(world, 'Again', 'again-stranger@example.com');
		await expect(stranger.client.rpc.workspace.invites.accept({ token: first })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		expect((await owner().workspace.invites.list()).filter((i) => i.email === 'again@example.com')).toHaveLength(1);
	});

	test('revoke removes a pending invite', async () => {
		await clearDevMails(world.env);
		const invite = await owner().workspace.invites.create({ email: 'revoked@example.com', role: 'member' });
		const { token } = await inviteMail('revoked@example.com');
		await owner().workspace.invites.revoke({ id: invite.id });
		await expect(owner().workspace.invites.revoke({ id: invite.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const revokedUser = await signUpPerson(world, 'Revoked', 'revoked@example.com');
		await expect(revokedUser.client.rpc.workspace.invites.accept({ token })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('accepting: a new user signs up from the invite', () => {
	test('create, mail stored, sign up through the link, accept, member mirrored', async () => {
		await clearDevMails(world.env);
		await owner().workspace.invites.create({ email: 'newbie@example.com', role: 'member' });
		const { token } = await inviteMail('newbie@example.com');

		const preview = await new Client(world).json('GET', `/invite-info?token=${encodeURIComponent(token)}`);
		expect(preview.body).toMatchObject({
			valid: true,
			workspaceName: 'Invite Club',
			inviterName: 'Ada Lovelace',
			email: 'newbie@example.com',
			existingAccount: false
		});

		// The invite's address is the account's address, whatever the form says, and it is verified by the link.
		await clearDevMails(world.env);
		const anonymous = new Client(world);
		const signedUp = await anonymous.signUp({ name: 'Newbie', email: 'someone-else@example.com', inviteToken: token });
		expect(signedUp.ceremony?.verify.status).toBe(200);
		expect(signedUp.ceremony?.verify.body.user).toMatchObject({ email: 'newbie@example.com', emailVerified: true });
		expect(await mails(world)).toHaveLength(0); // no verification mail needed

		const workspaceBefore = world.workspaces.syncs.length;
		const joined = await anonymous.rpc.workspace.invites.accept({ token });
		expect(joined).toMatchObject({ id: workspace.id, name: 'Invite Club', role: 'member' });

		const userId = signedUp.ceremony!.verify.body.user.id as string;
		expect(await db().membership.findFirst({ where: { workspaceId: workspace.id, userId } })).toMatchObject({ role: 'member' });
		expect((await db().invite.findFirstOrThrow({ where: { email: 'newbie@example.com' } })).acceptedAt).toBeInstanceOf(Date);
		expect(world.workspaces.syncs.slice(workspaceBefore)).toContainEqual({ workspaceId: workspace.id, userId, role: 'member', name: 'Newbie' });
		expect(await resolveMembership(world.env, userId, workspace.id)).toBe('member');
		expect((await anonymous.rpc.me()).workspaces.map((w) => w.id)).toEqual([workspace.id]);
		const members = await owner().workspace.members.list();
		expect(members.map((m) => m.email)).toContain('newbie@example.com');
	});

	test('a used invite cannot be accepted again', async () => {
		await clearDevMails(world.env);
		await owner().workspace.invites.create({ email: 'twice@example.com', role: 'member' });
		const { token } = await inviteMail('twice@example.com');
		const person = await signUpPerson(world, 'Twice', 'twice@example.com', token);
		await person.client.rpc.workspace.invites.accept({ token });
		await expect(person.client.rpc.workspace.invites.accept({ token })).rejects.toMatchObject({ code: 'NOT_FOUND' });
		const info = await new Client(world).json('GET', `/invite-info?token=${encodeURIComponent(token)}`);
		expect(info.body).toMatchObject({ valid: false, accepted: true });
	});

	test('the invite link cannot sign up another address once used or expired', async () => {
		await clearDevMails(world.env);
		const invite = await owner().workspace.invites.create({ email: 'late@example.com', role: 'member' });
		const { token } = await inviteMail('late@example.com');
		await world.env.DB.prepare("UPDATE invite SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE id = ?1").bind(invite.id).run();
		const attempt = await new Client(world).json('POST', '/registration-token', { name: 'Late', turnstileToken: 'x', inviteToken: token });
		expect(attempt.status).toBe(400);
		expect(attempt.body.code).toBe('INVITE_INVALID');
		const info = await new Client(world).json('GET', `/invite-info?token=${encodeURIComponent(token)}`);
		expect(info.body).toMatchObject({ valid: false, expired: true });
		const late = await signUpPerson(world, 'Late', 'late@example.com');
		await expect(late.client.rpc.workspace.invites.accept({ token })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('accepting: an existing user', () => {
	test('signs in, then accepts; a different account cannot use the link', async () => {
		const grace = await signUpPerson(world, 'Grace', 'grace-invites@example.com');
		await clearDevMails(world.env);
		await owner().workspace.invites.create({ email: 'grace-invites@example.com', role: 'admin' });
		const { token } = await inviteMail('grace-invites@example.com');
		const preview = await new Client(world).json('GET', `/invite-info?token=${encodeURIComponent(token)}`);
		expect(preview.body.existingAccount).toBe(true);

		const mallory = await signUpPerson(world, 'Mallory', 'mallory@example.com');
		await expect(mallory.client.rpc.workspace.invites.accept({ token })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(new Client(world).rpc.workspace.invites.accept({ token })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

		const returning = new Client(world);
		expect((await returning.signInWithPasskey(grace.authenticator)).status).toBe(200);
		const joined = await returning.rpc.workspace.invites.accept({ token });
		expect(joined.role).toBe('admin');
		expect(await resolveMembership(world.env, grace.userId, workspace.id)).toBe('admin');
		// Following the emailed link proved the mailbox.
		expect((await db().user.findFirstOrThrow({ where: { id: grace.userId } })).emailVerified).toBe(true);
	});
});
