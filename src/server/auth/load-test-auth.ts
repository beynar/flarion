/**
 * Load-test authentication (docs/ops/load-test.md): lets `scripts/load` create synthetic users, sessions and a
 * workspace without the passkey UI, so a few hundred sockets can be opened against staging.
 *
 * It is a standing hole in authentication, so it is shut by default and impossible in production:
 *   - the route exists only when {@link loadTestAuthEnabled} says so: `ENVIRONMENT` is `staging` and the Worker
 *     secret `LOAD_TEST_KEY` is set (24 characters or more). Local smoke runs are the one other case:
 *     `ENVIRONMENT` is `development`, `LOAD_TEST_KEY` is set in `.dev.vars` and the request addresses
 *     localhost, 127.0.0.1 or [::1]. `production` and `test` never qualify, whatever the secret;
 *   - every request must carry `x-load-test-key`, compared in constant time;
 *   - anything else answers a plain 404, the same as a path that does not exist.
 *
 * Endpoints (all `POST`, JSON):
 *   /api/load-test/users      { runId, count }                  -> { users: [{ userId, name, email, cookie }] }
 *   /api/load-test/workspace  { ownerId, memberIds?, name? }    -> { workspaceId, slug, members }
 *   /api/load-test/cleanup    { runId, workspaceIds? }          -> { workspaces, users }
 *
 * Synthetic users are `load-<runId>-<n>@load.invalid`: the reserved `.invalid` domain can never receive mail and
 * the prefix tells the cleanup which rows are ours.
 */
import { getAuth } from './auth';
import { createDirectoryClient } from '../db/global.client';
import { ensureDevSchema } from '../db/dev-migrate';
import { LOAD_TEST_KEY_HEADER, loadTestAuthEnabled, LOAD_TEST_PREFIX, safeEqual, type LoadTestEnv } from './load-test-guard';
import { outboxInsert } from './outbox';
import { createWorkspace, deliver, type Services } from './workspaces';
import { locationHintFor, parseLocationHint } from '../objects/workspace/location';
import type { Ctx } from '../http/types';

export { LOAD_TEST_PREFIX, loadTestAuthEnabled };
/** Users minted by one call. */
export const MAX_USERS_PER_CALL = 200;
const MAX_MEMBERS = 500;
const RUN_ID = /^[a-z0-9][a-z0-9-]{3,39}$/;

const notFound = () => Response.json({ message: 'Not found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const bad = (message: string) => json({ message }, 400);

/** `value.signature`, URL-encoded: how better-auth signs a cookie (HMAC-SHA-256, base64). */
async function signCookie(value: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
	let binary = '';
	for (const byte of mac) binary += String.fromCharCode(byte);
	return encodeURIComponent(`${value}.${btoa(binary)}`);
}

/** Runs `fn` over `items`, `size` at a time. */
async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(...(await Promise.all(items.slice(i, i + size).map((item, j) => fn(item, i + j)))));
	}
	return out;
}

/**
 * What a signed-in browser holds: the session token and the short-lived `session_data` cookie cache better-auth sets on its
 * first `get-session`. With the cache, `/rpc` and `/ws` verify a signature instead of reading D1 (docs/PLAN.md "D1 unavailable:
 * existing sessions keep working from the cookie cache"), so the load test measures the path real tabs take. Without it
 * (better-auth refusing, say) the token alone still works, through D1.
 */
async function withCookieCache(env: Env, tokenCookie: string): Promise<string> {
	try {
		const res = await getAuth(env).api.getSession({ headers: new Headers({ cookie: tokenCookie }), returnHeaders: true });
		const cache = res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.filter((c) => /session_data/.test(c.split('=')[0]));
		return [tokenCookie, ...cache].join('; ');
	} catch {
		return tokenCookie;
	}
}

