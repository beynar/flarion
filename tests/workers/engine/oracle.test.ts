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
import { NOW, buildWorld, readPages, type World } from './world';
import { afterWrite, applyEavOp, invalidateRegistry, recomputeNowFormulas, type ChangeRecord, type EavOp } from '../../../src/server/objects/workspace/eav';
import { formatDate } from '../../../src/lib/shared/dates';
import { naiveOf } from './oracle';
import { ctx as eavCtx } from '../eav/helpers';

const describeOptions = (o: QueryOptions): string =>
	JSON.stringify({ ...o, visible: o.visible === null ? 'unrestricted' : `${'size' in o.visible ? o.visible.size : o.visible.length} page numbers` });

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


describe('relations, rollups and formulas against the oracle', () => {
	test('the random world exercises them: filled computed values, tombstoned targets, reverse sides', { timeout: 120_000 }, async () => {
		await inWorkspace(async (_state, db) => {
			const world = await buildWorld(db, rng(2024), { pages: 400, density: 0.6 });
			const naive = naiveOf(world);
			const filled = (prop: string) => world.pages.filter((p) => naive.get(p.id)?.[prop] != null).length;
			for (const prop of ['ftext', 'fnum', 'fbool', 'fdue', 'ftitles', 'rnum', 'rcount', 'rdue', 'rtags', 'rback', 'rchain', 'fchain', 'rel:reverse'])
				expect(filled(prop), prop).toBeGreaterThan(20);
			const dead = new Set(world.pages.filter((p) => p.deletedAt).map((p) => p.id));
			const pointsAtDead = world.pages.filter((p) => ['rel', 'rel1'].some((r) => ((p.props[r] as string[] | undefined) ?? []).some((id) => dead.has(id))));
			expect(pointsAtDead.length).toBeGreaterThan(5);
			// What the oracle computes is what the engine stored: no drift after the initial fill.
			for (const p of world.pages)
				for (const prop of ['ftext', 'fnum', 'fbool', 'fdue', 'ftitles', 'rnum', 'rcount', 'rdue', 'rtags', 'rback', 'rchain', 'fchain'])
					expect(p.props[prop] ?? null, `${p.id}.${prop}`).toEqual(naive.get(p.id)?.[prop] ?? null);
		});
	});

	test('after random writes, relation edits, trash and restore the engine still matches the oracle', { timeout: 240_000 }, async () => {
		await inWorkspace(async (_state, db) => {
			const r = rng(31);
			const world = await buildWorld(db, r, { pages: 300, density: 0.6, randomSource: (w) => randomSource(r, w, 2) });
			const ids = world.pages.map((p) => p.id);
			const live = new Set(world.pages.filter((p) => !p.deletedAt).map((p) => p.id));
			const day = () => `2026-0${r.int(1, 9)}-${String(r.int(10, 28))}`;
			const ops = (): EavOp[] =>
				Array.from({ length: r.int(1, 4) }, (): EavOp => {
					const page = r.pick([...live]);
					switch (r.int(0, 8)) {
						case 0:
							return { op: 'setProp', page, prop: 'amount', value: r.pick([0, 1, 5, 12, -3, null]) } as EavOp;
						case 1:
							return { op: 'setProp', page, prop: 'score', value: r.pick([0, 2, 11, null]) } as EavOp;
						case 2:
							return { op: 'setProp', page, prop: 'done', value: r.bool() } as EavOp;
						case 3:
							return { op: 'setProp', page, prop: 'due', value: r.bool(0.8) ? { start: day() } : null } as EavOp;
						case 4:
							return { op: 'setProp', page, prop: 'tags', value: ['t1', 't2', 't3'].filter(() => r.bool(0.4)) } as EavOp;
						case 5:
							return { op: 'setProp', page, prop: 'rel', value: Array.from({ length: r.int(0, 3) }, () => r.pick(ids)).filter((x, i, a) => a.indexOf(x) === i) } as EavOp;
						case 6:
							return { op: 'setProp', page, prop: 'rel1', value: r.bool(0.7) ? [r.pick(ids)] : null } as EavOp;
						case 7:
							return { op: 'setProp', page, prop: 'title', value: r.pick(['Alpha', 'Zed', 'Été', null]) } as EavOp;
						default:
							return { op: 'setProp', page, prop: 'prio', value: r.pick(['p1', 'p2', 'p3', null]) } as EavOp;
					}
				});
			for (let step = 0; step < 40; step++) {
				const records: ChangeRecord[] = [];
				await db.$transaction(async (tx) => {
					if (step % 5 === 4) {
						const id = r.pick(ids);
						if (live.has(id)) {
							await tx.$executeRawUnsafe("UPDATE page SET deleted_at = '2026-02-01T00:00:00Z', trash_root = ? WHERE id = ?", id, id);
							live.delete(id);
							records.push({ kind: 'trash', page: id, prop: null, old: null, new: null });
						} else {
							await tx.$executeRawUnsafe('UPDATE page SET deleted_at = NULL, trash_root = NULL WHERE id = ?', id);
							live.add(id);
							records.push({ kind: 'restore', page: id, prop: null, old: null, new: null });
						}
					} else for (const op of ops()) records.push(...(await applyEavOp(tx, op, eavCtx)));
					await afterWrite(tx, records, eavCtx);
				});
				invalidateRegistry();
			}
			const w2: World = { ...world, pages: await readPages(db) };
			const naive = naiveOf(w2);
			for (const p of w2.pages) for (const prop of ['ftext', 'fnum', 'fbool', 'fdue', 'ftitles', 'rnum', 'rcount', 'rdue', 'rtags', 'rback', 'rchain', 'fchain'])
				expect(p.props[prop] ?? null, `${p.id}.${prop}`).toEqual(naive.get(p.id)?.[prop] ?? null);
			for (let i = 0; i < 80; i++) {
				const { spec, opts } = randomScenario(r, w2);
				const failure = await compare(w2, spec, opts);
				if (failure !== null) {
					const small = await shrink(w2, spec, opts);
					throw new Error(`engine differs from the oracle after writes (scenario #${i})\n  first difference: ${failure}\n  shrunk (${small.message}): ${JSON.stringify(small.spec)}`);
				}
			}
		});
	});

	test('the hourly recompute rewrites now() formulas, and the engine reads the new values', { timeout: 120_000 }, async () => {
		await inWorkspace(async (_state, db) => {
			const world = await buildWorld(db, rng(9), { pages: 120 });
			const before = world.pages.filter((p) => !p.deletedAt);
			expect(before.every((p) => (p.props.fdate as { start: string }).start === formatDate(NOW, false))).toBe(true);
			const later = { actorId: 'cron', now: NOW + 3 * 3_600_000 };
			const changes = await recomputeNowFormulas(db, later);
			expect(changes.filter((c) => c.prop === 'fdate').length).toBe(before.length);
			const after = await readPages(db);
			for (const p of after) {
				const expected = p.deletedAt ? undefined : { start: formatDate(later.now, false) };
				if (expected) expect(p.props.fdate).toEqual(expected);
			}
			// The oracle recomputes everything at the later time and agrees with every stored value.
			const naive = naiveOf({ ...world, pages: after }, later.now);
			for (const p of after.filter((x) => !x.deletedAt)) expect(p.props.fdate ?? null, p.id).toEqual(naive.get(p.id)?.fdate ?? null);
			// A second recompute at the same instant changes nothing.
			expect(await recomputeNowFormulas(db, later)).toEqual([]);
			// The engine filters on the stored value: pages whose now() formula is on or after the later instant.
			const visible = new Set(after.map((p) => p.num));
			const res = await runQuery(db, { filter: { and: [{ prop: 'fdate', op: 'on_or_after', value: { kind: 'exact', date: formatDate(later.now, false) } }] } }, { visible, now: later.now });
			expect(res.total).toBe(before.length);
		});
	});
});
