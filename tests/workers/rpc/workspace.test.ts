import { beforeAll, describe, expect, test } from 'vitest';
import { resolveMembership, resolveSession } from '../../../src/server/auth/session';
import { drainOutbox, reconcileMemberships } from '../../../src/server/auth/outbox';
import { createDirectoryClient } from '../../../src/server/db/global.client';
import { Client, createWorld, signUpPerson, verifyEmail, type Person, type TestWorld } from '../auth/helpers';

let world: TestWorld;
let ada: Person;
let adaWorkspace: { id: string; slug: string };

beforeAll(async () => {
	world = createWorld();
	ada = await signUpPerson(world, 'Ada Lovelace', 'ada@example.com');
	await verifyEmail(world, ada);
});

const db = () => createDirectoryClient(world.env.DB);
const requestWith = (person: Person) => new Request('http://localhost:5173/rpc/me', { headers: { cookie: person.client.jar.header } });

describe('sessions', () => {
	test('resolveSession reads the better-auth session from the cookie', async () => {
		const session = await resolveSession(requestWith(ada), world.env);
		expect(session).toMatchObject({ userId: ada.userId, name: 'Ada Lovelace', email: 'ada@example.com' });
		expect(session?.sessionId).toBeTruthy();
	});

	test('no cookie, a forged cookie or a garbage cookie resolve to null', async () => {
		expect(await resolveSession(new Request('http://localhost:5173/'), world.env)).toBeNull();
		const forged = new Request('http://localhost:5173/', { headers: { cookie: 'better-auth.session_token=abc.def' } });
		expect(await resolveSession(forged, world.env)).toBeNull();
		const garbage = new Request('http://localhost:5173/', { headers: { cookie: 'better-auth.session_token=%%%' } });
		expect(await resolveSession(garbage, world.env)).toBeNull();
	});

	test('the cookie cache serves the session without reading D1', async () => {
		const spy = world.env.DB;
		const before = await resolveSession(requestWith(ada), world.env);
		// Break D1 for session reads: a cached cookie still resolves.
		const broken = new Proxy(spy, {
			get(target, property) {
				if (property === 'prepare' || property === 'batch') throw new Error('D1 is down');
				return Reflect.get(target, property, target);
			}
		}) as D1Database;
		const offline = createWorld({ DB: broken });
		const cachedRequest = requestWith(ada);
		const after = await resolveSession(cachedRequest, offline.env);
		expect(after?.userId).toBe(before?.userId);
	});
});

