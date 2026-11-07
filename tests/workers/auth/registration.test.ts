import { beforeAll, describe, expect, test } from 'vitest';
import { getAuth } from '../../../src/server/auth/auth';
import {
	consumeRegistrationToken,
	issueRegistrationToken,
	peekRegistrationToken,
	REGISTRATION_TOKEN_TTL_SECONDS
} from '../../../src/server/auth/registration-token';
import { createDirectoryClient } from '../../../src/server/db/global.client';
import { TURNSTILE_TEST_SECRET_FAIL } from '../../../src/server/auth/turnstile';
import { clearDevMails, Client, createWorld, mails, ORIGIN, RP_ID, VirtualAuthenticator, type TestWorld } from './helpers';

let world: TestWorld;
beforeAll(() => {
	world = createWorld();
});

const userCount = async (email: string) => createDirectoryClient(world.env.DB).user.count({ where: { email } });

describe('registration token', () => {
	const secret = 'k3J9xQ2vL7mZp0RtYw8NfB4aHs6UdEcG1iVoXq5TyMn';
	const claims = { name: 'Ada', email: 'ada@example.com', emailVerified: false };

	test('is single-use: the first consume wins, a replay and every racer find nothing', async () => {
		const { internalAdapter } = await getAuth(world.env).$context;
		const { token } = await issueRegistrationToken(internalAdapter, secret, claims);
		expect(await peekRegistrationToken(internalAdapter, secret, token)).toMatchObject(claims);
		const results = await Promise.all(Array.from({ length: 5 }, () => consumeRegistrationToken(internalAdapter, secret, token)));
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await consumeRegistrationToken(internalAdapter, secret, token)).toBeNull();
		expect(await peekRegistrationToken(internalAdapter, secret, token)).toBeNull();
	});

	test('expires after its TTL, whether peeked or consumed', async () => {
		const { internalAdapter } = await getAuth(world.env).$context;
		const issuedAt = Date.now();
		const { token } = await issueRegistrationToken(internalAdapter, secret, claims, issuedAt);
		const later = issuedAt + (REGISTRATION_TOKEN_TTL_SECONDS + 1) * 1000;
		expect(await peekRegistrationToken(internalAdapter, secret, token, later)).toBeNull();
		expect(await consumeRegistrationToken(internalAdapter, secret, token, later)).toBeNull();
	});

	test('a forged or re-signed token is refused', async () => {
		const { internalAdapter } = await getAuth(world.env).$context;
		const { token } = await issueRegistrationToken(internalAdapter, secret, claims);
		const [prefix, jti, exp] = token.split('.');
		expect(await peekRegistrationToken(internalAdapter, secret, `${prefix}.${jti}.${Number(exp) + 100}.${token.split('.')[3]}`)).toBeNull();
		expect(await peekRegistrationToken(internalAdapter, 'another-secret-another-secret-123456', token)).toBeNull();
		expect(await peekRegistrationToken(internalAdapter, secret, 'rg1.nope')).toBeNull();
	});
});