async function mintUsers(env: Env, body: { runId?: unknown; count?: unknown; offset?: unknown }): Promise<Response> {
	const runId = String(body.runId ?? '');
	const count = Number(body.count ?? 1);
	const offset = Number(body.offset ?? 0);
	if (!RUN_ID.test(runId)) return bad('runId must be 4 to 40 characters of a-z, 0-9 and "-"');
	if (!Number.isInteger(count) || count < 1 || count > MAX_USERS_PER_CALL) return bad(`count must be 1 to ${MAX_USERS_PER_CALL}`);
	if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) return bad('offset is out of range');
	const auth = await getAuth(env).$context;
	const cookieName = auth.authCookies.sessionToken.name;
	const indexes = Array.from({ length: count }, (_, i) => offset + i + 1);
	const users = await inBatches(indexes, 10, async (n) => {
		const email = `load-${runId}-${n}@load.invalid`;
		const user = await auth.internalAdapter.createUser({ name: `Load ${n}`, email, emailVerified: true }, { method: 'load-test' });
		const session = await auth.internalAdapter.createSession(user.id);
		const token = `${cookieName}=${await signCookie(session.token, auth.secret)}`;
		return { userId: user.id, name: user.name, email, cookie: await withCookieCache(env, token) };
	});
	return json({ users });
}

async function makeWorkspace(env: Env, ctx: Ctx, request: Request, body: { ownerId?: unknown; memberIds?: unknown; name?: unknown; locationHint?: unknown }): Promise<Response> {
	const ownerId = String(body.ownerId ?? '');
	const memberIds = Array.isArray(body.memberIds) ? body.memberIds.map(String) : [];
	const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'Load test';
	if (!ownerId) return bad('ownerId is required');
	if (memberIds.length > MAX_MEMBERS) return bad(`at most ${MAX_MEMBERS} members`);
	const db = createDirectoryClient(env.DB, ownerId);
	const owner = await db.user.findFirst({ where: { id: ownerId } });
	if (!owner || !owner.email.endsWith('@load.invalid')) return bad('ownerId is not a synthetic user');
	// Placement (docs/ops/load-test.md "Placement"): the object is created near where the tabs come from. The tabs of an inside run are
	// opened by Workers that answer a request from this same client, so the continent of this request is theirs; `locationHint` in the body
	// (`--hint`) overrides it, to run the same scenario against another region. The hint travels the way a real creator's does: the `init`
	// outbox job, which `createWorkspace` fills from `services.request.cf`.
	const cf = (request as { cf?: { continent?: string; country?: string; longitude?: string } }).cf;
	const forced = parseLocationHint(body.locationHint);
	if (body.locationHint !== undefined && !forced) return bad('locationHint must be one of wnam, enam, sam, weur, eeur, apac, oc, afr, me');
	const hint = forced ?? locationHintFor(cf);
	const services: Services = { env, ctx, request };
	// The real create path: D1 rows, the `init` outbox job and the Workspace DO's first commit.
	const workspace = await createWorkspace(services, { userId: owner.id, sessionId: 'load-test', name: owner.name, email: owner.email, emailVerified: true }, { name }, forced);
	const joined = await inBatches(memberIds, 10, async (userId) => {
		const user = await db.user.findFirst({ where: { id: userId } });
		if (!user || !user.email.endsWith('@load.invalid') || userId === ownerId) return false;
		const outbox = outboxInsert(db, workspace.id, { kind: 'syncMember', payload: { userId, role: 'member', name: user.name } });
		await db.$transaction([
			db.membership.create({ data: { id: crypto.randomUUID(), workspaceId: workspace.id, userId, role: 'member', joinedAt: new Date() } }),
			outbox.operation
		]);
		await deliver(services, [outbox.id]);
		return true;
	});
	return json({ workspaceId: workspace.id, slug: workspace.slug, members: joined.filter(Boolean).length, locationHint: hint ?? null, hintFrom: forced ? 'flag' : hint ? `request.cf (${cf?.continent ?? '?'}/${cf?.country ?? '?'})` : 'none' });
}

