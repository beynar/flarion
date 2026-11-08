/**
 * Session fast path: verifies better-auth's signed `session_data` cookie cache directly, without loading better-auth.
 *
 * Why: the first `resolveSession` of an isolate used to evaluate the whole `auth` chunk (better-auth, kysely, the viborm D1
 * client: ~1.85 MB, ~75 ms per MB on a socket dial, docs/ops/load-test.md "Start-up"). While a tab's cookie cache is valid
 * (five minutes after its last `/api/auth/get-session`), better-auth answers `getSession` from the cookie alone, so the
 * same answer can be computed here with one WebCrypto verification.
 *
 * What better-auth 1.7.18 does for that case (`api/routes/session.mjs` `getSession`, `cookies/index.mjs` `decodeCookieCache`,
 * `cookies/cache.mjs`) and what this file replicates, in order; anything else falls back to the full path:
 *   1. the session token cookie (`[__Secure-]better-auth.session_token`) is signed (better-call: `value.<base64 HMAC-SHA256>`,
 *      signature of 44 characters ending in `=`) under the secret: replicated, verified with `crypto.subtle.verify`
 *      (constant time);
 *   2. the cookie cache (`[__Secure-]better-auth.session_data`, strategy `compact`, the default `auth.ts` leaves in place) is
 *      `base64url({ session, expiresAt, signature })` where `signature = base64urlnopad(HMAC-SHA256(secret,
 *      JSON.stringify({ ...session, expiresAt })))`: replicated, including the date-reviving JSON parse (`safeJSONParse`);
 *   3. the cache's schema (`cookieCachePayloadSchema`): checked for the fields used here, and the types better-auth's zod
 *      schema would reject are refused;
 *   4. the cached token equals the session cookie's token, the cache `version` equals the configured one (`"1"`:
 *      `auth.ts` sets none), the cache's `expiresAt` and the session's `expiresAt` are in the future: replicated;
 *   5. `cookieRefreshCache` is off (`auth.ts` does not enable it), so a valid cache is returned as is; when it is on the only
 *      effect is re-setting cookies, which `resolveSession` never forwards.
 * Beyond that `resolveSession` refuses `restricted` (recovery) sessions: refused here too, which sends them to the full path.
 *
 * Never decided here: a missing, chunked, malformed, expired, tampered or other-secret cache; a token cookie that does not
 * verify; a previous secret (the rotation overlap lives in `secret-rotation.ts`, and better-auth signs only with the
 * current secret); a cache of another strategy or version; a `restricted` session; any exception. The fast path only ever
 * says "this session" and never "signed out": a null here means "ask the full path", which gives the definitive answer
 * (including reading D1 when the cache is stale). Security decision: if in doubt, fall back.
 *
 * Keep this module free of heavy imports: it is evaluated by every isolate that serves a dial.
 */
import { authSecrets, type AuthSecretEnv } from './secret-rotation';
import type { SessionInfo } from './session';

/** Which path served `resolveSession` in this isolate (tests, `console.debug` while tuning). */
export const sessionPathStats = { fast: 0, full: 0 };

export interface SessionCacheEnv extends AuthSecretEnv {
	APP_ORIGIN?: string;
}

/** The cookie cache version `auth.ts` configures (`session.cookieCache.version` is unset: better-auth's default). */
const CACHE_VERSION = '1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const keys = new Map<string, Promise<CryptoKey>>();
function verifyKey(secret: string): Promise<CryptoKey> {
	let key = keys.get(secret);
	if (!key) {
		// Two secrets at most are ever live (a rotation); anything else is a test swapping secrets.
		if (keys.size >= 4) keys.clear();
		key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
		keys.set(secret, key);
	}
	return key;
}

/** better-call's `tryDecode`. */
function tryDecode(value: string): string {
	try {
		return value.includes('%') ? decodeURIComponent(value) : value;
	} catch {
		return value;
	}
}

/** better-call's `parseCookies` (first occurrence of a name wins, a quoted value loses its quotes, then percent-decoding). */
function parseCookies(header: string): Map<string, string> {
	const cookies = new Map<string, string>();
	let index = 0;
	while (index < header.length) {
		const eq = header.indexOf('=', index);
		if (eq === -1) break;
		let end = header.indexOf(';', index);
		if (end === -1) end = header.length;
		else if (end < eq) {
			index = header.lastIndexOf(';', eq - 1) + 1;
			continue;
		}
		const key = header.slice(index, eq).trim();
		if (!cookies.has(key)) {
			let value = header.slice(eq + 1, end).trim();
			if (value.codePointAt(0) === 34) value = value.slice(1, -1);
			cookies.set(key, tryDecode(value));
		}
		index = end + 1;
	}
	return cookies;
}

