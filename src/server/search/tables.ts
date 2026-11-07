/**
 * Raw-SQL tables of search that are not viborm models (like the P2 `file` table: viborm only widens an estate's
 * managed-table scope with a fresh estate, which a deployed object cannot adopt). Created from the Workspace
 * DO's constructor, idempotent and additive. The FTS5 `search` table itself is a P1 raw step.
 *
 * - `visit(user_id, page_num, visited_at)`: per-user recently opened pages for quick find. Keyed by the page's
 *   dense `num` (never reused), so purging a page's index rows removes its visits without reading the page.
 * - `embed_chunk(page_id, idx, hash, model, version)`: the embedded chunks of each page. A chunk is skipped
 *   when its hash and the embedding model id are unchanged; rows beyond the page's chunk count are stale.
 */
export function ensureSearchTables(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS visit (
		user_id TEXT NOT NULL,
		page_num INTEGER NOT NULL,
		visited_at INTEGER NOT NULL,
		PRIMARY KEY (user_id, page_num)
	) WITHOUT ROWID`);
	sql.exec('CREATE INDEX IF NOT EXISTS visit_recent ON visit (user_id, visited_at DESC)');
	sql.exec('CREATE INDEX IF NOT EXISTS visit_page ON visit (page_num)');
	sql.exec(`CREATE TABLE IF NOT EXISTS embed_chunk (
		page_id TEXT NOT NULL,
		idx INTEGER NOT NULL,
		hash TEXT NOT NULL,
		model TEXT NOT NULL,
		version INTEGER NOT NULL,
		PRIMARY KEY (page_id, idx)
	) WITHOUT ROWID`);
}
