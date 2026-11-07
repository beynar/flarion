import { beforeAll, describe, expect, test } from 'vitest';
import { createDirectoryClient, globalClient } from '../../../src/server/db/global.client';
import { handleShareData } from '../../../src/server/share/route';
import { reconcilePublicShares, resolveShare } from '../../../src/server/share';
import { NIGHTLY_CRON, scheduled } from '../../../src/server/scheduled';
import { createWorld, signUpPerson, verifyEmail, type Person, type TestWorld } from '../auth/helpers';

let world: TestWorld;
let ada: Person;
let workspace: { id: string; slug: string };

const PAGE = 'page-public';
let pageCounter = 0;
/** A fresh page per test, so links never collide. */
function newPage(title = 'Handbook', icon: string | null = '📘') {
	const id = `${PAGE}-${++pageCounter}`;
	world.workspaces.fakeGrants.addPage(workspace.id, id, title, icon);
	return id;
}

beforeAll(async () => {
	world = createWorld();
	ada = await signUpPerson(world, 'Ada', 'ada-public@example.com');
	await verifyEmail(world, ada);
	workspace = await ada.client.rpc.workspace.create({ name: 'Public Club' });
});

const owner = () => ada.client.rpcWithWorkspace(workspace.id);
const fake = () => world.workspaces.fakeGrants;
const doGrants = () => fake().grants.get(workspace.id) ?? [];
const routes = (pageId: string) => globalClient(world.env.DB).publicShare.findMany({ where: { pageId } });

