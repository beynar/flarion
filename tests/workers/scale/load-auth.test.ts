/** The load-test auth (`src/server/auth/load-test-auth.ts`): refused everywhere but staging, and what it mints works. */
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { handleLoadTest } from '../../../src/server/auth/load-test-auth';
import { handleRpc } from '../../../src/server/http/rpc-route';
import { handleWorkspaceSocket } from '../../../src/server/http/workspace-socket-route';

const KEY = 'load-test-key-for-the-tests-0123456789';
const base = env as unknown as Env;
const staging = { ...base, ENVIRONMENT: 'staging', LOAD_TEST_KEY: KEY } as unknown as Env;

const ctx = {
	pending: [] as Promise<unknown>[],
	waitUntil(p: Promise<unknown>) {
		this.pending.push(p.catch(() => undefined));
	},
	passThroughOnException() {}
};
const exec = ctx as unknown as ExecutionContext;

const call = (e: Env, route: string, body: unknown, key: string | null = KEY, host = 'flarion-staging.beynar.workers.dev') =>
	handleLoadTest(
		new Request(`https://${host}/api/load-test/${route}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'x-load-test-key': key }) },
			body: JSON.stringify(body)
		}),
		e,
		exec
	);

const runId = () => `t${crypto.randomUUID().slice(0, 8)}`;

describe('refusals answer 404 and mint nothing', () => {
	for (const environment of ['test', 'production', 'development', 'preview']) {
		test(`ENVIRONMENT=${environment}, correct key`, async () => {
			const id = runId();
			const e = { ...base, ENVIRONMENT: environment, LOAD_TEST_KEY: KEY } as unknown as Env;
			// "development" is allowed from a loopback host only: a staging-looking host must still be refused.
			const res = await call(e, 'users', { runId: id, count: 1 });
			expect(res.status).toBe(404);
			const rows = await base.DB.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "email" LIKE ?1`).bind(`load-${id}-%`).first<{ n: number }>();
			expect(rows?.n).toBe(0);
		});
	}

	test('production refuses even from localhost with a valid key', async () => {
		const e = { ...base, ENVIRONMENT: 'production', LOAD_TEST_KEY: KEY } as unknown as Env;
		expect((await call(e, 'users', { runId: runId(), count: 1 }, KEY, 'localhost')).status).toBe(404);
		expect((await call(e, 'cleanup', { runId: runId() }, KEY, 'localhost')).status).toBe(404);
		expect((await call(e, 'workspace', { ownerId: 'x' }, KEY, 'localhost')).status).toBe(404);
	});

	test('staging without the secret set, or with a short one', async () => {
		expect((await call({ ...base, ENVIRONMENT: 'staging' } as unknown as Env, 'users', { runId: runId(), count: 1 })).status).toBe(404);
		expect((await call({ ...base, ENVIRONMENT: 'staging', LOAD_TEST_KEY: 'short' } as unknown as Env, 'users', { runId: runId(), count: 1 }, 'short')).status).toBe(404);
	});

	test('staging with a missing or wrong key header', async () => {
		expect((await call(staging, 'users', { runId: runId(), count: 1 }, null)).status).toBe(404);
		expect((await call(staging, 'users', { runId: runId(), count: 1 }, `${KEY}x`)).status).toBe(404);
		expect((await call(staging, 'users', { runId: runId(), count: 1 }, '')).status).toBe(404);
	});

	test('development is honoured on loopback only', async () => {
		const dev = { ...base, ENVIRONMENT: 'development', LOAD_TEST_KEY: KEY } as unknown as Env;
		expect((await call(dev, 'users', { runId: runId(), count: 1 }, KEY, 'flarion.example.com')).status).toBe(404);
	});

	test('staging: GET and unknown routes are 404', async () => {
		const get = await handleLoadTest(new Request('https://x.workers.dev/api/load-test/users', { headers: { 'x-load-test-key': KEY } }), staging, exec);
		expect(get.status).toBe(404);
		expect((await call(staging, 'nope', {})).status).toBe(404);
	});
});

describe('accepted in staging', () => {
	test('validates input', async () => {
		expect((await call(staging, 'users', { runId: 'Bad Id!', count: 1 })).status).toBe(400);
		expect((await call(staging, 'users', { runId: runId(), count: 201 })).status).toBe(400);
		expect((await call(staging, 'users', { runId: runId(), count: 0 })).status).toBe(400);
	});

	test('mints users, a workspace and members whose cookies pass /rpc and /ws, then cleans up', { timeout: 60_000 }, async () => {
		const id = runId();
		const minted = (await (await call(staging, 'users', { runId: id, count: 3 })).json()) as { users: { userId: string; email: string; cookie: string }[] };
		expect(minted.users).toHaveLength(3);
		expect(minted.users[0].email).toBe(`load-${id}-1@load.invalid`);
		const [owner, member] = minted.users;

		// Distinct users on a second call do not collide when an offset is given.
		const more = (await (await call(staging, 'users', { runId: id, count: 1, offset: 3 })).json()) as { users: { email: string }[] };
		expect(more.users[0].email).toBe(`load-${id}-4@load.invalid`);

		const made = await call(staging, 'workspace', { ownerId: owner.userId, memberIds: [member.userId, minted.users[2].userId], name: 'Load test ws' });
		expect(made.status).toBe(200);
		const ws = (await made.json()) as { workspaceId: string; members: number };
		expect(ws.members).toBe(2);

		const origin = base.APP_ORIGIN;
		const rpc = (cookie: string, path: string, body: unknown = {}, workspaceId?: string) =>
			handleRpc(
				new Request(`${origin}/rpc/${path}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin, 'x-csrf-token': 'orpc', cookie, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
					body: JSON.stringify({ json: body })
				}),
				base,
				exec
			) as Promise<Response>;
		const me = await rpc(owner.cookie, 'me');
		expect(me.status).toBe(200);
		expect(JSON.stringify(await me.json())).toContain(ws.workspaceId);
		const asMember = await rpc(member.cookie, 'workspace/members/list', {}, ws.workspaceId);
		expect(asMember.status).toBe(200);
		expect((await rpc('', 'me')).status).toBe(401);

		// A socket upgrade through the real route, authenticated by the minted cookie alone.
		const upgrade = await handleWorkspaceSocket(
			new Request(`https://example.com/ws/${ws.workspaceId}?v=0.0.1`, { headers: { Upgrade: 'websocket', Origin: origin, cookie: member.cookie } }),
			base,
			exec
		);
		expect(upgrade?.status).toBe(101);
		upgrade?.webSocket?.accept();
		upgrade?.webSocket?.close(1000, 'done');
		const anonymous = await handleWorkspaceSocket(
			new Request(`https://example.com/ws/${ws.workspaceId}`, { headers: { Upgrade: 'websocket', Origin: origin } }),
			base,
			exec
		);
		expect(anonymous?.status).toBe(401);

		const gone = await call(staging, 'cleanup', { runId: id });
		expect(gone.status).toBe(200);
		expect(await gone.json()).toMatchObject({ workspaces: 1, users: 4 });
		const left = await base.DB.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "email" LIKE ?1`).bind(`load-${id}-%`).first<{ n: number }>();
		expect(left?.n).toBe(0);
		expect((await rpc(owner.cookie, 'me')).status).toBe(401);
	});
});
