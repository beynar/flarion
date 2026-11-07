import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { testEnv } from './helpers';

test('SQLite Durable Object runs in workerd', async () => {
	const stub = testEnv.TEST_SQL.getByName('smoke');
	const value = await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
		state.storage.sql.exec('CREATE TABLE t (v INTEGER)');
		state.storage.sql.exec('INSERT INTO t VALUES (41)');
		return state.storage.sql.exec<{ v: number }>('SELECT v + 1 AS v FROM t').one().v;
	});
	expect(value).toBe(42);
});
