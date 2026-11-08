/**
 * `Idempotency-Key` of the public API's writes (docs/PLAN.md "API": "kept 24 hours in the Workspace DO"). A raw-SQL
 * table beside the P2 file table (`ensureFilesTable`), created when the object wakes.
 *
 * A key belongs to a scope (the API token that sent it, so two tokens never see each other's keys) and to the request
 * it first came with (a hash of method, path and body). Replaying a key with the same request answers the stored
 * response without running the write again; a different request under the same key is a conflict; a request still in
 * flight under the key is refused as such (the client retries). A response that was not stored (the write failed with a
 * 5xx) frees the key so a retry runs.
 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A request that never finished (the isolate died) frees its key after this long. */
export const IDEMPOTENCY_STALE_MS = 2 * 60 * 1000;

export function ensureIdempotencyTable(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS api_idempotency (
		scope TEXT NOT NULL,
		key TEXT NOT NULL,
		request_hash TEXT NOT NULL,
		status INTEGER,
		body TEXT,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (scope, key)
	) WITHOUT ROWID`);
	sql.exec('CREATE INDEX IF NOT EXISTS api_idempotency_created ON api_idempotency (created_at)');
}

export type IdempotencyBegin =
	| { state: 'new' }
	| { state: 'replay'; status: number; body: string }
	| { state: 'conflict' }
	| { state: 'in_flight' };

interface Row extends Record<string, SqlStorageValue> {
	request_hash: string;
	status: number | null;
	body: string | null;
	created_at: number;
}

/** Claims `key` for this request, or says what the earlier use of it left. Expired keys are dropped first. */
export function beginIdempotent(sql: SqlStorage, scope: string, key: string, requestHash: string, now: number = Date.now()): IdempotencyBegin {
	sql.exec('DELETE FROM api_idempotency WHERE created_at < ?', now - IDEMPOTENCY_TTL_MS);
	const row = sql.exec<Row>('SELECT request_hash, status, body, created_at FROM api_idempotency WHERE scope = ? AND key = ?', scope, key).toArray()[0];
	if (!row) {
		sql.exec('INSERT INTO api_idempotency (scope, key, request_hash, created_at) VALUES (?, ?, ?, ?)', scope, key, requestHash, now);
		return { state: 'new' };
	}
	if (row.request_hash !== requestHash) return { state: 'conflict' };
	if (row.status !== null) return { state: 'replay', status: row.status, body: row.body ?? '' };
	if (now - row.created_at > IDEMPOTENCY_STALE_MS) {
		sql.exec('UPDATE api_idempotency SET created_at = ? WHERE scope = ? AND key = ?', now, scope, key);
		return { state: 'new' };
	}
	return { state: 'in_flight' };
}

/** Stores the response a key's request produced. */
export function finishIdempotent(sql: SqlStorage, scope: string, key: string, status: number, body: string): void {
	sql.exec('UPDATE api_idempotency SET status = ?, body = ? WHERE scope = ? AND key = ?', status, body, scope, key);
}

/** Frees a key whose request failed in a way a retry may fix. */
export function abandonIdempotent(sql: SqlStorage, scope: string, key: string): void {
	sql.exec('DELETE FROM api_idempotency WHERE scope = ? AND key = ? AND status IS NULL', scope, key);
}
