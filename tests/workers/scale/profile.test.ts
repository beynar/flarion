/**
 * P4 profiling harness (docs/PLAN.md "Performance, limits and scaling": "Add Roaring bitmaps ... when profiling
 * shows filters or fan-out dominating"). One workspace with many pages and many open shared views; measures
 *
 *   1. filter evaluation in the engine (one-shot `runQuery` over the whole database; the candidate checks the live
 *      loop makes, `matchesFilterMany`), per property type the bitmaps are meant for;
 *   2. the cold first window of a view (evaluating a unit nobody watched yet);
 *   3. fan-out per write: a hot `status` write against every open view, commit alone vs commit plus fan-out, and
 *      where the fan-out spends its time (`liveStats().perf`);
 *   4. state held for the live loop (bytes of unit state, which is also what the isolate keeps in memory).
 *
 * Defaults are a small smoke run (a few thousand pages: seconds). The real profile:
 *
 *   pnpm scale:profile                         # 20,000 pages
 *   VITE_SCALE_PAGES=50000 pnpm scale:profile  # 50,000 pages
 *
 * Variables: VITE_SCALE_PAGES, VITE_SCALE_VIEWS (distinct shared views), VITE_SCALE_SOCKETS (sockets, each
 * subscribed to VITE_SCALE_SUBS views), VITE_SCALE_WRITES (writes per kind), VITE_SCALE_REPORT=1 (print the
 * machine-readable report), VITE_SCALE_MODES (`sql,bitmaps` by default: the same run on a fresh workspace with the option
 * index, the visibility and membership bitmaps off, then on; `bitmaps` alone to skip the first). Results are printed,
 * never asserted, except that the live state is exact after the writes.
 */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { FilterGroup } from '../../../src/lib/shared/filter-ast';
