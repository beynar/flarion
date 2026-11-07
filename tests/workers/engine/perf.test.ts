/** Performance smoke test at 5,000 pages: typical view queries, timings logged, results checked against the oracle. */
import { expect, test } from 'vitest';
import type { QuerySpec } from '../../../src/lib/shared/filter-ast';
import { explainQuery, runQuery, type QueryOptions } from '../../../src/server/engine';
import { rng } from '../../unit/shared/helpers';
import { inWorkspace } from '../eav/helpers';
import { diff, oracle, summarize } from './oracle';
import { randomSource } from './queries';
import { NOW, buildWorld } from './world';

test('5,000 pages: typical views run in tens of milliseconds', { timeout: 600_000 }, async () => {
	await inWorkspace(async (_state, db) => {
		const r = rng(5000);
		const t0 = Date.now();
		const world = await buildWorld(db, r, { pages: 5000, density: 0.3, randomSource: (w) => randomSource(r, w, 2) });
		console.log(`[perf] built ${world.pages.length} pages in ${Date.now() - t0} ms`);
		const visible = new Set(world.pages.filter((p) => !p.deletedAt && r.bool(0.9)).map((p) => p.num));
		const base: QueryOptions = { visible, me: 'u1', now: NOW, window: { offset: 0, limit: 50 } };
		const scenarios: [string, QuerySpec, Partial<QueryOptions>][] = [
			['table, no filter, sorted by title', { sorts: [{ prop: 'title', dir: 'asc' }] }, {}],
			['table, sorted by amount desc, page 3', { sorts: [{ prop: 'amount', dir: 'desc' }] }, { window: { offset: 100, limit: 50 } }],
			['table, sorted by select (heap)', { sorts: [{ prop: 'prio', dir: 'asc' }, { prop: 'amount', dir: 'asc' }] }, {}],
			['selective filter: stage is done and owner contains u2', { filter: { and: [{ prop: 'stage', op: 'is', value: 'done' }, { prop: 'owner', op: 'contains', value: 'u2' }] }, sorts: [{ prop: 'due', dir: 'asc' }] }, {}],
			['text contains, sorted', { filter: { and: [{ prop: 'title', op: 'contains', value: 'alpha' }] }, sorts: [{ prop: 'created', dir: 'desc' }] }, {}],
			['three-level filter', { filter: { and: [{ or: [{ prop: 'done', op: 'is', value: true }, { prop: 'prio', op: 'is', value: 'p1' }] }, { prop: 'due', op: 'within', value: { kind: 'named', range: 'next_month' } }, { prop: 'tags', op: 'not_contains', value: 't1' }] } }, {}],
			['board grouped by stage, 50 per group', { sorts: [{ prop: 'due', dir: 'asc' }], groupBy: { prop: 'stage' } }, {}],
			['grouped by multi-select tags', { groupBy: { prop: 'tags' } }, {}],
			['child database (collection) sorted', { sorts: [{ prop: 'amount', dir: 'desc' }] }, { collectionId: 'col1' }],
			['filtered collection, grouped', { groupBy: { prop: 'prio' } }, { collectionId: 'col2' }]
		];
		for (const [name, spec, extra] of scenarios) {
			const opts = { ...base, ...extra };
			const start = Date.now();
			const res = await runQuery(db, spec, opts);
			const ms = Date.now() - start;
			const wanted = oracle(world, spec, opts);
			expect(diff(wanted, summarize(res)), name).toBeNull();
			console.log(`[perf] ${name}: ${ms} ms, total ${res.total}, sort ${res.stats.sort}, ${res.stats.statements} statements, ${res.stats.scans} scans, ${res.stats.probes} probes`);
		}
		const plan = await explainQuery(db, scenarios[3][1], base);
		console.log(`[perf] explain: ${plan.order.join(' -> ')}`);
	});
});
