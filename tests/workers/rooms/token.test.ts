import { describe, expect, it } from 'vitest';
import {
	ROOM_TOKEN_TTL_SECONDS,
	mintRoomToken,
	signRoomToken,
	verifyRoomToken,
	type RoomClaims,
	type RoomTokenPayload
} from '../../../src/server/rooms/token';
import { parseRoomName, roomName } from '../../../src/server/rooms/names';

const KEY = 'current-key-current-key-current-key';
const OLD = 'previous-key-previous-key-previous-';
const claims: RoomClaims = { userId: 'ada', workspaceId: 'ws1', pageId: 'pg1', access: 'write' };
const NOW = 1_800_000_000_000;

describe('room token', () => {
	it('mints and verifies a token carrying the claims, lasting ten minutes', async () => {
		const { token, expiresAt } = await mintRoomToken({ ROOM_TOKEN_KEY: KEY }, claims, { now: NOW });
		expect(token).toMatch(/^rt1\.[\w-]+\.[\w-]+$/);
		expect(expiresAt).toBe(NOW + ROOM_TOKEN_TTL_SECONDS * 1000);
		expect(ROOM_TOKEN_TTL_SECONDS).toBe(600);
		const result = await verifyRoomToken({ ROOM_TOKEN_KEY: KEY }, token, { now: NOW + 1000 });
		expect(result).toEqual({ ok: true, claims: { ...claims, exp: expiresAt / 1000 }, usedPreviousKey: false });
	});

	it('rejects an expired token, with the exact boundary', async () => {
		const { token } = await mintRoomToken({ ROOM_TOKEN_KEY: KEY }, claims, { now: NOW });
		const exp = NOW + ROOM_TOKEN_TTL_SECONDS * 1000;
		expect(await verifyRoomToken({ ROOM_TOKEN_KEY: KEY }, token, { now: exp - 1 })).toMatchObject({ ok: true });
		expect(await verifyRoomToken({ ROOM_TOKEN_KEY: KEY }, token, { now: exp })).toEqual({ ok: false, reason: 'expired' });
	});

	it('rejects a tampered payload, signature, prefix and truncation', async () => {
		const env = { ROOM_TOKEN_KEY: KEY };
		const { token } = await mintRoomToken(env, claims, { now: NOW });
		const [prefix, payload, signature] = token.split('.');
		// Swap in claims for another workspace and a higher access, keeping the original signature.
		const forged: RoomTokenPayload = { ...claims, workspaceId: 'ws2', exp: NOW / 1000 + 600 };
		const forgedPayload = btoa(JSON.stringify(forged)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
		const bad = [
			`${prefix}.${forgedPayload}.${signature}`,
			`${prefix}.${payload}.${flipped}`,
			`${prefix}.${payload}`,
			`${prefix}.${payload}.${signature}.x`,
			`rt2.${payload}.${signature}`,
			'',
			'not a token',
			`${prefix}.${payload}.${signature.slice(0, -4)}`
		];
		for (const candidate of bad) {
			const result = await verifyRoomToken(env, candidate, { now: NOW });
			expect(result.ok, candidate).toBe(false);
		}
		expect(await verifyRoomToken(env, `${prefix}.${forgedPayload}.${signature}`, { now: NOW })).toEqual({
			ok: false,
			reason: 'bad-signature'
		});
		expect(await verifyRoomToken(env, null)).toEqual({ ok: false, reason: 'malformed' });
	});

	it('refuses a token signed by another key', async () => {
		const { token } = await mintRoomToken({ ROOM_TOKEN_KEY: OLD }, claims, { now: NOW });
		expect(await verifyRoomToken({ ROOM_TOKEN_KEY: KEY }, token, { now: NOW })).toEqual({
			ok: false,
			reason: 'bad-signature'
		});
	});

	it('rotates keys with a two-key overlap: current or previous verifies, only current signs', async () => {
		const oldToken = (await mintRoomToken({ ROOM_TOKEN_KEY: OLD }, claims, { now: NOW })).token;
		const rotated = { ROOM_TOKEN_KEY: KEY, ROOM_TOKEN_KEY_PREVIOUS: OLD };
		// A token minted before the rotation still works, and says so.
		expect(await verifyRoomToken(rotated, oldToken, { now: NOW })).toMatchObject({ ok: true, usedPreviousKey: true });
		// New tokens are signed with the current key: they verify with the current key alone.
		const fresh = (await mintRoomToken(rotated, claims, { now: NOW })).token;
		expect(await verifyRoomToken({ ROOM_TOKEN_KEY: KEY }, fresh, { now: NOW })).toMatchObject({
			ok: true,
			usedPreviousKey: false
		});
		expect(await verifyRoomToken({ ROOM_TOKEN_KEY: OLD }, fresh, { now: NOW })).toMatchObject({ ok: false });
		// Once the previous key is dropped, the old token dies.
		expect(await verifyRoomToken({ ROOM_TOKEN_KEY: KEY }, oldToken, { now: NOW })).toEqual({
			ok: false,
			reason: 'bad-signature'
		});
	});

	it('fails closed without a usable key', async () => {
		const { token } = await mintRoomToken({ ROOM_TOKEN_KEY: KEY }, claims, { now: NOW });
		expect(await verifyRoomToken({}, token, { now: NOW })).toEqual({ ok: false, reason: 'no-key' });
		expect(await verifyRoomToken({ ROOM_TOKEN_KEY: 'short' }, token, { now: NOW })).toEqual({ ok: false, reason: 'no-key' });
		await expect(mintRoomToken({}, claims)).rejects.toThrow(/key/);
		await expect(mintRoomToken({ ROOM_TOKEN_KEY: 'short' }, claims)).rejects.toThrow(/key/);
	});

	it('refuses invalid claims when signing and a signed-but-invalid payload when verifying', async () => {
		await expect(mintRoomToken({ ROOM_TOKEN_KEY: KEY }, { ...claims, access: 'owner' as never })).rejects.toThrow();
		await expect(mintRoomToken({ ROOM_TOKEN_KEY: KEY }, { ...claims, workspaceId: 'a:b' })).rejects.toThrow();
		await expect(mintRoomToken({ ROOM_TOKEN_KEY: KEY }, { ...claims, userId: '' })).rejects.toThrow();
		// A payload with a valid signature but bad claims (a signer bug) is rejected, not trusted.
		const body = btoa(JSON.stringify({ ...claims, access: 'admin', exp: NOW / 1000 + 600 }))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`rt1.${body}`)));
		const sigText = btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		expect(await verifyRoomToken({ ROOM_TOKEN_KEY: KEY }, `rt1.${body}.${sigText}`, { now: NOW })).toEqual({
			ok: false,
			reason: 'bad-claims'
		});
		// signRoomToken itself is exported for rotation tests and tooling.
		expect(await signRoomToken(KEY, { ...claims, exp: NOW / 1000 + 5 })).toMatch(/^rt1\./);
	});
});

describe('room names', () => {
	it('names rooms workspaceId:pageId and parses them back', () => {
		expect(roomName('ws1', 'pg1')).toBe('ws1:pg1');
		expect(parseRoomName('ws1:pg1')).toEqual({ workspaceId: 'ws1', pageId: 'pg1' });
		expect(parseRoomName('pg1')).toBeNull();
		expect(parseRoomName('a:b:c')).toBeNull();
		expect(parseRoomName(undefined)).toBeNull();
		expect(() => roomName('w:s', 'pg')).toThrow();
		expect(() => roomName('ws', '')).toThrow();
	});
});
