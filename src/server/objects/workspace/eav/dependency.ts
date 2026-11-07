/**
 * The dependency graph of computed properties (docs/PLAN.md "Relations, rollups and formulas").
 *
 * `dependency(source_prop, target_prop, via_relation)` says: when `source_prop` changes on page P, the value of
 * `target_prop` must be recomputed on the pages `via_relation` leads to from P:
 *
 *   via ''            P itself (a formula reading `source_prop`, a rollup whose relation is `source_prop`)
 *   via R             the pages whose relation R points at P: the reverse scan of `p_ref` on `(R, P)`
 *                     (a rollup of `source_prop` over relation R, a formula reading the titles R points at)
 *   via R:reverse     the pages P's relation R points at (the reverse side of a two-way relation)
 *
 * Rows are written when a rollup or formula is created or updated (`edgesOfProperty`) and read by `afterWrite`.
 * A cycle between properties (whatever the relation hops) is refused when the definition is written
 * (`findCycle`), so the graph stays a DAG and `topoRank` orders recomputation. The table is raw SQL created
 * by `ensureEavLayout` (and lazily by the first definition), like the `file` table: viborm's estate cannot
 * widen the managed tables without `ESTATE_FRESH`.
 */
import { analyzeFormula, envFromProperties } from '../../../../lib/shared/formula';
import { TITLE_PROP_ID, type PropertyDef, type PropertyRegistry } from '../../../../lib/shared/property-types';
import type { WorkspaceDb } from '../../../db/workspace.client';
import { all, run } from './sql';

export interface Edge {
	source: string;
	target: string;
	/** '' (the same page), a relation id, or `<relation id>:reverse`. */
	via: string;
}

export const DEPENDENCY_DDL = [
	`CREATE TABLE IF NOT EXISTS dependency (
		source_prop TEXT NOT NULL,
		target_prop TEXT NOT NULL,
		via_relation TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (source_prop, target_prop, via_relation)
	) WITHOUT ROWID`,
	'CREATE INDEX IF NOT EXISTS dependency_target ON dependency (target_prop)'
] as const;

/** Creates the `dependency` table. Idempotent; synchronous (Workspace DO constructor, tests). */
export function ensureDependencyTable(sql: SqlStorage): void {
	for (const ddl of DEPENDENCY_DDL) sql.exec(ddl);
}

/** The same, through the caller's transaction (the first definition of a rollup or formula). */
export async function ensureDependencyTx(db: WorkspaceDb): Promise<void> {
	for (const ddl of DEPENDENCY_DDL) await run(db, ddl);
}

export async function readEdges(db: WorkspaceDb): Promise<Edge[]> {
	return (await all<{ source_prop: string; target_prop: string; via_relation: string }>(db, 'SELECT source_prop, target_prop, via_relation FROM dependency')).map(
		(r) => ({ source: r.source_prop, target: r.target_prop, via: r.via_relation })
	);
}

/** Replaces every edge into `target` with `edges`. */
export async function replaceEdgesOf(db: WorkspaceDb, target: string, edges: readonly Edge[]): Promise<void> {
	await ensureDependencyTx(db);
	await run(db, 'DELETE FROM dependency WHERE target_prop = ?', target);
	for (const e of edges)
		await run(db, 'INSERT OR IGNORE INTO dependency (source_prop, target_prop, via_relation) VALUES (?,?,?)', e.source, e.target, e.via);
}

export async function deleteEdgesOf(db: WorkspaceDb, target: string): Promise<void> {
	await ensureDependencyTx(db);
	await run(db, 'DELETE FROM dependency WHERE target_prop = ?', target);
}

/** The edges a formula or rollup definition adds (none for other types). */
export function edgesOfProperty(def: PropertyDef, registry: PropertyRegistry & { all(): PropertyDef[] }): Edge[] {
	const out: Edge[] = [];
	// Reading a relation (its membership and the titles it points at) from this property's own page.
	const relation = (rel: PropertyDef, attribute: string): void => {
		const reverse = rel.type === 'relation' ? rel.config.reverseOf : undefined;
		const base = reverse ?? rel.id;
		out.push({ source: base, target: def.id, via: reverse ? rel.id : '' });
		out.push({ source: attribute, target: def.id, via: rel.id });
	};
	if (def.type === 'rollup') {
		const rel = registry.get(def.config.relationProp);
		if (rel) relation(rel, def.config.targetProp);
	} else if (def.type === 'formula') {
		const analysis = analyzeFormula(def.config.expression, envFromProperties(registry.all()));
		if (!analysis.ok) return out;
		const byName = new Map<string, PropertyDef>();
		for (const d of registry.all()) if (!byName.has(d.name)) byName.set(d.name, d);
		for (const name of analysis.deps) {
			const dep = byName.get(name);
			if (!dep) continue;
			if (dep.type === 'relation') relation(dep, TITLE_PROP_ID);
			else out.push({ source: dep.id, target: def.id, via: '' });
		}
	}
	return out;
}

/**
 * The properties of a dependency cycle that adding `newSources -> target` would close, `target` first and last
 * (`['a', 'b', 'a']`), or null. `edges` are the existing edges; those into `target` are about to be replaced
 * and are ignored.
 */
export function findCycle(edges: readonly Edge[], target: string, newSources: readonly string[]): string[] | null {
	const out = new Map<string, string[]>();
	for (const e of edges) {
		if (e.target === target) continue;
		(out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
	}
	const sources = new Set(newSources);
	if (sources.has(target)) return [target, target];
	const parent = new Map<string, string | null>([[target, null]]);
	const queue = [target];
	while (queue.length) {
		const at = queue.shift() as string;
		for (const next of out.get(at) ?? []) {
			if (parent.has(next)) continue;
			parent.set(next, at);
			if (sources.has(next)) {
				const path: string[] = [];
				for (let n: string | null | undefined = next; n !== null && n !== undefined; n = parent.get(n)) path.push(n);
				path.reverse();
				return [...path, target];
			}
			queue.push(next);
		}
	}
	return null;
}

/** Recomputation order: a property's rank is one more than the highest rank among its sources. */
export function topoRank(edges: readonly Edge[]): Map<string, number> {
	const into = new Map<string, Set<string>>();
	for (const e of edges) (into.get(e.target) ?? into.set(e.target, new Set()).get(e.target)!).add(e.source);
	const rank = new Map<string, number>();
	const visiting = new Set<string>();
	const rankOf = (id: string): number => {
		const known = rank.get(id);
		if (known !== undefined) return known;
		// A cycle cannot be stored (refused at definition time); stay finite if one ever is.
		if (visiting.has(id)) return 0;
		visiting.add(id);
		let r = 0;
		for (const s of into.get(id) ?? []) r = Math.max(r, rankOf(s) + 1);
		visiting.delete(id);
		rank.set(id, r);
		return r;
	};
	for (const id of into.keys()) rankOf(id);
	return rank;
}

/** `Total -> Rollup -> Total`, with property names. */
export function describeCycle(path: readonly string[], registry: PropertyRegistry): string {
	const name = (id: string): string => registry.get(id)?.name ?? id;
	return path.map(name).join(' → ');
}
