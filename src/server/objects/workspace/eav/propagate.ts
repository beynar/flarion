/**
 * Propagation: from what changed to every computed value that depends on it, in dependency order.
 *
 * `afterWrite` turns the records of a batch into a set of "dirty" (property, page) pairs through the edges of the
 * dependency graph (`dependency.ts`), then walks the computed properties by their topological rank: recompute the
 * dirty pages of a property, and for every page whose value actually changed mark its dependents dirty. A
 * property is only visited after everything it reads, so chains (a formula over a rollup over a formula) settle in
 * one pass, and an unchanged value stops the chain. The graph is acyclic by construction (cycles are refused when
 * a definition is written), so the pass always terminates.
 */
import { reverseIdOf, type PropertyDef } from '../../../../lib/shared/property-types';
import type { WorkspaceDb } from '../../../db/workspace.client';
import { Computer, PageStore, formulaUsesNow } from './compute';
import { readEdges, topoRank, type Edge } from './dependency';
import type { ChangeRecord, EavOpContext } from './index';
import { loadEavRegistry, type EavRegistry } from './registry';
import { MAX_PARAMS, all, chunks, qmarks } from './sql';

export const isComputedDef = (d: PropertyDef): boolean => d.type === 'formula' || d.type === 'rollup';

/** Whether the workspace has anything to recompute: the fast path of every write. */
export const hasComputed = (registry: EavRegistry): boolean => registry.all().some(isComputedDef);

export class Dirty {
	readonly byProp = new Map<string, Set<number>>();
	add(prop: string, nums: Iterable<number>): void {
		let set = this.byProp.get(prop);
		for (const n of nums) {
			set ??= this.byProp.set(prop, new Set()).get(prop)!;
			set.add(n);
		}
	}
}

/** The pages `via` leads to from `nums`: see `dependency.ts`. */
export async function resolveVia(db: WorkspaceDb, registry: EavRegistry, via: string, nums: readonly number[]): Promise<number[]> {
	if (via === '' || nums.length === 0) return [...nums];
	const rel = registry.get(via);
	if (!rel || rel.type !== 'relation') return [];
	const out = new Set<number>();
	const reverse = rel.config.reverseOf;
	const prop = registry.num(reverse ?? via);
	if (prop === undefined) return [];
	for (const part of chunks([...new Set(nums)], MAX_PARAMS - 1)) {
		if (reverse) {
			// The pages P's relation points at.
			for (const r of await all<{ v: string }>(db, `SELECT DISTINCT v FROM p_ref WHERE prop = ? AND page IN (${qmarks(part.length)})`, prop, ...part)) out.add(Number(r.v));
		} else {
			// The pages whose relation points at P: the reverse range scan of `(prop, v)`.
			for (const r of await all<{ page: number }>(db, `SELECT DISTINCT page FROM p_ref WHERE prop = ? AND v IN (${qmarks(part.length)})`, prop, ...part.map(String))) out.add(r.page);
		}
	}
	return [...out];
}

export interface Graph {
	edges: Edge[];
	bySource: Map<string, Edge[]>;
	rank: Map<string, number>;
}

export async function loadGraph(db: WorkspaceDb): Promise<Graph> {
	const edges = await readEdges(db);
	const bySource = new Map<string, Edge[]>();
	for (const e of edges) (bySource.get(e.source) ?? bySource.set(e.source, []).get(e.source)!).push(e);
	return { edges, bySource, rank: topoRank(edges) };
}

export async function allPageNums(db: WorkspaceDb): Promise<number[]> {
	return (await all<{ num: number }>(db, 'SELECT num FROM page ORDER BY num')).map((r) => r.num);
}

export interface Pass {
	db: WorkspaceDb;
	registry: EavRegistry;
	ctx: EavOpContext;
	store: PageStore;
	graph: Graph;
	dirty: Dirty;
}

export async function startPass(db: WorkspaceDb, ctx: EavOpContext): Promise<Pass> {
	const registry = await loadEavRegistry(db);
	return { db, registry, ctx, store: new PageStore(db), graph: await loadGraph(db), dirty: new Dirty() };
}

/** Marks the dependents of `prop` changed on `nums` (the pages `via` leads to), `extra` being former targets. */
export async function markDependents(pass: Pass, prop: string, nums: readonly number[], extraFor?: (edge: Edge) => number[]): Promise<void> {
	for (const e of pass.graph.bySource.get(prop) ?? []) {
		const pages = await resolveVia(pass.db, pass.registry, e.via, nums);
		const extra = extraFor?.(e);
		pass.dirty.add(e.target, extra?.length ? [...pages, ...extra] : pages);
	}
}

/** Walks the computed properties in dependency order, recomputing the dirty pages. Returns the records written. */
export async function runPass(pass: Pass): Promise<ChangeRecord[]> {
	const { registry, graph, dirty } = pass;
	const computer = new Computer(pass.db, registry, pass.ctx, pass.store);
	const order = registry
		.all()
		.filter(isComputedDef)
		.sort((a, b) => (graph.rank.get(a.id) ?? 0) - (graph.rank.get(b.id) ?? 0));
	const out: ChangeRecord[] = [];
	for (const def of order) {
		const pages = dirty.byProp.get(def.id);
		if (!pages?.size) continue;
		dirty.byProp.delete(def.id);
		const records = await computer.recompute(def, [...pages].sort((a, b) => a - b));
		out.push(...records);
		if (records.length === 0) continue;
		const nums = records.map((r) => pass.store.byId.get(r.page as string)?.num).filter((n): n is number => n !== undefined);
		await markDependents(pass, def.id, nums);
	}
	return out;
}

