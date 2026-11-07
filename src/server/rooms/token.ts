/**
 * Signed room tokens: how a browser proves to `/rooms/:pageId` who it is and what it may do there.
 *
 * Format: `rt1.<base64url(JSON claims)>.<base64url(HMAC-SHA256 over "rt1.<payload>")>`.
 * Claims: `{ userId, workspaceId, pageId, access, exp }` with `exp` in unix seconds. Tokens last about
 * ten minutes ({@link ROOM_TOKEN_TTL_SECONDS}); the edytor provider refreshes on close code 4401.
 *
 * Keys are Worker secrets. Rotation uses a two-key overlap: set `ROOM_TOKEN_KEY_PREVIOUS` to the old
 * value and `ROOM_TOKEN_KEY` to the new one; tokens are always signed with the current key and
 * verified against the current, then the previous key. Drop the previous key once every token minted
 * with it has expired (more than {@link ROOM_TOKEN_TTL_SECONDS} later).
 */
import { isValidRoomId } from './names';

export type RoomAccess = 'read' | 'comment' | 'write';

export interface RoomClaims {
	userId: string;
	workspaceId: string;
	pageId: string;
	access: RoomAccess;
}

export interface RoomTokenPayload extends RoomClaims {
	/** Expiry, unix seconds. */
	exp: number;
}

export interface RoomTokenEnv {
	ROOM_TOKEN_KEY?: string;
	ROOM_TOKEN_KEY_PREVIOUS?: string;
}

export type RoomTokenFailure = 'malformed' | 'bad-signature' | 'bad-claims' | 'expired' | 'no-key';
export type VerifyRoomTokenResult =
	| { ok: true; claims: RoomTokenPayload; usedPreviousKey: boolean }
	| { ok: false; reason: RoomTokenFailure };

export const ROOM_TOKEN_TTL_SECONDS = 600;
export const ROOM_TOKEN_PREFIX = 'rt1';
const MIN_KEY_LENGTH = 16;
const ACCESS_LEVELS: readonly RoomAccess[] = ['read', 'comment', 'write'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
	try {
		const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

const importKey = (secret: string, usage: 'sign' | 'verify') =>
	crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

const usableKey = (key: string | undefined): key is string => typeof key === 'string' && key.length >= MIN_KEY_LENGTH;

/** Validate claims shape; returns the cleaned payload or null. */
function parsePayload(value: unknown): RoomTokenPayload | null {
	if (typeof value !== 'object' || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.userId !== 'string' || v.userId.length < 1 || v.userId.length > 256) return null;
	if (typeof v.workspaceId !== 'string' || !isValidRoomId(v.workspaceId)) return null;
	if (typeof v.pageId !== 'string' || !isValidRoomId(v.pageId)) return null;
	if (typeof v.access !== 'string' || !ACCESS_LEVELS.includes(v.access as RoomAccess)) return null;
	if (typeof v.exp !== 'number' || !Number.isFinite(v.exp)) return null;
	return { userId: v.userId, workspaceId: v.workspaceId, pageId: v.pageId, access: v.access as RoomAccess, exp: v.exp };
}

/** Sign `claims` with `key`. Throws on an unusable key or invalid claims. */
export async function signRoomToken(key: string, payload: RoomTokenPayload): Promise<string> {
	if (!usableKey(key)) throw new Error(`room token key missing or shorter than ${MIN_KEY_LENGTH} characters`);
	if (!parsePayload(payload)) throw new Error('invalid room token claims');
	const body = `${ROOM_TOKEN_PREFIX}.${toBase64Url(encoder.encode(JSON.stringify(payload)))}`;
	const signature = await crypto.subtle.sign('HMAC', await importKey(key, 'sign'), encoder.encode(body));
	return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Mint a token for `claims` with the current `ROOM_TOKEN_KEY`. P1's auth code calls this. */
export async function mintRoomToken(
	env: RoomTokenEnv,
	claims: RoomClaims,
	options: { ttlSeconds?: number; now?: number } = {}
): Promise<{ token: string; expiresAt: number }> {
	const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
	const exp = nowSeconds + (options.ttlSeconds ?? ROOM_TOKEN_TTL_SECONDS);
	const token = await signRoomToken(env.ROOM_TOKEN_KEY ?? '', { ...claims, exp });
	/** `expiresAt` is in milliseconds since the epoch, like edytor's `expiresAt`. */
	return { token, expiresAt: exp * 1000 };
}

/** Verify signature (current key, then previous key), claims shape and expiry. Never throws. */
export async function verifyRoomToken(
	env: RoomTokenEnv,
	token: string | null | undefined,
	options: { now?: number } = {}
): Promise<VerifyRoomTokenResult> {
	const keys = [env.ROOM_TOKEN_KEY, env.ROOM_TOKEN_KEY_PREVIOUS].filter(usableKey);
	if (keys.length === 0) return { ok: false, reason: 'no-key' };
	if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'malformed' };
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== ROOM_TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
	const signature = fromBase64Url(parts[2]);
	const payloadBytes = fromBase64Url(parts[1]);
	if (!signature || !payloadBytes) return { ok: false, reason: 'malformed' };
	const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
	let usedPreviousKey = false;
	let valid = false;
	for (const key of keys) {
		// `verify` compares in constant time.
		if (await crypto.subtle.verify('HMAC', await importKey(key, 'verify'), signature, signed)) {
			valid = true;
			usedPreviousKey = key !== env.ROOM_TOKEN_KEY;
			break;
		}
	}
	if (!valid) return { ok: false, reason: 'bad-signature' };
	let payload: RoomTokenPayload | null;
	try {
		payload = parsePayload(JSON.parse(decoder.decode(payloadBytes)));
	} catch {
		payload = null;
	}
	if (!payload) return { ok: false, reason: 'bad-claims' };
	const nowSeconds = (options.now ?? Date.now()) / 1000;
	if (payload.exp <= nowSeconds) return { ok: false, reason: 'expired' };
	return { ok: true, claims: payload, usedPreviousKey };
}