/** Whether a synthetic user belongs to the workspace: the routes that speak to an object on the caller's word only touch those. */
export async function isLoadTestWorkspace(env: Env, workspaceId: string): Promise<boolean> {
	const owned = await env.DB.prepare(`SELECT 1 AS ok FROM "membership" m JOIN "user" u ON u."id" = m."userId" WHERE m."workspaceId" = ?1 AND u."email" LIKE 'load-%@load.invalid' LIMIT 1`).bind(workspaceId).first();
	return !!owned;
}

/** Removes a run's workspaces (Workspace DO storage wiped, D1 rows deleted for good) and its synthetic users. */
async function cleanup(env: Env, body: { runId?: unknown; workspaceIds?: unknown }): Promise<Response> {
	const runId = String(body.runId ?? '');
	if (!RUN_ID.test(runId)) return bad('runId must be 4 to 40 characters of a-z, 0-9 and "-"');
	const pattern = `load-${runId}-%@load.invalid`;
	// Only workspaces owned by this run's users are touched, whatever ids the caller sends.
	const owned = await env.DB.prepare(
		`SELECT DISTINCT m."workspaceId" AS id FROM "membership" m JOIN "user" u ON u."id" = m."userId" WHERE u."email" LIKE ?1`
	)
		.bind(pattern)
		.all<{ id: string }>();
	const wanted = new Set(Array.isArray(body.workspaceIds) ? body.workspaceIds.map(String) : owned.results.map((r) => r.id));
	const workspaceIds = owned.results.map((r) => r.id).filter((id) => wanted.has(id));
	for (const id of workspaceIds) {
		try {
			await (env.WORKSPACE.getByName(id) as unknown as { destroy(): Promise<void> }).destroy();
		} catch (error) {
			console.warn(`[load-test] destroying ${id} failed:`, error instanceof Error ? error.message : error);
		}
	}
	for (const id of workspaceIds) {
		// Two statements, not a batch: Distilled's D1 proxy cannot batch in `pnpm dev`.
		await env.DB.prepare(`DELETE FROM "outbox" WHERE "workspaceId" = ?1`).bind(id).run();
		await env.DB.prepare(`DELETE FROM "workspace" WHERE "id" = ?1`).bind(id).run();
	}
	// Sessions, accounts and memberships go with the user (foreign keys cascade).
	const users = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "email" LIKE ?1`).bind(pattern).first<{ n: number }>();
	await env.DB.prepare(`DELETE FROM "user" WHERE "email" LIKE ?1`).bind(pattern).run();
	return json({ workspaces: workspaceIds.length, users: users?.n ?? 0 });
}

/** `/api/load-test/*`. Answers 404 unless the endpoint is enabled for this environment and the key matches. */
export async function handleLoadTest(request: Request, env: Env, ctx: Ctx): Promise<Response> {
	const url = new URL(request.url);
	const route = url.pathname.slice(LOAD_TEST_PREFIX.length);
	if (!loadTestAuthEnabled(env as unknown as LoadTestEnv, url.hostname)) return notFound();
	const key = request.headers.get(LOAD_TEST_KEY_HEADER);
	if (!key || !safeEqual(key, (env as unknown as LoadTestEnv).LOAD_TEST_KEY as string)) return notFound();
	if (request.method !== 'POST' || !['users', 'workspace', 'cleanup', 'inside'].includes(route)) return notFound();
	let body: Record<string, unknown>;
	try {
		body = ((await request.json()) ?? {}) as Record<string, unknown>;
	} catch {
		return bad('JSON body expected');
	}
	try {
		await ensureDevSchema(env);
		if (route === 'users') return await mintUsers(env, body);
		if (route === 'workspace') return await makeWorkspace(env, ctx, request, body);
		if (route === 'inside') {
			if (!(await isLoadTestWorkspace(env, String(body.workspaceId ?? '')))) return bad('not a load-test workspace');
			return (await import('./load-test-inside')).runInside(env, body as never);
		}
		return await cleanup(env, body);
	} catch (error) {
		console.error('[load-test] failed:', error instanceof Error ? (error.stack ?? error.message) : error);
		return json({ message: 'load-test endpoint failed', detail: error instanceof Error ? error.message : String(error) }, 500);
	}
}
