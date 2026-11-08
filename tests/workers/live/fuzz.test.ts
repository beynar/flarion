/**
 * The live-update fuzz, many seeds (docs/PLAN.md "Testing"). `VITE_FUZZ_SEEDS=200 VITE_FUZZ_FROM=1000` runs a bigger sweep;
 * a failure prints the seed and the last steps: `VITE_FUZZ_SEED=<seed>` replays it alone.
 */
import { describe, expect, test } from 'vitest';
import { runFuzz } from './harness';

// Vite exposes `VITE_*` variables to the workerd test bundle: `VITE_FUZZ_SEEDS=200 VITE_FUZZ_FROM=1000 pnpm exec vitest run ...`.
const env = import.meta.env as Record<string, string | undefined>;
const one = env.VITE_FUZZ_SEED;
const count = Number(env.VITE_FUZZ_SEEDS ?? 16);
const from = Number(env.VITE_FUZZ_FROM ?? 1);
const seeds = one ? [Number(one)] : Array.from({ length: count }, (_, i) => from + i);

describe('live views equal a fresh query after every step', () => {
	for (const seed of seeds) {
		test(`seed ${seed}`, { timeout: 240_000 }, async () => {
			const stats = await runFuzz(seed);
			expect(stats.steps).toBeGreaterThan(0);
			expect(stats.checks).toBeGreaterThan(500);
			// The page value cache is on in the tests: units it can serve are maintained from it, the rest fall back to SQL.
			expect(stats.memory).not.toBeNull();
			// workerd swallows console output: a stats run fails on purpose and reports through the message.
			if (env.VITE_FUZZ_STATS) throw new Error(`[fuzz] seed ${seed}: ${JSON.stringify(stats)}`);
		});
	}
});