function base64Bytes(text: string, urlSafe: boolean): Uint8Array<ArrayBuffer> | null {
	if (urlSafe ? !BASE64URL.test(text) : !BASE64.test(text)) return null;
	try {
		let standard = urlSafe ? text.replace(/-/g, '+').replace(/_/g, '/') : text;
		while (standard.length % 4 !== 0) standard += '=';
		const binary = atob(standard);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/** better-auth's `getSignedCookie` for the session token: the token when the signature verifies under `secret`, else null. */
async function verifiedToken(value: string, secret: string): Promise<string | null> {
	const dot = value.lastIndexOf('.');
	if (dot < 1) return null;
	const token = value.slice(0, dot);
	const signature = value.slice(dot + 1);
	if (signature.length !== 44 || !signature.endsWith('=')) return null;
	const bytes = base64Bytes(signature, false);
	if (!bytes) return null;
	return (await crypto.subtle.verify('HMAC', await verifyKey(secret), bytes, encoder.encode(token))) ? token : null;
}

/** `safeJSONParse` of `@better-auth/core`: `JSON.parse` turning ISO 8601 strings into `Date`s (which `JSON.stringify` writes back). */
function reviveDate(_key: string, value: unknown): unknown {
	if (typeof value === 'string' && ISO_8601.test(value)) {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) return date;
	}
	return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());
const optional = (value: unknown, check: (v: unknown) => boolean) => value === undefined || check(value);
const nullish = (value: unknown, check: (v: unknown) => boolean) => value === undefined || value === null || check(value);

export interface CachedSession {
	info: SessionInfo;
	/** Epoch ms after which the cache is not served any more. */
	cacheExpiresAt: number;
}

/**
 * Decodes and verifies a `session_data` value (compact strategy) and the token of the session cookie. Null whenever anything is off.
 * `now` is injectable for tests.
 */
export async function verifySessionCache(dataValue: string, tokenValue: string, secret: string, now: number = Date.now()): Promise<CachedSession | null> {
	const token = await verifiedToken(tokenValue, secret);
	if (!token) return null;

	// `parseCompactCookieCache(safeJSONParse(binary.decode(base64Url.decode(value))))`
	const raw = base64Bytes(dataValue, true);
	if (!raw) return null;
	let outer: unknown;
	try {
		outer = JSON.parse(decoder.decode(raw), reviveDate);
	} catch {
		return null;
	}
	if (!isRecord(outer) || !isRecord(outer.session) || typeof outer.expiresAt !== 'number' || !Number.isFinite(outer.expiresAt) || !isString(outer.signature)) return null;
	const signature = base64Bytes(outer.signature, true);
	if (!signature) return null;
	// `createHMAC('SHA-256', 'base64urlnopad').verify(secret, JSON.stringify({ ...parsed.session, expiresAt }), signature)`
	const signed = JSON.stringify({ ...outer.session, expiresAt: outer.expiresAt });
	if (!(await crypto.subtle.verify('HMAC', await verifyKey(secret), signature, encoder.encode(signed)))) return null;

	// `cookieCachePayloadSchema`: { session: sessionSchema, user: userSchema, updatedAt: number, version?: string }
	const payload = outer.session;
	const session = payload.session;
	const user = payload.user;
	if (!isRecord(session) || !isRecord(user) || typeof payload.updatedAt !== 'number' || !optional(payload.version, isString)) return null;
	if (!isString(session.id) || !isString(session.userId) || !isString(session.token) || !isDate(session.expiresAt)) return null;
	if (!optional(session.createdAt, isDate) || !optional(session.updatedAt, isDate) || !nullish(session.ipAddress, isString) || !nullish(session.userAgent, isString)) return null;
	if (!isString(user.id) || !isString(user.name) || !isString(user.email)) return null;
	if (!optional(user.createdAt, isDate) || !optional(user.updatedAt, isDate) || !optional(user.emailVerified, (v) => typeof v === 'boolean') || !nullish(user.image, isString)) return null;
	if (session.userId !== user.id) return null;

	// What `getSession` does with a decoded cache.
	if (session.token !== token) return null;
	if (((payload.version as string | undefined) || '1') !== CACHE_VERSION) return null;
	if (outer.expiresAt < now || (session.expiresAt as Date).getTime() < now) return null;
	// `resolveSession` never resolves recovery sessions; the full path decides what they get.
	if (session.restricted) return null;

	return {
		info: {
			userId: user.id,
			sessionId: session.id,
			name: user.name,
			// `userSchema.email` lowercases.
			email: user.email.toLowerCase(),
			emailVerified: (user.emailVerified as boolean | undefined) ?? false,
			image: (user.image as string | null | undefined) ?? null
		},
		cacheExpiresAt: outer.expiresAt
	};
}

/**
 * The session of a request when its cookie cache proves it, else null (ask the full path). Never throws.
 * The cookies are named like `auth.ts` names them (`useSecureCookies` when `APP_ORIGIN` is https; default prefix).
 */
export async function sessionFromCookieCache(request: Request, env: SessionCacheEnv, now: number = Date.now()): Promise<SessionInfo | null> {
	try {
		const header = request.headers.get('cookie');
		if (!header) return null;
		const prefix = String(env.APP_ORIGIN ?? '').startsWith('https://') ? '__Secure-' : '';
		const cookies = parseCookies(header);
		const token = cookies.get(`${prefix}better-auth.session_token`);
		const data = cookies.get(`${prefix}better-auth.session_data`);
		if (!token || !data) return null;
		// The current secret only: a cookie signed under the previous one goes to the full path (which re-signs it).
		const [secret] = authSecrets(env);
		return (await verifySessionCache(data, token, secret, now))?.info ?? null;
	} catch {
		return null;
	}
}
