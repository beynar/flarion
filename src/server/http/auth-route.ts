/**
 * `/api/auth/*`: the better-auth handler (passkeys, sessions, Flarion's sign-up/recovery endpoints) behind
 * the `RL_AUTH` rate limit. In development and tests only, `GET|DELETE /api/auth/dev/mails` reads or clears
 * the mails the dev fallback stored (see `server/mail`).
 */
import { getAuth } from '../auth/auth';
import { ensureDevSchema } from '../db/dev-migrate';
import { clearDevMails, readDevMails } from '../mail';
import type { RouteHandler } from './types';

const PREFIX = '/api/auth';
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
	Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

const devOnly = (env: Env) => {
	const environment = env.ENVIRONMENT as string;
	return environment === 'development' || environment === 'test';
};

/** Session reads are cheap and frequent: they are not rate limited. */
const UNLIMITED = new Set(['/get-session', '/ok']);

export const handleAuth: RouteHandler = async (request, env) => {
	const path = new URL(request.url).pathname.slice(PREFIX.length) || '/';

	if (path === '/config') {
		// What the browser needs before any auth call: the Turnstile site key (a test key in dev and tests).
		return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, appName: env.APP_NAME, environment: env.ENVIRONMENT });
	}

	if (path === '/dev/mails') {
		if (!devOnly(env)) return json({ message: 'Not found' }, 404);
		if (request.method === 'DELETE') {
			await clearDevMails(env);
			return json({ ok: true });
		}
		return json(await readDevMails(env));
	}

	if (!UNLIMITED.has(path)) {
		const ip = request.headers.get('cf-connecting-ip') ?? 'local';
		let allowed = true;
		try {
			allowed = (await env.RL_AUTH.limit({ key: `${ip}:${path}` })).success;
		} catch (error) {
			// A broken limiter must not lock everyone out; the failure is logged.
			console.error('[auth] rate limiter failed:', error instanceof Error ? error.message : error);
		}
		if (!allowed) return json({ message: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED' }, 429, { 'retry-after': '60' });
	}

	try {
		await ensureDevSchema(env);
		return await getAuth(env).handler(request);
	} catch (error) {
		console.error('[auth] unhandled error:', error instanceof Error ? (error.stack ?? error.message) : error);
		// Internals are only ever shown in development and tests.
		return json({ message: 'Something went wrong. Try again.', ...(devOnly(env) ? { detail: String(error) } : {}) }, 500);
	}
};
