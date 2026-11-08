/**
 * The pure guard of the load-test authentication (see `load-test-auth.ts`): no Cloudflare or better-auth
 * imports, so unit tests can pin the rule that makes it impossible in production.
 */
export const LOAD_TEST_PREFIX = '/api/load-test/';
export const LOAD_TEST_KEY_HEADER = 'x-load-test-key';
export const LOAD_TEST_KEY_MIN = 24;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface LoadTestEnv {
	ENVIRONMENT: string;
	LOAD_TEST_KEY?: string;
}

/**
 * Whether the load-test endpoints may answer at all. Pure, so both the route and the tests use it:
 * staging with a long enough key, or local development with one and a loopback host. Never production.
 */
export function loadTestAuthEnabled(env: LoadTestEnv, host?: string | null): boolean {
	const key = env.LOAD_TEST_KEY;
	if (typeof key !== 'string' || key.length < LOAD_TEST_KEY_MIN) return false;
	const environment = String(env.ENVIRONMENT);
	if (environment === 'staging') return true;
	if (environment === 'development') return !!host && LOCAL_HOSTS.has(host.toLowerCase());
	return false;
}

/** Constant-time string equality (the compared lengths are not secret: the key is a fixed-size random string). */
export function safeEqual(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	const n = Math.max(x.length, y.length);
	for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

