import { beforeAll, describe, expect, test } from 'vitest';
import { getAuth } from '../../../src/server/auth/auth';
import { createWorld, type TestWorld } from './helpers';

let world: TestWorld;
let adapter: Awaited<ReturnType<typeof getAuth>['$context']>['adapter'];
let internal: Awaited<ReturnType<typeof getAuth>['$context']>['internalAdapter'];

beforeAll(async () => {
	world = createWorld();
	const context = await getAuth(world.env).$context;
	adapter = context.adapter;
	internal = context.internalAdapter;
});

const user = (email: string, extra: Record<string, unknown> = {}) =>
	adapter.create<Record<string, unknown>>({
		model: 'user',
		data: { name: email.split('@')[0], email, emailVerified: false, createdAt: new Date(), updatedAt: new Date(), ...extra }
	}) as Promise<{ id: string; email: string; name: string; emailVerified: boolean; createdAt: Date; image: string | null }>;

describe('viborm adapter CRUD against D1', () => {
	test('create returns the row with a generated id and real types', async () => {
		const created = await user('crud-a@example.com');
		expect(created.id).toMatch(/\S{10,}/);
		expect(created.emailVerified).toBe(false);
		expect(created.createdAt).toBeInstanceOf(Date);
		expect(created.image ?? null).toBeNull();
	});

	test('findOne by field, with select, and null on a miss', async () => {
		const created = await user('crud-find@example.com');
		const found = await adapter.findOne<{ id: string; email: string }>({
			model: 'user',
			where: [{ field: 'email', value: 'crud-find@example.com' }]
		});
		expect(found?.id).toBe(created.id);
		const selected = await adapter.findOne<Record<string, unknown>>({
			model: 'user',
			where: [{ field: 'id', value: created.id }],
			select: ['email']
		});
		expect(selected).toEqual({ email: 'crud-find@example.com' });
		expect(await adapter.findOne({ model: 'user', where: [{ field: 'email', value: 'nobody@example.com' }] })).toBeNull();
	});

	test('where operators: in, not_in, ne, contains, starts_with, ends_with, lt/gt, null, case-insensitive', async () => {
		const a = await user('ops-alpha@example.com', { name: 'Alpha Person' });
		const b = await user('ops-beta@example.com', { name: 'Beta Person', image: 'https://x/y.png' });
		const ids = [a.id, b.id];
		const find = (where: any[]) => adapter.findMany<{ id: string }>({ model: 'user', where, limit: 50 });
		const inIds = { field: 'id', operator: 'in' as const, value: ids };

		expect((await find([inIds])).length).toBe(2);
		expect((await find([{ field: 'id', operator: 'in', value: [a.id] }])).map((r) => r.id)).toEqual([a.id]);
		expect((await find([inIds, { field: 'id', operator: 'not_in', value: [a.id] }])).map((r) => r.id)).toEqual([b.id]);
		expect((await find([inIds, { field: 'name', operator: 'ne', value: 'Alpha Person' }])).map((r) => r.id)).toEqual([b.id]);
		expect((await find([inIds, { field: 'name', operator: 'contains', value: 'Beta' }])).map((r) => r.id)).toEqual([b.id]);
		expect((await find([inIds, { field: 'name', operator: 'starts_with', value: 'Alpha' }])).map((r) => r.id)).toEqual([a.id]);
		expect((await find([inIds, { field: 'name', operator: 'ends_with', value: 'Person' }])).length).toBe(2);
		expect((await find([inIds, { field: 'name', value: 'alpha person', mode: 'insensitive' }])).map((r) => r.id)).toEqual([a.id]);
		expect((await find([inIds, { field: 'name', value: 'alpha person' }])).length).toBe(0);
		expect((await find([inIds, { field: 'image', value: null }])).map((r) => r.id)).toEqual([a.id]);
		expect((await find([inIds, { field: 'image', operator: 'ne', value: null }])).map((r) => r.id)).toEqual([b.id]);
		expect((await find([inIds, { field: 'createdAt', operator: 'lt', value: new Date(Date.now() + 60_000) }])).length).toBe(2);
		expect((await find([inIds, { field: 'createdAt', operator: 'gt', value: new Date(Date.now() + 60_000) }])).length).toBe(0);
		// LIKE wildcards in the value match literally.
		expect((await find([inIds, { field: 'name', operator: 'contains', value: '%' }])).length).toBe(0);
	});

	test('OR groups are ANDed with the AND group; sort, limit and offset', async () => {
		const rows = [await user('page-1@example.com', { name: 'p1' }), await user('page-2@example.com', { name: 'p2' }), await user('page-3@example.com', { name: 'p3' })];
		const prefix = { field: 'email', operator: 'starts_with' as const, value: 'page-' };
		const either = await adapter.findMany<{ name: string }>({
			model: 'user',
			where: [prefix, { field: 'name', value: 'p1', connector: 'OR' }, { field: 'name', value: 'p3', connector: 'OR' }],
			sortBy: { field: 'name', direction: 'desc' }
		});
		expect(either.map((r) => r.name)).toEqual(['p3', 'p1']);
		const paged = await adapter.findMany<{ name: string }>({
			model: 'user',
			where: [prefix],
			sortBy: { field: 'name', direction: 'asc' },
			limit: 1,
			offset: 1
		});
		expect(paged.map((r) => r.name)).toEqual(['p2']);
		expect(await adapter.count({ model: 'user', where: [prefix] })).toBe(rows.length);
	});

	test('update changes one row and returns it; updateMany returns the count', async () => {
		const created = await user('upd-1@example.com');
		const other = await user('upd-2@example.com');
		const updated = await adapter.update<{ name: string; emailVerified: boolean }>({
			model: 'user',
			where: [{ field: 'id', value: created.id }],
			update: { name: 'Renamed', emailVerified: true }
		});
		expect(updated).toMatchObject({ name: 'Renamed', emailVerified: true });
		expect((await adapter.findOne<{ name: string }>({ model: 'user', where: [{ field: 'id', value: other.id }] }))?.name).toBe('upd-2');
		expect(await adapter.update({ model: 'user', where: [{ field: 'id', value: 'missing' }], update: { name: 'x' } })).toBeNull();
		const count = await adapter.updateMany({
			model: 'user',
			where: [{ field: 'email', operator: 'starts_with', value: 'upd-' }],
			update: { name: 'bulk' }
		});
		expect(count).toBe(2);
	});

	test('delete and deleteMany', async () => {
		const a = await user('del-1@example.com');
		await user('del-2@example.com');
		await adapter.delete({ model: 'user', where: [{ field: 'id', value: a.id }] });
		expect(await adapter.count({ model: 'user', where: [{ field: 'email', operator: 'starts_with', value: 'del-' }] })).toBe(1);
		expect(await adapter.deleteMany({ model: 'user', where: [{ field: 'email', operator: 'starts_with', value: 'del-' }] })).toBe(1);
	});

	test('related tables: sessions and passkeys reference users and cascade on delete', async () => {
		const owner = await user('cascade@example.com');
		const session = await internal.createSession(owner.id);
		expect(session.userId).toBe(owner.id);
		expect((session as { restricted?: boolean }).restricted).toBe(false);
		await adapter.create({
			model: 'passkey',
			data: {
				userId: owner.id,
				publicKey: 'cGs=',
				credentialID: `cred-${crypto.randomUUID()}`,
				counter: 0,
				deviceType: 'multiDevice',
				backedUp: true,
				createdAt: new Date()
			}
		});
		await adapter.delete({ model: 'user', where: [{ field: 'id', value: owner.id }] });
		expect(await adapter.count({ model: 'session', where: [{ field: 'userId', value: owner.id }] })).toBe(0);
		expect(await adapter.count({ model: 'passkey', where: [{ field: 'userId', value: owner.id }] })).toBe(0);
	});
});

