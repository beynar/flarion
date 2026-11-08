/**
 * Statements per commit (docs/ops/load-test.md "Third pass"): the SQL a value-only `setProp` makes on a workspace with open views, grouped by
 * statement shape. A guard for the commit path (a commit that quietly makes twice the statements costs twice the CPU on the object's one thread)
 * and the tool that found where they come from. `VITE_TRACE_PRINT=1` prints the statements.
 */
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { ensureRoaring, setRoaringEnabled } from '../../../src/server/bitmaps/roaring';
import type { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';
import { rng } from '../../unit/shared/helpers';
import { connect } from '../socket/helpers';
import { batch } from '../workspace/helpers';
import { scaleViews, seedScale } from './harness';

const env = import.meta.env as Record<string, string | undefined>;
const now = () => performance.now();

test('statements and time of one value-only commit with 10 sockets x 8 views', { timeout: 120_000 }, async () => {
	await ensureRoaring();
	setRoaringEnabled(true);
	const r = rng(7);
	const world = await seedScale('trace', { pages: 500, people: 60, tags: 24 }, r);
	const { fx } = world;
	const views = scaleViews(world, 8, r);
	const people = ['owner-1', ...Array.from({ length: 4 }, (_, i) => `m${i + 1}`)];
	const conns = [];
	for (let i = 0; i < 10; i++) {
		const user = people[i % people.length];
		const conn = await connect(fx.id, { 'x-flarion-dev-actor': user, 'x-flarion-dev-role': user === 'owner-1' ? 'owner' : 'member' });
		const log = conn.rawHello({ subs: views.map((sub, k) => ({ id: `v${k}`, sub })) });
		await log.wait((m) => m.t === 'head');
		conns.push(conn);
	}
	const op = (kind: 'amount' | 'status' | 'notes') => ({
		op: 'setProp' as const,
		page: world.rowIds[r.int(0, world.rowIds.length - 1)],
		prop: kind,
		value: kind === 'amount' ? r.int(0, 1000) : kind === 'notes' ? `e${r.int(0, 1e6)}` : r.pick(world.statusIds)
	});
	for (const kind of ['amount', 'status', 'notes'] as const) {
		for (let i = 0; i < 30; i++) await fx.stub.apply(fx.owner, batch([op(kind)])); // warm
		const out = await runInDurableObject(fx.stub, async (instance: WorkspaceDO, state: DurableObjectState) => {
			const sql = state.storage.sql as unknown as { exec: (...a: unknown[]) => unknown };
			const original = sql.exec;
			const seen: string[] = [];
			const where = new Map<string, Map<string, number>>();
			sql.exec = function (this: unknown, query: unknown, ...rest: unknown[]) {
				seen.push(String(query));
				if (env.VITE_TRACE_WHERE) {
					const key = String(query).replace(/\s+/g, ' ').replace(/\(\?(?:,\s?\?)*\)/g, '(?..)').slice(0, 110);
					const frames = (new Error().stack ?? '').split('\n').slice(2, 9).map((l) => l.trim().replace(/\(.*\/(src\/[^)]*)\)/, '($1)').replace(/^at /, '')).filter((l) => /src\//.test(l)).slice(0, 4).join(' < ');
					const m = where.get(key) ?? new Map();
					m.set(frames, (m.get(frames) ?? 0) + 1);
					where.set(key, m);
				}
				return original.call(this, query, ...rest);
			};
			const N = 100;
			const t0 = now();
			try {
				for (let i = 0; i < N; i++) await instance.apply(fx.owner, batch([op(kind)]));
			} finally {
				sql.exec = original;
			}
			return { seen, ms: (now() - t0) / N, N, where: [...where].map(([k, m]) => [k, [...m]] as const) };
		});
		if (env.VITE_TRACE_WHERE && kind === 'amount')
			for (const [q, ms] of out.where) {
				console.log(`[where] ${q}`);
				for (const [f, n] of [...ms].sort((a, b) => b[1] - a[1]).slice(0, 4)) console.log(`[where]     ${(n / out.N).toFixed(2)}  ${f}`);
			}
		const shapes = new Map<string, number>();
		for (const q of out.seen) {
			const key = q.replace(/\s+/g, ' ').replace(/\(\?(?:,\s?\?)*\)/g, '(?..)').slice(0, 110);
			shapes.set(key, (shapes.get(key) ?? 0) + 1);
		}
		console.log(`[trace] ${kind}: ${out.ms.toFixed(2)} ms per commit, ${(out.seen.length / out.N).toFixed(1)} statements per commit (${shapes.size} shapes)`);
		if (env.VITE_TRACE_PRINT)
			for (const [q, n] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`[trace]   ${(n / out.N).toFixed(2).padStart(6)}  ${q}`);
		// Guard: before the per-commit memos a commit that touched views made 107 statements, 23 to 28 without views.
		expect(out.seen.length / out.N, `${kind} statements per commit`).toBeLessThan(kind === 'notes' ? 35 : 60);
	}
	expect(conns.length).toBe(10);
});
