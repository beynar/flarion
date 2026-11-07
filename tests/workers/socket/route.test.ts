import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { expect, test } from 'vitest';
import {
	allowedOrigins,
	devActor,
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
import { ORIGIN, upgradeRequest, workspaceStub } from './helpers';

const ctx = { waitUntil() {}, passThroughOnException() {} };

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
		ctx
	);
	expect(post?.status).toBe(426);
});

test('no session is refused with 401, and a malformed workspace id with 400', async () => {
	// No dev actor and no session cookie: resolveSession finds nobody.
	const noActor = await upgradeRequest('route-auth', { 'x-flarion-dev-actor': '' });
	expect(noActor.status).toBe(401);
	const badId = await upgradeRequest('bad%20id');
	expect(badId.status).toBe(400);
});

test('the dev actor header never authenticates outside test and development', async () => {
	const production = { ...(env as unknown as Env), ENVIRONMENT: 'production', APP_ORIGIN: ORIGIN } as unknown as Env;
	const response = await handleWorkspaceSocket(
		new Request('http://example.com/ws/route-prod', {
			headers: { Upgrade: 'websocket', Origin: ORIGIN, 'x-flarion-dev-actor': 'user-1' }
		}),
		production,
		ctx
	);
	expect(response?.status).toBe(401);
	expect(devActor(new Request('https://x/ws/a', { headers: { 'x-flarion-dev-actor': 'u' } }), { ENVIRONMENT: 'staging' } as never, 'a')).toBeNull();
	expect(
		devActor(
			new Request('https://x/ws/a', { headers: { 'x-flarion-dev-actor': 'u', 'x-flarion-dev-role': 'guest', 'x-flarion-dev-name': 'Una' } }),
			{ ENVIRONMENT: 'development' } as never,
			'a'
		)
	).toEqual({ userId: 'u', sessionId: 'dev-u', workspaceId: 'a', role: 'guest', name: 'Una' });
});

test('a client cannot forward its own actor header to the object', async () => {
	const response = await upgradeRequest('route-spoof', {
		[ACTOR_HEADER]: encodeActorHeader({ userId: 'admin', role: 'owner' })
	});
	expect(response.status).toBe(101);
	response.webSocket?.accept();
	const attached = await runInDurableObject(workspaceStub('route-spoof'), (_i, state) =>
		state.getWebSockets().map((ws) => ws.deserializeAttachment())
	);
	expect(attached).toHaveLength(1);
	expect(attached[0].actor).toMatchObject({ userId: 'user-1', role: 'member', workspaceId: 'route-spoof' });
	response.webSocket?.close();
});

test('the object only ever sees the actor the route resolved: role and name come from the seam', async () => {
	const response = await upgradeRequest('route-role', { 'x-flarion-dev-role': 'admin', 'x-flarion-dev-name': 'Ada' });
	response.webSocket?.accept();
	const attached = await runInDurableObject(workspaceStub('route-role'), (_i, state) =>
		state.getWebSockets().map((ws) => ws.deserializeAttachment())
	);
	expect(attached[0].actor).toEqual({ userId: 'user-1', sessionId: 'dev-user-1', workspaceId: 'route-role', role: 'admin', name: 'Ada' });
	response.webSocket?.close();
});

test('origin rules per environment', () => {
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
});

test('an oversized attachment is rejected, at the 2,048 byte boundary', async () => {
	// Size of { socketId: <uuid>, actor } as stored: pad the actor's name to hit an exact byte count.
	const attachmentFor = (len: number) => ({
		socketId: crypto.randomUUID(),
		actor: devActor(
			new Request('https://x/ws/route-limit', { headers: { 'x-flarion-dev-actor': 'user-1', 'x-flarion-dev-name': 'x'.repeat(len) } }),
			{ ENVIRONMENT: 'test' } as never,
			'route-limit'
		)
	});
	// (An empty name falls back to the user id, so measure from one character.)
	const fits = 1 + MAX_ATTACHMENT_BYTES - attachmentSize(attachmentFor(1));
	expect(attachmentSize(attachmentFor(fits))).toBe(MAX_ATTACHMENT_BYTES);
	expect(() => assertAttachmentSize(attachmentFor(fits))).not.toThrow();
	expect(() => assertAttachmentSize(attachmentFor(fits + 1))).toThrow(AttachmentTooLargeError);

	// Through the Worker route: the object answers 413 and no socket is accepted.
	const tooBig = await upgradeRequest('route-big-1', { 'x-flarion-dev-name': 'x'.repeat(fits + 1) });
	expect(tooBig.status).toBe(413);
	expect(tooBig.webSocket).toBeNull();
	// Under the limit (the JSON byte count is a safe bound of workerd's own), the socket is accepted.
	const atLimit = await upgradeRequest('route-limit', { 'x-flarion-dev-name': 'x'.repeat(fits - 80) });
	expect(atLimit.status).toBe(101);
	atLimit.webSocket?.accept();
	atLimit.webSocket?.close();
});