describe('single-use consumption', () => {
	test('consumeVerificationValue gives the value to exactly one of several racers', async () => {
		await internal.createVerificationValue({ identifier: 'race:1', value: 'secret', expiresAt: new Date(Date.now() + 60_000) });
		const results = await Promise.all(Array.from({ length: 6 }, () => internal.consumeVerificationValue('race:1')));
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await internal.consumeVerificationValue('race:1')).toBeNull();
	});

	test('an expired value is consumed but not returned', async () => {
		await internal.createVerificationValue({ identifier: 'race:expired', value: 'old', expiresAt: new Date(Date.now() - 1000) });
		expect(await internal.consumeVerificationValue('race:expired')).toBeNull();
	});

	test('the adapter-level consumeOne deletes at most the one matching row', async () => {
		const email = (n: number) => `consume-${n}@example.com`;
		await Promise.all([user(email(1), { name: 'dup' }), user(email(2), { name: 'dup' })]);
		const row = await adapter.consumeOne<{ email: string }>({ model: 'user', where: [{ field: 'email', value: email(1) }] });
		expect(row?.email).toBe(email(1));
		expect(await adapter.count({ model: 'user', where: [{ field: 'name', value: 'dup' }] })).toBe(1);
		expect(await adapter.consumeOne({ model: 'user', where: [{ field: 'email', value: email(1) }] })).toBeNull();
	});
});
