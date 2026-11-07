/**
 * Short-lived signed file URLs. User files are served from the files origin (`env.FILES_ORIGIN`, a
 * separate host with no session cookie), so a download is authorised by the URL itself:
 *
 *   `<FILES_ORIGIN>/files/<fileId>?ws=<workspaceId>&exp=<unix seconds>[&w=<px>]&sig=<base64url HMAC-SHA256>`
 *
 * The signature covers `f1\n<workspaceId>\n<fileId>\n<exp>\n<w or 0>` with `FILES_URL_KEY` (falling back to
 * `ROOM_TOKEN_KEY`, domain-separated by the `f1` prefix so a room token can never be replayed as a file
 * signature). Rotation uses the same two-key overlap as room tokens: sign with the current key, verify
 * against the current then `FILES_URL_KEY_PREVIOUS` (falling back to `ROOM_TOKEN_KEY_PREVIOUS`).
 * Only `files.get`, the cookie-authenticated redirect and published pages mint these, each after a
 * permission check.
 */
import { FILE_URL_TTL_SECONDS, IMAGE_WIDTH_STEP, MAX_IMAGE_WIDTH } from './constants';

export interface FileSigningEnv {
	FILES_URL_KEY?: string;
	FILES_URL_KEY_PREVIOUS?: string;
	ROOM_TOKEN_KEY?: string;
	ROOM_TOKEN_KEY_PREVIOUS?: string;
}

export interface SignedFileClaims {
	workspaceId: string;
	fileId: string;
	/** Expiry, unix seconds. */
	exp: number;
	/** Requested image width in px (0: the original). */
	width: number;
}

export type VerifyFileUrlResult =
	| { ok: true; claims: SignedFileClaims }
	| { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'no-key' };

const MIN_KEY_LENGTH = 16;
const encoder = new TextEncoder();
const usable = (key: string | undefined): key is string => typeof key === 'string' && key.length >= MIN_KEY_LENGTH;

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
	try {
		const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

const message = (claims: SignedFileClaims) =>
	encoder.encode(`f1\n${claims.workspaceId}\n${claims.fileId}\n${claims.exp}\n${claims.width}`);

const hmacKey = (secret: string, usage: 'sign' | 'verify') =>
	crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

const currentKey = (env: FileSigningEnv) => (usable(env.FILES_URL_KEY) ? env.FILES_URL_KEY : env.ROOM_TOKEN_KEY);
const verifyKeys = (env: FileSigningEnv) =>
	[env.FILES_URL_KEY, env.FILES_URL_KEY_PREVIOUS, env.ROOM_TOKEN_KEY, env.ROOM_TOKEN_KEY_PREVIOUS]
		// With a dedicated key configured, the room-token keys are not accepted (and vice versa for rotation).
		.filter((key, index) => (usable(env.FILES_URL_KEY) ? index < 2 : index >= 2))
		.filter(usable);

/** Clamp an image width to a served variant (a multiple of the step, at most the maximum); 0 for none. */
export function imageWidth(value: unknown, step = IMAGE_WIDTH_STEP): number {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(MAX_IMAGE_WIDTH, Math.ceil(n / step) * step);
}

/** The query string of a signed URL. Throws when no signing key is configured. */
export async function signFileQuery(
	env: FileSigningEnv,
	input: { workspaceId: string; fileId: string; ttlSeconds?: number; width?: number; now?: number }
): Promise<URLSearchParams> {
	const key = currentKey(env);
	if (!usable(key)) throw new Error('file URL signing key missing or shorter than 16 characters');
	const claims: SignedFileClaims = {
		workspaceId: input.workspaceId,
		fileId: input.fileId,
		exp: Math.floor((input.now ?? Date.now()) / 1000) + (input.ttlSeconds ?? FILE_URL_TTL_SECONDS),
		width: imageWidth(input.width)
	};
	const signature = await crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), message(claims));
	const query = new URLSearchParams({ ws: claims.workspaceId, exp: String(claims.exp) });
	if (claims.width > 0) query.set('w', String(claims.width));
	query.set('sig', toBase64Url(new Uint8Array(signature)));
	return query;
}

/** A signed download URL on the files origin. */
export async function signedFileUrl(
	env: FileSigningEnv & { FILES_ORIGIN: string },
	input: { workspaceId: string; fileId: string; ttlSeconds?: number; width?: number; now?: number; origin?: string }
): Promise<string> {
	const query = await signFileQuery(env, input);
	const origin = (input.origin ?? env.FILES_ORIGIN).replace(/\/+$/, '');
	return `${origin}/files/${encodeURIComponent(input.fileId)}?${query}`;
}

/** Verify the `ws`, `exp`, `w` and `sig` parameters of a download for `fileId`. Never throws. */
export async function verifyFileQuery(
	env: FileSigningEnv,
	fileId: string,
	params: URLSearchParams,
	options: { now?: number } = {}
): Promise<VerifyFileUrlResult> {
	const keys = verifyKeys(env);
	if (keys.length === 0) return { ok: false, reason: 'no-key' };
	const workspaceId = params.get('ws');
	const exp = Number(params.get('exp'));
	const width = params.has('w') ? Number(params.get('w')) : 0;
	const signature = fromBase64Url(params.get('sig') ?? '');
	if (!workspaceId || !signature || !Number.isInteger(exp) || !Number.isInteger(width) || width < 0) {
		return { ok: false, reason: 'malformed' };
	}
	const claims: SignedFileClaims = { workspaceId, fileId, exp, width };
	let valid = false;
	for (const key of keys) {
		// `verify` compares in constant time.
		if (await crypto.subtle.verify('HMAC', await hmacKey(key, 'verify'), signature, message(claims))) {
			valid = true;
			break;
		}
	}
	if (!valid) return { ok: false, reason: 'bad-signature' };
	if (exp <= (options.now ?? Date.now()) / 1000) return { ok: false, reason: 'expired' };
	return { ok: true, claims };
}
