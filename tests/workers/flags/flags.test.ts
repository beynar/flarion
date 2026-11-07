import { env as testEnv } from 'cloudflare:test';
import { beforeAll, expect, test } from 'vitest';
import migration from '../../../migrations/d1/0000_feature_flags.sql?raw';
import { evaluateFlag, FLAG_CACHE_TTL_SECONDS, getFlag, invalidateFlag, rolloutBucket } from '../../../src/server/flags';

const env = testEnv as unknown as Env;
const set = (name: string, enabled: number, rollout = 100) =>
	env.DB.prepare('INSERT OR REPLACE INTO feature_flag (name, enabled, rollout) VALUES (?1, ?2, ?3)')
		.bind(name, enabled, rollout)
		.run();

beforeAll(async () => {
	for (const statement of migration.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
});

test('missing flags are off, enabled flags are on', async () => {
	expect(await getFlag(env, 'flags-missing')).toBe(false);
	await set('flags-on', 1);
	await set('flags-off', 0);
	expect(await getFlag(env, 'flags-on')).toBe(true);
	expect(await getFlag(env, 'flags-off')).toBe(false);
});

test('reads are cached in KV for 60 seconds and invalidation shows changes', async () => {
	expect(FLAG_CACHE_TTL_SECONDS).toBe(60);
	await set('flags-cached', 1);
	expect(await getFlag(env, 'flags-cached')).toBe(true);
	expect(await env.CACHE.get('flag:flags-cached', 'json')).toEqual({ enabled: true, rollout: 100 });

	await set('flags-cached', 0);
	expect(await getFlag(env, 'flags-cached')).toBe(true); // stale until the TTL or an invalidation
	await invalidateFlag(env, 'flags-cached');
	expect(await getFlag(env, 'flags-cached')).toBe(false);
});

test('partial rollouts are sticky per subject and need a subject', async () => {
	await set('flags-half', 1, 50);
	expect(await getFlag(env, 'flags-half')).toBe(false);
	const subjects = Array.from({ length: 400 }, (_, i) => `user-${i}`);
	const on = subjects.filter((s) => evaluateFlag('flags-half', { enabled: true, rollout: 50 }, s));
	expect(on.length).toBeGreaterThan(140);
	expect(on.length).toBeLessThan(260);
	expect(await getFlag(env, 'flags-half', on[0])).toBe(true);
	expect(rolloutBucket('flags-half', 'user-1')).toBe(rolloutBucket('flags-half', 'user-1'));
	expect(evaluateFlag('x', { enabled: true, rollout: 0 }, 'u')).toBe(false);
	expect(evaluateFlag('x', { enabled: false, rollout: 100 }, 'u')).toBe(false);
});

test('a D1 failure fails closed and is not cached', async () => {
	const broken = { ...env, DB: { prepare: () => { throw new Error('d1 down'); } } } as unknown as typeof env;
	expect(await getFlag(broken, 'flags-d1-down')).toBe(false);
	expect(await env.CACHE.get('flag:flags-d1-down')).toBeNull();
});
