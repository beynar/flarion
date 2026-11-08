/**
 * Secret rotation with a two-key overlap (docs/ops/secrets.md): the better-auth session cookie is re-signed from the
 * previous secret to the current one, so a rotation signs nobody out; without the previous secret, a stale cookie is dead.
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAuth } from '../../../src/server/http/auth-route';
import { resolveSession } from '../../../src/server/auth/session';
import { authSecrets, signCookie, verifyCookie } from '../../../src/server/auth/secret-rotation';
import { createWorld, ORIGIN, signUpPerson } from './helpers';

const OLD = String((env as unknown as Record<string, string>).BETTER_AUTH_SECRET);
const NEW = 'a-brand-new-better-auth-secret-0123456789';

const sessionCookie = (jar: string) => jar.split('; ').find((c) => /better-auth\.session_token=/.test(c))!;

async function getSession(world: ReturnType<typeof createWorld>, cookie: string) {
	const response = (await handleAuth(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } }), world.env, world.ctx)) as Response;
	const text = await response.text();
	return { response, session: text && text !== 'null' ? JSON.parse(text) : null };
}

describe('authSecrets', () => {
	it('lists the current secret first and the previous one when it is set and different', () => {
		expect(authSecrets({ BETTER_AUTH_SECRET: NEW, BETTER_AUTH_SECRET_PREVIOUS: OLD })).toEqual([NEW, OLD]);
		expect(authSecrets({ BETTER_AUTH_SECRET: NEW })).toEqual([NEW]);
		expect(authSecrets({ BETTER_AUTH_SECRET: NEW, BETTER_AUTH_SECRET_PREVIOUS: NEW })).toEqual([NEW]);
		expect(authSecrets({ BETTER_AUTH_SECRET: NEW, BETTER_AUTH_SECRET_PREVIOUS: 'short' })).toEqual([NEW]);
		expect(() => authSecrets({ ENVIRONMENT: 'production', BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/);
	});

	it('signs cookies the way better-call does, and verifies only under the right secret', async () => {
		const signed = await signCookie('token-123', OLD);
		expect(await verifyCookie(signed, OLD)).toBe('token-123');
		expect(await verifyCookie(signed, NEW)).toBeNull();
		expect(await verifyCookie('garbage', OLD)).toBeNull();
	});
});

describe('session cookie across a rotation', () => {
	it('keeps a session alive through the overlap, migrates its cookie, and drops stale cookies without the previous secret', async () => {
		const world = createWorld();
		const person = await signUpPerson(world, 'Rita', `rita-${crypto.randomUUID().slice(0, 6)}@example.com`);
		const oldCookie = sessionCookie(person.client.jar.header);
		expect((await getSession(world, oldCookie)).session?.user.id).toBe(person.userId);

		const rotated = createWorld({ BETTER_AUTH_SECRET: NEW, BETTER_AUTH_SECRET_PREVIOUS: OLD, WORKSPACE: world.env.WORKSPACE });
		const during = await getSession(rotated, oldCookie);
		expect(during.session?.user.id, 'still signed in during the overlap').toBe(person.userId);
		const setCookie = during.response.headers.getSetCookie().find((c) => /better-auth\.session_token=/.test(c));
		expect(setCookie, 'the response carries the re-signed cookie').toBeTruthy();
		expect(setCookie).toMatch(/HttpOnly/);
		const migrated = setCookie!.split(';')[0]!;
		expect(migrated).not.toBe(oldCookie);

		// The same session through the app's own session lookup (`/rpc`, sockets, files) with the old cookie.
		const fromRpc = await resolveSession(new Request(`${ORIGIN}/rpc`, { headers: { cookie: oldCookie } }), rotated.env);
		expect(fromRpc?.userId).toBe(person.userId);

		// After the previous secret is removed: the migrated cookie works, the old one does not.
		const after = createWorld({ BETTER_AUTH_SECRET: NEW, WORKSPACE: world.env.WORKSPACE });
		expect((await getSession(after, migrated)).session?.user.id).toBe(person.userId);
		expect((await getSession(after, oldCookie)).session).toBeNull();
	});

	it('a cookie signed with some other secret never gets in', async () => {
		const world = createWorld({ BETTER_AUTH_SECRET: NEW, BETTER_AUTH_SECRET_PREVIOUS: OLD });
		const forged = `better-auth.session_token=${await signCookie('whatever', 'x'.repeat(40))}`;
		expect((await getSession(world, forged)).session).toBeNull();
	});
});
