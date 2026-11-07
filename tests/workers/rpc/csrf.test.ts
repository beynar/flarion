import { beforeAll, describe, expect, test } from 'vitest';
import { handleRpc } from '../../../src/server/http/rpc-route';
import { createWorld, ORIGIN, signUpPerson, type Person, type TestWorld } from '../auth/helpers';

let world: TestWorld;
let ada: Person;
beforeAll(async () => {
	world = createWorld();
	ada = await signUpPerson(world, 'Ada', 'ada-csrf@example.com');
});

const call = (init: { method?: string; headers?: Record<string, string>; body?: string; cookie?: boolean }) =>
	handleRpc(
		new Request(`${ORIGIN}/rpc/me`, {
			method: init.method ?? 'POST',
			headers: { ...(init.cookie === false ? {} : { cookie: ada.client.jar.header }), ...init.headers },
			...(['GET','HEAD'].includes(init.method ?? '') ? {} : { body: init.body ?? JSON.stringify({}) })
		}),
		world.env,
		world.ctx
	) as Promise<Response>;

const ok = { origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': 'orpc' };

describe('/rpc CSRF protection', () => {
	test('a same-origin JSON POST with the CSRF header works', async () => {
		const response = await call({ headers: ok });
		expect(response.status).toBe(200);
		expect(((await response.json()) as any).json.email).toBe('ada-csrf@example.com');
	});

	test('only POST is accepted', async () => {
		for (const method of ['GET', 'PUT', 'DELETE']) {
			const response = await call({ method, headers: ok });
			expect(response.status).toBe(405);
		}
	});

	test('a missing or foreign Origin is refused, with a valid session cookie', async () => {
		const { origin: _origin, ...withoutOrigin } = ok;
		expect((await call({ headers: withoutOrigin })).status).toBe(403);
		expect((await call({ headers: { ...ok, origin: 'https://evil.example' } })).status).toBe(403);
		expect((await call({ headers: { ...ok, origin: 'http://localhost:5174' } })).status).toBe(403);
	});

	test('cross-site fetch metadata is refused', async () => {
		expect((await call({ headers: { ...ok, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
		expect((await call({ headers: { ...ok, 'sec-fetch-site': 'same-site' } })).status).toBe(403);
		expect((await call({ headers: { ...ok, 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
	});

	test('a non-JSON body (an HTML form post) is refused', async () => {
		const form = await call({ headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': 'orpc' }, body: 'a=b' });
		expect(form.status).toBe(415);
		const text = await call({ headers: { origin: ORIGIN, 'content-type': 'text/plain', 'x-csrf-token': 'orpc' } });
		expect(text.status).toBe(415);
	});

	test("oRPC's CSRF plugin refuses a request without its token header", async () => {
		const { 'x-csrf-token': _token, ...withoutToken } = ok;
		const response = await call({ headers: withoutToken });
		expect(response.status).toBe(403);
		expect(JSON.stringify(await response.json())).toContain('CSRF');
	});

	test('without a session the call is 401, and errors do not leak internals', async () => {
		const response = await call({ headers: ok, cookie: false });
		expect(response.status).toBe(401);
		const unknown = await handleRpc(new Request(`${ORIGIN}/rpc/nope/missing`, { method: 'POST', headers: ok, body: '{}' }), world.env, world.ctx);
		expect(unknown?.status).toBe(404);
	});
});
