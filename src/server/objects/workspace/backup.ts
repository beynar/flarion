/**
 * The Workspace DO's side of backups: a logical export of the authoritative tables, paged through in batches, and
 * the matching import (docs/PLAN.md "Operations": "a nightly logical export of each Workspace DO to R2").
 *
 * What is exported, and why (the rest is rebuilt, never copied):
 *
 *   authoritative   meta, member, teamspace, teamspace_member, page, property, p_text, p_num, p_date, p_ref,
 *                   value_count, collection, collection_member, view, grant, change (the log and its seq),
 *                   mutation (idempotency keys), link, file, file_meta, visit, dependency.
 *                   `value_count` and `dependency` are derivable, but cheap, and keeping them means a restore is
 *                   byte-for-byte the object that was backed up (the drill diffs every one of these tables).
 *   derived         search (FTS5 and its shadow tables), page_text, embed_chunk. Rebuilt by replaying indexing
 *                   (`replayIndexing`: one index job per live page, the queue consumer reads each body from its
 *                   Page DO), and `reindexAll` for titles and properties. Page bodies are not in this object.
 *   ephemeral       socket_stream, socket_sub, sub_unit, sub_link, sub_prop (the live registry), open_room,
 *                   raw_schema and viborm's migration marker (the target applies its own), `_cf_*`, sqlite_*.
 *
 * Row format (JSON lines, gzip): see `src/server/backup/format.ts`. A row is an array in the table's column order
 * (the header lists the columns), BLOBs as `{"$b":"<base64>"}`. Tables are exported parents first, so an import never
 * violates a foreign key; every table is paged by keyset (rowid, or the primary key of a WITHOUT ROWID table), so a
 * batch costs the same at row one million.
 */

/** Export order: parents before children (foreign keys), the change log last. */
export const EXPORT_TABLES = [
	'meta',
	'member',
	'teamspace',
	'teamspace_member',
	'page',
	'property',
	'p_text',
	'p_num',
	'p_date',
	'p_ref',
	'value_count',
	'collection',
	'collection_member',
	'view',
	'grant',
	'link',
	'file',
	'file_meta',
	'visit',
	'dependency',
	'mutation',
	'change'
] as const;

/** Derived tables a restore clears (they are rebuilt by replaying indexing). */
export const DERIVED_TABLES = ['search', 'page_text', 'embed_chunk'] as const;
/** Live registry and room bookkeeping: meaningless after a restore, cleared. */
export const EPHEMERAL_TABLES = ['socket_stream', 'socket_sub', 'sub_unit', 'sub_link', 'sub_prop', 'open_room'] as const;

/**
 * Columns that reference their own table (`page.parent_id`, ON DELETE RESTRICT). Rows are paged in rowid order, where
 * a page can come before the parent it was moved under, so an import loads these columns as NULL and sets them once
 * every row is in (`applySelfReferences`, from `restore_fixup`).
 */
const SELF_REFERENCES: Record<string, string[]> = { page: ['parent_id'] };

/** Tables whose AUTOINCREMENT counter matters (the next `seq` must not go backwards). */
const SEQUENCED = ['change'] as const;

export const BACKUP_FORMAT_VERSION = 1;

export interface TableSpec {
	name: string;
	columns: string[];
	/** `rowid`: paged by rowid; `pk`: a WITHOUT ROWID table paged by its primary key columns. */
	order: 'rowid' | 'pk';
	pk: string[];
}

export interface BackupHeader {
	v: typeof BACKUP_FORMAT_VERSION;
	kind: 'flarion-workspace-backup';
	workspaceId: string;
	createdAt: string;
	/** `seq` of the change log when the export began. */
	headSeq: number;
	/** `databaseSize` of the object, bytes (the 5 GB alert reads the same number). */
	databaseBytes: number;
	tables: TableSpec[];
	sequences: Record<string, number>;
	/** What was left out on purpose, so a reader of the file knows it is not an oversight. */
	derived: readonly string[];
	ephemeral: readonly string[];
}