describe('creating a public link', () => {
	test('the DO grant comes first and mints the token; the D1 route follows and the link resolves', async () => {
		const pageId = newPage();
		fake().calls.length = 0;
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		expect(grant).toMatchObject({ subjectKind: 'public', level: 'read', pageId, createdBy: ada.userId });
		expect(grant.token).toMatch(/^tok_/);
		expect(doGrants().find((g) => g.id === grant.id)?.token).toBe(grant.token);
		const [route] = await routes(pageId);
		expect(route).toMatchObject({ token: grant.token, workspaceId: workspace.id, pageId, createdBy: ada.userId, grantId: grant.id, revokedAt: null });
		expect(await resolveShare(world.env, grant.token!)).toEqual({ workspaceId: workspace.id, pageId, level: 'read' });
	});

	test('asking again returns the same link; only view access can be public', async () => {
		const pageId = newPage();
		const first = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		const second = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		expect(second.token).toBe(first.token);
		expect(await routes(pageId)).toHaveLength(1);
		await expect(owner().page.grants.set({ pageId: newPage(), subjectKind: 'public', subjectId: null, level: 'update' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
	});

	test('the list shows the link with its token', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		expect(await owner().page.grants.list({ id: pageId })).toContainEqual(expect.objectContaining({ id: grant.id, token: grant.token, subjectKind: 'public' }));
	});

	test('a failed route insert takes the DO grant back, so no grant is left without a route', async () => {
		const pageId = newPage();
		// A live route already owns the token the DO is about to mint: the partial unique index refuses the second.
		const taken = `tok_collision_${crypto.randomUUID().replace(/-/g, '')}`;
		await globalClient(world.env.DB).publicShare.create({
			data: { id: crypto.randomUUID(), token: taken, workspaceId: workspace.id, pageId: 'other', createdBy: ada.userId, createdAt: new Date() }
		});
		fake().nextToken = taken;
		await expect(owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' })).rejects.toBeTruthy();
		fake().nextToken = null;
		expect(doGrants().filter((g) => g.pageId === pageId)).toEqual([]);
		expect(await routes(pageId)).toEqual([]);
	});

	test('if taking the grant back fails too, the orphan grant is unreachable: no route, no resolution', async () => {
		const pageId = newPage();
		const taken = `tok_collision_${crypto.randomUUID().replace(/-/g, '')}`;
		await globalClient(world.env.DB).publicShare.create({
			data: { id: crypto.randomUUID(), token: taken, workspaceId: workspace.id, pageId: 'other-2', createdBy: ada.userId, createdAt: new Date() }
		});
		fake().nextToken = taken;
		fake().failRevoke = true;
		await expect(owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' })).rejects.toBeTruthy();
		fake().failRevoke = false;
		fake().nextToken = null;
		expect(doGrants().filter((g) => g.pageId === pageId)).toHaveLength(1); // the orphan
		expect(await routes(pageId)).toEqual([]);
		// The token belongs to the other route (which has no DO grant for `other-2`): nothing resolves.
		expect(await resolveShare(world.env, taken)).toBeNull();
	});

	test('the unique index ignores tombstones: a revoked token can be issued again, a live one cannot be duplicated', async () => {
		const db = globalClient(world.env.DB);
		const token = `tok_reuse_${crypto.randomUUID().replace(/-/g, '')}`;
		const row = (id: string, revokedAt: Date | null = null) => ({ id, token, workspaceId: workspace.id, pageId: 'x', createdBy: ada.userId, createdAt: new Date(), revokedAt });
		await db.publicShare.create({ data: row('a', new Date()) });
		await db.publicShare.create({ data: row('b') });
		await expect(db.publicShare.create({ data: row('c') })).rejects.toBeTruthy();
		await db.publicShare.updateMany({ where: { id: 'b' }, data: { revokedAt: new Date() } });
		await expect(db.publicShare.create({ data: row('d') })).resolves.toBeTruthy();
	});
});

describe('revoking a public link', () => {
	test('the D1 route is revoked first, then the DO grant', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		await expect(owner().page.grants.revoke({ grantId: grant.id })).resolves.toEqual({ seq: 7 });
		const [route] = await routes(pageId);
		expect(route!.revokedAt).toBeInstanceOf(Date);
		expect(route!.doRevokedAt).toBeInstanceOf(Date);
		expect(doGrants().find((g) => g.id === grant.id)).toBeUndefined();
		expect(await resolveShare(world.env, grant.token!)).toBeNull();
		// A new link for the page is a new token.
		const next = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		expect(next.token).not.toBe(grant.token);
	});

	test('a failure between the two steps: the link is already dead, and the reconcile removes the DO grant', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		fake().failRevoke = true;
		await expect(owner().page.grants.revoke({ grantId: grant.id })).resolves.toEqual({ seq: 0 });
		fake().failRevoke = false;

		const [route] = await routes(pageId);
		expect(route!.revokedAt).toBeInstanceOf(Date);
		expect(route!.doRevokedAt).toBeNull(); // drift: the DO grant is still there
		expect(doGrants().find((g) => g.id === grant.id)).toBeTruthy();
		expect(await resolveShare(world.env, grant.token!)).toBeNull(); // yet nobody can use the link

		const result = await reconcilePublicShares(world.env);
		expect(result.grantsRevoked).toBeGreaterThanOrEqual(1);
		expect(doGrants().find((g) => g.id === grant.id)).toBeUndefined();
		expect((await routes(pageId))[0]!.doRevokedAt).toBeInstanceOf(Date);
		expect((await reconcilePublicShares(world.env)).grantsRevoked).toBe(0); // converged
	});

	test('a live route whose DO grant vanished is revoked by the reconcile', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		fake().grants.set(workspace.id, doGrants().filter((g) => g.id !== grant.id)); // e.g. the page was purged in the DO
		expect(await resolveShare(world.env, grant.token!)).toBeNull(); // the DO is the authority
		const result = await reconcilePublicShares(world.env);
		expect(result.routesRevoked).toBeGreaterThanOrEqual(1);
		const [route] = await routes(pageId);
		expect(route).toMatchObject({ revokedAt: expect.any(Date), doRevokedAt: expect.any(Date) });
	});

	test('the nightly cron runs the reconcile', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		fake().failRevoke = true;
		await owner().page.grants.revoke({ grantId: grant.id });
		fake().failRevoke = false;
		await scheduled({ cron: NIGHTLY_CRON, scheduledTime: Date.now(), noRetry() {} } as ScheduledController, world.env, world.ctx as never);
		await world.settle();
		expect(doGrants().find((g) => g.id === grant.id)).toBeUndefined();
	});

	test('only people with full access can revoke, and a refused revoke leaves the link alive', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		const mia = await signUpPerson(world, 'Mia', 'mia-public@example.com');
		await createDirectoryClient(world.env.DB).membership.create({
			data: { id: crypto.randomUUID(), workspaceId: workspace.id, userId: mia.userId, role: 'member', joinedAt: new Date() }
		});
		world.workspaces.members.get(workspace.id)!.set(mia.userId, 'member');
		await owner().page.grants.set({ pageId, subjectKind: 'user', subjectId: mia.userId, level: 'update' });
		const rpc = mia.client.rpcWithWorkspace(workspace.id);
		await expect(rpc.page.grants.revoke({ grantId: grant.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(rpc.page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(await resolveShare(world.env, grant.token!)).toMatchObject({ pageId });
	});
});

describe('resolveShare', () => {
	test('answers workspace, page and level; null for junk, unknown tokens and deleted workspaces', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		expect(await resolveShare(world.env, grant.token!)).toEqual({ workspaceId: workspace.id, pageId, level: 'read' });
		expect(await resolveShare(world.env, 'short')).toBeNull();
		expect(await resolveShare(world.env, 'x'.repeat(40))).toBeNull();
		expect(await resolveShare(world.env, "tok' OR 1=1 --")).toBeNull();
	});

	test('null when the D1 route and the DO grant disagree about the page', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		doGrants().find((g) => g.id === grant.id)!.pageId = 'another-page';
		expect(await resolveShare(world.env, grant.token!)).toBeNull();
	});

	test('null once the workspace is in the trash', async () => {
		const other = await signUpPerson(world, 'Olga', 'olga-public@example.com');
		await verifyEmail(world, other);
		const ws = await other.client.rpc.workspace.create({ name: 'Doomed' });
		fake().addPage(ws.id, 'doomed-page', 'Doomed page');
		const rpc = other.client.rpcWithWorkspace(ws.id);
		const grant = await rpc.page.grants.set({ pageId: 'doomed-page', subjectKind: 'public', subjectId: null, level: 'read' });
		expect(await resolveShare(world.env, grant.token!)).toMatchObject({ workspaceId: ws.id });
		await rpc.workspace.delete({ confirmName: 'Doomed' });
		expect(await resolveShare(world.env, grant.token!)).toBeNull();
	});
});

describe('/share-data/:token', () => {
	const call = (token: string, env = world.env, init: RequestInit = {}) =>
		handleShareData(new Request(`http://localhost:5173/share-data/${token}`, { headers: { 'cf-connecting-ip': '203.0.113.9' }, ...init }), env) as Promise<Response>;

	test('returns the title and icon, noindex, uncached; the visitor is anonymous', async () => {
		const pageId = newPage('Launch plan', '🚀');
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		const response = await call(grant.token!);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ title: 'Launch plan', icon: '🚀', level: 'read' });
		expect(response.headers.get('x-robots-tag')).toContain('noindex');
		expect(response.headers.get('cache-control')).toBe('no-store');
		// The actor the DO saw: a share token, no user id, a guest.
		expect(fake().lastPageActor).toMatchObject({ shareToken: grant.token, guest: true, workspaceId: workspace.id });
		expect((fake().lastPageActor as { userId?: string }).userId).toBeUndefined();
	});

	test('unknown, malformed and revoked tokens are 404 and still noindex', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		await owner().page.grants.revoke({ grantId: grant.id });
		for (const token of [grant.token!, 'nope', 'z'.repeat(40), encodeURIComponent('../etc/passwd')]) {
			const response = await call(token);
			expect(response.status, token).toBe(404);
			expect(response.headers.get('x-robots-tag')).toContain('noindex');
		}
	});

	test('is rate limited with RL_PUBLIC and rejects other methods', async () => {
		const pageId = newPage();
		const grant = await owner().page.grants.set({ pageId, subjectKind: 'public', subjectId: null, level: 'read' });
		const keys: string[] = [];
		const limited = { ...world.env, RL_PUBLIC: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } } as unknown as Env;
		const response = await call(grant.token!, limited);
		expect(response.status).toBe(429);
		expect(response.headers.get('x-robots-tag')).toContain('noindex');
		expect(keys).toEqual(['share:203.0.113.9']);
		const post = await call(grant.token!, world.env, { method: 'POST' });
		expect(post.status).toBe(405);
	});

	test('other paths fall through', async () => {
		expect(await handleShareData(new Request('http://localhost:5173/share-data/'), world.env)).toBeUndefined();
	});
});
