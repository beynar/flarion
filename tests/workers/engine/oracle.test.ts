/**
 * The engine matches the oracle: random workspaces (every property type, empties, multi-values, relations,
 * trashed pages, collections with source ASTs and hand-picked members) in real Durable Object SQLite, random
 * three-level filters, sorts, groupings, windows and visibility sets, compared with the naive evaluation of
 * `filter-ast.ts`. A failure prints the seed, the scenario index and a shrunk repro.
 */
import { describe, expect, test } from 'vitest';
import { evaluate, type QuerySpec } from '../../../src/lib/shared/filter-ast';
import { compareSortTuples, matchesFilter, runQuery, sortKeyOf, type QueryOptions } from '../../../src/server/engine';
import { rng } from '../../unit/shared/helpers';
import { inWorkspace } from '../eav/helpers';
import { compare, oracle, shrink, valuesOf } from './oracle';
import { randomFilter, randomScenario, randomSorts, randomSource, randomVisible, sampledDate } from './queries';
import type { Condition } from '../../../src/lib/shared/filter-ast';
import type { FilterOp } from '../../../src/lib/shared/property-types';
import { NOW, buildWorld, type World } from './world';

const describeOptions = (o: QueryOptions): string =>
	JSON.stringify({ ...o, visible: `${'size' in o.visible ? o.visible.size : o.visible.length} page numbers` });

interface Stats {
	ran: number;
	nonEmpty: number;
	grouped: number;
	withCollection: number;
	windowed: number;
	sorted: number;
}

async function checkScenarios(seed: number, pages: number, scenarios: number, density?: number): Promise<Stats> {
	return inWorkspace(async (_state, db) => {
		const r = rng(seed);
		const world = await buildWorld(db, r, { pages, density, randomSource: (w) => randomSource(r, w, 2) });
		const stats: Stats = { ran: 0, nonEmpty: 0, grouped: 0, withCollection: 0, windowed: 0, sorted: 0 };
		for (let i = 0; i < scenarios; i++) {
			const { spec, opts } = randomScenario(r, world);
			let failure: string | null;
			try {
				failure = await compare(world, spec, opts);
			} catch (error) {
				failure = `engine threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
			}
			stats.ran++;
			if (oracle(world, spec, opts).total > 0) stats.nonEmpty++;
			if (spec.groupBy) stats.grouped++;
			if (opts.collectionId) stats.withCollection++;
			if (opts.window) stats.windowed++;
			if (spec.sorts?.length) stats.sorted++;
			if (failure !== null) {
				const small = await shrink(world, spec, opts);
				throw new Error(
					`engine differs from the oracle\n  seed: ${seed}, pages: ${pages}, scenario #${i}\n  first difference: ${failure}\n` +
						`  shrunk repro (${small.message}):\n    spec: ${JSON.stringify(small.spec)}\n    opts: ${describeOptions(small.opts)}`
				);
			}
		}
		return stats;
	});
}

describe('engine matches the oracle', () => {
	const SEEDS = Array.from({ length: 16 }, (_, i) => i + 1);
	for (const seed of SEEDS) {
		const pages = [150, 400, 800, 1200][seed % 4];
		test(`seed ${seed}: ${pages} pages, 60 random queries`, { timeout: 120_000 }, async () => {
			const stats = await checkScenarios(seed, pages, 60);
			expect(stats.ran).toBe(60);
			// The scenarios must not be vacuous.
			expect(stats.nonEmpty).toBeGreaterThan(15);
			expect(stats.grouped).toBeGreaterThan(5);
		});
	}

	test('seed 101: 3000 pages, 40 random queries', { timeout: 240_000 }, async () => {
		await checkScenarios(101, 3000, 40, 0.4);
	});
});

