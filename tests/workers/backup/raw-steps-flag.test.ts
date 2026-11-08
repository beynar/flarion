/** The migration flag gate on raw schema steps (docs/ops/migrations.md). */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { applyRawSteps, pendingFlags, rawSchemaVersion, RAW_STEPS, type RawStep } from '../../../src/server/objects/workspace/migrations';
import { migrationFlags } from '../../../src/server/objects/workspace/migrations';
import { invalidateFlag } from '../../../src/server/flags';
import { testEnv } from '../helpers';

const steps: RawStep[] = [
	['CREATE TABLE a (x INTEGER)'],
	{ flag: 'migration.add-b', statements: ['CREATE TABLE b (x INTEGER)', 'ALTER TABLE a ADD COLUMN y TEXT'] },
	['CREATE TABLE c (x INTEGER)']
];

const inObject = <T>(fn: (storage: DurableObjectStorage) => T | Promise<T>) =>
	runInDurableObject(testEnv.TEST_SQL.getByName(`raw-${crypto.randomUUID()}`), (_i, state: DurableObjectState) => fn(state.storage));
const tables = (s: DurableObjectStorage) =>
	s.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a','b','c') ORDER BY name").toArray().map((r) => r.name);

describe('gated raw steps', () => {
	test('a gated step holds back itself and everything after it until its flag is on', async () => {
		await inObject((storage) => {
			expect(pendingFlags(storage, steps)).toEqual(['migration.add-b']);
			expect(applyRawSteps(storage, new Set(), steps)).toBe(1);
			expect(tables(storage)).toEqual(['a']);
			// Still off on the next wake: nothing changes, nothing breaks.
			expect(applyRawSteps(storage, new Set(), steps)).toBe(1);
			expect(applyRawSteps(storage, new Set(['migration.add-b']), steps)).toBe(3);
			expect(tables(storage)).toEqual(['a', 'b', 'c']);
			expect(rawSchemaVersion(storage)).toBe(3);
			// Idempotent once current, flag or no flag.
			expect(applyRawSteps(storage, new Set(), steps)).toBe(3);
			expect(pendingFlags(storage, steps)).toEqual([]);
		});
	});

	test('a failing step rolls back with its version: the object stays at the last good step', async () => {
		await inObject((storage) => {
			const bad: RawStep[] = [['CREATE TABLE a (x INTEGER)'], ['CREATE TABLE b (x INTEGER)', 'THIS IS NOT SQL']];
			expect(() => applyRawSteps(storage, new Set(), bad)).toThrow();
			// The whole call is one transaction here: nothing applied, version unchanged, a retry starts clean.
			expect(rawSchemaVersion(storage)).toBe(0);
			expect(tables(storage)).toEqual([]);
		});
	});

	test('the shipped steps are all ungated (an existing object needs no flag lookup)', async () => {
		expect(RAW_STEPS.every((s) => Array.isArray(s))).toBe(true);
		await inObject(async (storage) => {
			applyRawSteps(storage);
			expect(await migrationFlags(storage, testEnv as unknown as Env)).toEqual(new Set());
		});
	});

	test('flags come from D1 through the KV cache, and a lookup failure reads as off', async () => {
		const env = testEnv as unknown as Env;
		const set = async (on: boolean) => {
			await env.DB.prepare('INSERT OR REPLACE INTO feature_flag (name, enabled, rollout) VALUES (?, ?, 100)').bind('migration.add-b', on ? 1 : 0).run();
			await invalidateFlag(env, 'migration.add-b');
		};
		await inObject(async (storage) => {
			await set(false);
			expect(await migrationFlags(storage, env, 'ws', steps)).toEqual(new Set());
			await set(true);
			expect(await migrationFlags(storage, env, 'ws', steps)).toEqual(new Set(['migration.add-b']));
			const broken = { DB: { prepare: () => { throw new Error('D1 down'); } }, CACHE: { get: async () => { throw new Error('KV down'); }, put: async () => {} } } as unknown as Env;
			expect(await migrationFlags(storage, broken, 'ws', steps)).toEqual(new Set());
		});
		await env.DB.prepare('DELETE FROM feature_flag WHERE name = ?').bind('migration.add-b').run();
		await invalidateFlag(env, 'migration.add-b');
	});
});
