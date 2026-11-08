import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { s } from 'viborm';
import { createMigrationClient, MemoryEstateStorage } from 'viborm/migrations';
import { createDurableObjectStorageWriter } from 'viborm/migrations/storage/durable-object';
import { createTenantMigrator } from 'viborm/migrations/tenant';
import { createDurableObjectSqliteClient } from '../../../src/server/db/driver/client';
import { migrateOnWake } from '../../../src/server/db/driver/migrate';
import { createDurableObjectSqliteDriver } from '../../../src/server/db/do-sqlite-driver';
import { testEnv } from '../helpers';

const v1 = {
	user: s
		.model({ id: s.string().id(), name: s.string(), posts: s.toMany(() => v1.post) })
		.map('users'),
	post: s
		.model({
			id: s.string().id(),
			title: s.string(),
			authorId: s.string(),
			author: s.toOne(() => v1.user).fields('authorId').references('id')
		})
		.map('posts')
};

/** v2 adds a nullable column and a unique constraint: the second forces a table recreation. */
const v2 = {
	user: s
		.model({
			id: s.string().id(),
			name: s.string().unique(),
			bio: s.string().nullable(),
			posts: s.toMany(() => v2.post)
		})
		.map('users'),
	post: s
		.model({
			id: s.string().id(),
			title: s.string(),
			authorId: s.string(),
			author: s.toOne(() => v2.user).fields('authorId').references('id')
		})
		.map('posts')
};

const TABLES = ['users', 'posts'];

function inObject<T>(name: string, fn: (state: DurableObjectState) => Promise<T>): Promise<T> {
	const stub = testEnv.TEST_SQL.getByName(`migrations-${name}-${crypto.randomUUID()}`);
	return runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => fn(state));
}

