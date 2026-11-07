import { beforeAll, describe, expect, test } from 'vitest';
import { resolveSession } from '../../../src/server/auth/session';
import { RECOVERY_TTL_MINUTES } from '../../../src/server/auth/flarion-plugin';
import { recoveryIdentifier } from '../../../src/server/auth/flarion-plugin';
import { sha256Hex } from '../../../src/server/auth/crypto';
import { createDirectoryClient } from '../../../src/server/db/global.client';
import { firstLink } from '../../../src/server/mail';
import { Client, clearDevMails, createWorld, mails, ORIGIN, RP_ID, signUpPerson, verifyEmail, VirtualAuthenticator, type Person, type TestWorld } from './helpers';

let world: TestWorld;
beforeAll(() => {
	world = createWorld();
});

const tokenIn = (link: string) => new URL(link).searchParams.get('token')!;
const requestWith = (client: Client) => new Request(`${ORIGIN}/rpc/me`, { headers: { cookie: client.jar.header } });
const request = (email: string) => new Client(world).json('POST', '/recovery/request', { email, turnstileToken: 'x' });

async function recoveryLink(email: string): Promise<string | null> {
	const mail = (await mails(world)).find((m) => m.to === email && m.subject.includes('passkey'));
	return mail ? firstLink(mail) : null;
}

describe('requesting a recovery link', () => {
	test('a verified email gets a single link, expiring in 15 minutes; the answer is always the same', async () => {
		const ada = await signUpPerson(world, 'Ada', 'ada-recover@example.com');
		await verifyEmail(world, ada);
		await clearDevMails(world.env);
		const answers = [await request('ada-recover@example.com'), await request('nobody@example.com')];
		expect(answers.map((a) => [a.status, a.body])).toEqual([[200, { ok: true }], [200, { ok: true }]]);
		const link = await recoveryLink('ada-recover@example.com');
		expect(link).toContain('/recover?token=');
		expect(await recoveryLink('nobody@example.com')).toBeNull();

		const row = await world.env.DB.prepare('SELECT expiresAt FROM verification WHERE identifier = ?1')
			.bind(recoveryIdentifier(await sha256Hex(tokenIn(link!))))
			.first<{ expiresAt: string }>();
		const minutes = (new Date(row!.expiresAt).getTime() - Date.now()) / 60_000;
		expect(RECOVERY_TTL_MINUTES).toBe(15);
		expect(minutes).toBeGreaterThan(14);
		expect(minutes).toBeLessThanOrEqual(15);

		// A second request within a minute sends nothing more.
		await request('ada-recover@example.com');
		expect((await mails(world)).filter((m) => m.to === 'ada-recover@example.com' && m.subject.includes('passkey'))).toHaveLength(1);
	});

	test('an unverified email gets nothing: recovery needs a verified address', async () => {
		await signUpPerson(world, 'Unverified', 'unverified-recover@example.com');
		await clearDevMails(world.env);
		expect((await request('unverified-recover@example.com')).status).toBe(200);
		expect(await recoveryLink('unverified-recover@example.com')).toBeNull();
	});

	test('needs Turnstile and a well-formed email', async () => {
		expect((await new Client(world).json('POST', '/recovery/request', { email: 'nope', turnstileToken: 'x' })).status).toBe(400);
		expect((await new Client(world).json('POST', '/recovery/request', { email: 'a@example.com', turnstileToken: '' })).status).toBe(403);
	});
});

