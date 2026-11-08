/**
 * The live-update fuzz with every socket held by a socket shard (`SocketShardDO`, docs/spikes/p4-scale.md "Socket shards"): the
 * Workspace DO derives and encodes, the shards send, and evictions hit the shards as well as the Workspace DO. Same invariant as
 * `fuzz.test.ts`: every window a client holds equals a fresh query after every step.
 * `VITE_FUZZ_SEEDS`, `VITE_FUZZ_FROM` and `VITE_FUZZ_SEED` work as in `fuzz.test.ts`.
 */
import { describe, expect, test } from 'vitest';
import { runFuzz } from './harness';

const env = import.meta.env as Record<string, string | undefined>;
const one = env.VITE_FUZZ_SEED;
const count = Number(env.VITE_FUZZ_SEEDS ?? 16);
const from = Number(env.VITE_FUZZ_FROM ?? 1);
const seeds = one ? [Number(one)] : Array.from({ length: count }, (_, i) => from + i);

describe('live views equal a fresh query after every step, through socket shards', () => {
	for (const seed of seeds) {
		test(`seed ${seed}`, { timeout: 240_000 }, async () => {
			const stats = await runFuzz(seed, { shards: 3 });
			expect(stats.steps).toBeGreaterThan(0);
			expect(stats.checks).toBeGreaterThan(500);
		});
	}
});