describe('workspace.create', () => {
	test('inserts the workspace and the owner membership, then calls init on the DO', async () => {
		const created = await ada.client.rpc.workspace.create({ name: 'Acme Inc' });
		adaWorkspace = created;
		expect(created).toMatchObject({ name: 'Acme Inc', slug: 'acme-inc', role: 'owner', icon: null });

		expect(await db().workspace.findFirst({ where: { id: created.id } })).toMatchObject({ name: 'Acme Inc', slug: 'acme-inc' });
		expect(await db().membership.findFirst({ where: { workspaceId: created.id, userId: ada.userId } })).toMatchObject({ role: 'owner' });
		expect(world.workspaces.inits).toContainEqual({ workspaceId: created.id, name: 'Acme Inc', ownerId: ada.userId, ownerName: 'Ada Lovelace' });
		const outbox = await world.env.DB.prepare('SELECT kind, doneAt FROM outbox WHERE workspaceId = ?1').bind(created.id).all<{ kind: string; doneAt: string | null }>();
		expect(outbox.results).toHaveLength(1);
		expect(outbox.results[0]).toMatchObject({ kind: 'init' });
		expect(outbox.results[0]!.doneAt).not.toBeNull();
	});

	test('me lists the user and their workspaces', async () => {
		const me = await ada.client.rpc.me();
		expect(me).toMatchObject({ id: ada.userId, email: 'ada@example.com', emailVerified: true });
		expect(me.workspaces.map((w) => [w.slug, w.role])).toEqual([['acme-inc', 'owner']]);
		expect((await ada.client.rpc.workspace.list()).map((w) => w.id)).toEqual([adaWorkspace.id]);
	});

	test('an automatic slug is suffixed when taken; an explicit one conflicts', async () => {
		const second = await ada.client.rpc.workspace.create({ name: 'Acme Inc' });
		expect(second.slug).toMatch(/^acme-inc-[0-9a-f]{4}$/);
		await expect(ada.client.rpc.workspace.create({ name: 'Other', slug: 'acme-inc' })).rejects.toMatchObject({ code: 'CONFLICT' });
	});

	test('needs a session', async () => {
		await expect(new Client(world).rpc.workspace.create({ name: 'Nope' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
	});

	test('a failing DO does not lose the workspace: the outbox keeps init for a retry', async () => {
		world.workspaces.failing = true;
		const created = await ada.client.rpc.workspace.create({ name: 'Flaky' });
		world.workspaces.failing = false;
		expect(world.workspaces.inits.some((init) => init.workspaceId === created.id)).toBe(false);
		const pending = await world.env.DB.prepare('SELECT attempts, doneAt, lastError FROM outbox WHERE workspaceId = ?1').bind(created.id).first<{ attempts: number; doneAt: string | null; lastError: string }>();
		expect(pending).toMatchObject({ attempts: 1, doneAt: null });
		expect(pending?.lastError).toContain('unavailable');

		// Not due yet: the backoff holds it back. Make it due, then the drain delivers.
		expect((await drainOutbox(world.env)).delivered).toBe(0);
		await world.env.DB.prepare("UPDATE outbox SET nextAttemptAt = '2000-01-01T00:00:00.000Z' WHERE workspaceId = ?1").bind(created.id).run();
		expect((await drainOutbox(world.env)).delivered).toBeGreaterThanOrEqual(1);
		expect(world.workspaces.inits.some((init) => init.workspaceId === created.id)).toBe(true);
	});
});

describe('membership resolution', () => {
	test('asks the Workspace DO cache first', async () => {
		const before = world.workspaces.getRoleCalls;
		expect(await resolveMembership(world.env, ada.userId, adaWorkspace.id)).toBe('owner');
		expect(world.workspaces.getRoleCalls).toBe(before + 1);

		// Proof the cache answers: a role only the DO knows is returned although D1 has no row.
		world.workspaces.getByName(adaWorkspace.id).syncMember({ userId: 'ghost-user', role: 'guest' });
		expect(await resolveMembership(world.env, 'ghost-user', adaWorkspace.id)).toBe('guest');
	});

	test('falls back to D1 when the mirror has no row or is unavailable', async () => {
		world.workspaces.members.get(adaWorkspace.id)!.delete(ada.userId);
		expect(await resolveMembership(world.env, ada.userId, adaWorkspace.id)).toBe('owner');
		world.workspaces.failing = true;
		expect(await resolveMembership(world.env, ada.userId, adaWorkspace.id)).toBe('owner');
		world.workspaces.failing = false;
		world.workspaces.members.get(adaWorkspace.id)!.set(ada.userId, 'owner');
	});

	test('strangers and unknown workspaces resolve to null', async () => {
		const grace = await signUpPerson(world, 'Grace', 'grace-stranger@example.com');
		expect(await resolveMembership(world.env, grace.userId, adaWorkspace.id)).toBeNull();
		expect(await resolveMembership(world.env, ada.userId, 'no-such-workspace')).toBeNull();
		await expect(grace.client.rpcWithWorkspace(adaWorkspace.id).workspace.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(ada.client.rpc.workspace.get()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
	});
});

describe('members, roles and removal', () => {
	let grace: Person;
	beforeAll(async () => {
		grace = await signUpPerson(world, 'Grace Hopper', 'grace@example.com');
		await db().membership.create({ data: { id: crypto.randomUUID(), workspaceId: adaWorkspace.id, userId: grace.userId, role: 'member', joinedAt: new Date() } });
		world.workspaces.getByName(adaWorkspace.id).syncMember({ userId: grace.userId, role: 'member' });
	});

	test('lists members with their roles', async () => {
		const members = await ada.client.rpcWithWorkspace(adaWorkspace.id).workspace.members.list();
		expect(members.map((m) => [m.email, m.role])).toEqual([['ada@example.com', 'owner'], ['grace@example.com', 'member']]);
	});

	test('setRole writes D1 and mirrors through syncMember', async () => {
		const owner = ada.client.rpcWithWorkspace(adaWorkspace.id);
		await owner.workspace.members.setRole({ userId: grace.userId, role: 'admin' });
		expect((await db().membership.findFirst({ where: { workspaceId: adaWorkspace.id, userId: grace.userId } }))?.role).toBe('admin');
		expect(world.workspaces.syncs.at(-1)).toMatchObject({ workspaceId: adaWorkspace.id, userId: grace.userId, role: 'admin' });
		expect(await resolveMembership(world.env, grace.userId, adaWorkspace.id)).toBe('admin');
	});

	test('rules: only owner/admin change roles, the owner is untouchable, admins cannot touch admins', async () => {
		const asGrace = grace.client.rpcWithWorkspace(adaWorkspace.id);
		await expect(asGrace.workspace.members.setRole({ userId: ada.userId, role: 'member' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(ada.client.rpcWithWorkspace(adaWorkspace.id).workspace.members.remove({ userId: ada.userId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(asGrace.workspace.members.setRole({ userId: grace.userId, role: 'admin' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(ada.client.rpcWithWorkspace(adaWorkspace.id).workspace.members.setRole({ userId: 'nobody', role: 'member' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	test('remove tombstones the membership, mirrors the removal and revokes access', async () => {
		const owner = ada.client.rpcWithWorkspace(adaWorkspace.id);
		await owner.workspace.members.remove({ userId: grace.userId });
		expect(await db().membership.findFirst({ where: { workspaceId: adaWorkspace.id, userId: grace.userId } })).toBeNull();
		const tombstone = await db().membership.findFirst({ where: { workspaceId: adaWorkspace.id, userId: grace.userId }, deleted: 'only' });
		expect(tombstone?.deletedAt).toBeInstanceOf(Date);
		expect(tombstone?.deletedById).toBe(ada.userId);
		expect(world.workspaces.syncs.at(-1)).toMatchObject({ userId: grace.userId, role: null });
		expect(await resolveMembership(world.env, grace.userId, adaWorkspace.id)).toBeNull();
		await expect(grace.client.rpcWithWorkspace(adaWorkspace.id).workspace.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	test('a removed member can be added again (the partial unique index ignores tombstones)', async () => {
		await db().membership.create({ data: { id: crypto.randomUUID(), workspaceId: adaWorkspace.id, userId: grace.userId, role: 'guest', joinedAt: new Date() } });
		expect(await db().membership.count({ where: { workspaceId: adaWorkspace.id, userId: grace.userId } })).toBe(1);
		await expect(
			db().membership.create({ data: { id: crypto.randomUUID(), workspaceId: adaWorkspace.id, userId: grace.userId, role: 'member', joinedAt: new Date() } })
		).rejects.toThrow();
		await db().membership.deleteMany({ where: { workspaceId: adaWorkspace.id, userId: grace.userId } });
	});
});

describe('nightly reconcile', () => {
	test('re-pushes live memberships and removals that the mirror lost', async () => {
		const mirror = world.workspaces.members.get(adaWorkspace.id)!;
		mirror.delete(ada.userId); // drift: the DO forgot the owner
		mirror.set('stale-user', 'member'); // not repaired (reconcile pushes D1 -> DO, and D1 removals)
		const result = await reconcileMemberships(world.env);
		expect(result.failed).toBe(0);
		expect(mirror.get(ada.userId)).toBe('owner');
		// A tombstoned membership is pushed as a removal (grace was removed above).
		const grace = await db().user.findFirstOrThrow({ where: { email: 'grace@example.com' } });
		mirror.set(grace.id, 'member');
		await reconcileMemberships(world.env);
		expect(mirror.has(grace.id)).toBe(false);
	});
});

describe('workspace settings and delete', () => {
	test('settings update the name, slug and icon; members cannot', async () => {
		const owner = ada.client.rpcWithWorkspace(adaWorkspace.id);
		const updated = await owner.workspace.settings({ name: 'Acme Corp', icon: '🚀', slug: 'acme-corp' });
		expect(updated).toMatchObject({ name: 'Acme Corp', icon: '🚀', slug: 'acme-corp', role: 'owner' });
		await expect(owner.workspace.settings({ slug: 'x' })).rejects.toThrow();
		const taken = await ada.client.rpc.workspace.create({ name: 'Another' });
		await expect(owner.workspace.settings({ slug: taken.slug })).rejects.toMatchObject({ code: 'CONFLICT' });
	});

	test('delete soft-deletes in D1 and refuses sign-in to that workspace', async () => {
		const target = await ada.client.rpc.workspace.create({ name: 'Doomed' });
		const owner = ada.client.rpcWithWorkspace(target.id);
		await expect(owner.workspace.delete({ confirmName: 'Wrong' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		const { purgeAfter } = await owner.workspace.delete({ confirmName: 'Doomed' });
		expect(new Date(purgeAfter).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

		expect(await db().workspace.findFirst({ where: { id: target.id } })).toBeNull();
		const tombstone = await db().workspace.findFirst({ where: { id: target.id }, deleted: 'only' });
		expect(tombstone).toMatchObject({ deletedById: ada.userId });
		expect(await resolveMembership(world.env, ada.userId, target.id)).toBeNull();
		await expect(owner.workspace.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect((await ada.client.rpc.me()).workspaces.map((w) => w.id)).not.toContain(target.id);
		// The slug is free again.
		expect((await ada.client.rpc.workspace.create({ name: 'Doomed', slug: 'doomed' })).slug).toBe('doomed');
	});

	test('only the owner deletes', async () => {
		const admin = await signUpPerson(world, 'Admin', 'admin-del@example.com');
		const target = await ada.client.rpc.workspace.create({ name: 'Guarded' });
		await db().membership.create({ data: { id: crypto.randomUUID(), workspaceId: target.id, userId: admin.userId, role: 'admin', joinedAt: new Date() } });
		await expect(admin.client.rpcWithWorkspace(target.id).workspace.delete({ confirmName: 'Guarded' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});
});
