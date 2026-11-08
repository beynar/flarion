import type { WorkspaceDb } from '../../../db/workspace.client';
import { quiet } from '../../../db/quiet';

/** DO SQLite allows 100 bound parameters per statement; stay under it. */
export const MAX_PARAMS = 90;

export const all = <T>(db: WorkspaceDb, sql: string, ...params: unknown[]): Promise<T[]> =>
	db.$queryRawUnsafe<T>(sql, ...params) as Promise<T[]>;

export const run = (db: WorkspaceDb, sql: string, ...params: unknown[]): Promise<number> =>
	db.$executeRawUnsafe(quiet(sql), ...params) as Promise<number>;

export const qmarks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

export function chunks<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export const iso = (ms: number): string => new Date(ms).toISOString();