export interface ExportCursor {
	/** Index into `header.tables`. */
	t: number;
	/** Last key of the table already exported (rowid, or the primary key tuple); null at the start of a table. */
	after: unknown[] | null;
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

const tableExists = (sql: SqlStorage, name: string): boolean =>
	sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", name).one().n > 0;

/** The shape of one table as it is in this object now, or null when it does not exist. */
export function describeTable(sql: SqlStorage, name: string): TableSpec | null {
	if (!tableExists(sql, name)) return null;
	const info = sql
		.exec<{ name: string; pk: number }>('SELECT name, pk FROM pragma_table_info(?) ORDER BY cid', name)
		.toArray();
	const ddl = sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name).one().sql;
	const withoutRowid = /WITHOUT\s+ROWID/i.test(ddl);
	const pk = info
		.filter((c) => c.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((c) => c.name);
	return { name, columns: info.map((c) => c.name), order: withoutRowid ? 'pk' : 'rowid', pk };
}

export function readHeadSeq(sql: SqlStorage): number {
	const row = sql.exec<{ s: number | null }>('SELECT MAX(seq) AS s FROM change').one();
	if (row.s != null) return row.s;
	const floor = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'log_floor'").toArray()[0];
	const n = floor ? Number(JSON.parse(floor.value)) : 0;
	return Number.isFinite(n) ? n : 0;
}

function readSequences(sql: SqlStorage): Record<string, number> {
	const out: Record<string, number> = {};
	if (!tableExists(sql, 'sqlite_sequence')) return out;
	for (const name of SEQUENCED) {
		const row = sql.exec<{ seq: number }>('SELECT seq FROM sqlite_sequence WHERE name = ?', name).toArray()[0];
		if (row) out[name] = row.seq;
	}
	return out;
}

export function exportHeader(sql: SqlStorage, workspaceId: string, now = Date.now()): BackupHeader {
	const tables = EXPORT_TABLES.map((name) => describeTable(sql, name)).filter((t): t is TableSpec => t !== null);
	return {
		v: BACKUP_FORMAT_VERSION,
		kind: 'flarion-workspace-backup',
		workspaceId,
		createdAt: new Date(now).toISOString(),
		headSeq: readHeadSeq(sql),
		databaseBytes: sql.databaseSize,
		tables,
		sequences: readSequences(sql),
		derived: DERIVED_TABLES,
		ephemeral: EPHEMERAL_TABLES
	};
}

// ───────────────────────── values ─────────────────────────

const toBase64 = (buffer: ArrayBuffer): string => {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
};
const fromBase64 = (text: string): ArrayBuffer => {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
};

export const encodeValue = (value: SqlStorageValue): unknown => (value instanceof ArrayBuffer ? { $b: toBase64(value) } : value);
export const decodeValue = (value: unknown): SqlStorageValue =>
	value !== null && typeof value === 'object' && '$b' in (value as object) ? fromBase64((value as { $b: string }).$b) : (value as SqlStorageValue);

// ───────────────────────── export ─────────────────────────

export interface ExportBatch {
	/** JSON lines, ready to write: `{"t":"page","r":[...]}`. */
	lines: string[];
	/** Where to resume, or null when every table is done. */
	cursor: ExportCursor | null;
}

/** About 1 MiB of lines per batch: well under the 32 MiB RPC reply limit. */
export const BATCH_BYTES = 1024 * 1024;
export const BATCH_ROWS = 5000;

/**
 * The next batch of rows. Read-only, one synchronous turn: every row of a batch is from the same instant (the
 * Workspace DO holds its commit queue between batches while a backup runs, see `WorkspaceDO.backupBegin`).
 */
export function exportBatch(sql: SqlStorage, header: BackupHeader, cursor: ExportCursor | null, maxRows = BATCH_ROWS, maxBytes = BATCH_BYTES): ExportBatch {
	let { t, after } = cursor ?? { t: 0, after: null };
	const lines: string[] = [];
	let bytes = 0;
	while (t < header.tables.length) {
		const table = header.tables[t]!;
		const cols = table.columns.map(q).join(', ');
		const keyCols = table.order === 'rowid' ? ['rowid'] : table.pk.map(q);
		let where = '';
		const params: unknown[] = [];
		if (after) {
			where = keyCols.length === 1 ? `WHERE ${keyCols[0]} > ?` : `WHERE (${keyCols.join(', ')}) > (${keyCols.map(() => '?').join(', ')})`;
			params.push(...after);
		}
		const keyIndex = table.order === 'rowid' ? 0 : -1;
		const select = table.order === 'rowid' ? `rowid AS "__rid", ${cols}` : cols;
		const cursorRows = sql.exec(`SELECT ${select} FROM ${q(table.name)} ${where} ORDER BY ${keyCols.join(', ')} LIMIT ?`, ...params, maxRows - lines.length);
		let full = false;
		for (const row of cursorRows.raw()) {
			const key = table.order === 'rowid' ? [row[keyIndex]] : table.pk.map((c) => row[table.columns.indexOf(c)]);
			const values = (table.order === 'rowid' ? row.slice(1) : row).map(encodeValue);
			const line = JSON.stringify({ t: table.name, r: values });
			lines.push(line);
			bytes += line.length + 1;
			after = key;
			if (lines.length >= maxRows || bytes >= maxBytes) {
				full = true;
				break;
			}
		}
		// A full batch resumes in this table (the next call finds it exhausted, or more rows).
		if (full) return { lines, cursor: { t, after } };
		t++;
		after = null;
	}
	return { lines, cursor: null };
}

// ───────────────────────── import ─────────────────────────

export interface ImportResult {
	rows: number;
	/** Tables of the export this object has no table for (skipped), and columns it lacks (dropped). */
	skippedTables: string[];
	droppedColumns: Record<string, string[]>;
}

/** Whether the object holds workspace state (a restore into it needs `force`). */
export function isPopulated(sql: SqlStorage): boolean {
	if (!tableExists(sql, 'page') || !tableExists(sql, 'meta')) return false;
	if (sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM page').one().n > 0) return true;
	return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM meta WHERE key = 'initialized'").one().n > 0;
}

/** Deletes every authoritative, derived and ephemeral row (children first), keeping the schema. */
export function wipeRows(sql: SqlStorage): void {
	// `page.parent_id` restricts the delete of a parent: detach the tree first.
	if (tableExists(sql, 'page')) sql.exec('UPDATE page SET parent_id = NULL WHERE parent_id IS NOT NULL');
	for (const table of [...EPHEMERAL_TABLES, ...DERIVED_TABLES, ...[...EXPORT_TABLES].reverse()]) {
		if (tableExists(sql, table)) sql.exec(`DELETE FROM ${q(table)}`);
	}
	if (tableExists(sql, 'sqlite_sequence')) for (const name of SEQUENCED) sql.exec('DELETE FROM sqlite_sequence WHERE name = ?', name);
}

const MAX_BOUND = 90;

/** The side table the self-referencing columns of an import wait in until every row is loaded. */
export function prepareFixups(sql: SqlStorage): void {
	sql.exec('CREATE TABLE IF NOT EXISTS restore_fixup (tbl TEXT NOT NULL, id TEXT NOT NULL, col TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY (tbl, id, col))');
	sql.exec('DELETE FROM restore_fixup');
}

/** Sets the self-referencing columns recorded while loading, then drops the side table. */
export function applySelfReferences(sql: SqlStorage): void {
	if (!tableExists(sql, 'restore_fixup')) return;
	for (const [table, cols] of Object.entries(SELF_REFERENCES)) {
		for (const col of cols) {
			sql.exec(
				`UPDATE ${q(table)} SET ${q(col)} = (SELECT ref FROM restore_fixup f WHERE f.tbl = ? AND f.col = ? AND f.id = ${q(table)}.id) WHERE id IN (SELECT id FROM restore_fixup WHERE tbl = ? AND col = ?)`,
				table,
				col,
				table,
				col
			);
		}
	}
	sql.exec('DROP TABLE restore_fixup');
}

/**
 * Inserts the row lines of an export (any number, any table mix, in the order they were written). Columns are
 * matched by name: an old export restores into newer code (new columns take their defaults), and a column or table
 * this version no longer has is skipped and reported. Idempotent (`INSERT OR IGNORE`: a retried batch changes nothing, and never cascades into rows already loaded).
 * The caller wraps it in a transaction.
 */
export function importLines(sql: SqlStorage, header: BackupHeader, lines: readonly string[], report?: ImportResult): number {
	const specs = new Map(header.tables.map((t) => [t.name, t]));
	const targets = new Map<string, TableSpec | null>();
	let rows = 0;
	type Group = { table: string; keep: number[]; names: string[]; rows: unknown[][] };
	const flush = (g: Group) => {
		if (g.rows.length === 0) return;
		const per = Math.max(1, Math.floor(MAX_BOUND / g.names.length));
		const names = g.names.map(q).join(', ');
		const one = `(${g.names.map(() => '?').join(', ')})`;
		const self = SELF_REFERENCES[g.table] ?? [];
		const selfAt = g.names.flatMap((n, i) => (self.includes(n) ? [i] : []));
		const idAt = g.names.indexOf('id');
		for (const row of selfAt.length ? g.rows : []) {
			for (const at of selfAt) {
				if (row[at] === null || row[at] === undefined) continue;
				sql.exec('INSERT OR REPLACE INTO restore_fixup (tbl, id, col, ref) VALUES (?, ?, ?, ?)', g.table, row[idAt], g.names[at], row[at]);
				row[at] = null;
			}
		}
		for (let i = 0; i < g.rows.length; i += per) {
			const part = g.rows.slice(i, i + per);
			sql.exec(`INSERT OR IGNORE INTO ${q(g.table)} (${names}) VALUES ${part.map(() => one).join(', ')}`, ...part.flat());
		}
		rows += g.rows.length;
		g.rows = [];
	};
	let group: Group | null = null;
	for (const line of lines) {
		const parsed = JSON.parse(line) as { t: string; r: unknown[] };
		const spec = specs.get(parsed.t);
		if (!spec) throw new Error(`export row for unknown table "${parsed.t}"`);
		if (!targets.has(parsed.t)) targets.set(parsed.t, describeTable(sql, parsed.t));
		const target = targets.get(parsed.t);
		if (!target) {
			if (report && !report.skippedTables.includes(parsed.t)) report.skippedTables.push(parsed.t);
			continue;
		}
		if (!group || group.table !== parsed.t) {
			if (group) flush(group);
			const keep = spec.columns.flatMap((c, i) => (target.columns.includes(c) ? [i] : []));
			const dropped = spec.columns.filter((c) => !target.columns.includes(c));
			if (report && dropped.length > 0) report.droppedColumns[parsed.t] = dropped;
			group = { table: parsed.t, keep, names: keep.map((i) => spec.columns[i]!), rows: [] };
		}
		group.rows.push(group.keep.map((i) => decodeValue(parsed.r[i])));
		const per = Math.max(1, Math.floor(MAX_BOUND / group.names.length));
		if (group.rows.length >= per * 20) flush(group);
	}
	if (group) flush(group);
	return rows;
}

/** Restores the AUTOINCREMENT counters recorded in the header (the next `seq` continues where the export left off). */
export function restoreSequences(sql: SqlStorage, header: BackupHeader): void {
	if (!tableExists(sql, 'sqlite_sequence')) return;
	for (const [name, seq] of Object.entries(header.sequences)) {
		const have = sql.exec<{ seq: number }>('SELECT seq FROM sqlite_sequence WHERE name = ?', name).toArray()[0];
		if (!have) sql.exec('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', name, seq);
		else if (have.seq < seq) sql.exec('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', seq, name);
	}
}

/** Row counts per exported table, as they are in this object now (the import's check against the trailer). */
export function countRows(sql: SqlStorage, names: readonly string[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const name of names) if (tableExists(sql, name)) out[name] = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(name)}`).one().n;
	return out;
}

// ───────────────────────── point-in-time recovery seam ─────────────────────────

/** The three storage calls of point-in-time recovery, as a seam: workerd's local storage does not implement them. */
export interface PitrStorage {
	getBookmarkForTime(timestamp: number | Date): Promise<string>;
	onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
}

/** The PITR window of Durable Object SQLite storage. */
export const PITR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface PitrPlan {
	/** The bookmark of the requested time. */
	bookmark: string;
	/** The bookmark of the state being replaced: restoring it undoes the restore. */
	undo: string;
}

/**
 * Arms point-in-time recovery: resolves the bookmark of `timestamp`, tells the storage to restore it on the next
 * session start, then calls `abort` (the object restarts and wakes up restored). The order is the contract: the
 * bookmark first (a time outside the window fails here, before anything is armed), the restore armed next, the abort
 * last. `before` runs after the undo bookmark is known and before the abort (the caller persists it: the object's own
 * storage is about to be rolled back, so the marker has to live outside it).
 */
export async function armPointInTimeRestore(
	storage: PitrStorage,
	timestamp: number,
	abort: () => void,
	before?: (plan: PitrPlan) => Promise<void>,
	now = Date.now()
): Promise<PitrPlan> {
	if (!Number.isFinite(timestamp) || timestamp > now) throw new RangeError('timestamp must be a time in the past');
	if (timestamp < now - PITR_WINDOW_MS) throw new RangeError('timestamp is outside the 30-day recovery window');
	const bookmark = await storage.getBookmarkForTime(timestamp);
	const undo = await storage.onNextSessionRestoreBookmark(bookmark);
	const plan = { bookmark, undo };
	if (before) await before(plan);
	abort();
	return plan;
}