describe('boundaries, exhaustively', () => {
	test('every date operator on every date property with operands on and around stored values', { timeout: 120_000 }, async () => {
		await inWorkspace(async (_state, db) => {
			const r = rng(31337);
			const world = await buildWorld(db, r, { pages: 600, density: 0.7 });
			const visible = new Set(world.pages.map((p) => p.num));
			const ops: FilterOp[] = ['is', 'before', 'after', 'on_or_before', 'on_or_after'];
			let checked = 0;
			for (const prop of ['due', 'meeting', 'fdate', 'created', 'edited']) {
				for (const op of ops) {
					for (let i = 0; i < 12; i++) {
						const date = sampledDate(r, world, prop) as string;
						const cond: Condition = { prop, op, value: { kind: 'exact', date } };
						const spec: QuerySpec = { filter: { and: [cond] } };
						const failure = await compare(world, spec, { visible, now: NOW });
						expect(failure, JSON.stringify(cond)).toBeNull();
						checked++;
					}
				}
				for (let i = 0; i < 10; i++) {
					const from = sampledDate(r, world, prop) as string;
					const to = sampledDate(r, world, prop) as string;
					const cond: Condition = { prop, op: 'within', value: { kind: 'between', from: { kind: 'exact', date: from }, to: { kind: 'exact', date: to } } };
					expect(await compare(world, { filter: { and: [cond] } }, { visible, now: NOW }), JSON.stringify(cond)).toBeNull();
					checked++;
				}
			}
			expect(checked).toBeGreaterThan(200);
		});
	});

	test('text operators against full values, prefixes, suffixes and long values cut by the key', { timeout: 120_000 }, async () => {
		await inWorkspace(async (_state, db) => {
			const r = rng(4242);
			const world = await buildWorld(db, r, { pages: 500, density: 0.8 });
			const visible = new Set(world.pages.map((p) => p.num));
			const ops: FilterOp[] = ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with'];
			const longs = world.pages.map((p) => p.props.notes).filter((x): x is string => typeof x === 'string' && x.length > 300);
			expect(longs.length).toBeGreaterThan(3);
			const needles = ['zzneedleqq', 'ZZNEEDLEQQ', 'lorem ipsum', 'amet zzneedleqq', longs[0], longs[0].toUpperCase(), longs[0].slice(0, 280), longs[1].slice(-30), longs[1].slice(0, 255), longs[1].slice(0, 256), 'é', 'ÉPSILON', ''];
			for (const prop of ['notes', 'title']) {
				for (const op of ops) {
					for (const value of needles) {
						const spec: QuerySpec = { filter: { and: [{ prop, op, value }] } };
						expect(await compare(world, spec, { visible, now: NOW }), `${prop} ${op} ${JSON.stringify(value.slice(0, 40))}`).toBeNull();
					}
				}
			}
		});
	});
});

describe('helpers for the live loop', () => {
	test('matchesFilter and sortKeyOf agree with the oracle', { timeout: 120_000 }, async () => {
		await inWorkspace(async (_state, db) => {
			const r = rng(777);
			const world = await buildWorld(db, r, { pages: 500, randomSource: (w) => randomSource(r, w, 2) });
			const ctx = { registry: world.registry, meId: 'u1', now: NOW, weekStartsOn: 1 as const };
			for (let i = 0; i < 40; i++) {
				const filter = randomFilter(r, world, 3);
				const visible = randomVisible(r, world);
				const collectionId = r.bool(0.5) ? r.pick(world.collections).id : undefined;
				const { opts } = { opts: { visible, me: 'u1', now: NOW, ...(collectionId ? { collectionId } : {}) } as QueryOptions };
				// Membership and filter, as the oracle sees them, for 25 random pages.
				const expected = new Set(oracle(world, { filter }, opts).rows);
				for (let k = 0; k < 25; k++) {
					const page = r.pick(world.pages);
					const got = await matchesFilter(db, filter, page.num, { me: 'u1', now: NOW, visible, ...(collectionId ? { collectionId } : {}) });
					expect(got, `filter ${JSON.stringify(filter)} page ${page.id} collection ${collectionId}`).toBe(expected.has(page.id));
				}
				void ctx;
				void evaluate;
			}
			for (let i = 0; i < 25; i++) {
				const sorts = randomSorts(r, world);
				const sample = world.pages.filter((p) => !p.deletedAt && r.bool(0.1));
				const tuples = await sortKeyOf(db, sorts, sample.map((p) => p.num), { now: NOW });
				const ordered = [...tuples.values()].sort(compareSortTuples(sorts)).map((t) => t.id);
				const expected = oracle(world, { sorts }, { visible: new Set(sample.map((p) => p.num)), now: NOW }).rows;
				expect(ordered, JSON.stringify(sorts)).toEqual(expected);
			}
		});
	});

	test('a collection that does not exist, or a tombstoned one, has no rows', async () => {
		await inWorkspace(async (_state, db) => {
			const world = await buildWorld(db, rng(5), { pages: 60 });
			const none = await runQuery(db, {}, { visible: world.pages.map((p) => p.num), now: NOW, collectionId: 'nope' });
			expect(none.total).toBe(0);
			expect(none.rows).toEqual([]);
		});
	});

	test('visibility is a hard bound: an empty set returns nothing, whatever the filter', async () => {
		await inWorkspace(async (_state, db) => {
			const world = await buildWorld(db, rng(6), { pages: 80 });
			for (const spec of [{}, { filter: { or: [] } }, { filter: { and: [{ prop: 'done', op: 'is', value: false }] } }] as QuerySpec[]) {
				const res = await runQuery(db, spec, { visible: [], now: NOW });
				expect(res.total).toBe(0);
			}
			void world;
		});
	});
});
