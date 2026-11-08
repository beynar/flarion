/**
 * Rotation of the better-auth secret with a two-key overlap (docs/ops/secrets.md).
 *
 * better-auth signs its session cookie with one secret (`ctx.context.secret`, the first of its `secrets`); it can verify
 * *encrypted* data under older versions but not a signed cookie. A plain rotation would therefore sign everybody out.
 * The overlap is done here instead: with `BETTER_AUTH_SECRET_PREVIOUS` set, a session cookie whose signature only
 * verifies under the previous secret is re-signed under the current one before better-auth sees the request (and the
 * response sets the re-signed cookie), so sessions carry on and migrate the next time the app talks to `/api/auth`.
 * Sessions live in D1, so nothing else depends on the secret; the short-lived `session_data` cookie cache simply fails
 * its check and better-auth rebuilds it from D1. Registration tokens (ten minutes) verify under both secrets.
 *
 * Rotation: set `BETTER_AUTH_SECRET_PREVIOUS` to the old value and `BETTER_AUTH_SECRET` to the new one; deploy; once
 * the sessions you care about have been seen (a day is plenty for the app's daily refresh; the cookie lives 30 days),
 * delete the previous secret. Anyone not seen by then signs in again with their passkey.
 */
const encoder = new TextEncoder();
const MIN_SECRET_LENGTH = 32;
/** Local `pnpm dev` only: a fixed, public secret so a fresh checkout works without `.dev.vars`. */
const DEV_SECRET = 'flarion-local-development-secret-not-for-production';
/** The name better-auth gives its session cookie (`useSecureCookies` adds the `__Secure-` prefix). */
const SESSION_COOKIE = /^(__Secure-)?better-auth\.session_token$/;

export interface AuthSecretEnv {
	ENVIRONMENT?: string;
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_SECRET_PREVIOUS?: string;
}

const usable = (secret: string | undefined): secret is string => typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;

/** The current secret, then the previous one when set (and different). Throws when there is no current one. */
export function authSecrets(env: AuthSecretEnv): [string, ...string[]] {
	const current = usable(env.BETTER_AUTH_SECRET) ? env.BETTER_AUTH_SECRET : env.ENVIRONMENT === 'development' ? DEV_SECRET : undefined;
	if (!current) throw new Error('BETTER_AUTH_SECRET must be set to at least 32 characters');
	return usable(env.BETTER_AUTH_SECRET_PREVIOUS) && env.BETTER_AUTH_SECRET_PREVIOUS !== current ? [current, env.BETTER_AUTH_SECRET_PREVIOUS] : [current];
}

const hmacKey = (secret: string) => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	try {
		const binary = atob(text);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/** better-call's signed cookie value: `encodeURIComponent("<value>.<base64 HMAC-SHA256 of value>")`. */
export async function signCookie(value: string, secret: string): Promise<string> {
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value)));
	return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...signature))}`);
}

/** The value inside a signed cookie when its signature verifies under `secret`, else null. */
export async function verifyCookie(signed: string, secret: string): Promise<string | null> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(signed);
	} catch {
		return null;
	}
	const dot = decoded.lastIndexOf('.');
	if (dot < 1) return null;
	const signature = fromBase64(decoded.slice(dot + 1));
	if (!signature) return null;
	const value = decoded.slice(0, dot);
	return (await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, encoder.encode(value))) ? value : null;
}

export interface ResignResult {
	/** The request to hand to better-auth: the same one, or with the session cookie re-signed. */
	request: Request;
	/** A `Set-Cookie` for the response when the cookie was re-signed. */
	setCookie: string | null;
}

/**
 * Re-signs the session cookie of a request under the current secret when it was signed under the previous one. A
 * cookie that verifies under the current secret, or under neither, is left alone (better-auth rejects the latter).
 */
export async function resignSessionCookie(request: Request, env: AuthSecretEnv, maxAgeSeconds: number): Promise<ResignResult> {
	const [current, previous] = authSecrets(env);
	const header = request.headers.get('cookie');
	if (!previous || !header) return { request, setCookie: null };
	const pairs = header.split(/;\s*/);
	let setCookie: string | null = null;
	const rewritten: string[] = [];
	for (const pair of pairs) {
		const eq = pair.indexOf('=');
		const name = eq < 0 ? pair : pair.slice(0, eq);
		if (eq < 0 || !SESSION_COOKIE.test(name)) {
			rewritten.push(pair);
			continue;
		}
		const signed = pair.slice(eq + 1);
		if (await verifyCookie(signed, current)) {
			rewritten.push(pair);
			continue;
		}
		const value = await verifyCookie(signed, previous);
		if (value === null) {
			rewritten.push(pair);
			continue;
		}
		const fresh = await signCookie(value, current);
		rewritten.push(`${name}=${fresh}`);
		const secure = name.startsWith('__Secure-');
		setCookie = `${name}=${fresh}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
	}
	if (!setCookie) return { request, setCookie: null };
	const headers = new Headers(request.headers);
	headers.set('cookie', rewritten.join('; '));
	return { request: new Request(request, { headers }), setCookie };
}
