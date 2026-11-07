import { runInDurableObject, SELF } from 'cloudflare:test';
import { expect, test } from 'vitest';
import {
	allowedOrigins,
	authenticateUpgrade,
	handleWorkspaceSocket,
	isOriginAllowed
} from '../../../src/server/http/workspace-socket-route';
import {
	ACTOR_HEADER,
	assertAttachmentSize,
	AttachmentTooLargeError,
	attachmentSize,
	encodeActorHeader,
	MAX_ATTACHMENT_BYTES
} from '../../../src/server/objects/workspace/socket';
import { env } from 'cloudflare:test';
import { ORIGIN, upgradeRequest, workspaceStub } from './helpers';

test('a valid upgrade is accepted with 101', async () => {
	const response = await upgradeRequest('route-ok');
	expect(response.status).toBe(101);
	response.webSocket?.accept();
	response.webSocket?.close();
});

test('a bad Origin is refused with 403', async () => {
	const response = await upgradeRequest('route-origin', { Origin: 'https://evil.example' });
	expect(response.status).toBe(403);
	expect(response.webSocket).toBeNull();
});

test('a non-upgrade request is refused with 426', async () => {
	const plain = await SELF.fetch('http://example.com/ws/route-plain', {
		headers: { Origin: ORIGIN, 'x-flarion-dev-actor': 'user-1' }
	});
	expect(plain.status).toBe(426);
	// The test pool's fetch rewrites the method of upgrade requests, so call the route directly.
	const post = await handleWorkspaceSocket(
		new Request('http://example.com/ws/route-plain', {
			method: 'POST',
			headers: { Upgrade: 'websocket', Origin: ORIGIN, 'x-flarion-dev-actor': 'user-1' }
		}),
		env as unknown as Env,
		{ waitUntil() {}, passThroughOnException() {} }
	);
	expect(post?.status).toBe(426);
});

test('no session is refused with 401, and a malformed workspace id with 400', async () => {
	const noActor = await upgradeRequest('route-auth', { 'x-flarion-dev-actor': '' });
	expect(noActor.status).toBe(401);
	const badId = await upgradeRequest('bad%20id');
	expect(badId.status).toBe(400);
});

test('a client cannot forward its own actor header to the object', async () => {
	const response = await upgradeRequest('route-spoof', { [ACTOR_HEADER]: encodeActorHeader({ userId: 'admin' }) });
	expect(response.status).toBe(101);
	response.webSocket?.accept();
	const attached = await runInDurableObject(workspaceStub('route-spoof'), (_i, state) =>
		state.getWebSockets().map((ws) => ws.deserializeAttachment())
	);
	expect(attached).toHaveLength(1);
	expect(attached[0].actor).toEqual({ userId: 'user-1' });
	response.webSocket?.close();
});

test('origin and session rules per environment', async () => {
	const prod = { ENVIRONMENT: 'production', APP_ORIGIN: 'https://flarion.beynar.dev' } as const;
	const origin = (value: string | null) =>
		new Request('https://x/ws/a', value === null ? {} : { headers: { Origin: value } });
	expect(isOriginAllowed(origin('https://flarion.beynar.dev'), prod as never)).toBe(true);
	expect(isOriginAllowed(origin('https://flarion.beynar.dev.evil.example'), prod as never)).toBe(false);
	expect(isOriginAllowed(origin(null), prod as never)).toBe(false); // production requires an Origin
	expect(isOriginAllowed(origin(null), { ...prod, ENVIRONMENT: 'test' } as never)).toBe(true);
	expect(allowedOrigins({ APP_ORIGIN: 'https://a.example, https://b.example' } as never)).toEqual([
		'https://a.example',
		'https://b.example'
	]);
	// The dev header never authenticates outside test and development.
	const devRequest = new Request('https://x/ws/a', { headers: { 'x-flarion-dev-actor': 'user-1' } });
	expect(await authenticateUpgrade(devRequest, prod as never)).toBeNull();
	expect(await authenticateUpgrade(devRequest, { ENVIRONMENT: 'staging' } as never)).toBeNull();
	expect(await authenticateUpgrade(devRequest, { ENVIRONMENT: 'development' } as never)).toEqual({ userId: 'user-1' });
});

test('an oversized attachment is rejected, at the 2,048 byte boundary', async () => {
	// Size of { socketId: <uuid>, actor: { userId } } as stored: pad userId to hit an exact byte count.
	const sizeFor = (len: number) =>
		attachmentSize({ socketId: crypto.randomUUID(), actor: { userId: 'x'.repeat(len) } });
	const overhead = sizeFor(0);
	const fits = MAX_ATTACHMENT_BYTES - overhead;
	expect(sizeFor(fits)).toBe(MAX_ATTACHMENT_BYTES);
	expect(() => assertAttachmentSize({ socketId: 's', actor: { userId: 'x'.repeat(fits) } })).not.toThrow();
	expect(() => assertAttachmentSize({ socketId: 's', actor: { userId: 'x'.repeat(MAX_ATTACHMENT_BYTES) } })).toThrow(
		AttachmentTooLargeError
	);

	// Through the Worker route: the object answers 413 and no socket is accepted.
	const tooBig = await upgradeRequest('route-big', { 'x-flarion-dev-actor': 'x'.repeat(fits + 1) });
	expect(tooBig.status).toBe(413);
	expect(tooBig.webSocket).toBeNull();
	// Exactly at the limit, workerd accepts the attachment (the JSON byte count is a safe bound).
	const atLimit = await upgradeRequest('route-limit', { 'x-flarion-dev-actor': 'x'.repeat(fits - 37) });
	expect(atLimit.status).toBe(101);
	atLimit.webSocket?.accept();
	atLimit.webSocket?.close();
});
