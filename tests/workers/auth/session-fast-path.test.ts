/**
 * The session fast path (`server/auth/session-cache.ts`) against the real better-auth: cookies minted by better-auth are
 * accepted without loading it, the answer equals the full path's, and every case the fast path does not decide (missing,
 * expired or tampered cache, another secret, recovery sessions) is served by the full path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { getAuth } from '../../../src/server/auth/auth';
import { handleLoadTest } from '../../../src/server/auth/load-test-auth';
import { resolveSession, type SessionInfo } from '../../../src/server/auth/session';
import { sessionPathStats } from '../../../src/server/auth/session-cache';
import { signCookie } from '../../../src/server/auth/secret-rotation';
import { createWorld, ORIGIN, signUpPerson, type Person } from './helpers';

const OLD = String((env as unknown as Record<string, string>).BETTER_AUTH_SECRET);
const NEW = 'a-brand-new-better-auth-secret-0123456789';

const cookieOf = (jar: string, name: string) => jar.split('; ').find((c) => c.startsWith(`better-auth.${name}=`))!;
const request = (cookie: string) => new Request(`${ORIGIN}/ws/some-workspace`, { headers: { cookie, upgrade: 'websocket' } });

/** Which path served `fn`: the counters' deltas. */
async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; fast: number; full: number }> {
	const before = { ...sessionPathStats };
	const value = await fn();
	return { value, fast: sessionPathStats.fast - before.fast, full: sessionPathStats.full - before.full };
}

/** What `resolveSession` makes of better-auth's own answer to this cookie (the full path, reading the cache or D1 as better-auth decides). */
async function betterAuthSays(world: ReturnType<typeof createWorld>, cookie: string): Promise<SessionInfo | null> {
	const result = await getAuth(world.env).api.getSession({ headers: new Headers({ cookie }) });
	if (!result || (result.session as { restricted?: boolean }).restricted) return null;
	return {
		userId: result.user.id,
		sessionId: result.session.id,
		name: result.user.name,
		email: result.user.email,
		emailVerified: result.user.emailVerified,
		image: result.user.image ?? null
	};
}

const world = createWorld();
let person: Person;
async function ada(): Promise<Person> {
	return (person ??= await signUpPerson(world, 'Ada Fast', `ada-fast-${crypto.randomUUID().slice(0, 6)}@Example.com`));
}

afterEach(() => vi.restoreAllMocks());

