/**
 * What the Workspace DO remembers about CSV imports: one `import_job` row per import, written by `import.begin`,
 * advanced by the Workflow after every chunk and read by `import.status`. Raw SQL outside viborm's managed tables
 * (like `file` and `dependency`), created idempotently by `ensureEavLayout`.
 *
 * `status`: `queued` (begun, Workflow not started its first step), `running`, then one of `done`, `failed`,
 * `cancelled`. A terminal status is final: late progress from a chunk that was in flight when the import was cancelled
 * adds to the counts but never revives the import.
 */
import type { ImportState, ImportStatus } from '../../lib/shared/import/schemas';

export const ensureImportTable = (sql: SqlStorage): void => {
	sql.exec(`CREATE TABLE IF NOT EXISTS import_job (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		status TEXT NOT NULL,
		title TEXT NOT NULL,
		page_id TEXT NOT NULL,
		size INTEGER NOT NULL,
		bytes INTEGER NOT NULL DEFAULT 0,
		rows INTEGER NOT NULL DEFAULT 0,
		rejected INTEGER NOT NULL DEFAULT 0,
		failed INTEGER NOT NULL DEFAULT 0,
		error TEXT,
		cancel INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`);
};

interface Row {
	id: string;
	user_id: string;
	status: string;
	title: string;
	page_id: string;
	size: number;
	bytes: number;
	rows: number;
	rejected: number;
	failed: number;
	error: string | null;
	cancel: number;
	created_at: number;
	updated_at: number;
	[key: string]: SqlStorageValue;
}

export interface ImportJob {
	id: string;
	userId: string;
	status: ImportState;
	title: string;
	pageId: string;
	size: number;
	bytes: number;
	rows: number;
	rejected: number;
	failed: number;
	error: string | null;
	cancelRequested: boolean;
	createdAt: number;
	updatedAt: number;
}

const toJob = (r: Row): ImportJob => ({
	id: r.id,
	userId: r.user_id,
	status: r.status as ImportState,
	title: r.title,
	pageId: r.page_id,
	size: r.size,
	bytes: r.bytes,
	rows: r.rows,
	rejected: r.rejected,
	failed: r.failed,
	error: r.error,
	cancelRequested: r.cancel === 1,
	createdAt: r.created_at,
	updatedAt: r.updated_at
});

export const isTerminal = (status: ImportState): boolean => status === 'done' || status === 'failed' || status === 'cancelled';

export const toStatus = (job: ImportJob): ImportStatus => ({
	id: job.id,
	status: job.status,
	pageId: job.pageId,
	title: job.title,
	rows: job.rows,
	bytes: job.bytes,
	size: job.size,
	rejectedCells: job.rejected,
	failedRows: job.failed,
	error: job.error,
	createdAt: job.createdAt,
	updatedAt: job.updatedAt
});

export interface NewJob {
	id: string;
	userId: string;
	title: string;
	pageId: string;
	size: number;
}

export function createJob(sql: SqlStorage, job: NewJob, now: number): ImportJob {
	sql.exec('INSERT INTO import_job (id, user_id, status, title, page_id, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', job.id, job.userId, 'queued', job.title, job.pageId, job.size, now, now);
	return getJob(sql, job.id) as ImportJob;
}

export function getJob(sql: SqlStorage, id: string): ImportJob | null {
	const row = sql.exec<Row>('SELECT * FROM import_job WHERE id = ?', id).toArray()[0];
	return row ? toJob(row) : null;
}

export interface Progress {
	/** Absolute totals so far (a step that runs twice reports the same numbers): rows created, cells left empty, rows refused. */
	rows?: number;
	rejected?: number;
	failed?: number;
	/** Absolute: how far into the file the import is. */
	bytes?: number;
	status?: ImportState;
	error?: string | null;
}

/** Applies a progress report. A terminal job takes the counts but keeps its status; counts only grow. */
export function updateJob(sql: SqlStorage, id: string, progress: Progress, now: number): ImportJob | null {
	const job = getJob(sql, id);
	if (!job) return null;
	const status = isTerminal(job.status) || progress.status === undefined ? job.status : progress.status;
	sql.exec(
		'UPDATE import_job SET status = ?, rows = MAX(rows, ?), rejected = MAX(rejected, ?), failed = MAX(failed, ?), bytes = MAX(bytes, ?), error = ?, updated_at = ? WHERE id = ?',
		status,
		progress.rows ?? 0,
		progress.rejected ?? 0,
		progress.failed ?? 0,
		progress.bytes ?? 0,
		progress.error !== undefined && !isTerminal(job.status) ? progress.error : job.error,
		now,
		id
	);
	return getJob(sql, id);
}

/** Marks the import cancelled: the Workflow stops at its next chunk. Returns the job, or null when unknown. */
export function cancelJob(sql: SqlStorage, id: string, now: number): ImportJob | null {
	const job = getJob(sql, id);
	if (!job) return null;
	if (isTerminal(job.status)) return job;
	sql.exec("UPDATE import_job SET cancel = 1, status = 'cancelled', updated_at = ? WHERE id = ?", now, id);
	return getJob(sql, id);
}