import type { Op } from '../../../src/lib/shared/ops';
import type { ServerMessage } from '../../../src/lib/shared/protocol';
import { ensureRoaring, setRoaringEnabled } from '../../../src/server/bitmaps/roaring';
import { createWorkspaceClient } from '../../../src/server/db/workspace.client';
import { matchesFilterMany, runQuery } from '../../../src/server/engine';
import type { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';
import { rng } from '../../unit/shared/helpers';
import { connect, type Connection } from '../socket/helpers';
import { batch } from '../workspace/helpers';
import { fmt, scaleViews, seedScale, stats } from './harness';

const env = import.meta.env as Record<string, string | undefined>;
const PAGES = Number(env.VITE_SCALE_PAGES ?? 3000);
const VIEWS = Number(env.VITE_SCALE_VIEWS ?? 60);
const SOCKETS = Number(env.VITE_SCALE_SOCKETS ?? 12);
const SUBS = Number(env.VITE_SCALE_SUBS ?? 8);
const ACTORS = Number(env.VITE_SCALE_ACTORS ?? 5);
const WRITES = Number(env.VITE_SCALE_WRITES ?? 40);
const MODES = (env.VITE_SCALE_MODES ?? 'sql,bitmaps').split(',') as ('sql' | 'bitmaps')[];
const now = () => performance.now();
const line = (label: string, s: ReturnType<typeof stats>, extra = '') =>
	console.log(`[scale] ${label.padEnd(46)} n=${String(s.n).padStart(4)} mean ${fmt(s.mean).padStart(7)} p50 ${fmt(s.p50).padStart(7)} p95 ${fmt(s.p95).padStart(7)} p99 ${fmt(s.p99).padStart(7)} max ${fmt(s.max).padStart(7)} ms${extra}`);

describe('scale profile', () => {
	for (const mode of MODES)
	test(`${PAGES} pages, ${VIEWS} shared views, ${SOCKETS} sockets, ${ACTORS} people, ${mode === 'sql' ? 'SQL paths' : 'bitmaps'}`, { timeout: 1_800_000 }, async () => {
		await ensureRoaring();
		setRoaringEnabled(mode === 'bitmaps');
		console.log(`[scale] ===== mode: ${mode === 'sql' ? 'SQL paths (bitmaps off)' : 'bitmaps on'} =====`);
		const r = rng(42);
		const world = await seedScale('scale', { pages: PAGES, people: 60, tags: 24 }, r);
		const { fx } = world;
		const report: Record<string, unknown> = { mode, pages: PAGES, views: VIEWS, sockets: SOCKETS, subsPerSocket: SUBS, seedMs: Math.round(world.seedMs) };
		console.log(`[scale] seeded ${PAGES} pages in ${fmt(world.seedMs)} ms`);

		// ───────────── 1. filter evaluation in the engine ─────────────
		const filters: [string, FilterGroup][] = [
			['status is X (hot value)', { and: [{ prop: 'status', op: 'is', value: world.statusIds[0] }] }],
			['status is Y (cold value)', { and: [{ prop: 'status', op: 'is', value: world.statusIds[2] }] }],
			['status is not X', { and: [{ prop: 'status', op: 'is_not', value: world.statusIds[0] }] }],
			['prio is p2', { and: [{ prop: 'prio', op: 'is', value: world.prioIds[1] }] }],
			['assignee contains u1 (hot)', { and: [{ prop: 'assignee', op: 'contains', value: 'u1' }] }],
			['assignee contains u40 (cold)', { and: [{ prop: 'assignee', op: 'contains', value: 'u40' }] }],
			['tags contains t1', { and: [{ prop: 'tags', op: 'contains', value: world.tagIds[0] }] }],
			['status is X and assignee contains u2', { and: [{ prop: 'status', op: 'is', value: world.statusIds[0] }, { prop: 'assignee', op: 'contains', value: 'u2' }] }],
			['(status X or Y) and prio p1 and tags not t3', { and: [{ or: [{ prop: 'status', op: 'is', value: world.statusIds[0] }, { prop: 'status', op: 'is', value: world.statusIds[1] }] }, { prop: 'prio', op: 'is', value: world.prioIds[0] }, { prop: 'tags', op: 'not_contains', value: world.tagIds[2] }] }]
		];
		const engine = await runInDurableObject(fx.stub, async (_i: WorkspaceDO, state: DurableObjectState) => {
			const db = createWorkspaceClient(state.storage);
			const out: Record<string, unknown> = {};
			const full: Record<string, { ms: number; total: number }> = {};
			const cand: Record<string, { one: number; ten: number; forty: number }> = {};
			const nums = world.rowIds.map((_, i) => i + 3);
			for (const [name, filter] of filters) {
				const opts = { visible: null, now: Date.now(), collectionId: world.collectionId, window: { offset: 0, limit: 50 }, me: 'owner-1' };
				const times: number[] = [];
				let total = 0;
				for (let i = 0; i < 3; i++) {
					const t0 = now();
					const res = await runQuery(db, { filter, sorts: [{ prop: 'amount', dir: 'desc' }] }, opts);
					times.push(now() - t0);
					total = res.total;
				}
				full[name] = { ms: Math.min(...times), total };
				const sample = (k: number) => Array.from({ length: k }, () => nums[r.int(0, nums.length - 1)]);
				const timeMany = async (k: number) => {
					const ts: number[] = [];
					for (let i = 0; i < 20; i++) {
						const pageNums = sample(k);
						const t0 = now();
						await matchesFilterMany(db, filter, pageNums, { now: Date.now(), collectionId: world.collectionId, me: 'owner-1' });
						ts.push(now() - t0);
					}
					return stats(ts).p50;
				};
				cand[name] = { one: await timeMany(1), ten: await timeMany(10), forty: await timeMany(40) };
				console.log(`[scale] filter ${name.padEnd(46)} full query ${fmt(full[name].ms).padStart(7)} ms (matches ${full[name].total})   candidate check p50: 1 page ${fmt(cand[name].one)} ms, 10 pages ${fmt(cand[name].ten)} ms, 40 pages ${fmt(cand[name].forty)} ms`);
			}
			out.full = full;
			out.candidates = cand;
			return out;
		});
		report.engine = engine;

		// ───────────── 2 + 3. sockets, cold first windows, fan-out ─────────────
		const views = scaleViews(world, VIEWS, r);
		expect(views.length).toBeGreaterThanOrEqual(Math.min(VIEWS, 8));
		// The sockets are spread over this many people: the server derives one diff per person and view shape, so 5 people is the sharing
		// case; `VITE_SCALE_ACTORS=40` (one person per socket) is the case without sharing.
		const people = ['owner-1', ...Array.from({ length: ACTORS - 1 }, (_, i) => `m${i + 1}`)];
		const sockets: { conn: Connection; user: string; snapshotsAt: Map<string, number>; frames: number }[] = [];
		const firstWindows: number[] = [];
		const coldWindows: number[] = [];
		const seenUnits = new Set<string>();
		const t0 = now();
		for (let i = 0; i < SOCKETS; i++) {
			const user = people[i % people.length];
			const conn = await connect(fx.id, { 'x-flarion-dev-actor': user, 'x-flarion-dev-role': user === 'owner-1' ? 'owner' : 'member' });
			const mine = Array.from({ length: SUBS }, (_, k) => views[(i * 3 + k * 7) % views.length]).filter((v, k, a) => a.indexOf(v) === k);
			const entry = { conn, user, snapshotsAt: new Map<string, number>(), frames: 0 };
			conn.ws.addEventListener('message', (event) => {
				entry.frames++;
				if (typeof event.data !== 'string' || !event.data.includes('"snapshot"')) return;
				try {
					const m = JSON.parse(event.data) as ServerMessage;
					if (m.t === 'snapshot') entry.snapshotsAt.set(m.id, now());
				} catch {
					// not ours
				}
			});
			const started = now();
			const log = conn.rawHello({ subs: mine.map((sub, k) => ({ id: `v${k}`, sub })) });
			await log.wait((m) => m.t === 'head');
			const elapsed = now() - started;
			// First sockets evaluate units nobody watched (cold); later ones share them (warm).
			const cold = mine.some((sub) => !seenUnits.has(JSON.stringify([sub.filter, sub.sorts, sub.groupBy])));
			for (const sub of mine) seenUnits.add(JSON.stringify([sub.filter, sub.sorts, sub.groupBy]));
			(cold ? coldWindows : firstWindows).push(elapsed / mine.length);
			sockets.push(entry);
		}
		console.log(`[scale] ${SOCKETS} sockets x ${SUBS} views connected in ${fmt(now() - t0)} ms, ${seenUnits.size} distinct units`);
		line('hello + first windows, per view (cold unit)', stats(coldWindows));
		line('hello + first windows, per view (shared unit)', stats(firstWindows));
		report.coldFirstWindowMsPerView = stats(coldWindows);
		report.sharedFirstWindowMsPerView = stats(firstWindows);

		const initial = await fx.stub.liveStats({ resetPerf: true, stale: false });
		console.log(`[scale] live state: ${initial.units} units, ${initial.streams} streams`);

		const sizes = await runInDurableObject(fx.stub, async (_i: WorkspaceDO, state: DurableObjectState) => {
			const sql = state.storage.sql;
			const unit = sql.exec<{ n: number; bytes: number; biggest: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(ids)),0) AS bytes, COALESCE(MAX(LENGTH(ids)),0) AS biggest FROM sub_unit WHERE kind = 'view'").toArray()[0];
			const db = sql.databaseSize;
			return { unitBytes: unit.bytes, biggestUnitBytes: unit.biggest, unitCount: unit.n, databaseBytes: db };
		});
		const live = await fx.stub.liveStats({ stale: false });
		report.bitmapBytes = live.bitmaps?.bytes ?? null;
		console.log(`[scale] option index: ${live.bitmaps ? `${live.bitmaps.loaded.length} properties, ${(live.bitmaps.bytes / 1024).toFixed(1)} KB` : 'off'}`);
		console.log(`[scale] unit state: ${(sizes.unitBytes / 1e6).toFixed(2)} MB over ${sizes.unitCount} view units (biggest ${(sizes.biggestUnitBytes / 1e6).toFixed(2)} MB), database ${(sizes.databaseBytes / 1e6).toFixed(1)} MB`);
		report.state = sizes;

		const writeKinds: [string, () => Op[]][] = [
			['status write (hot property)', () => [{ op: 'setProp', page: world.rowIds[r.int(0, world.rowIds.length - 1)], prop: 'status', value: r.pick(world.statusIds) }]],
			['assignee write', () => [{ op: 'setProp', page: world.rowIds[r.int(0, world.rowIds.length - 1)], prop: 'assignee', value: [`u${r.int(1, 60)}`] }]],
			['amount write (sorted by, filtered by few)', () => [{ op: 'setProp', page: world.rowIds[r.int(0, world.rowIds.length - 1)], prop: 'amount', value: r.int(0, 1000) }]],
			['notes write (no view reads it)', () => [{ op: 'setProp', page: world.rowIds[r.int(0, world.rowIds.length - 1)], prop: 'notes', value: `edit ${r.int(0, 1e6)}` }]],
			['batch of 20 status writes', () => Array.from({ length: 20 }, () => ({ op: 'setProp', page: world.rowIds[r.int(0, world.rowIds.length - 1)], prop: 'status', value: r.pick(world.statusIds) }) as Op)]
		];
		const fanout: Record<string, unknown> = {};
		for (const [name, make] of writeKinds) {
			await fx.stub.liveStats({ resetPerf: true, stale: false });
			const total: number[] = [];
			for (let i = 0; i < WRITES; i++) {
				const t = now();
				await fx.stub.apply(fx.owner, batch(make()));
				total.push(now() - t);
			}
			const { perf } = await fx.stub.liveStats({ resetPerf: true, stale: false });
			const per = (x: number) => x / Math.max(1, perf.fanOuts);
			line(`${name}`, stats(total), `   | per commit: fan-out ${fmt(per(perf.totalMs))} = maintain ${fmt(per(perf.maintainMs))} + derive ${fmt(per(perf.deriveMs))} + send ${fmt(per(perf.sendMs))}; ${fmt(perf.unitsMaintained / perf.fanOuts)} units maintained, ${fmt(perf.subsDerived / perf.fanOuts)} subs touched, ${fmt(perf.derivationsShared / perf.fanOuts)} of them shared`);
			fanout[name] = { total: stats(total), perCommit: { fanOutMs: per(perf.totalMs), maintainMs: per(perf.maintainMs), deriveMs: per(perf.deriveMs), sendMs: per(perf.sendMs), unitsMaintained: perf.unitsMaintained / perf.fanOuts, subsDerived: perf.subsDerived / perf.fanOuts, derivationsShared: perf.derivationsShared / perf.fanOuts } };
		}
		report.fanout = fanout;

		const final = await fx.stub.liveStats({ stale: true });
		report.staleUnits = final.stale.length;
		expect(final.stale, 'live units equal a fresh evaluation after the profile writes').toEqual([]);

		// Commit alone: the same status writes with nobody listening (no streams -> no fan-out work).
		for (const s of sockets) s.conn.ws.close();
		await new Promise((res) => setTimeout(res, 200));
		const alone: number[] = [];
		for (let i = 0; i < WRITES; i++) {
			const t = now();
			await fx.stub.apply(fx.owner, batch([{ op: 'setProp', page: world.rowIds[r.int(0, world.rowIds.length - 1)], prop: 'status', value: r.pick(world.statusIds) }]));
			alone.push(now() - t);
		}
		line('status write, no sockets (commit alone)', stats(alone));
		report.commitAlone = stats(alone);

		if (env.VITE_SCALE_REPORT) console.log(`[scale-report] ${JSON.stringify(report)}`);
	});
});
