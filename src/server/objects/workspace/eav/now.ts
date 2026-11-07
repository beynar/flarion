/**
 * Formulas that read the clock: `usesNow` (view validation refuses one as a view's primary sort, because its value
 * changes without any write) and `recomputeNowFormulas` (the hourly alarm).
 */
import type { PropertyDef } from '../../../../lib/shared/property-types';
import type { WorkspaceClient, WorkspaceDb } from '../../../db/workspace.client';
import { formulaUsesNow } from './compute';
import { readEdges } from './dependency';
import type { ChangeRecord, EavOpContext } from './index';
import { hasComputed, isComputedDef, runPass, startPass } from './propagate';
import { loadEavRegistry } from './registry';
import { all } from './sql';

/**
 * Whether the value of a property changes with the clock: a formula that reads `now()` or `today()`, or a
 * formula or rollup that reads one (through any chain of properties). Everything else is false.
 */
export async function usesNow(db: WorkspaceDb, propId: string): Promise<boolean> {
	const registry = await loadEavRegistry(db);
	const def = registry.get(propId);
	if (!def || !isComputedDef(def)) return false;
	const edges = await readEdges(db);
	const into = new Map<string, string[]>();
	for (const e of edges) (into.get(e.target) ?? into.set(e.target, []).get(e.target)!).push(e.source);
	const seen = new Set<string>();
	const walk = (id: string): boolean => {
		if (seen.has(id)) return false;
		seen.add(id);
		const d = registry.get(id);
		if (d && formulaUsesNow(d, registry)) return true;
		return (into.get(id) ?? []).some(walk);
	};
	return walk(propId);
}

/** The formulas that read the clock directly. */
export async function nowFormulas(db: WorkspaceDb): Promise<PropertyDef[]> {
	const registry = await loadEavRegistry(db);
	return registry.all().filter((d) => d.type === 'formula' && formulaUsesNow(d, registry));
}

/**
 * Recomputes every formula that reads `now()` on the live pages, then what depends on them, in one transaction.
 * Called hourly by the Workspace DO's alarm, outside any open transaction; returns the records to publish.
 */
export async function recomputeNowFormulasImpl(db: WorkspaceDb, ctx: EavOpContext): Promise<ChangeRecord[]> {
	const registry = await loadEavRegistry(db);
	if (!hasComputed(registry)) return [];
	const formulas = registry.all().filter((d) => d.type === 'formula' && formulaUsesNow(d, registry));
	if (formulas.length === 0) return [];
	const run = async (tx: WorkspaceDb): Promise<ChangeRecord[]> => {
		const live = (await all<{ num: number }>(tx, 'SELECT num FROM page WHERE deleted_at IS NULL ORDER BY num')).map((r) => r.num);
		const pass = await startPass(tx, ctx);
		for (const f of formulas) pass.dirty.add(f.id, live);
		return runPass(pass);
	};
	return (db as WorkspaceClient).$transaction((tx) => run(tx as unknown as WorkspaceDb));
}
