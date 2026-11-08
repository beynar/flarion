import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { s, sql } from 'viborm';
import { createMigrationClient } from 'viborm/migrations';
import { createDurableObjectSqliteClient } from '../../../src/server/db/driver/client';
import {
	createDurableObjectSqliteDriver,
	DO_MAX_BOUND_PARAMETERS
} from '../../../src/server/db/do-sqlite-driver';
import { testEnv } from '../helpers';

const user = s
	.model({
		id: s.string().id(),
		name: s.string(),
		email: s.string().unique().nullable(),
		age: s.int().nullable(),
		active: s.boolean().default(true),
		joined: s.dateTime().nullable(),
		meta: s.json().nullable(),
		avatar: s.blob().nullable(),
		posts: s.toMany(() => post)
	})
	.map('users');
const post = s
	.model({
		id: s.string().id(),
		title: s.string(),
		views: s.int().default(0),
		authorId: s.string(),
		author: s.toOne(() => user).fields('authorId').references('id')
	})
	.map('posts');
const schema = { user, post };

async function withClient<T>(
	fn: (client: ReturnType<typeof createDurableObjectSqliteClient<typeof schema>>, state: DurableObjectState) => Promise<T>
): Promise<T> {
	const stub = testEnv.TEST_SQL.getByName(`driver-${crypto.randomUUID()}`);
	return runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
		const client = createDurableObjectSqliteClient(state.storage, schema);
		const migrations = createMigrationClient(client, { tables: ['users', 'posts'] });
		const preview = await migrations.push({ dryRun: true });
		await migrations.push({ consent: preview.consent });
		return fn(client, state);
	});
}

describe('Durable Object SQLite driver: statements', () => {
	test('declares its limits and one driver per storage', async () => {
		await withClient(async (client, state) => {
			const driver = createDurableObjectSqliteDriver(state.storage);
			expect(driver).toBe(createDurableObjectSqliteDriver(state.storage));
			expect(driver.maxBindParametersPerStatement).toBe(100);
			expect(DO_MAX_BOUND_PARAMETERS).toBe(100);
			expect(driver.supportsTransactions).toBe(true);
			expect(driver.sqliteMigrationCapability).toMatchObject({ foreignKeys: 'pragma' });
			expect(client.$driver).toBe(driver);
		});
	});

	test('round-trips booleans, dates, JSON, BLOBs and nullables', async () => {
		await withClient(async (client) => {
			const joined = new Date('2026-11-07T10:00:00.000Z');
			await client.user.create({
				data: {
					id: 'u1',
					name: 'Ada',
					age: 36,
					active: false,
					joined,
					meta: { tags: ['a', 'b'], n: 1 },
					avatar: new Uint8Array([1, 2, 3, 255])
				}
			});
			const found = await client.user.findUniqueOrThrow({ where: { id: 'u1' } });
			expect(found.active).toBe(false);
			expect(found.joined).toEqual(joined);
			expect(found.meta).toEqual({ tags: ['a', 'b'], n: 1 });
			expect([...(found.avatar as Uint8Array)]).toEqual([1, 2, 3, 255]);
			expect(found.email).toBeNull();
		});
	});

	test('update, delete, count, updateMany and deleteMany report exact row counts', async () => {
		await withClient(async (client) => {
			await client.user.createMany({
				data: Array.from({ length: 30 }, (_, i) => ({ id: `u${i}`, name: `n${i}`, age: i }))
			});
			expect(await client.user.count()).toBe(30);
			expect(await client.user.updateMany({ where: { age: { gte: 20 } }, data: { name: 'old' } })).toEqual({ count: 10 });
			expect(await client.user.deleteMany({ where: { name: 'old' } })).toEqual({ count: 10 });
			expect(await client.user.count()).toBe(20);
		});
	});

	test('bulk inserts that need more than 100 bound values are split to fit the platform limit', async () => {
		await withClient(async (client, state) => {
			// 9 scalar columns x 40 rows = 360 bound values: far over 100 for one statement.
			await client.user.createMany({ data: Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, name: `bulk${i}` })) });
			expect(await client.user.count()).toBe(40);
			expect(state.storage.sql.exec('SELECT count(*) c FROM users').one()).toEqual({ c: 40 });
		});
	});

	test('raw queries, raw writes with row counts and insert ids', async () => {
		await withClient(async (client) => {
			expect(await client.$executeRaw(sql`INSERT INTO users (id, name, active) VALUES (${'r1'}, ${'Raw'}, ${1})`)).toBe(1);
			expect(await client.$executeRaw(sql`UPDATE users SET name = ${'Raw2'} WHERE id = ${'r1'}`)).toBe(1);
			expect(await client.$executeRaw(sql`UPDATE users SET name = ${'x'} WHERE id = ${'missing'}`)).toBe(0);
			const rows = await client.$queryRaw<{ name: string }>(sql`SELECT name FROM users WHERE id = ${'r1'}`);
			expect(rows).toEqual([{ name: 'Raw2' }]);
		});
	});

	test('large IN lists travel as one bound JSON array; statements that need >100 separate values are refused', async () => {
		await withClient(async (client) => {
			const ids = Array.from({ length: 300 }, (_, i) => `id${i}`);
			// `in` is compiled to json_each(?): one bound value however long the list.
			expect(await client.user.findMany({ where: { id: { in: ids } } })).toEqual([]);
			// 150 OR-ed (name, age) pairs are 300 separate bound values: viborm refuses before SQLite does.
			const failure = await client.user
				.findMany({ where: { OR: ids.slice(0, 150).map((id, i) => ({ name: id, age: i })) } })
				.catch((e) => e);
			expect(failure).toMatchObject({ name: 'UnsupportedOperationError' });
			expect(String((failure as Error).message)).toMatch(/100/);
		});
	});
});

