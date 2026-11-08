/**
 * The session fast path (`server/auth/session-cache.ts`): better-auth's signed `session_data` cookie cache verified without
 * better-auth. The golden cookie was produced by the real better-auth 1.7.18 (sign-up in a workers test, secret below); the
 * rest are built with a local signer that follows the same format, to reach every refusal.
 */
import { describe, expect, it } from 'vitest';
import { signCookie } from '../../../src/server/auth/secret-rotation';
import { sessionFromCookieCache, verifySessionCache } from '../../../src/server/auth/session-cache';

const SECRET = 'fixture-secret-for-session-cache-0123456789';
const OTHER = 'another-secret-for-session-cache-0123456789';

/** Cookies minted by the real better-auth under SECRET (token cookie value, session_data value). */
const GOLDEN = {
	token: 'NmpMCOZMMErnPsxZXRRFkHRicwsrlkmZ.OLZuYktl8XYjODLZpawdNPHcmYSx4RQJih%2FaR1LKA7Y%3D',
	data: 'eyJzZXNzaW9uIjp7InNlc3Npb24iOnsiZXhwaXJlc0F0IjoiMjAyNi0xMi0wOFQxMTozNDo0Mi45NDNaIiwidG9rZW4iOiJObXBNQ09aTU1Fcm5Qc3haWFJSRmtIUmljd3NybGttWiIsImNyZWF0ZWRBdCI6IjIwMjYtMTEtMDhUMTE6MzQ6NDIuOTQzWiIsInVwZGF0ZWRBdCI6IjIwMjYtMTEtMDhUMTE6MzQ6NDIuOTQzWiIsImlwQWRkcmVzcyI6IiIsInVzZXJBZ2VudCI6IiIsInVzZXJJZCI6IkZvMkZuNmRXV1pkVjhnVjYwUG13MzZ2ZkFLTklVRk5jIiwicmVzdHJpY3RlZCI6ZmFsc2UsImlkIjoiREdlM2FUM2lsSnNVNDBqT2RSTVg2cFBsNGpVckFCUWgifSwidXNlciI6eyJuYW1lIjoiUml0YSBGaXh0dXJlIiwiZW1haWwiOiJyaXRhLWZpeHR1cmVAZXhhbXBsZS5jb20iLCJlbWFpbFZlcmlmaWVkIjpmYWxzZSwiaW1hZ2UiOm51bGwsImNyZWF0ZWRBdCI6IjIwMjYtMTEtMDhUMTE6MzQ6NDIuOTM3WiIsInVwZGF0ZWRBdCI6IjIwMjYtMTEtMDhUMTE6MzQ6NDIuOTM3WiIsImlkIjoiRm8yRm42ZFdXWmRWOGdWNjBQbXczNnZmQUtOSVVGTmMifSwidXBkYXRlZEF0IjoxNzk0MTM3NjgyOTQ0LCJ2ZXJzaW9uIjoiMSJ9LCJleHBpcmVzQXQiOjE3OTQxMzc5ODI5NDQsInNpZ25hdHVyZSI6IjBWcW1DQUUyT0pSbjI3Y3FHMHp3V3pRRHB5eWY0ci1zOTVNRWlaVkFyZG8ifQ',
	userId: 'Fo2Fn6dWWZdV8gV60Pmw36vfAKNIUFNc',
	sessionId: 'DGe3aT3ilJsU40jOdRMX6pPl4jUrABQh',
	/** Inside the cache's five minutes (it expires at 1794137982944). */
	now: 1794137700000
};

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const text = (value: string) => new TextEncoder().encode(value);

async function hmac(secret: string, value: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', text(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, text(value)));
}

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function payload(overrides: { session?: Record<string, unknown>; user?: Record<string, unknown>; version?: string | null; updatedAt?: unknown } = {}) {
	return {
		session: {
			expiresAt: iso(NOW + 86_400_000),
			token: 'tok-123',
			createdAt: iso(NOW - 1000),
			updatedAt: iso(NOW - 1000),
			ipAddress: '',
			userAgent: '',
			userId: 'user-1',
			restricted: false,
			id: 'session-1',
			...overrides.session
		},
		user: { name: 'Ada', email: 'ada@example.com', emailVerified: true, image: null, createdAt: iso(NOW - 5000), updatedAt: iso(NOW - 5000), id: 'user-1', ...overrides.user },
		updatedAt: overrides.updatedAt ?? NOW - 1000,
		...(overrides.version === null ? {} : { version: overrides.version ?? '1' })
	};
}

