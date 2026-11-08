/**
 * Scale harness for P4 profiling (docs/spikes/p4-scale.md): a real Workspace Durable Object holding a large
 * database (20k to 50k pages with select, status, person and tag properties), seeded straight into its storage
 * through the EAV write path (the same typed rows, per-value counts and `props_json` a `create` op writes, minus
 * the per-op policy and change-log cost, which a seed does not need), plus a generator of many distinct shared
 * views. `tests/workers/scale/profile.test.ts` measures filters, fan-out, commit cost and state sizes on it.
 */
import { runInDurableObject } from 'cloudflare:test';
import type { FilterGroup, GroupBySpec, SortSpec } from '../../../src/lib/shared/filter-ast';
import type { Op } from '../../../src/lib/shared/ops';
import type { Subscription } from '../../../src/lib/shared/protocol';
import type { PropertyDef } from '../../../src/lib/shared/property-types';
import { evenRanks } from '../../../src/lib/shared/sort-keys';
import { createWorkspaceClient } from '../../../src/server/db/workspace.client';
import { applyEavOp, loadEavRegistry, writeInitialValues } from '../../../src/server/objects/workspace/eav';
import { invalidateRegistry } from '../../../src/server/objects/workspace/eav/registry';
import type { WorkspaceDO } from '../../../src/server/objects/workspace/workspace-do';
import type { Rng } from '../../unit/shared/helpers';
import { batch, createOp, createWorkspace, ranks, type Fixture } from '../workspace/helpers';

const opt = (id: string) => ({ id, name: id.toUpperCase(), color: 'default' as const });
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

export interface ScaleSpec {
	pages: number;
	/** Distinct people (`assignee`). */
	people: number;
	/** Distinct tag options. */
	tags: number;
}

export interface ScaleWorld {
	fx: Fixture;
	dbId: string;
	collectionId: string;
	spec: ScaleSpec;
	statusIds: string[];
	prioIds: string[];
	tagIds: string[];
	userIds: string[];
	/** Page ids that are rows of the database, in `num` order. */
	rowIds: string[];
	seedMs: number;
}

export const statusDef = (): PropertyDef => ({ id: 'status', name: 'Status', type: 'status', config: { options: [], groups: [] } });

export const scaleDefs = (spec: ScaleSpec): PropertyDef[] => [
	statusDef(),
	{ id: 'prio', name: 'Priority', type: 'select', config: { options: ids('p', 5).map(opt) } },
	{ id: 'assignee', name: 'Assignee', type: 'person', config: {} },
	{ id: 'tags', name: 'Tags', type: 'multi_select', config: { options: ids('t', spec.tags).map(opt) } },
	{ id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } },
	{ id: 'done', name: 'Done', type: 'checkbox', config: {} },
	{ id: 'notes', name: 'Notes', type: 'text', config: {} },
	{ id: 'created', name: 'Created', type: 'created_time', config: {} }
];

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'plan', 'bug', 'launch', 'review', 'epsilon', 'zeta', 'roadmap', 'spec'];
const chunk = <T>(xs: readonly T[], n: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
	return out;
};

/** A workspace with the database page, its collection and `spec.pages` rows. */
export async function seedScale(label: string, spec: ScaleSpec, r: Rng): Promise<ScaleWorld> {
	const fx = await createWorkspace(label);
	const defs = scaleDefs(spec);
	const dbId = 'db';
	const collectionId = 'c1';
	const rk = ranks(1);
	await fx.stub.apply(fx.owner, batch(defs.map((property) => ({ op: 'createProperty', property }) as Op)));
	await fx.stub.apply(
		fx.owner,
		batch([
			createOp(dbId, null, rk[0], { teamspaceId: fx.generalId, isDatabase: true, values: { title: 'Tasks' } }),
			{ op: 'createCollection', id: collectionId, pageId: dbId, sourceAst: { and: [{ prop: '$parent', op: 'is', value: dbId }] } } as Op
		])
	);
	const t0 = performance.now();
	const userIds = Array.from({ length: spec.people }, (_, i) => `u${i + 1}`);
	const rowIds = Array.from({ length: spec.pages }, (_, i) => `r${i.toString(36).padStart(5, '0')}`);
	const world: Omit<ScaleWorld, 'statusIds' | 'prioIds' | 'tagIds'> = { fx, dbId, collectionId, spec, userIds, rowIds, seedMs: 0 };

	const out = await runInDurableObject(fx.stub, async (_instance: WorkspaceDO, state: DurableObjectState) => {
		const db = createWorkspaceClient(state.storage);
		invalidateRegistry();
		const registry = await loadEavRegistry(db);
		const options = (id: string) => ((registry.get(id) as { config: { options: { id: string }[] } }).config.options ?? []).map((o) => o.id);
		const statusIds = options('status');
		const prioIds = options('prio');
		const tagIds = options('tags');
		const rankPool = evenRanks(32);
		const base = Date.UTC(2026, 0, 1);
		const day = 86_400_000;
		const ctx = { actorId: 'owner-1', now: base + 200 * day };
		// Skew like real data: most tasks sit in a couple of statuses, a long tail of people and tags.
		const pickStatus = () => statusIds[r.next() < 0.5 ? 0 : r.next() < 0.6 ? 1 : r.int(0, statusIds.length - 1)];
		const zipf = <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(xs.length * r.next() ** 2))];
		let num = 3; // the database page took 1 and 2 is "Getting started"
		const [{ n: pageCount }] = state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM page').toArray();
		num = pageCount + 1;
		for (const part of chunk(rowIds, 100)) {
			const rows = part.map((id, i) => {
				const created = base + r.int(0, 190 * day);
				return [id, num + i, dbId, r.pick(rankPool), fx.generalId, 'owner-1', new Date(created).toISOString(), 'owner-1', new Date(created + r.int(0, day)).toISOString()];
			});
			num += part.length;
			for (const sub of chunk(rows, 10)) {
				state.storage.sql.exec(
					`INSERT INTO page (id, num, parent_id, rank, teamspace_id, title, created_by, created_at, updated_by, updated_at, props_json) VALUES ${sub.map(() => "(?,?,?,?,?,'',?,?,?,?,'{}')").join(',')}`,
					...sub.flat()
				);
			}
			await db.$transaction(async (tx) => {
				for (const id of part) {
					const values: Record<string, unknown> = { title: `${r.pick(WORDS)} ${r.pick(WORDS)} ${id}` };
					values.status = pickStatus();
					if (r.bool(0.9)) values.prio = r.pick(prioIds);
					if (r.bool(0.85)) values.assignee = r.bool(0.15) ? [zipf(userIds), zipf(userIds)].filter((u, i, a) => a.indexOf(u) === i) : [zipf(userIds)];
					if (r.bool(0.6)) values.tags = Array.from({ length: r.int(1, 3) }, () => zipf(tagIds)).filter((t, i, a) => a.indexOf(t) === i);
					if (r.bool(0.8)) values.amount = r.int(0, 1000);
					values.done = r.bool(0.3);
					if (r.bool(0.5)) values.notes = `${r.pick(WORDS)} ${r.pick(WORDS)}`;
					await writeInitialValues(tx, id, values as never, ctx);
				}
			});
		}
		state.storage.sql.exec(
			"INSERT INTO meta (key, value) VALUES ('nextPageNum', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			JSON.stringify(num)
		);
		invalidateRegistry();
		return { statusIds, prioIds, tagIds };
	});
	return { ...world, ...out, seedMs: performance.now() - t0 };
}