describe('POST /api/auth/registration-token', () => {
	test('needs Turnstile', async () => {
		const failing = createWorld({ TURNSTILE_SECRET: TURNSTILE_TEST_SECRET_FAIL });
		const response = await new Client(failing).json('POST', '/registration-token', { name: 'A', email: 'a@example.com', turnstileToken: 'x' });
		expect(response.status).toBe(403);
		expect(response.body.code).toBe('TURNSTILE_FAILED');
		const missing = await new Client(world).json('POST', '/registration-token', { name: 'A', email: 'a@example.com', turnstileToken: '' });
		expect(missing.status).toBe(403);
	});

	test('refuses production with a test secret', async () => {
		const prod = createWorld({ ENVIRONMENT: 'production', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' });
		const response = await new Client(prod).json('POST', '/registration-token', { name: 'A', email: 'a@example.com', turnstileToken: 'x' });
		expect(response.status).toBe(403);
	});

	test('validates the body', async () => {
		const response = await new Client(world).json('POST', '/registration-token', { name: '', email: 'not-an-email', turnstileToken: 'x' });
		expect(response.status).toBe(400);
	});
});

describe('passkey sign-up ceremony', () => {
	test('creates the user in afterVerification, the passkey, a session cookie and a verification mail', async () => {
		await clearDevMails(world.env);
		const client = new Client(world);
		expect(await userCount('new@example.com')).toBe(0);
		const { issued, ceremony } = await client.signUp({ name: 'New Person', email: 'New@Example.com' });
		expect(issued.status).toBe(200);
		expect(ceremony?.options.status).toBe(200);
		// The user does not exist before the ceremony verified.
		expect(ceremony?.verify.status).toBe(200);
		expect(ceremony?.verify.body.user).toMatchObject({ email: 'new@example.com', name: 'New Person', emailVerified: false });
		expect(ceremony?.verify.body.session.token).toBeTruthy();
		expect(await userCount('new@example.com')).toBe(1);
		expect(client.jar.cookies.has('better-auth.session_token')).toBe(true);

		const db = createDirectoryClient(world.env.DB);
		const user = await db.user.findFirstOrThrow({ where: { email: 'new@example.com' } });
		expect(await db.passkey.count({ where: { userId: user.id } })).toBe(1);

		const verification = (await mails(world)).find((mail) => mail.to === 'new@example.com');
		expect(verification?.subject).toMatch(/Verify your email/);
		expect(verification?.text).toContain('/api/auth/verify-email?token=');
	});

	test('the session cookie, the challenge cookie and the passkey are Lax, Secure and HttpOnly', async () => {
		const client = new Client(world);
		const issued = await client.json<{ token: string }>('POST', '/registration-token', { name: 'Cookie', email: 'cookie@example.com', turnstileToken: 'x' });
		const options = await client.auth('GET', `/passkey/generate-register-options?context=${encodeURIComponent(issued.body.token)}`);
		const challengeCookie = options.headers.getSetCookie().find((c) => c.startsWith('better-auth.flarion-passkey'));
		expect(challengeCookie).toBeTruthy();
		for (const attribute of ['SameSite=Lax', 'Secure', 'HttpOnly']) expect(challengeCookie).toContain(attribute);
		const body = (await options.json()) as any;
		expect(body.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
		expect(body.rp.id).toBe(RP_ID);

		const authenticator = new VirtualAuthenticator(ORIGIN, RP_ID);
		const verify = await client.auth('POST', '/passkey/verify-registration', { response: await authenticator.register(body), createSession: true });
		const session = verify.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token'));
		for (const attribute of ['SameSite=Lax', 'Secure', 'HttpOnly']) expect(session).toContain(attribute);
	});

	test('a failed ceremony creates no user and leaves the token usable', async () => {
		const client = new Client(world);
		const issued = await client.json<{ token: string }>('POST', '/registration-token', { name: 'Fail', email: 'fail@example.com', turnstileToken: 'x' });
		const authenticator = new VirtualAuthenticator(ORIGIN, RP_ID);

		const options = await client.json<any>('GET', `/passkey/generate-register-options?context=${encodeURIComponent(issued.body.token)}`);
		const corrupt = await authenticator.register(options.body, { corruptAttestation: true });
		const bad = await client.json('POST', '/passkey/verify-registration', { response: corrupt, createSession: true });
		expect(bad.status).toBe(400);
		expect(await userCount('fail@example.com')).toBe(0);

		const wrongOrigin = await client.json<any>('GET', `/passkey/generate-register-options?context=${encodeURIComponent(issued.body.token)}`);
		const phished = await authenticator.register(wrongOrigin.body, { origin: 'https://evil.example' });
		expect((await client.json('POST', '/passkey/verify-registration', { response: phished, createSession: true })).status).toBe(400);
		expect(await userCount('fail@example.com')).toBe(0);

		const noUv = await client.json<any>('GET', `/passkey/generate-register-options?context=${encodeURIComponent(issued.body.token)}`);
		const unverified = await authenticator.register(noUv.body, { userVerified: false });
		expect((await client.json('POST', '/passkey/verify-registration', { response: unverified, createSession: true })).status).toBe(400);
		expect(await userCount('fail@example.com')).toBe(0);

		// The token was not burned by the failures: a real ceremony still completes.
		const retry = await client.registerPasskey(authenticator, issued.body.token, { createSession: true });
		expect(retry.verify.status).toBe(200);
		expect(await userCount('fail@example.com')).toBe(1);
	});

	test('a used token cannot create a second user, and an unknown context is refused', async () => {
		const client = new Client(world);
		const issued = await client.json<{ token: string }>('POST', '/registration-token', { name: 'Once', email: 'once@example.com', turnstileToken: 'x' });
		const first = await new Client(world).registerPasskey(new VirtualAuthenticator(ORIGIN, RP_ID), issued.body.token, { createSession: true });
		expect(first.verify.status).toBe(200);
		const replay = await new Client(world).registerPasskey(new VirtualAuthenticator(ORIGIN, RP_ID), issued.body.token, { createSession: true });
		expect(replay.options.status).toBe(400);
		expect(await userCount('once@example.com')).toBe(1);

		const nocontext = await new Client(world).json('GET', '/passkey/generate-register-options');
		expect(nocontext.status).toBe(400);
		const forged = await new Client(world).json('GET', '/passkey/generate-register-options?context=rg1.abc.9999999999.zzz');
		expect(forged.status).toBe(400);
	});

	test('the same email cannot sign up twice, and the same authenticator cannot register twice', async () => {
		const taken = await new Client(world).json('POST', '/registration-token', { name: 'Dup', email: 'once@example.com', turnstileToken: 'x' });
		expect(taken.status).toBe(409);
		expect(taken.body.code).toBe('EMAIL_TAKEN');

		const authenticator = new VirtualAuthenticator(ORIGIN, RP_ID);
		expect((await new Client(world).signUp({ name: 'One', email: 'dup-key-1@example.com' }, authenticator)).ceremony?.verify.status).toBe(200);
		const second = await new Client(world).signUp({ name: 'Two', email: 'dup-key-2@example.com' }, authenticator);
		expect(second.ceremony?.verify.status).toBeGreaterThanOrEqual(400);
		expect(await userCount('dup-key-2@example.com')).toBe(0);
	});
});

describe('sign-in', () => {
	test('a registered passkey signs in with a discoverable credential and sets a session', async () => {
		const authenticator = new VirtualAuthenticator(ORIGIN, RP_ID);
		const signedUp = await new Client(world).signUp({ name: 'Back', email: 'back@example.com' }, authenticator);
		expect(signedUp.ceremony?.verify.status).toBe(200);

		const returning = new Client(world);
		const response = await returning.signInWithPasskey(authenticator);
		expect(response.status).toBe(200);
		expect(response.body.user.email).toBe('back@example.com');
		const session = await returning.json('GET', '/get-session');
		expect(session.body.user.email).toBe('back@example.com');
	});

	test('an unknown credential is refused', async () => {
		const stranger = new VirtualAuthenticator(ORIGIN, RP_ID);
		expect((await new Client(world).signInWithPasskey(stranger)).status).toBeGreaterThanOrEqual(400);
	});
});
