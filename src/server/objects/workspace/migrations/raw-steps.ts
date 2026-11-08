/**
 * Raw SQL schema steps: what viborm cannot express (FTS5) and what is internal bookkeeping that should
 * not go through the ORM (the subscription registry, hot on every commit). Each step runs once, in its
 * own transaction, and the applied version is stored in `raw_schema`. Steps are append-only and additive.
 *
 * They run synchronously from the constructor, before viborm's estate: never while a viborm transaction
 * is open (CLAUDE.md), and viborm ignores these tables because they are not in `WORKSPACE_TABLES`.
 */
export type RawStep = string[] | GatedRawStep;

/**
 * A step that waits for a feature flag: it applies only while the flag `migration.<name>` is on (D1 flag, KV cached,
 * `src/server/flags.ts`; a flag lookup that fails reads as off, so a flaky flag store delays a migration, never runs
 * one). Steps apply in order and a gated step that is not enabled holds back every step after it, so a flag can only
 * delay the schema, never reorder it. Ship the step dark (flag off) in one deploy, code that uses its columns in a
 * later one, switch the flag on object by object (`rollout`), and roll back by switching it off and deploying the
 * previous version (docs/ops/migrations.md).
 */
export interface GatedRawStep {
	flag: `migration.${string}`;
	statements: string[];
}

const statementsOf = (step: RawStep): string[] => (Array.isArray(step) ? step : step.statements);

export const RAW_STEPS: readonly RawStep[] = [
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
	],
	[
		// ----- live views (P3) -----
		// The property-to-subscription index: the properties a view unit filters, sorts, groups by and takes its
		// membership from (`$parent`, `$teamspace` and `$edited` stand for the page-level fields). A commit checks
		// only the units whose properties it wrote.
		`CREATE TABLE sub_prop (
			prop TEXT NOT NULL,
			unit_key TEXT NOT NULL,
			PRIMARY KEY (prop, unit_key)
		) WITHOUT ROWID`,
		'CREATE INDEX sub_prop_unit ON sub_prop (unit_key)',
		// Per-group window sizes of a grouped view subscription (JSON: group key -> limit).
		'ALTER TABLE socket_sub ADD COLUMN glim TEXT',
		// Flags of a view unit: 1 = depends on the clock (relative dates), 2 = hand-picked members only.
		'ALTER TABLE sub_unit ADD COLUMN flags INTEGER NOT NULL DEFAULT 0'
	]
];

/** The raw schema version this object is at (0 for a fresh one). */
export function rawSchemaVersion(storage: DurableObjectStorage): number {
	const sql = storage.sql;
	sql.exec('CREATE TABLE IF NOT EXISTS raw_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)');
	return sql.exec<{ version: number }>('SELECT version FROM raw_schema WHERE id = 1').toArray()[0]?.version ?? 0;
}

/** The flags of the gated steps this object has not applied yet, in step order (the caller looks them up, then calls `applyRawSteps`). */
export function pendingFlags(storage: DurableObjectStorage, steps: readonly RawStep[] = RAW_STEPS): string[] {
	const out: string[] = [];
	for (let v = rawSchemaVersion(storage); v < steps.length; v++) {
		const step = steps[v]!;
		if (!Array.isArray(step)) out.push(step.flag);
	}
	return out;
}

/**
 * Applies the steps not yet recorded, in order, each in its own transaction, up to the first gated step whose flag is
 * not in `enabled`. Idempotent and cheap once current (one SELECT). Returns the version the object is at afterwards.
 */
export function applyRawSteps(storage: DurableObjectStorage, enabled: ReadonlySet<string> = new Set(), steps: readonly RawStep[] = RAW_STEPS): number {
	const sql = storage.sql;
	const current = rawSchemaVersion(storage);
	let version = current;
	storage.transactionSync(() => {
		while (version < steps.length) {
			const step = steps[version]!;
			if (!Array.isArray(step) && !enabled.has(step.flag)) break;
			for (const statement of statementsOf(step)) sql.exec(statement);
			version++;
		}
		if (version !== current) sql.exec('INSERT OR REPLACE INTO raw_schema (id, version) VALUES (1, ?)', version);
	});
	return version;
}