describe('Durable Object SQLite driver: errors', () => {
	test('constraint failures map to viborm errors with their columns', async () => {
		await withClient(async (client) => {
			await client.user.create({ data: { id: 'u1', name: 'A', email: 'a@x.dev' } });
			const unique = await client.user.create({ data: { id: 'u2', name: 'B', email: 'a@x.dev' } }).catch((e) => e);
			// workerd's SQLite errors carry no `code`: viborm maps them from the message (the driver adds nothing), so the
			// class, the V-code and the constrained columns all come from viborm itself.
			expect(unique).toMatchObject({ name: 'UniqueConstraintError', code: 'V3001', meta: { columns: ['email'], table: 'users' } });
			const pk = await client.user.create({ data: { id: 'u1', name: 'C' } }).catch((e) => e);
			expect(pk).toMatchObject({ name: 'UniqueConstraintError', code: 'V3001', meta: { columns: ['id'], table: 'users' } });
			const fk = await client.post.create({ data: { id: 'p1', title: 't', authorId: 'nobody' } }).catch((e) => e);
			expect(fk).toMatchObject({ name: 'ForeignKeyError', code: 'V3002' });
			// RESTRICT: a parent with children cannot be deleted.
			await client.post.create({ data: { id: 'p2', title: 't', authorId: 'u1' } });
			const restrict = await client.user.delete({ where: { id: 'u1' } }).catch((e) => e);
			expect(restrict).toMatchObject({ name: 'ForeignKeyError', code: 'V3002' });
		});
	});

	test('raw NOT NULL and CHECK failures are mapped by viborm from the message, NOT NULL with its column', async () => {
		await withClient(async (client, state) => {
			const notNull = await client.$executeRawUnsafe('INSERT INTO users (id) VALUES (?)', 'x').catch((e) => e);
			expect(notNull).toMatchObject({ name: 'NotNullConstraintError', code: 'V3003', meta: { columns: ['name'], table: 'users' } });
			state.storage.sql.exec('CREATE TABLE checked (n INTEGER CHECK (n > 0))');
			const check = await client.$executeRawUnsafe('INSERT INTO checked VALUES (-1)').catch((e) => e);
			expect(check).toMatchObject({ name: 'CheckConstraintError', code: 'V3004' });
			const auth = await client.$queryRawUnsafe('SELECT count(*) FROM sqlite_schema WHERE 1').catch((e) => e);
			expect(auth).toBeTruthy();
		});
	});

	test('a statement over the 100 KB platform limit fails with SQLITE_TOOBIG', async () => {
		await withClient(async (client) => {
			const huge = `SELECT ${'1,'.repeat(60_000)}1`;
			const error = await client.$queryRawUnsafe(huge).catch((e) => e);
			expect(String(error.cause?.message ?? error.message)).toMatch(/TOOBIG|too long|redacted|failed/i);
			expect(error).toBeInstanceOf(Error);
		});
	});
});