/** Recomputes one computed property on `nums` (default: every page), then everything that depends on it. */
export async function recomputeProperty(db: WorkspaceDb, ctx: EavOpContext, propId: string, nums?: readonly number[]): Promise<ChangeRecord[]> {
	const pass = await startPass(db, ctx);
	pass.dirty.add(propId, nums ?? (await allPageNums(db)));
	return runPass(pass);
}

// ───────────────────────────── seeds ─────────────────────────────

const parseIds = (x: unknown): string[] => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : typeof x === 'string' ? [x] : []);

/** Every page of the subtree of `root` (itself included) that is live or whose trash root is `root`. */
async function affectedByTrash(db: WorkspaceDb, root: string, restored: boolean): Promise<number[]> {
	const rows = restored
		? await all<{ num: number }>(
				db,
				`WITH RECURSIVE sub(id) AS (SELECT id FROM page WHERE id = ? UNION SELECT p.id FROM page p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL)
				 SELECT num FROM page WHERE id IN (SELECT id FROM sub)`,
				root
			)
		: await all<{ num: number }>(db, 'SELECT num FROM page WHERE trash_root = ? OR id = ?', root, root);
	return rows.map((r) => r.num);
}

const optionNames = (def: PropertyDef | undefined): string =>
	def && (def.type === 'select' || def.type === 'multi_select' || def.type === 'status') ? JSON.stringify(def.config.options.map((o) => [o.id, o.name])) : '';

/**
 * Seeds a pass from the records of a batch: what each one makes dirty. Handled records: `setProp` (the property
 * changed on the page, and the page's last-edited stamp), `create` (every computed property of the new page),
 * `trash` and `restore` (rollups and formulas reading the page through a relation, and now-formulas of a restored
 * page), `updateProperty` (option renames reach the properties that read the option names), `setPage` and `move`
 * (the last-edited stamp that formulas may read).
 */
export async function seedFromRecords(pass: Pass, records: readonly ChangeRecord[]): Promise<void> {
	const { registry, graph, store } = pass;
	await store.ensureIds(records.flatMap((r) => (r.page ? [r.page] : [])));
	const computed = registry.all().filter(isComputedDef);
	const stamps = registry.all().filter((d) => d.type === 'last_edited_time' || d.type === 'last_edited_by');
	const stampEdges = stamps.some((d) => graph.bySource.has(d.id));
	for (const rec of records) {
		const page = rec.page ? store.byId.get(rec.page) : undefined;
		switch (rec.kind) {
			case 'setProp': {
				if (!page || !rec.prop) break;
				const def = registry.get(rec.prop);
				let old: number[] = [];
				if (def?.type === 'relation' && !def.config.reverseOf) {
					// Pages the relation used to point at lose (or keep) this page in their reverse side.
					const ids = parseIds(rec.old);
					await store.ensureIds(ids);
					old = ids.map((id) => store.byId.get(id)?.num).filter((n): n is number => n !== undefined);
				}
				await markDependents(pass, rec.prop, [page.num], (e) => (e.via === reverseIdOf(rec.prop as string) ? old : []));
				if (stampEdges && !(def && isComputedDef(def))) for (const s of stamps) await markDependents(pass, s.id, [page.num]);
				break;
			}
			case 'create':
				if (page) for (const def of computed) pass.dirty.add(def.id, [page.num]);
				break;
			case 'setPage':
			case 'move':
				// Touching a page moves its last-edited stamp.
				if (page && stampEdges) for (const s of stamps) await markDependents(pass, s.id, [page.num]);
				break;
			case 'trash':
			case 'restore': {
				if (!rec.page) break;
				const nums = await affectedByTrash(pass.db, rec.page, rec.kind === 'restore');
				for (const e of graph.edges) if (e.via !== '') pass.dirty.add(e.target, await resolveVia(pass.db, registry, e.via, nums));
				if (rec.kind === 'restore') for (const def of computed) if (formulaUsesNow(def, registry)) pass.dirty.add(def.id, nums);
				break;
			}
			case 'updateProperty': {
				if (!rec.prop) break;
				const before = rec.old as PropertyDef | undefined;
				const after = rec.new as PropertyDef | undefined;
				if (optionNames(before) === optionNames(after)) break;
				// Renamed options change what every page's formulas and rollups read.
				const everyone = await allPageNums(pass.db);
				for (const e of graph.bySource.get(rec.prop) ?? []) pass.dirty.add(e.target, everyone);
				break;
			}
			default:
		}
	}
}

/** `afterWrite`: see the seam's documentation in `index.ts`. */
export async function afterWriteImpl(db: WorkspaceDb, records: readonly ChangeRecord[], ctx: EavOpContext): Promise<ChangeRecord[]> {
	if (records.length === 0) return [];
	const registry = await loadEavRegistry(db);
	if (!hasComputed(registry)) return [];
	const pass = await startPass(db, ctx);
	await seedFromRecords(pass, records);
	return runPass(pass);
}
