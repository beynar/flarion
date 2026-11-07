/**
 * Cloudflare Turnstile verification (docs/PLAN.md "Sign-up"). Tests and local dev use Cloudflare's
 * documented test keys, which are decided offline here (no network call): the always-pass secret passes,
 * the always-fail secret fails. A test secret is refused in production, and a missing secret fails closed
 * outside development and test.
 */
export const TURNSTILE_TEST_SECRET_PASS = '1x0000000000000000000000000000000AA';
export const TURNSTILE_TEST_SECRET_FAIL = '2x0000000000000000000000000000000AA';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type TurnstileEnv = { ENVIRONMENT?: string; TURNSTILE_SECRET?: string };

export async function verifyTurnstile(env: TurnstileEnv, token: string | undefined, ip?: string | null): Promise<boolean> {
	const production = env.ENVIRONMENT === 'production';
	const relaxed = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
	const secret = env.TURNSTILE_SECRET ?? (relaxed ? TURNSTILE_TEST_SECRET_PASS : undefined);
	if (!secret) {
		console.error('[turnstile] TURNSTILE_SECRET is not configured');
		return false;
	}
	if (!token) return false;
	if (secret === TURNSTILE_TEST_SECRET_PASS || secret === TURNSTILE_TEST_SECRET_FAIL) {
		if (production) {
			console.error('[turnstile] a Turnstile test secret is configured in production');
			return false;
		}
		return secret === TURNSTILE_TEST_SECRET_PASS;
	}
	try {
		const body = new URLSearchParams({ secret, response: token });
		if (ip) body.set('remoteip', ip);
		const response = await fetch(SITEVERIFY, { method: 'POST', body });
		if (!response.ok) return false;
		return ((await response.json()) as { success?: boolean }).success === true;
	} catch (error) {
		console.error('[turnstile] verification request failed', error instanceof Error ? error.message : error);
		return false;
	}
}