/** A `session_data` value the way better-auth's compact strategy writes it. */
async function sessionData(inner: Record<string, unknown>, secret = SECRET, expiresAt = NOW + 300_000): Promise<string> {
	const signature = b64url(await hmac(secret, JSON.stringify({ ...inner, expiresAt })));
	return b64url(text(JSON.stringify({ session: inner, expiresAt, signature })));
}

const tokenCookie = (token = 'tok-123', secret = SECRET) => signCookie(token, secret);

describe('golden cookies from the real better-auth', () => {
	it('verifies and yields the session better-auth returned', async () => {
		const result = await verifySessionCache(GOLDEN.data, decodeURIComponent(GOLDEN.token), SECRET, GOLDEN.now);
		expect(result?.info).toEqual({
			userId: GOLDEN.userId,
			sessionId: GOLDEN.sessionId,
			name: 'Rita Fixture',
			email: 'rita-fixture@example.com',
			emailVerified: false,
			image: null
		});
		expect(result?.cacheExpiresAt).toBe(1794137982944);
	});

	it('reads both cookies from a Cookie header, the token percent-encoded as browsers send it', async () => {
		const request = new Request('http://localhost/rpc', {
			headers: { cookie: `better-auth.flarion-passkey=x; better-auth.session_token=${GOLDEN.token}; better-auth.session_data=${GOLDEN.data}` }
		});
		const env = { ENVIRONMENT: 'production', BETTER_AUTH_SECRET: SECRET, APP_ORIGIN: 'http://localhost:5173' };
		expect((await sessionFromCookieCache(request, env, GOLDEN.now))?.userId).toBe(GOLDEN.userId);
		// The token cookie sent raw (the cookie jars of tests do) is the same cookie.
		const raw = new Request('http://localhost/rpc', { headers: { cookie: `better-auth.session_token=${decodeURIComponent(GOLDEN.token)}; better-auth.session_data=${GOLDEN.data}` } });
		expect((await sessionFromCookieCache(raw, env, GOLDEN.now))?.userId).toBe(GOLDEN.userId);
	});

	it('refuses it after the cache expired, under another secret and without its token cookie', async () => {
		const token = decodeURIComponent(GOLDEN.token);
		expect(await verifySessionCache(GOLDEN.data, token, SECRET, 1794137982945)).toBeNull();
		expect(await verifySessionCache(GOLDEN.data, token, OTHER, GOLDEN.now)).toBeNull();
		expect(await verifySessionCache(GOLDEN.data, 'not-a-signed-cookie', SECRET, GOLDEN.now)).toBeNull();
	});

	it('refuses any single changed character of the cache or of the token', async () => {
		const token = decodeURIComponent(GOLDEN.token);
		for (const at of [10, 120, 400, 700, GOLDEN.data.length - 3, GOLDEN.data.length - 1]) {
			const flipped = GOLDEN.data.slice(0, at) + (GOLDEN.data[at] === 'A' ? 'B' : 'A') + GOLDEN.data.slice(at + 1);
			expect(await verifySessionCache(flipped, token, SECRET, GOLDEN.now), `data ${at}`).toBeNull();
		}
		for (const at of [0, 15, 31]) {
			const flipped = token.slice(0, at) + (token[at] === 'A' ? 'B' : 'A') + token.slice(at + 1);
			expect(await verifySessionCache(GOLDEN.data, flipped, SECRET, GOLDEN.now), `token ${at}`).toBeNull();
		}
	});
});