// ───────────────────────────── views ─────────────────────────────

type View = Extract<Subscription, { kind: 'view' }>;

/**
 * `count` distinct view subscriptions over the database: filters on status, priority, people and tags (the
 * properties the plan says the bitmaps are for), a few sorts, boards grouped by status. Distinct on purpose: each
 * becomes its own shared unit, so this is "many open views", the worst case of a hot `status` write.
 */
export function scaleViews(world: ScaleWorld, count: number, r: Rng): View[] {
	const out: View[] = [];
	const sorts: (SortSpec[] | undefined)[] = [undefined, [{ prop: 'amount', dir: 'desc' }], [{ prop: 'title', dir: 'asc' }], [{ prop: 'created', dir: 'desc' }]];
	const seen = new Set<string>();
	let guard = 0;
	while (out.length < count && guard++ < count * 20) {
		const kind = r.int(0, 8);
		const status = r.pick(world.statusIds);
		const filter: FilterGroup =
			kind === 0
				? { and: [{ prop: 'status', op: 'is', value: status }] }
				: kind === 1
					? { and: [{ prop: 'status', op: 'is_not', value: status }] }
					: kind === 2
						? { and: [{ prop: 'status', op: 'is', value: status }, { prop: 'assignee', op: 'contains', value: r.pick(world.userIds) }] }
						: kind === 3
							? { and: [{ prop: 'prio', op: 'is', value: r.pick(world.prioIds) }, { prop: 'status', op: 'is_not', value: status }] }
							: kind === 4
								? { and: [{ prop: 'tags', op: 'contains', value: r.pick(world.tagIds) }] }
								: kind === 5
									? { or: [{ prop: 'status', op: 'is', value: status }, { prop: 'status', op: 'is', value: r.pick(world.statusIds) }] }
									: kind === 6
										? { and: [{ prop: 'assignee', op: 'contains', value: r.pick(world.userIds) }, { prop: 'done', op: 'is', value: false }] }
										: kind === 7
											? { and: [{ prop: 'status', op: 'is', value: status }, { prop: 'amount', op: 'gt', value: r.int(100, 900) }] }
											: { and: [{ prop: 'tags', op: 'not_contains', value: r.pick(world.tagIds) }, { prop: 'prio', op: 'is', value: r.pick(world.prioIds) }] };
		const groupBy: GroupBySpec | undefined = r.int(0, 5) === 0 ? { prop: 'status' } : undefined;
		const sub: View = {
			kind: 'view',
			collectionId: world.collectionId,
			filter,
			sorts: sorts[r.int(0, sorts.length - 1)],
			...(groupBy ? { groupBy } : {}),
			limit: 50
		};
		const key = JSON.stringify([sub.filter, sub.sorts, sub.groupBy]);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(sub);
	}
	return out;
}

export const quantile = (sorted: readonly number[], q: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
export const stats = (xs: readonly number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const sum = s.reduce((a, b) => a + b, 0);
	return { n: s.length, mean: s.length ? sum / s.length : 0, p50: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99), max: s.at(-1) ?? 0 };
};
export const fmt = (x: number) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
