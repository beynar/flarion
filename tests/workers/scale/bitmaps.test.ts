/**
 * The option index (Roaring bitmaps per select / status / multi-select / person option, src/server/bitmaps) answers
 * what SQL answers:
 *   1. the engine with bitmaps matches the naive oracle on random workspaces, sorts, groupings and visibility sets;
 *   2. the live loop's candidate checks (`matchesFilter`, `matchesFilterMany`) match it too;
 *   3. inside a real Workspace DO, through the commit path (value writes, option edits, definition changes, trash and
 *      restore, coalesced live typing, purge), the index never drifts from `p_ref`, and the live units still equal a
 *      fresh evaluation that does not use bitmaps.
 */
import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { FilterGroup } from '../../../src/lib/shared/filter-ast';
import type { Op } from '../../../src/lib/shared/ops';
import type { Subscription } from '../../../src/lib/shared/protocol';
import { OptionIndex } from '../../../src/server/bitmaps/option-index';
import { ensureRoaring, roaringReady } from '../../../src/server/bitmaps/roaring';
import { matchesFilter, matchesFilterMany, runQuery, type QueryOptions } from '../../../src/server/engine';
import { rng } from '../../unit/shared/helpers';
import { inWorkspace } from '../eav/helpers';
import { compare, oracle, shrink } from '../engine/oracle';
import { randomFilter, randomScenario, randomSource, randomVisible } from '../engine/queries';
import { NOW, buildWorld } from '../engine/world';
import { connect } from '../socket/helpers';
import { batch, createOp, createWorkspace, inside, ranks } from '../workspace/helpers';

const opt = (id: string) => ({ id, name: id, color: 'default' as const });

describe('the engine with bitmaps matches the oracle', () => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		const pages = [200, 500, 900, 1400][seed % 4];
		test(`seed ${seed}: ${pages} pages, 60 random queries`, { timeout: 180_000 }, async () => {
			expect(await ensureRoaring()).toBe(true);
			await inWorkspace(async (_state, db) => {
				const r = rng(seed);
				const world = await buildWorld(db, r, { pages, density: 0.6, randomSource: (w) => randomSource(r, w, 2) });
				const bitmaps = new OptionIndex();
				let nonEmpty = 0;
				for (let i = 0; i < 60; i++) {
					const { spec, opts } = randomScenario(r, world);
					const withBitmaps: QueryOptions = { ...opts, bitmaps };
					let failure: string | null;
					try {
						failure = await compare(world, spec, withBitmaps);
					} catch (error) {
						failure = `engine threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
					}
					if (oracle(world, spec, opts).total > 0) nonEmpty++;
					if (failure !== null) {
						const small = await shrink(world, spec, withBitmaps);
						throw new Error(`engine with bitmaps differs from the oracle\n  seed ${seed}, scenario #${i}\n  ${failure}\n  shrunk (${small.message}): ${JSON.stringify(small.spec)}`);
					}
				}
				expect(nonEmpty).toBeGreaterThan(15);
				// The bitmaps were really used, and they are exactly what `p_ref` holds.
				expect(bitmaps.loadedProps.length).toBeGreaterThan(0);
				expect(await bitmaps.drift(db)).toEqual([]);
			});
		});
	}

	test('is empty, is not empty, is me and unknown options, on every indexed type', { timeout: 120_000 }, async () => {
		await ensureRoaring();
		await inWorkspace(async (_state, db) => {
			const r = rng(99);
			const world = await buildWorld(db, r, { pages: 700, density: 0.5 });
			const bitmaps = new OptionIndex();
			const visible = new Set(world.pages.map((p) => p.num));
			const conditions: FilterGroup[] = [];
			for (const prop of ['prio', 'stage', 'tags', 'owner']) {
				conditions.push({ and: [{ prop, op: 'is_empty' } as never] }, { and: [{ prop, op: 'is_not_empty' } as never] });
			}
			conditions.push(
				{ and: [{ prop: 'owner', op: 'is_me' } as never] },
				{ and: [{ prop: 'owner', op: 'is_not_me' } as never] },
				{ and: [{ prop: 'prio', op: 'is', value: 'no-such-option' }] },
				{ and: [{ prop: 'prio', op: 'is_not', value: 'no-such-option' }] },
				{ and: [{ prop: 'tags', op: 'contains', value: 'no-such-tag' }] },
				{ and: [{ prop: 'tags', op: 'not_contains', value: 't1' }, { prop: 'owner', op: 'contains', value: 'u1' }] },
				{ or: [{ prop: 'stage', op: 'is', value: 'not_started' }, { prop: 'owner', op: 'is_empty' } as never] }
			);
			for (const filter of conditions) {
				const opts: QueryOptions = { visible, me: 'u1', now: NOW, bitmaps };
				expect(await compare(world, { filter }, opts), JSON.stringify(filter)).toBeNull();
			}
			expect(await bitmaps.drift(db)).toEqual([]);
		});
	});
});

