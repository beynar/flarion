/**
 * Keeps the option index (`src/server/bitmaps/option-index.ts`) in step with the commits of a Workspace DO: a
 * `setProp` record of a select, status, multi-select or person property re-reads that (property, page) from `p_ref`;
 * a property definition record drops the property's bitmaps (options renamed or removed, type changed, deleted),
 * to be rebuilt from SQL when a filter next reads them.
 */
import type { OptionIndex, ValueChange } from '../../bitmaps/option-index';
import { INDEXED_TYPES } from '../../bitmaps/option-index';
import type { WorkspaceDb } from '../../db/workspace.client';
import type { LogRow } from './changelog';
import { loadEavRegistry } from './eav/registry';
import type { RowReader } from './rows';

const DEFINITIONS: ReadonlySet<string> = new Set(['createProperty', 'updateProperty', 'deleteProperty']);

export async function syncOptionIndex(index: OptionIndex, db: WorkspaceDb, rows: readonly LogRow[], reader: RowReader): Promise<void> {
	const registry = await loadEavRegistry(db);
	const written: { prop: number; page: string }[] = [];
	for (const row of rows) {
		if (DEFINITIONS.has(row.kind)) {
			const num = row.kind === 'deleteProperty' || !row.prop ? undefined : registry.num(row.prop);
			if (num === undefined) index.invalidateAll();
			else index.invalidate(num);
			continue;
		}
		if (row.kind !== 'setProp' || !row.page || !row.prop) continue;
		const def = registry.get(row.prop);
		if (!def || !INDEXED_TYPES.has(def.type)) continue;
		const num = registry.num(row.prop);
		if (num !== undefined) written.push({ prop: num, page: row.page });
	}
	if (written.length === 0) return;
	const nums = reader.nums([...new Set(written.map((w) => w.page))]);
	const changes: ValueChange[] = [];
	for (const w of written) {
		const page = nums.get(w.page);
		if (page !== undefined) changes.push({ prop: w.prop, page });
	}
	await index.refresh(db, changes);
}
