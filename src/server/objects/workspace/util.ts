import type { WorkspaceDb } from '../../db/workspace.client';

/** Durable Object SQLite allows 100 bound parameters per statement; stay under it. */
export const MAX_PARAMS = 90;

export function chunks<T>(items: readonly T[], size = MAX_PARAMS): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export const qmarks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

/** Raw read through viborm (use inside a transaction: raw `ctx.storage.sql` is off limits there). */
export const rawAll = <T>(db: WorkspaceDb, sql: string, ...params: unknown[]): Promise<T[]> =>
	db.$queryRawUnsafe<T>(sql, ...params) as Promise<T[]>;

export const rawRun = (db: WorkspaceDb, sql: string, ...params: unknown[]): Promise<number> =>
	db.$executeRawUnsafe(sql, ...params) as Promise<number>;

export const isoTime = (ms: number): string => new Date(ms).toISOString();

/** Pages of a subtree, root included, tombstoned or not (the CTE of docs/PLAN.md "Deleting a subtree"). */
export const SUBTREE_CTE = `WITH RECURSIVE sub(id) AS (
	SELECT id FROM page WHERE id = ?
	UNION ALL
	SELECT p.id FROM page p JOIN sub ON p.parent_id = sub.id
)`;

/** Pages of a subtree that are still live. */
export const LIVE_SUBTREE_CTE = `WITH RECURSIVE sub(id) AS (
	SELECT id FROM page WHERE id = ?
	UNION ALL
	SELECT p.id FROM page p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL
)`;

export const asJson = (value: unknown): unknown => (value === undefined ? null : value);
