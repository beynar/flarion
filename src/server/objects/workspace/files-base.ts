/**
 * The parts of the files module the Workspace DO needs at every wake or on hot paths (the `file` table's DDL, page levels), apart from
 * `files.ts` so that the rest of it (uploads, quota, sweeps) is imported by the first `files*` call instead of by the wake
 * (docs/ops/load-test.md "Start-up"). `files.ts` re-exports everything here.
 */

/** What a page level may do, lowest first (the Sync core's levels). */
export const PAGE_LEVELS = ['read', 'comment', 'update', 'full'] as const;
export type PageLevel = (typeof PAGE_LEVELS)[number];
const RANK: Record<PageLevel, number> = { read: 0, comment: 1, update: 2, full: 3 };
export const atLeast = (level: PageLevel | null, wanted: PageLevel): boolean => level !== null && RANK[level] >= RANK[wanted];

/** Reads whatever shape `pageAccess` answers (a level, `{ level }`, `'none'`, `null`) as a {@link PageLevel} or `null`. */
export function normalizeLevel(value: unknown): PageLevel | null {
	const raw = typeof value === 'object' && value !== null ? ((value as { level?: unknown }).level ?? null) : value;
	if (raw === 'write') return 'update';
	return typeof raw === 'string' && (PAGE_LEVELS as readonly string[]).includes(raw) ? (raw as PageLevel) : null;
}

/** Creates the `file` table. Idempotent; a synchronous no-op once it exists. */
export function ensureFilesTable(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS file (
		id TEXT PRIMARY KEY,
		page_id TEXT NOT NULL,
		name TEXT NOT NULL,
		size INTEGER NOT NULL,
		type TEXT NOT NULL,
		r2_key TEXT NOT NULL,
		created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		committed INTEGER NOT NULL DEFAULT 0,
		deleted_at INTEGER,
		upload_id TEXT
	)`);
	sql.exec('CREATE INDEX IF NOT EXISTS file_page ON file (page_id)');
	sql.exec('CREATE INDEX IF NOT EXISTS file_pending ON file (committed, created_at)');
	sql.exec('CREATE TABLE IF NOT EXISTS file_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}