describe('redeeming the link', () => {
	let ada: Person;
	let oldSession: Client;
	let link: string;

	beforeAll(async () => {
		ada = await signUpPerson(world, 'Ada', 'ada-redeem@example.com');
		await verifyEmail(world, ada);
		oldSession = new Client(world); // another device, still signed in
		await oldSession.signInWithPasskey(ada.authenticator);
		await clearDevMails(world.env);
		await request('ada-redeem@example.com');
		link = (await recoveryLink('ada-redeem@example.com'))!;
	});

	test('the link works once, into a restricted session that cannot use the app or manage passkeys', async () => {
		const recovering = new Client(world);
		const redeemed = await recovering.json('POST', '/recovery/redeem', { token: tokenIn(link) });
		expect(redeemed.status).toBe(200);
		expect(redeemed.body.email).toBe('ada-redeem@example.com');

		// The link is single-use.
		expect((await new Client(world).json('POST', '/recovery/redeem', { token: tokenIn(link) })).status).toBe(400);

		// The restricted session does not resolve for the app, and auth calls other than "add a passkey" are refused.
		expect(await resolveSession(requestWith(recovering), world.env)).toBeNull();
		await expect(recovering.rpc.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
		for (const [method, path, body] of [
			['GET', '/passkey/list-user-passkeys'],
			['POST', '/passkey/delete-passkey', { id: 'x' }],
			['POST', '/passkey/update-passkey', { id: 'x', name: 'y' }],
			['GET', '/list-sessions'],
			['POST', '/revoke-other-sessions', {}]
		] as const) {
			const refused = await recovering.json(method, path, body);
			expect(refused.status, `${method} ${path}`).toBe(403);
			expect(refused.body.code).toBe('RESTRICTED_SESSION');
		}
		expect((await recovering.json('GET', '/get-session')).status).toBe(200);
	});

	test('registering the new passkey lifts the restriction and revokes every other session', async () => {
		const recovering = new Client(world);
		await request('ada-redeem@example.com'); // throttled: no new link, so mint one directly for this test
		const { internalAdapter } = await (await import('../../../src/server/auth/auth')).getAuth(world.env).$context;
		const token = 'second-recovery-token-for-the-test-0123456789';
		await internalAdapter.createVerificationValue({
			identifier: recoveryIdentifier(await sha256Hex(token)),
			value: JSON.stringify({ userId: ada.userId }),
			expiresAt: new Date(Date.now() + 60_000)
		});
		expect((await recovering.json('POST', '/recovery/redeem', { token })).status).toBe(200);

		const fresh = new VirtualAuthenticator(ORIGIN, RP_ID);
		const registered = await recovering.registerPasskey(fresh, undefined, { name: 'New phone' });
		expect(registered.verify.status).toBe(200);

		// Restriction lifted: the session now serves the app and passkey management.
		expect(await resolveSession(requestWith(recovering), world.env)).toMatchObject({ userId: ada.userId });
		const passkeys = await recovering.json<Array<{ name: string }>>('GET', '/passkey/list-user-passkeys');
		expect(passkeys.status).toBe(200);
		expect(passkeys.body.map((p) => p.name)).toContain('New phone');

		// Every other session is gone, cache or not.
		const stale = await oldSession.json('GET', '/get-session?disableCookieCache=true');
		expect(stale.body).toBeNull();
		const signedIn = new Client(world);
		expect((await signedIn.signInWithPasskey(fresh)).status).toBe(200);
	});

	test('an expired link is refused', async () => {
		const { internalAdapter } = await (await import('../../../src/server/auth/auth')).getAuth(world.env).$context;
		const token = 'expired-recovery-token-for-the-test-0123456789';
		await internalAdapter.createVerificationValue({
			identifier: recoveryIdentifier(await sha256Hex(token)),
			value: JSON.stringify({ userId: ada.userId }),
			expiresAt: new Date(Date.now() - 1000)
		});
		const response = await new Client(world).json('POST', '/recovery/redeem', { token });
		expect(response.status).toBe(400);
		expect(response.body.code).toBe('RECOVERY_LINK_INVALID');
		expect((await new Client(world).json('POST', '/recovery/redeem', { token: 'never-issued-token-0123456789' })).status).toBe(400);
	});

	test('a link for a deleted user is refused', async () => {
		const ghost = await signUpPerson(world, 'Ghost', 'ghost-recover@example.com');
		await verifyEmail(world, ghost);
		await clearDevMails(world.env);
		await request('ghost-recover@example.com');
		const ghostLink = (await recoveryLink('ghost-recover@example.com'))!;
		await world.env.DB.prepare('DELETE FROM user WHERE id = ?1').bind(ghost.userId).run();
		expect((await new Client(world).json('POST', '/recovery/redeem', { token: tokenIn(ghostLink) })).status).toBe(400);
	});
});

describe('an owner helps a member who lost their passkey', () => {
	let owner: Person;
	let member: Person;
	let workspaceId: string;

	beforeAll(async () => {
		owner = await signUpPerson(world, 'Owner', 'owner-help@example.com');
		await verifyEmail(world, owner);
		workspaceId = (await owner.client.rpc.workspace.create({ name: 'Help Desk' })).id;
		member = await signUpPerson(world, 'Member', 'member-help@example.com');
		await createDirectoryClient(world.env.DB).membership.create({
			data: { id: crypto.randomUUID(), workspaceId, userId: member.userId, role: 'member', joinedAt: new Date() }
		});
	});

	test("only an owner may; the target must be in the workspace and, for removal, have a verified email", async () => {
		const body = { workspaceId, userId: member.userId, removePasskeys: true };
		expect((await member.client.json('POST', '/recovery/member', body)).status).toBe(403);
		expect((await new Client(world).json('POST', '/recovery/member', body)).status).toBe(401);
		expect((await owner.client.json('POST', '/recovery/member', { ...body, userId: 'nobody' })).status).toBe(404);
		const unverified = await owner.client.json('POST', '/recovery/member', body);
		expect(unverified.status).toBe(400);
		expect(unverified.body.code).toBe('EMAIL_NOT_VERIFIED');
		// Nothing was removed.
		expect((await member.client.json<unknown[]>('GET', '/passkey/list-user-passkeys')).body).toHaveLength(1);
	});

	test('removes the passkeys and sessions, mails a fresh link, and the member recovers', async () => {
		await verifyEmail(world, member);
		await clearDevMails(world.env);
		const result = await owner.client.json('POST', '/recovery/member', { workspaceId, userId: member.userId, removePasskeys: true });
		expect(result.body).toEqual({ removedPasskeys: 1, recoveryLinkSent: true });
		expect((await member.client.json('GET', '/get-session?disableCookieCache=true')).body).toBeNull();
		expect((await new Client(world).signInWithPasskey(member.authenticator)).status).toBeGreaterThanOrEqual(400);

		const link = (await recoveryLink('member-help@example.com'))!;
		const recovering = new Client(world);
		expect((await recovering.json('POST', '/recovery/redeem', { token: tokenIn(link) })).status).toBe(200);
		const fresh = new VirtualAuthenticator(ORIGIN, RP_ID);
		expect((await recovering.registerPasskey(fresh, undefined)).verify.status).toBe(200);
		expect((await new Client(world).signInWithPasskey(fresh)).status).toBe(200);
	});

	test('resending the link alone leaves passkeys in place', async () => {
		await clearDevMails(world.env);
		const result = await owner.client.json('POST', '/recovery/member', { workspaceId, userId: member.userId });
		expect(result.body).toEqual({ removedPasskeys: 0, recoveryLinkSent: true });
		expect(await recoveryLink('member-help@example.com')).toContain('/recover?token=');
	});
});
