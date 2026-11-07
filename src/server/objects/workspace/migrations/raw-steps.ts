/**
 * Raw SQL schema steps: what viborm cannot express (FTS5) and what is internal bookkeeping that should
 * not go through the ORM (the subscription registry, hot on every commit). Each step runs once, in its
 * own transaction, and the applied version is stored in `raw_schema`. Steps are append-only and additive.
 *
 * They run synchronously from the constructor, before viborm's estate: never while a viborm transaction
 * is open (CLAUDE.md), and viborm ignores these tables because they are not in `WORKSPACE_TABLES`.
 */
export const RAW_STEPS: readonly string[][] = [
	[
		// ----- subscription registry (survives hibernation; attachments hold only { socketId, actor }) -----
		// The one stream per socket (the `hello` event iterator): every server message goes to `request_id`.
		`CREATE TABLE socket_stream (
			socket_id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL,
			client_id TEXT NOT NULL,
			opened_at INTEGER NOT NULL
		)`,
		// What a socket subscribed to. `lim` is the window of a view/backlinks subscription.
		`CREATE TABLE socket_sub (
			socket_id TEXT NOT NULL,
			sub_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			spec TEXT NOT NULL,
			lim INTEGER,
			PRIMARY KEY (socket_id, sub_id)
		)`,
		// A shared unit: identical queries with the same visibility scope are evaluated once. `ids` is
		// the unit's ordered result (JSON array of page ids), what every linked socket currently holds.
		`CREATE TABLE sub_unit (
			unit_key TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			spec TEXT NOT NULL,
			ids TEXT NOT NULL
		)`,
		// The units of a socket subscription, in window order (a tree subscription has one per parent).
		`CREATE TABLE sub_link (
			socket_id TEXT NOT NULL,
			sub_id TEXT NOT NULL,
			ord INTEGER NOT NULL,
			unit_key TEXT NOT NULL,
			PRIMARY KEY (socket_id, sub_id, ord)
		)`,
		'CREATE INDEX sub_link_unit ON sub_link (unit_key)',
		// ----- derived data -----
		// Body text and outline of each page, fed by the indexing queue (docs/PLAN.md "Between Durable Objects").
		`CREATE TABLE page_text (
			page_num INTEGER PRIMARY KEY,
			version INTEGER NOT NULL,
			text TEXT NOT NULL,
			outline_json TEXT NOT NULL,
			edited_at INTEGER,
			edited_by TEXT
		)`,
		// Full-text search (docs/spikes/p0-fts5.md). Created now, filled and queried from P3.
		`CREATE VIRTUAL TABLE search USING fts5(page_num UNINDEXED, field, text, tokenize = 'porter unicode61')`
	]
];

/** Applies the steps not yet recorded. Idempotent and cheap once current (one SELECT). */
export function applyRawSteps(storage: DurableObjectStorage): void {
	const sql = storage.sql;
	sql.exec('CREATE TABLE IF NOT EXISTS raw_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)');
	const row = sql.exec<{ version: number }>('SELECT version FROM raw_schema WHERE id = 1').toArray()[0];
	const current = row?.version ?? 0;
	if (current >= RAW_STEPS.length) return;
	storage.transactionSync(() => {
		for (let v = current; v < RAW_STEPS.length; v++) {
			for (const statement of RAW_STEPS[v]) sql.exec(statement);
		}
		sql.exec('INSERT OR REPLACE INTO raw_schema (id, version) VALUES (1, ?)', RAW_STEPS.length);
	});
}