describe('resolveSession fast path', () => {
	it('serves a valid cookie cache without the full path, with the answer better-auth gives', async () => {
		const { client, userId } = await ada();
		const jar = client.jar.header;
		expect(jar).toMatch(/better-auth\.session_data=/);
		const run = await counted(() => resolveSession(request(jar), world.env));
		expect(run).toMatchObject({ fast: 1, full: 0 });
		expect(run.value).toMatchObject({ userId });
		expect(run.value).toEqual(await betterAuthSays(world, jar));
	});

	it('does not read D1 (it is the cookie alone)', async () => {
		const { client, userId } = await ada();
		const broken = new Proxy(world.env.DB, {
			get(target, property) {
				if (property === 'prepare' || property === 'batch') throw new Error('D1 is down');
				return Reflect.get(target, property, target);
			}
		}) as D1Database;
		const offline = createWorld({ DB: broken, WORKSPACE: world.env.WORKSPACE });
		const run = await counted(() => resolveSession(request(client.jar.header), offline.env));
		expect(run).toMatchObject({ fast: 1, full: 0 });
		expect(run.value?.userId).toBe(userId);
	});

	it('uses the full path when there is no cookie cache, and gives the same session', async () => {
		const { client } = await ada();
		const tokenOnly = cookieOf(client.jar.header, 'session_token');
		const cached = await counted(() => resolveSession(request(client.jar.header), world.env));
		const full = await counted(() => resolveSession(request(tokenOnly), world.env));
		expect(full).toMatchObject({ fast: 0, full: 1 });
		expect(full.value).toEqual(cached.value);
	});

	it('uses the full path once the cache expired (the session row is still good), and agrees with better-auth', async () => {
		const { client } = await ada();
		const jar = client.jar.header;
		const fresh = (await resolveSession(request(jar), world.env))!;
		const later = Date.now() + 6 * 60_000;
		vi.spyOn(Date, 'now').mockReturnValue(later);
		const run = await counted(() => resolveSession(request(jar), world.env));
		expect(run).toMatchObject({ fast: 0, full: 1 });
		expect(run.value).toEqual(fresh);
		expect(run.value).toEqual(await betterAuthSays(world, jar));
	});

	it('a revoked session is served for the cache lifetime exactly as better-auth serves it, and not after', async () => {
		const world2 = createWorld({ WORKSPACE: world.env.WORKSPACE });
		const gone = await signUpPerson(world2, 'Gone Soon', `gone-${crypto.randomUUID().slice(0, 6)}@example.com`);
		const jar = gone.client.jar.header;
		await world2.env.DB.prepare('DELETE FROM session WHERE userId = ?1').bind(gone.userId).run();
		const inside = await counted(() => resolveSession(request(jar), world2.env));
		expect(inside.fast).toBe(1);
		expect(inside.value).toEqual(await betterAuthSays(world2, jar));
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
		const after = await counted(() => resolveSession(request(jar), world2.env));
		expect(after).toMatchObject({ fast: 0, full: 1, value: null });
		expect(await betterAuthSays(world2, jar)).toBeNull();
	});

	it('a tampered cache never serves a fast answer; the token cookie decides through the full path', async () => {
		const { client, userId } = await ada();
		const token = cookieOf(client.jar.header, 'session_token');
		const data = cookieOf(client.jar.header, 'session_data');
		const value = data.slice(data.indexOf('=') + 1);
		const flipped = `better-auth.session_data=${value.slice(0, 200)}${value[200] === 'A' ? 'B' : 'A'}${value.slice(201)}`;
		const run = await counted(() => resolveSession(request(`${token}; ${flipped}`), world.env));
		expect(run).toMatchObject({ fast: 0, full: 1 });
		expect(run.value?.userId).toBe(userId);
		// A cache of somebody else's session next to this token: its token differs, so it is refused as well.
		const other = await signUpPerson(world, 'Other Fast', `other-fast-${crypto.randomUUID().slice(0, 6)}@example.com`);
		const swapped = await counted(() => resolveSession(request(`${token}; ${cookieOf(other.client.jar.header, 'session_data')}`), world.env));
		expect(swapped).toMatchObject({ fast: 0, full: 1 });
		expect(swapped.value?.userId).toBe(userId);
		// A cache without its token cookie is nothing.
		const bare = await counted(() => resolveSession(request(data), world.env));
		expect(bare).toMatchObject({ fast: 0, full: 1, value: null });
	});

	it('another secret: no fast answer; the rotation overlap still works through the full path, a bare rotation signs out', async () => {
		const { client, userId } = await ada();
		const jar = client.jar.header;
		const bare = createWorld({ BETTER_AUTH_SECRET: NEW, WORKSPACE: world.env.WORKSPACE });
		const dead = await counted(() => resolveSession(request(jar), bare.env));
		expect(dead).toMatchObject({ fast: 0, full: 1, value: null });
		const overlap = createWorld({ BETTER_AUTH_SECRET: NEW, BETTER_AUTH_SECRET_PREVIOUS: OLD, WORKSPACE: world.env.WORKSPACE });
		const alive = await counted(() => resolveSession(request(jar), overlap.env));
		expect(alive).toMatchObject({ fast: 0, full: 1 });
		expect(alive.value?.userId).toBe(userId);
	});

	it('a recovery (restricted) session never resolves, fast or full', async () => {
		const { userId } = await ada();
		const auth = await getAuth(world.env).$context;
		const session = await auth.internalAdapter.createSession(userId, false, { restricted: true, expiresAt: new Date(Date.now() + 10 * 60_000) }, true);
		const token = `${auth.authCookies.sessionToken.name}=${await signCookie(session.token, auth.secret)}`;
		// What a browser holds after better-auth cached it (recovery sets both cookies).
		const res = await getAuth(world.env).api.getSession({ headers: new Headers({ cookie: token }), returnHeaders: true });
		const cache = res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0]!)
			.filter((c) => /session_data/.test(c.split('=')[0]!));
		expect(cache, 'better-auth cached the restricted session').toHaveLength(1);
		const jar = [token, ...cache].join('; ');
		const run = await counted(() => resolveSession(request(jar), world.env));
		expect(run).toMatchObject({ fast: 0, full: 1, value: null });
		expect(await betterAuthSays(world, jar)).toBeNull();
	});

	it('accepts what the load-test route mints (token cookie + session_data cache)', async () => {
		const KEY = 'load-test-key-for-the-tests-0123456789';
		const staging = { ...(env as unknown as Env), ENVIRONMENT: 'staging', LOAD_TEST_KEY: KEY } as unknown as Env;
		const exec = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
		const call = (route: string, body: unknown) =>
			handleLoadTest(
				new Request(`https://flarion-staging.beynar.workers.dev/api/load-test/${route}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-load-test-key': KEY },
					body: JSON.stringify(body)
				}),
				staging,
				exec
			);
		const runId = `fp${crypto.randomUUID().slice(0, 8)}`;
		try {
			const minted = await call('users', { runId, count: 2 });
			expect(minted.status).toBe(200);
			const { users } = (await minted.json()) as { users: { userId: string; cookie: string }[] };
			for (const user of users) {
				expect(user.cookie).toMatch(/session_data=/);
				const run = await counted(() => resolveSession(request(user.cookie), staging));
				expect(run, user.userId).toMatchObject({ fast: 1, full: 0 });
				expect(run.value?.userId).toBe(user.userId);
				expect(run.value?.email).toBe(`load-${runId}-${users.indexOf(user) + 1}@load.invalid`);
			}
		} finally {
			await call('cleanup', { runId });
		}
	});
});