describe('the live loop checks candidates with bitmaps', () => {
	test('matchesFilter and matchesFilterMany agree with the oracle', { timeout: 180_000 }, async () => {
		await ensureRoaring();
		await inWorkspace(async (_state, db) => {
			const r = rng(555);
			const world = await buildWorld(db, r, { pages: 600, randomSource: (w) => randomSource(r, w, 2) });
			const bitmaps = new OptionIndex();
			for (let i = 0; i < 40; i++) {
				const filter = randomFilter(r, world, 3);
				const visible = randomVisible(r, world);
				const collectionId = r.bool(0.5) ? r.pick(world.collections).id : undefined;
				const opts: QueryOptions = { visible, me: 'u1', now: NOW, ...(collectionId ? { collectionId } : {}) };
				const expected = new Set(oracle(world, { filter }, opts).rows);
				const sample = Array.from({ length: 30 }, () => r.pick(world.pages));
				const many = await matchesFilterMany(db, filter, sample.map((p) => p.num), { me: 'u1', now: NOW, visible, bitmaps, ...(collectionId ? { collectionId } : {}) });
				for (const page of sample) {
					expect(many.has(page.num), `many: ${JSON.stringify(filter)} page ${page.id} collection ${collectionId}`).toBe(expected.has(page.id));
					const one = await matchesFilter(db, filter, page.num, { me: 'u1', now: NOW, visible, bitmaps, ...(collectionId ? { collectionId } : {}) });
					expect(one, `one: ${JSON.stringify(filter)} page ${page.id}`).toBe(expected.has(page.id));
				}
			}
			expect(bitmaps.loadedProps.length).toBeGreaterThan(0);
			expect(await bitmaps.drift(db)).toEqual([]);
		});
	});

	test('a candidate check is answered through its candidates, never by scanning an index of the whole table', { timeout: 180_000 }, async () => {
		await ensureRoaring();
		await inWorkspace(async (state, db) => {
			const r = rng(8);
			const world = await buildWorld(db, r, { pages: 3000, density: 0.5, randomSource: (w) => randomSource(r, w, 2) });
			const filters: FilterGroup[] = [
				{ and: [{ prop: 'stage', op: 'is', value: 'not_started' }] },
				{ and: [{ prop: 'prio', op: 'is', value: 'p1' }, { prop: 'tags', op: 'contains', value: 't1' }] },
				{ and: [{ prop: 'owner', op: 'contains', value: 'u1' }] },
				{ and: [{ prop: 'done', op: 'is', value: true }, { prop: '$teamspace', op: 'is', value: 'ts1' }] }
			];
			const nums = world.pages.map((p) => p.num);
			// SQLite has no statistics for these tables and, from the fifth candidate on, switched from the candidates to an index of the
			// whole table (`parent_id`, `teamspace_id`, or the `(prop, v)` key of `p_ref`): profiled at 20,000 pages, 45 ms for 10 candidates
			// against 0.1 ms for 2. The plan of every probe statement is checked, which is exact where timings are not.
			const plans: string[] = [];
			const watched = new Proxy(db, {
				get(target, prop, receiver) {
					if (prop !== '$queryRawUnsafe') return Reflect.get(target, prop, receiver);
					return async (sql: string, ...params: unknown[]) => {
						if (/\bIN \(\?/.test(sql) && !/FROM p_ref WHERE prop = \?\s*$/.test(sql)) {
							const plan = state.storage.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).toArray().map((x) => x.detail).join('; ');
							plans.push(plan);
						}
						return (target.$queryRawUnsafe as (...a: unknown[]) => Promise<unknown>)(sql, ...params);
					};
				}
			});
			for (const bitmaps of [undefined, new OptionIndex()]) {
				for (const filter of filters) {
					// The first read of a property builds its bitmaps from `p_ref` (one scan, once per wake): not what is checked here.
					await matchesFilterMany(db, filter, nums.slice(0, 60), { now: NOW, collectionId: world.collections[0].id, bitmaps });
					for (const k of [2, 10, 40]) {
						await matchesFilterMany(watched, filter, Array.from({ length: k }, () => r.pick(nums)), { now: NOW, collectionId: world.collections[0].id, bitmaps });
					}
				}
			}
			expect(plans.length).toBeGreaterThan(50);
			const scans = plans.filter((plan) => /parent_id=\?|teamspace_id=\?|\(prop=\? AND v=\?\)|\(prop=\? AND v>/.test(plan));
			expect(scans, `probe plans that scan an index of the whole table:\n${scans.slice(0, 3).join('\n')}`).toEqual([]);
		});
	});
});

describe('the index stays exact through the commit path of a Workspace DO', () => {
	test('random writes, option edits, definition changes, trash, restore, coalesced typing and hibernation', { timeout: 300_000 }, async () => {
		expect(await ensureRoaring()).toBe(true);
		expect(roaringReady()).toBe(true);
		const r = rng(2026);
		const ROWS = 160;
		const ws = await createWorkspace('bitmaps');
		const statusIds = ['not_started', 'in_progress', 'done'];
		await ws.stub.apply(
			ws.owner,
			batch([
				{ op: 'createProperty', property: { id: 'status', name: 'Status', type: 'status', config: { options: [], groups: [] } } },
				{ op: 'createProperty', property: { id: 'prio', name: 'Priority', type: 'select', config: { options: ['p1', 'p2', 'p3'].map(opt) } } },
				{ op: 'createProperty', property: { id: 'tags', name: 'Tags', type: 'multi_select', config: { options: ['t1', 't2', 't3', 't4'].map(opt) } } },
				{ op: 'createProperty', property: { id: 'who', name: 'Who', type: 'person', config: {} } },
				{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } }
			] as Op[])
		);
		const rk = ranks(ROWS + 1);
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('db', null, rk[0], { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
				{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } } as Op,
				...Array.from({ length: ROWS }, (_, i) =>
					createOp(`r${i}`, 'db', rk[i + 1], {
						values: {
							title: `Row ${i}`,
							status: r.pick(statusIds),
							prio: r.pick(['p1', 'p2', 'p3']),
							tags: ['t1', 't2', 't3'].filter(() => r.bool(0.4)),
							who: ['owner-1', 'u1', 'u2'].filter(() => r.bool(0.4)),
							amount: r.int(0, 100)
						}
					})
				)
			])
		);
		const views: Record<string, Subscription> = {
			a: { kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'status', op: 'is', value: 'done' }] }, sorts: [{ prop: 'amount', dir: 'desc' }], limit: 30 },
			b: { kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'tags', op: 'contains', value: 't1' }, { prop: 'who', op: 'contains', value: 'u1' }] }, limit: 30 },
			c: { kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'prio', op: 'is_not', value: 'p1' }] }, groupBy: { prop: 'status' }, limit: 20 },
			d: { kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'who', op: 'is_empty' }] }, limit: 30 }
		};
		const open = async () => {
			const c = await connect(ws.id, { 'x-flarion-dev-actor': 'owner-1', 'x-flarion-dev-role': 'owner' });
			await c.rawHello({ subs: Object.entries(views).map(([id, sub]) => ({ id, sub })) }).wait((m) => m.t === 'head');
			return c;
		};
		let conn = await open();
		const first = await ws.stub.liveStats();
		expect(first.bitmaps?.loaded.length).toBeGreaterThanOrEqual(4);
		expect(first.bitmaps?.drift).toEqual([]);

		const steps = 220;
		let tagOptions = ['t1', 't2', 't3', 't4'];
		let trashed: string[] = [];
		let applied = 0;
		for (let step = 0; step < steps; step++) {
			const row = `r${r.int(0, ROWS - 1)}`;
			const roll = r.next();
			let ops: Op[];
			if (roll < 0.22) ops = [{ op: 'setProp', page: row, prop: 'status', value: r.pick([...statusIds, null]) } as Op];
			else if (roll < 0.34) ops = [{ op: 'setProp', page: row, prop: 'prio', value: r.pick(['p1', 'p2', 'p3', null]) } as Op];
			else if (roll < 0.46) ops = [{ op: 'setProp', page: row, prop: 'tags', value: tagOptions.filter(() => r.bool(0.4)) } as Op];
			else if (roll < 0.56) ops = [{ op: 'addOption', page: row, prop: 'who', option: r.pick(['owner-1', 'u1', 'u2', 'u3']) } as Op];
			else if (roll < 0.66) ops = [{ op: 'removeOption', page: row, prop: 'who', option: r.pick(['owner-1', 'u1', 'u2', 'u3']) } as Op];
			else if (roll < 0.74) ops = [{ op: 'addOption', page: row, prop: 'tags', option: r.pick(tagOptions) } as Op];
			else if (roll < 0.78) ops = [{ op: 'removeOption', page: row, prop: 'tags', option: r.pick(tagOptions) } as Op];
			else if (roll < 0.84) {
				// Live typing on one property by one actor: the log coalesces these rows.
				const page = row;
				for (const value of ['p1', 'p2', 'p3', 'p1']) await ws.stub.apply(ws.owner, batch([{ op: 'setProp', page, prop: 'prio', value } as Op]));
				continue;
			} else if (roll < 0.88 && trashed.length < 20) {
				trashed.push(row);
				ops = [{ op: 'trash', page: row } as Op];
			} else if (roll < 0.92 && trashed.length > 0) {
				ops = [{ op: 'restore', page: trashed.shift() as string } as Op];
			} else if (roll < 0.95) {
				// A definition change: options of the multi-select edited (one removed, one added).
				tagOptions = r.bool(0.5) ? tagOptions.filter((t) => t !== 't4').concat(['t4']) : [...tagOptions.filter((t) => t !== 't3'), 't3'];
				ops = [{ op: 'updateProperty', id: 'tags', config: { options: tagOptions.map(opt) } } as Op];
			} else if (roll < 0.97) {
				// Bulk batch over several pages and properties.
				ops = Array.from({ length: 8 }, () => ({ op: 'setProp', page: `r${r.int(0, ROWS - 1)}`, prop: 'status', value: r.pick(statusIds) }) as Op);
			} else if (roll < 0.985) {
				// Hibernation: the object wakes with no index, no units and no socket; a new tab rebuilds what it reads.
				conn.ws.close();
				await evictDurableObject(ws.stub);
				conn = await open();
				continue;
			} else ops = [{ op: 'setProp', page: row, prop: 'amount', value: r.int(0, 100) } as Op];
			try {
				await ws.stub.apply(ws.owner, batch(ops));
				applied++;
			} catch {
				// a write on a trashed page or an option the definition just dropped: refused, nothing changed
			}
			if (step % 20 === 19) {
				const stats = await ws.stub.liveStats();
				expect(stats.bitmaps?.drift, `drift at step ${step}`).toEqual([]);
				expect(stats.stale, `stale units at step ${step}`).toEqual([]);
			}
		}
		const stats = await ws.stub.liveStats();
		expect(stats.bitmaps?.drift).toEqual([]);
		expect(stats.stale).toEqual([]);
		expect(stats.bitmaps?.loaded.length).toBeGreaterThan(0);

		expect(applied).toBeGreaterThan(steps / 2);
		// Purge pages: they leave the bitmaps, and nothing else moves.
		for (const id of trashed) await ws.stub.apply(ws.owner, batch([{ op: 'restore', page: id } as Op]));
		const victims = ['r3', 'r44', 'r90', 'r121'];
		for (const id of victims) await ws.stub.apply(ws.owner, batch([{ op: 'trash', page: id } as Op]));
		for (const id of victims) await ws.stub.purgeTrash(ws.owner, id);
		const gone = await inside(ws.stub, (sql) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM page WHERE deleted_at IS NOT NULL').one().n);
		expect(gone).toBe(0);
		const after = await ws.stub.liveStats();
		expect(after.bitmaps?.drift).toEqual([]);
		expect(after.stale).toEqual([]);
		conn.ws.close();
	});
});