describe('verifySessionCache', () => {
	const verify = async (inner: Record<string, unknown>, options: { secret?: string; token?: string; expiresAt?: number; now?: number } = {}) =>
		verifySessionCache(
			await sessionData(inner, options.secret ?? SECRET, options.expiresAt),
			decodeURIComponent(await tokenCookie(options.token ?? 'tok-123')),
			SECRET,
			options.now ?? NOW
		);

	it('accepts a well-formed cache and lowercases the email like better-auth does', async () => {
		const result = await verify(payload({ user: { email: 'Ada@Example.COM', emailVerified: undefined, image: 'https://x/y.png' } }));
		expect(result?.info).toEqual({ userId: 'user-1', sessionId: 'session-1', name: 'Ada', email: 'ada@example.com', emailVerified: false, image: 'https://x/y.png' });
	});

	it('accepts a cache without a version (default "1") and refuses another one', async () => {
		expect(await verify(payload({ version: null }))).not.toBeNull();
		expect(await verify(payload({ version: '2' }))).toBeNull();
	});

	it('refuses a cache signed under another secret', async () => {
		expect(await verify(payload(), { secret: OTHER })).toBeNull();
	});

	it('refuses an expired cache and an expired session', async () => {
		expect(await verify(payload(), { expiresAt: NOW - 1 })).toBeNull();
		expect(await verify(payload({ session: { expiresAt: iso(NOW - 1) } }))).toBeNull();
	});

	it('refuses a restricted (recovery) session, however it is spelled', async () => {
		expect(await verify(payload({ session: { restricted: true } }))).toBeNull();
		expect(await verify(payload({ session: { restricted: 'true' } }))).toBeNull();
		expect(await verify(payload({ session: { restricted: 1 } }))).toBeNull();
		expect(await verify(payload({ session: { restricted: false } }))).not.toBeNull();
	});

	it('refuses a cache whose token is not the cookie token, or whose user is not the session user', async () => {
		expect(await verify(payload({ session: { token: 'someone-elses' } }))).toBeNull();
		expect(await verify(payload(), { token: 'someone-elses' })).toBeNull();
		expect(await verify(payload({ session: { userId: 'user-2' } }))).toBeNull();
	});

	it('refuses payloads that better-auth\'s schema would refuse', async () => {
		expect(await verify(payload({ session: { id: 7 } }))).toBeNull();
		expect(await verify(payload({ session: { expiresAt: 'tomorrow' } }))).toBeNull();
		expect(await verify(payload({ session: { expiresAt: undefined } }))).toBeNull();
		expect(await verify(payload({ user: { email: undefined } }))).toBeNull();
		expect(await verify(payload({ user: { name: 12 } }))).toBeNull();
		expect(await verify(payload({ user: { emailVerified: 'yes' } }))).toBeNull();
		expect(await verify(payload({ updatedAt: 'now' }))).toBeNull();
		expect(await verify(payload({ version: undefined, user: { image: 4 } }))).toBeNull();
	});

	it('refuses malformed outer shapes and encodings', async () => {
		const token = decodeURIComponent(await tokenCookie());
		const good = await sessionData(payload());
		expect(await verifySessionCache(await sessionData(payload(), SECRET, 1000), token, SECRET)).toBeNull(); // default clock: the real one
		expect(await verifySessionCache(good, token, SECRET, NOW)).not.toBeNull();
		expect(await verifySessionCache('', token, SECRET, NOW)).toBeNull();
		expect(await verifySessionCache('%%%', token, SECRET, NOW)).toBeNull();
		expect(await verifySessionCache(good + '=', token, SECRET, NOW)).toBeNull();
		expect(await verifySessionCache(b64url(text('not json')), token, SECRET, NOW)).toBeNull();
		expect(await verifySessionCache(b64url(text('"a string"')), token, SECRET, NOW)).toBeNull();
		expect(await verifySessionCache(b64url(text(JSON.stringify({ session: {}, expiresAt: NOW + 1000 }))), token, SECRET, NOW)).toBeNull();
		expect(await verifySessionCache(b64url(text(JSON.stringify({ session: payload(), expiresAt: '9', signature: 'abc' }))), token, SECRET, NOW)).toBeNull();
		expect(await verifySessionCache(b64url(text(JSON.stringify({ session: payload(), expiresAt: NOW + 1000, signature: '!!' }))), token, SECRET, NOW)).toBeNull();
	});

	it('a signature over the payload without expiresAt, or over another expiresAt, does not verify', async () => {
		const inner = payload();
		const withoutExpiry = b64url(await hmac(SECRET, JSON.stringify(inner)));
		const token = decodeURIComponent(await tokenCookie());
		expect(await verifySessionCache(b64url(text(JSON.stringify({ session: inner, expiresAt: NOW + 300_000, signature: withoutExpiry }))), token, SECRET, NOW)).toBeNull();
		const forever = b64url(await hmac(SECRET, JSON.stringify({ ...inner, expiresAt: NOW + 300_000 })));
		expect(await verifySessionCache(b64url(text(JSON.stringify({ session: inner, expiresAt: NOW + 9e9, signature: forever }))), token, SECRET, NOW)).toBeNull();
	});

	it('token cookie: wrong secret, wrong signature length and a missing dot are refused', async () => {
		const data = await sessionData(payload());
		const good = decodeURIComponent(await tokenCookie());
		expect(await verifySessionCache(data, good, SECRET, NOW)).not.toBeNull();
		expect(await verifySessionCache(data, decodeURIComponent(await tokenCookie('tok-123', OTHER)), SECRET, NOW)).toBeNull();
		expect(await verifySessionCache(data, good.slice(0, -2) + '=', SECRET, NOW)).toBeNull();
		expect(await verifySessionCache(data, 'tok-123', SECRET, NOW)).toBeNull();
		expect(await verifySessionCache(data, '.' + good.split('.')[1], SECRET, NOW)).toBeNull();
	});
});

