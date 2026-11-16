import type { EavTable } from '../../../../lib/shared/property-types';
import { ensureImportTable } from '../../../import/store';
import { ensureAiTable } from './ai';
import { ensureDependencyTable } from './dependency';

/** Tables laid out as `WITHOUT ROWID` clustered by their primary key (the plan's "clustered by property"). */
export const CLUSTERED_TABLES = ['p_text', 'p_num', 'p_date', 'p_ref', 'value_count'] as const;
export const EAV_TABLES: readonly EavTable[] = ['p_text', 'p_num', 'p_date', 'p_ref'];

/**
 * viborm cannot emit `WITHOUT ROWID`, so the migrations create the EAV tables as ordinary rowid tables.
 * This step converts them in place (rename, create `WITHOUT ROWID`, copy, drop, re-create the indexes),
 * which halves the B-trees written per EAV row. It is idempotent and self-healing: call it in the
 * Workspace DO's constructor right after `migrateOnWake` (inside `blockConcurrencyWhile`), never while a
 * viborm transaction is open. A later viborm migration that recreates one of these tables loses the
 * option; the next wake restores it. viborm 1.12.1's drift check did not see the difference; 1.14.0's does, and wrongly
 * reports every other table's constraints too (a regression, `tests/workers/eav/eav.test.ts` "layout"): until viborm
 * fixes it, the estate must not change (docs/ops/migrations.md).
 */
export function ensureEavLayout(storage: DurableObjectStorage): string[] {
	const converted: string[] = [];
	const sql = storage.sql;
	// The dependency graph of rollups and formulas: raw SQL, outside viborm's managed tables.
	ensureDependencyTable(sql);
	// AI-property markers and CSV import jobs: raw SQL tables of the same kind.
	ensureAiTable(sql);
	ensureImportTable(sql);
	for (const table of CLUSTERED_TABLES) {
		const row = sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray()[0];
		if (!row || /WITHOUT\s+ROWID/i.test(row.sql)) continue;
		const indexes = sql
			.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", table)
			.toArray()
			.map((r) => r.sql);
		const tmp = `${table}__clustered`;
		const create = row.sql.replace(/^CREATE TABLE\s+("?[\w]+"?)/i, `CREATE TABLE "${tmp}"`).replace(/\)\s*$/, ') WITHOUT ROWID');
		storage.transactionSync(() => {
			sql.exec(create);
			sql.exec(`INSERT INTO "${tmp}" SELECT * FROM "${table}"`);
			sql.exec(`DROP TABLE "${table}"`);
			sql.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
			for (const ddl of indexes) sql.exec(ddl);
		});
		converted.push(table);
	}
	return converted;
}
