/**
 * API tokens: shown once and stored hashed, scoped (an empty list grants nothing), expiring, revocable, rotated with a
 * two-key pepper overlap, logged per use, rate limited per token, and dead when their user leaves the workspace.
 */
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createDirectoryClient } from '../../../src/server/db/global.client';
import { hashToken, LAST_USED_GRANULARITY_MS, peppersOf, TOKEN_PREFIX } from '../../../src/server/auth/api-tokens';
import { api, addMember, createApiFixture, createFixture, issueToken, title } from './helpers';

vi.setConfig({ testTimeout: 40_000 });

describe('tokens.* (the settings tab\'s RPCs)', () => {
	it('shows the secret once, keeps only its hash, lists without the secret and revokes', async () => {
		const fx = await createFixture();
		const rpc = fx.ada.client.rpcWithWorkspace(fx.workspaceId);
		const created = await rpc.tokens.create({ name: 'CI', scopes: ['page.read', 'search'] });
		expect(created.token.startsWith(TOKEN_PREFIX)).toBe(true);
		expect(created.info).toMatchObject({ name: 'CI', scopes: ['page.read', 'search'], expiresAt: null, lastUsedAt: null, revokedAt: null });
		const listed = await rpc.tokens.list();
		expect(listed.map((t) => t.id)).toEqual([created.info.id]);
		expect(JSON.stringify(listed)).not.toContain(created.token);

		// D1 holds a keyed hash, never the secret.
		const row = await fx.world.env.DB.prepare('SELECT tokenHash FROM apiToken WHERE id = ?1').bind(created.info.id).first<{ tokenHash: string }>();
		expect(row!.tokenHash).toBe(await hashToken(peppersOf(fx.world.env)[0]!, created.token));
		expect(row!.tokenHash).not.toContain(created.token);

		await rpc.tokens.revoke({ id: created.info.id });
		expect((await rpc.tokens.list())[0]!.revokedAt).not.toBeNull();
		await rpc.tokens.revoke({ id: created.info.id }); // idempotent
		expect((await api(fx, '/users/me', { token: created.token })).status).toBe(401);
	});

	it('lists only the caller\'s own tokens, and another user\'s token does not exist for them', async () => {
		const fx = await createFixture();
		const bob = await addMember(fx, 'Bob', 'member');
		const mine = await issueToken(fx, fx.ada, ['page.read']);
		const bobs = bob.client.rpcWithWorkspace(fx.workspaceId);
		expect(await bobs.tokens.list()).toEqual([]);
		await expect(bobs.tokens.revoke({ id: mine.info.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('refuses an expiry in the past', async () => {
		const fx = await createFixture();
		await expect(issueToken(fx, fx.ada, ['page.read'], { expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
	});
});

describe('authentication and scopes', () => {
	it('answers 401 without a token, with a malformed one, and with an unknown one', async () => {
		const { fx } = await createApiFixture();
		expect((await api(fx, '/users/me')).status).toBe(401);
		expect((await api(fx, '/users/me', { token: 'nope' })).status).toBe(401);
		expect((await api(fx, '/users/me', { token: `${TOKEN_PREFIX}${'a'.repeat(43)}` })).status).toBe(401);
		const basic = await api(fx, '/users/me', { headers: { authorization: 'Basic abc' } });
		expect(basic.status).toBe(401);
	});

	it('an empty scope list grants nothing, and each endpoint needs its own scope', async () => {
		const fx = await createFixture();
		const none = (await issueToken(fx, fx.ada, [])).token;
		for (const [path, init] of [
			['/users/me', {}],
			[`/pages/${fx.pageId}`, {}],
			['/search', { body: { query: 'x' } }],
			[`/blocks/${fx.pageId}/children`, {}],
			[`/comments?block_id=${fx.pageId}`, {}]
		] as const) {
			const res = await api(fx, path, { token: none, ...init });
			expect(res.status, path).toBe(403);
		}
		const readOnly = (await issueToken(fx, fx.ada, ['page.read'])).token;
		expect((await api(fx, `/pages/${fx.pageId}`, { token: readOnly })).status).toBe(200);
		expect((await api(fx, `/pages/${fx.pageId}`, { token: readOnly, method: 'PATCH', body: { properties: { title: title('x') } } })).status).toBe(403);
		expect((await api(fx, '/pages', { token: readOnly, body: { parent: { type: 'workspace', workspace: true } } })).status).toBe(403);
		expect((await api(fx, `/pages/${fx.pageId}/trash`, { token: readOnly, method: 'POST' })).status).toBe(403);
	});

	it('stops at expiry and at revocation', async () => {
		const fx = await createFixture();
		const soon = await issueToken(fx, fx.ada, ['user.read'], { expiresAt: new Date(Date.now() + 60_000).toISOString() });
		expect((await api(fx, '/users/me', { token: soon.token })).status).toBe(200);
		await fx.world.env.DB.prepare('UPDATE apiToken SET expiresAt = ?1 WHERE id = ?2').bind(new Date(Date.now() - 1000).toISOString(), soon.info.id).run();
		expect((await api(fx, '/users/me', { token: soon.token })).status).toBe(401);
	});

	it('stamps lastUsedAt, at most once a minute', async () => {
		const fx = await createFixture();
		const t = await issueToken(fx, fx.ada, ['user.read']);
		const lastUsed = async () => (await fx.world.env.DB.prepare('SELECT lastUsedAt FROM apiToken WHERE id = ?1').bind(t.info.id).first<{ lastUsedAt: string | null }>())!.lastUsedAt;
		expect(await lastUsed()).toBeNull();
		await api(fx, '/users/me', { token: t.token });
		const first = await lastUsed();
		expect(first).not.toBeNull();
		await api(fx, '/users/me', { token: t.token });
		expect(await lastUsed()).toBe(first);
		expect(LAST_USED_GRANULARITY_MS).toBe(60_000);
		await fx.world.env.DB.prepare('UPDATE apiToken SET lastUsedAt = ?1 WHERE id = ?2').bind(new Date(Date.now() - 120_000).toISOString(), t.info.id).run();
		await api(fx, '/users/me', { token: t.token });
		expect(Date.parse((await lastUsed())!)).toBeGreaterThan(Date.now() - 10_000);
	});

	it('stops working when its user is removed from the workspace', async () => {
		const fx = await createFixture();
		const bob = await addMember(fx, 'Bob', 'member');
		const db = createDirectoryClient(fx.world.env.DB);
		await db.membership.create({ data: { id: crypto.randomUUID(), workspaceId: fx.workspaceId, userId: bob.userId, role: 'member', joinedAt: new Date() } });
		const token = (await issueToken(fx, bob, ['user.read'])).token;
		expect((await api(fx, '/users/me', { token })).status).toBe(200);
		await db.membership.deleteMany({ where: { workspaceId: fx.workspaceId, userId: bob.userId } });
		await fx.stub.syncMember({ userId: bob.userId, role: null });
		expect((await api(fx, '/users/me', { token })).status).toBe(401);
	});
});

describe('pepper rotation (two-key overlap)', () => {
	it('accepts a token hashed under the previous pepper, rehashes it, and refuses it once the previous key is gone', async () => {
		const fx = await createFixture();
		const old = fx.world.env as unknown as Record<string, unknown>;
		const token = (await issueToken(fx, fx.ada, ['user.read'])).token;
		const asEnv = (vars: Record<string, string | undefined>) => ({ ...old, ...vars }) as unknown as Env;
		const oldPepper = String(old.API_TOKEN_PEPPER);
		const rotated = asEnv({ API_TOKEN_PEPPER: 'a-brand-new-pepper-value', API_TOKEN_PEPPER_PREVIOUS: oldPepper });
		// Only the new pepper: the old token is unknown.
		expect((await api(fx, '/users/me', { token, env: asEnv({ API_TOKEN_PEPPER: 'a-brand-new-pepper-value', API_TOKEN_PEPPER_PREVIOUS: undefined }) })).status).toBe(401);
		// Overlap: it still works, and is rewritten under the new pepper.
		expect((await api(fx, '/users/me', { token, env: rotated })).status).toBe(200);
		const row = await fx.world.env.DB.prepare('SELECT tokenHash FROM apiToken WHERE userId = ?1').bind(fx.ada.userId).first<{ tokenHash: string }>();
		expect(row!.tokenHash).toBe(await hashToken('a-brand-new-pepper-value', token));
		// The previous pepper can now be dropped: the rehashed token keeps working.
		expect((await api(fx, '/users/me', { token, env: asEnv({ API_TOKEN_PEPPER: 'a-brand-new-pepper-value', API_TOKEN_PEPPER_PREVIOUS: undefined }) })).status).toBe(200);
	});
});

describe('rate limit and metrics', () => {
	it('answers 429 with Retry-After when the token\'s limiter says no, per token', async () => {
		const { fx, token, tokenId } = await createApiFixture();
		const seen: string[] = [];
		const limited = { ...(fx.world.env as unknown as Record<string, unknown>), RL_API: { limit: async ({ key }: { key: string }) => (seen.push(key), { success: false }) } } as unknown as Env;
		const res = await api(fx, '/users/me', { token, env: limited });
		expect(res.status).toBe(429);
		expect(res.body.code).toBe('RATE_LIMITED');
		expect(res.response.headers.get('retry-after')).toBe('60');
		expect(seen).toEqual([`token:${tokenId}`]);
	});

	it('writes one data point per request, naming the token and never its secret', async () => {
		const { fx, token, tokenId } = await createApiFixture();
		const points: AnalyticsEngineDataPoint[] = [];
		const traced = { ...(fx.world.env as unknown as Record<string, unknown>), METRICS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => void points.push(p) } } as unknown as Env;
		await api(fx, '/users/me', { token, env: traced });
		await api(fx, '/pages/does-not-exist', { token, env: traced });
		expect(points).toHaveLength(2);
		expect(points[0]).toMatchObject({ indexes: ['api'], blobs: [tokenId, 'GET users/me', '2xx'] });
		expect(points[1]).toMatchObject({ indexes: ['api'], blobs: [tokenId, 'GET pages/{id}', '4xx'], doubles: [expect.any(Number), 404] });
		expect(JSON.stringify(points)).not.toContain(token);
		void env;
	});
});