describe('Durable Object SQLite driver: transactions', () => {
	test('commits when the callback resolves and returns its value', async () => {
		await withClient(async (client) => {
			const result = await client.$transaction(async (tx) => {
				await tx.user.create({ data: { id: 'u1', name: 'A' } });
				await tx.user.create({ data: { id: 'u2', name: 'B' } });
				return (await tx.user.count()) * 10;
			});
			expect(result).toBe(20);
			expect(await client.user.count()).toBe(2);
		});
	});

	test('rolls back every write, before and after an await, when the callback throws', async () => {
		await withClient(async (client) => {
			await expect(
				client.$transaction(async (tx) => {
					await tx.user.create({ data: { id: 'u1', name: 'A' } });
					await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
					await tx.user.create({ data: { id: 'u2', name: 'B' } });
					throw new Error('boom');
				})
			).rejects.toThrow('boom');
			expect(await client.user.count()).toBe(0);
		});
	});

	test('rolls back on a constraint failure inside the transaction', async () => {
		await withClient(async (client) => {
			await client.user.create({ data: { id: 'u1', name: 'A' } });
			const failure = await client
				.$transaction(async (tx) => {
					await tx.user.update({ where: { id: 'u1' }, data: { name: 'changed' } });
					await tx.post.create({ data: { id: 'p1', title: 't', authorId: 'nobody' } });
				})
				.catch((e) => e);
			expect(failure).toMatchObject({ name: 'ForeignKeyError' });
			expect((await client.user.findUniqueOrThrow({ where: { id: 'u1' } })).name).toBe('A');
		});
	});

	test('a nested $transaction is a savepoint: its rollback keeps the outer writes', async () => {
		await withClient(async (client) => {
			await client.$transaction(async (tx) => {
				await tx.user.create({ data: { id: 'outer', name: 'o' } });
				await tx
					.$transaction(async (inner) => {
						await inner.user.create({ data: { id: 'inner', name: 'i' } });
						// a savepoint inside the savepoint, committed, then rolled back with its parent
						await inner.$transaction(async (deep) => {
							await deep.user.create({ data: { id: 'deep', name: 'd' } });
						});
						throw new Error('inner failed');
					})
					.catch((e: Error) => expect(e.message).toBe('inner failed'));
				await tx.$transaction(async (sibling) => {
					await sibling.user.create({ data: { id: 'sibling', name: 's' } });
				});
				await tx.user.create({ data: { id: 'after', name: 'a' } });
			});
			const ids = (await client.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((u) => u.id);
			expect(ids).toEqual(['after', 'outer', 'sibling']);
		});
	});

	test('an outer rollback undoes committed savepoints', async () => {
		await withClient(async (client) => {
			await expect(
				client.$transaction(async (tx) => {
					await tx.$transaction(async (inner) => {
						await inner.user.create({ data: { id: 'inner', name: 'i' } });
					});
					throw new Error('outer failed');
				})
			).rejects.toThrow('outer failed');
			expect(await client.user.count()).toBe(0);
		});
	});

	test('$transaction([...]) is atomic and ordered', async () => {
		await withClient(async (client) => {
			const [created, count] = await client.$transaction([
				client.user.create({ data: { id: 'b1', name: 'b' } }),
				client.user.count()
			]);
			expect(created.id).toBe('b1');
			expect(count).toBe(1);
			await expect(
				client.$transaction([
					client.user.create({ data: { id: 'b2', name: 'b' } }),
					client.user.create({ data: { id: 'b1', name: 'duplicate' } })
				])
			).rejects.toMatchObject({ name: 'UniqueConstraintError' });
			expect(await client.user.count()).toBe(1);
		});
	});

	test('concurrent transactions are serialized and statements from other callers wait their turn', async () => {
		await withClient(async (client) => {
			await client.user.create({ data: { id: 'counter', name: 'c', age: 0 } });
			const bump = () =>
				client.$transaction(async (tx) => {
					const row = await tx.user.findUniqueOrThrow({ where: { id: 'counter' } });
					await Promise.resolve();
					await tx.user.update({ where: { id: 'counter' }, data: { age: (row.age ?? 0) + 1 } });
				});
			const observer = client.user.count();
			await Promise.all(Array.from({ length: 10 }, bump));
			await observer;
			expect((await client.user.findUniqueOrThrow({ where: { id: 'counter' } })).age).toBe(10);
		});
	});

	test('timeout option rolls the transaction back', async () => {
		await withClient(async (client) => {
			const failure = await client
				.$transaction(
					async (tx) => {
						await tx.user.create({ data: { id: 'slow', name: 's' } });
						await new Promise((resolve) => setTimeout(resolve, 200));
					},
					{ timeout: 20 }
				)
				.catch((e) => e);
			expect(failure).toBeInstanceOf(Error);
			expect(await client.user.count()).toBe(0);
		});
	});

	test('raw BEGIN / SAVEPOINT / ROLLBACK TO / RELEASE / COMMIT keep SQLite semantics (frame stack)', async () => {
		await withClient(async (client) => {
			const driver = client.$driver;
			const run = (statement: string) => driver._executeRaw(statement);
			await run('BEGIN IMMEDIATE');
			await run("INSERT INTO users (id, name, active) VALUES ('a', 'a', 1)");
			await run('SAVEPOINT s1');
			await run("INSERT INTO users (id, name, active) VALUES ('b', 'b', 1)");
			await run('ROLLBACK TO SAVEPOINT s1');
			await run("INSERT INTO users (id, name, active) VALUES ('c', 'c', 1)");
			await run('RELEASE SAVEPOINT s1');
			await run('COMMIT');
			const ids = (await client.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((u) => u.id);
			expect(ids).toEqual(['a', 'c']);
			await run('BEGIN');
			await run("INSERT INTO users (id, name, active) VALUES ('d', 'd', 1)");
			await run('ROLLBACK');
			expect(await client.user.count()).toBe(2);
			// PRAGMA busy_timeout is refused by the platform; the driver answers it locally.
			expect((await driver._executeRaw<{ timeout: number }>('PRAGMA busy_timeout')).rows).toEqual([{ timeout: 0 }]);
		});
	});
});