describe('migrations on Durable Object SQLite', () => {
	test('push creates the schema from an empty object, then is a no-op', async () => {
		await inObject('push', async (state) => {
			const client = createDurableObjectSqliteClient(state.storage, v1);
			const migrations = createMigrationClient(client, { tables: TABLES });
			const preview = await migrations.push({ dryRun: true });
			expect(preview.statements.length).toBeGreaterThan(0);
			expect((await migrations.push({ consent: preview.consent })).outcome).toBe('applied');
			await client.user.create({ data: { id: 'u1', name: 'Ada', posts: { create: { id: 'p1', title: 'Hi' } } } });
			expect((await migrations.push({ dryRun: true })).statements).toEqual([]);
		});
	});

	test('generate then apply (bundled estate), re-apply is a no-op, a second state migrates data in place', async () => {
		await inObject('generate-apply', async (state) => {
			const storage = new MemoryEstateStorage();
			const client1 = createDurableObjectSqliteClient(state.storage, v1);
			const m1 = createMigrationClient(client1, { storage, tables: TABLES });
			expect((await m1.generate({ name: 'init' })).outcome).toBe('published');
			expect((await m1.apply()).outcome).toBe('applied');
			expect((await m1.apply()).outcome).toBe('noop');
			await client1.user.create({ data: { id: 'u1', name: 'Ada', posts: { create: [{ id: 'p1', title: 'Hi' }] } } });

			const client2 = createDurableObjectSqliteClient(state.storage, v2);
			const m2 = createMigrationClient(client2, { storage, tables: TABLES });
			expect((await m2.generate({ name: 'unique-name-and-bio' })).outcome).toBe('published');
			expect((await m2.apply()).outcome).toBe('applied');
			// The users table was recreated; its child rows survived (foreign keys were lifted for real).
			expect(await client2.post.count()).toBe(1);
			expect((await client2.user.findUnique({ where: { id: 'u1' }, include: { posts: true } }))?.posts).toHaveLength(1);
			const foreignKeys = state.storage.sql.exec('PRAGMA foreign_keys').one();
			expect(foreignKeys).toEqual({ foreign_keys: 1 });
			expect(state.storage.sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
			await expect(client2.user.create({ data: { id: 'u2', name: 'Ada' } })).rejects.toMatchObject({
				name: 'UniqueConstraintError'
			});
		});
	});

	test('a write earlier in the same event does not turn the foreign-key lift into a silent no-op', async () => {
		await inObject('prewrite', async (state) => {
			const storage = new MemoryEstateStorage();
			const client1 = createDurableObjectSqliteClient(state.storage, v1);
			const m1 = createMigrationClient(client1, { storage, tables: TABLES });
			await m1.generate({ name: 'init' });
			await m1.apply();
			await client1.user.create({ data: { id: 'u1', name: 'Ada', posts: { create: [{ id: 'p1', title: 'a' }, { id: 'p2', title: 'b' }] } } });
			const client2 = createDurableObjectSqliteClient(state.storage, v2);
			const m2 = createMigrationClient(client2, { storage, tables: TABLES });
			await m2.generate({ name: 'v2' });
			// A raw write with no await before `apply`, as close to the lift as a test gets. (Whether it is still pending when
			// `apply` reaches `PRAGMA foreign_keys = OFF` depends on viborm's own I/O in between, so the hook has its own test below.)
			state.storage.sql.exec("INSERT INTO users (id, name) VALUES ('u3', 'Cy')");
			expect((await m2.apply()).outcome).toBe('applied');
			expect(await client2.post.count()).toBe(2);
		});
	});

	test("the driver's beforeForeignKeysOff hook settles a pending write, without which PRAGMA foreign_keys = OFF is a silent no-op", async () => {
		await inObject('fk-hook', async (state) => {
			const driver = createDurableObjectSqliteDriver(state.storage);
			const q = (statement: string) => state.storage.sql.exec(statement).toArray();
			const foreignKeys = () => (q('PRAGMA foreign_keys')[0] as { foreign_keys: number }).foreign_keys;
			q('CREATE TABLE fk_probe (id TEXT PRIMARY KEY)');
			q('PRAGMA foreign_keys = ON');
			// control: a pending write turns the pragma into a no-op (it still reads 1)
			q("INSERT INTO fk_probe VALUES ('a')");
			q('PRAGMA foreign_keys = OFF');
			expect(foreignKeys()).toBe(1);
			// viborm calls this hook right before its `PRAGMA foreign_keys = OFF` (base class: declared, not implemented)
			q("INSERT INTO fk_probe VALUES ('b')");
			await (driver as unknown as { beforeForeignKeysOff(): Promise<void> }).beforeForeignKeysOff();
			q('PRAGMA foreign_keys = OFF');
			expect(foreignKeys()).toBe(0);
			q('PRAGMA foreign_keys = ON');
		});
	});

	test('platform tables (_cf_KV from the KV API) and an FTS5 table do not block migrations', async () => {
		await inObject('platform-tables', async (state) => {
			await state.storage.put('some', 'kv');
			state.storage.sql.exec('CREATE VIRTUAL TABLE search USING fts5(page_num UNINDEXED, field, text)');
			const names = state.storage.sql
				.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
				.toArray()
				.map((r) => r.name);
			expect(names).toContain('_cf_KV');
			const storage = new MemoryEstateStorage();
			const client = createDurableObjectSqliteClient(state.storage, v1);
			const migrations = createMigrationClient(client, { storage, tables: TABLES });
			await migrations.generate({ name: 'init' });
			expect((await migrations.apply()).outcome).toBe('applied');
			expect((await migrations.status()).marker).toBeTruthy();
			expect(state.storage.sql.exec("SELECT count(*) c FROM search").one()).toEqual({ c: 0 });
		});
	});

	test('apply from the object constructor path: migrateOnWake inside blockConcurrencyWhile', async () => {
		await inObject('wake', async (state) => {
			const storage = new MemoryEstateStorage();
			const client = createDurableObjectSqliteClient(state.storage, v1);
			await createMigrationClient(client, { storage, tables: TABLES }).generate({ name: 'init' });
			expect((await migrateOnWake(state, { client, storage, tables: TABLES })).outcome).toBe('applied');
			expect((await migrateOnWake(state, { client, storage, tables: TABLES })).outcome).toBe('noop');
			await client.user.create({ data: { id: 'u1', name: 'Ada' } });
			expect(await client.user.count()).toBe(1);
		});
	});

	test('a failing migration rolls back completely and leaves the previous schema', async () => {
		await inObject('rollback', async (state) => {
			const storage = new MemoryEstateStorage();
			const client1 = createDurableObjectSqliteClient(state.storage, v1);
			const m1 = createMigrationClient(client1, { storage, tables: TABLES });
			await m1.generate({ name: 'init' });
			await m1.apply();
			// Two users with the same name: the v2 unique constraint cannot be applied.
			await client1.user.create({ data: { id: 'u1', name: 'Ada' } });
			await client1.user.create({ data: { id: 'u2', name: 'Ada' } });
			const client2 = createDurableObjectSqliteClient(state.storage, v2);
			const m2 = createMigrationClient(client2, { storage, tables: TABLES });
			await m2.generate({ name: 'v2' });
			await expect(m2.apply()).rejects.toBeTruthy();
			const columns = state.storage.sql
				.exec<{ name: string }>("SELECT name FROM pragma_table_info('users')")
				.toArray()
				.map((c) => c.name);
			expect(columns).toEqual(['id', 'name']);
			expect(await client1.user.count()).toBe(2);
			expect(state.storage.sql.exec('PRAGMA foreign_keys').one()).toEqual({ foreign_keys: 1 });
		});
	});

	test('history in the object (viborm/migrations/storage/durable-object) with the tenant migrator', async () => {
		await inObject('tenant', async (state) => {
			const history = createDurableObjectStorageWriter(
				state.storage as unknown as Parameters<typeof createDurableObjectStorageWriter>[0]
			);
			const client = createDurableObjectSqliteClient(state.storage, v1);
			const migrator = createTenantMigrator({ client, history, tables: TABLES });
			const first = await migrator.change(v1);
			expect(first.kind).toBe('applied');
			await client.user.create({ data: { id: 'u1', name: 'Ada', posts: { create: { id: 'p1', title: 'x' } } } });
			const second = await migrator.change(v2);
			expect(second.kind).toBe('applied');
			expect((await migrator.change(v2)).kind).toBe('noop');
			expect(await client.post.count()).toBe(1);
		});
	});
});
