/**
 * Edit to collaborator's diff (docs/PLAN.md "Security and reliability": target 150 ms p95, same region): the time
 * from the call that writes a property to the moment each OTHER socket receives the diff that carries it, over
 * many writes, with several sockets and shared views. workerd tests run in one process, so this measures the
 * object's own work (commit, incremental view maintenance, fan-out), not the network.
 */
import { describe, expect, test } from 'vitest';
import type { Op } from '../../../src/lib/shared/ops';
import type { ServerMessage, Subscription } from '../../../src/lib/shared/protocol';
import { rng } from '../../unit/shared/helpers';
import { connect } from '../socket/helpers';
import { batch, createOp, createWorkspace, ranks } from '../workspace/helpers';

const env = import.meta.env as Record<string, string | undefined>;
const WRITES = Number(env.VITE_LATENCY_WRITES ?? 300);
const ROWS = 200;
const now = () => performance.now();

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const opt = (id: string) => ({ id, name: id, color: 'default' as const });

describe('edit to collaborator diff', () => {
	test(`p95 stays under 150 ms over ${WRITES} writes, 5 sockets and 5 shared views`, { timeout: 120_000 }, async () => {
		const r = rng(7);
		const ws = await createWorkspace('latency');
		await ws.stub.apply(
			ws.owner,
			batch([
				{ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } },
				{ op: 'createProperty', property: { id: 'prio', name: 'Priority', type: 'select', config: { options: ['p1', 'p2', 'p3'].map(opt) } } },
				{ op: 'createProperty', property: { id: 'done', name: 'Done', type: 'checkbox', config: {} } },
				{ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } }
			])
		);
		const rk = ranks(ROWS + 1);
		await ws.stub.apply(
			ws.owner,
			batch([
				createOp('db', null, rk[0], { teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } }),
				{ op: 'createCollection', id: 'c1', pageId: 'db', sourceAst: { and: [{ prop: '$parent', op: 'is', value: 'db' }] } } as Op,
				...Array.from({ length: ROWS }, (_, i) => createOp(`r${i}`, 'db', rk[i + 1], { values: { title: `Row ${i}`, amount: r.int(0, 100), prio: r.pick(['p1', 'p2', 'p3']), done: r.bool(), notes: `note ${i}` } }))
			])
		);
		const views: Record<string, Subscription> = {
			table: { kind: 'view', collectionId: 'c1', sorts: [{ prop: 'amount', dir: 'desc' }], limit: 50 },
			board: { kind: 'view', collectionId: 'c1', groupBy: { prop: 'prio' }, sorts: [{ prop: 'amount', dir: 'asc' }], limit: 20 },
			open: { kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'done', op: 'is', value: false }] }, sorts: [{ prop: 'title', dir: 'asc' }], limit: 50 },
			big: { kind: 'view', collectionId: 'c1', filter: { and: [{ prop: 'amount', op: 'gt', value: 50 }] }, limit: 30 },
			list: { kind: 'view', collectionId: 'c1', props: ['title', 'notes'], limit: 40 }
		};
		const people = ['owner-1', 'u1', 'u2', 'u3', 'u4'];
		const arrivals = new Map<string, Map<number, number>>();
		const sockets = [];
		for (const user of people) {
			const conn = await connect(ws.id, { 'x-flarion-dev-actor': user, 'x-flarion-dev-role': user === 'owner-1' ? 'owner' : 'member' });
			const seen = new Map<number, number>();
			arrivals.set(user, seen);
			conn.ws.addEventListener('message', (event) => {
				if (typeof event.data !== 'string') return;
				try {
					const m = JSON.parse(event.data) as ServerMessage;
					if (m.t === 'diff' || m.t === 'head') seen.set(m.seq, now());
				} catch {
					// not ours
				}
			});
			const log = conn.rawHello({ subs: Object.entries(views).map(([id, sub]) => ({ id, sub })) });
			await log.wait((m) => m.t === 'head');
			sockets.push(conn);
		}

		const latencies: number[] = [];
		const commits: number[] = [];
		let counter = 0;
		for (let i = 0; i < WRITES; i++) {
			const roll = r.next();
			const row = `r${r.int(0, ROWS - 1)}`;
			const ops: Op[] =
				roll < 0.45
					? [{ op: 'setProp', page: row, prop: 'amount', value: r.int(0, 100) }]
					: roll < 0.7
						? [{ op: 'setProp', page: row, prop: 'prio', value: r.pick(['p1', 'p2', 'p3']) }]
						: roll < 0.85
							? [{ op: 'setProp', page: row, prop: 'done', value: r.bool() }]
							: roll < 0.95
								? [{ op: 'setProp', page: row, prop: 'notes', value: `edit ${i}` }]
								: [createOp(`x${counter++}`, 'db', rk[0], { values: { title: `New ${i}`, amount: r.int(0, 100) } })];
			const t0 = now();
			const { seq } = await ws.stub.apply(ws.owner, batch(ops));
			commits.push(now() - t0);
			// Every collaborator's socket (the writer's own too, but the others are the point).
			for (const user of people) {
				for (let spins = 0; spins < 400 && !(arrivals.get(user)!.get(seq) !== undefined); spins++) await new Promise((res) => setTimeout(res, 1));
				const at = arrivals.get(user)!.get(seq);
				if (at === undefined) throw new Error(`${user} never received seq ${seq}`);
				if (user !== 'owner-1') latencies.push(Math.max(0, at - t0));
			}
		}
		const sorted = [...latencies].sort((a, b) => a - b);
		const report = { writes: WRITES, samples: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), max: sorted.at(-1), commitP50: quantile([...commits].sort((a, b) => a - b), 0.5), commitP95: quantile([...commits].sort((a, b) => a - b), 0.95) };
		if (env.VITE_LATENCY_REPORT) throw new Error(`[latency] ${JSON.stringify(report)}`);
		expect(report.p95).toBeLessThan(150);
		for (const s of sockets) s.ws.close();
	});
});