describe('sessionFromCookieCache', () => {
	const env = { ENVIRONMENT: 'production', BETTER_AUTH_SECRET: SECRET, APP_ORIGIN: 'https://flarion.example' };
	const request = (cookie?: string) => new Request('https://flarion.example/ws/w', { headers: cookie ? { cookie } : {} });

	it('reads the __Secure- cookie names when APP_ORIGIN is https, and only those', async () => {
		const data = await sessionData(payload());
		const token = await tokenCookie();
		expect((await sessionFromCookieCache(request(`__Secure-better-auth.session_token=${token}; __Secure-better-auth.session_data=${data}`), env, NOW))?.userId).toBe('user-1');
		expect(await sessionFromCookieCache(request(`better-auth.session_token=${token}; better-auth.session_data=${data}`), env, NOW)).toBeNull();
		const plain = { ...env, APP_ORIGIN: 'http://localhost:5173' };
		expect(await sessionFromCookieCache(request(`__Secure-better-auth.session_token=${token}; __Secure-better-auth.session_data=${data}`), plain, NOW)).toBeNull();
	});

	it('falls back (null) on a missing header, a missing cookie, chunked data, a previous secret and a missing secret', async () => {
		const data = await sessionData(payload());
		const token = await tokenCookie();
		const names = '__Secure-better-auth';
		expect(await sessionFromCookieCache(request(), env, NOW)).toBeNull();
		expect(await sessionFromCookieCache(request(`${names}.session_token=${token}`), env, NOW)).toBeNull();
		expect(await sessionFromCookieCache(request(`${names}.session_data=${data}`), env, NOW)).toBeNull();
		expect(await sessionFromCookieCache(request(`${names}.session_token=${token}; ${names}.session_data.0=${data}`), env, NOW)).toBeNull();
		const cookies = `${names}.session_token=${token}; ${names}.session_data=${data}`;
		expect(await sessionFromCookieCache(request(cookies), env, NOW)).not.toBeNull();
		// Rotation: the secret changed, the previous one is still set; the cookie signed with it is the full path's business.
		expect(await sessionFromCookieCache(request(cookies), { ...env, BETTER_AUTH_SECRET: OTHER, BETTER_AUTH_SECRET_PREVIOUS: SECRET }, NOW)).toBeNull();
		expect(await sessionFromCookieCache(request(cookies), { ENVIRONMENT: 'production', APP_ORIGIN: env.APP_ORIGIN }, NOW)).toBeNull();
	});

	it('takes the first of two cookies with the same name, like better-auth', async () => {
		const data = await sessionData(payload());
		const token = await tokenCookie();
		const cookies = `better-auth.session_token=junk; better-auth.session_token=${token}; better-auth.session_data=${data}`;
		expect(await sessionFromCookieCache(request(cookies), { ...env, APP_ORIGIN: 'http://localhost:5173' }, NOW)).toBeNull();
	});
});
