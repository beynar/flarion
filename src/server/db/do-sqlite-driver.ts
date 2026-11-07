/**
 * viborm driver over Durable Object SQLite (`ctx.storage.sql`).
 *
 * viborm 1.12.1 ships drivers for sqlite3, libSQL, Bun SQLite and D1, none for Durable Objects. This
 * one is built only from viborm's public exports (`viborm/driver`, `viborm/adapters`).
 *
 * ## Semantics
 *
 * - **Statements** run synchronously on `ctx.storage.sql.exec` and are wrapped in resolved promises.
 *   Rows come back as keyed objects; BLOBs as `ArrayBuffer`. A DML statement without `RETURNING`
 *   reports `rowCount` from SQLite's `changes()` (not `cursor.rowsWritten`, which counts index writes)
 *   and an `insertId` from `last_insert_rowid()`.
 * - **Interactive transactions** (`client.$transaction(async (tx) => ...)`) map onto
 *   `ctx.storage.transaction(async () => ...)`. DO SQLite is synchronous, but the async transaction API
 *   keeps one SQLite transaction open across the `await`s of viborm's engine, commits when the closure
 *   resolves and rolls everything back (writes before and after any `await`) when it rejects. Raw
 *   `BEGIN`/`SAVEPOINT`/`COMMIT` are refused by Durable Objects, so they are never issued.
 *   `transactionSync` cannot be used here: it needs a synchronous callback, and a callback that returns
 *   a promise commits before the promise settles.
 * - **Nested transactions** (a `$transaction` inside a `$transaction`) are issued by viborm as
 *   `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` statements, and viborm's SQLite migration engine takes its
 *   lock with raw `BEGIN IMMEDIATE` ... `COMMIT`/`ROLLBACK`. Durable Objects refuse all of those, so the
 *   driver intercepts exactly these statements and maps each one onto a `ctx.storage.transaction` whose
 *   closure stays pending until the matching `RELEASE`/`COMMIT` (commit) or `ROLLBACK` (rollback). The
 *   frames form a LIFO stack; `ROLLBACK TO` rolls the frame back and re-opens it, as SQLite does.
 *   `PRAGMA busy_timeout` (refused by the platform) is answered locally.
 * - **Batches** (`$transaction([a, b])`): the driver declares no native batch, so viborm runs the array
 *   inside one interactive transaction. The result is atomic and ordered.
 * - **Serialization.** Top-level transactions and statements are queued (`serializeTransactions`), so
 *   statements from another viborm call never run inside an open transaction. Keep one driver per
 *   `ctx.storage` (the factory caches it) so every client shares that queue. Raw `ctx.storage.sql`
 *   calls that bypass the driver are not covered: do not issue them while a transaction is open, and
 *   never await non-storage I/O (fetch, timers) inside a transaction body.
 * - **Bound parameters**: 100 per statement, declared through `maxBindParametersPerStatement` so
 *   viborm splits or refuses oversized statements before they reach SQLite.
 * - **Errors**: workerd's SQLite errors carry no `code`; the driver derives one from the message
 *   (`SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_AUTH`, `SQLITE_TOOBIG`, ...) so viborm maps them to
 *   `UniqueConstraintError`, `ForeignKeyError`, `NotNullConstraintError`, `CheckConstraintError` and
 *   attaches the constrained columns.
 * - **Migrations**: the driver declares viborm's `SQLITE_MIGRATION_CAPABILITY`, so `push`, `apply`,
 *   `down` and `reset` are admitted. Table recreation settles pending writes with `ctx.storage.sync()`
 *   before it lifts foreign keys (a pending write silently makes `PRAGMA foreign_keys = OFF` a no-op
 *   inside a Durable Object). The platform's own `_cf_*` tables (created by the KV API or alarms) are
 *   hidden from viborm's catalog read, because their PRAGMAs are refused with `SQLITE_AUTH`.
 *
 * ## Known limits
 *
 * - Integers outside +-2^53 lose precision on read: workerd returns JS numbers (no BigInt mode).
 *   Bound `bigint`s inside the safe range are bound as numbers, others as decimal strings.
 * - Statements are limited to 100 bound parameters and 100 KB of SQL by the platform.
 * - viborm's transaction-phase notifications (`readyToCommit`/`committed`, used by the cache and
 *   instrumentation extensions for commit certainty) are internal and not emitted; instrumentation
 *   falls back to "committed once the callback returned".
 */
import { SQLiteAdapter } from 'viborm/adapters';
import type { DatabaseAdapter } from 'viborm/adapters';
import {
	Driver,
	SQLITE_MIGRATION_CAPABILITY,
	sqliteResultParser,
	type DriverResultParser,
	type QueryExecutionContext,
	type QueryResult
} from 'viborm/driver';

/** Platform limit, per statement (Cloudflare Durable Object SQLite). */
export const DO_MAX_BOUND_PARAMETERS = 100;
/** Platform limit, statement length in bytes. */
export const DO_MAX_STATEMENT_BYTES = 100_000;

const DRIVER_NAME = 'durable-object-sqlite';

/** Rolls a frame back through the `ctx.storage.transaction` that carries it. */
const FRAME_ROLLBACK = Symbol('frame-rollback');

/** One open `BEGIN` or `SAVEPOINT`, carried by a pending `ctx.storage.transaction`. */
interface Frame {
	/** `null` for the outermost `BEGIN`. */
	readonly name: string | null;
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

const BEGIN_STATEMENT = /^\s*BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*;?\s*$/i;
const COMMIT_STATEMENT = /^\s*(?:COMMIT|END)(?:\s+TRANSACTION)?\s*;?\s*$/i;
const ROLLBACK_STATEMENT = /^\s*ROLLBACK(?:\s+TRANSACTION)?\s*;?\s*$/i;
const SAVEPOINT_STATEMENT = /^\s*SAVEPOINT\s+"?([A-Za-z0-9_]+)"?\s*;?\s*$/i;
const RELEASE_STATEMENT = /^\s*RELEASE\s+(?:SAVEPOINT\s+)?"?([A-Za-z0-9_]+)"?\s*;?\s*$/i;
const ROLLBACK_TO_STATEMENT = /^\s*ROLLBACK\s+TO\s+(?:SAVEPOINT\s+)?"?([A-Za-z0-9_]+)"?\s*;?\s*$/i;
const BUSY_TIMEOUT_READ = /^\s*PRAGMA\s+busy_timeout\s*;?\s*$/i;
const BUSY_TIMEOUT_WRITE = /^\s*PRAGMA\s+busy_timeout\s*=/i;

/** First keyword of a statement, ignoring leading whitespace and comments. */
function leadingKeyword(sql: string): string {
	let i = 0;
	for (;;) {
		while (i < sql.length && /\s/.test(sql[i]!)) i++;
		if (sql.startsWith('--', i)) {
			const end = sql.indexOf('\n', i);
			i = end === -1 ? sql.length : end + 1;
		} else if (sql.startsWith('/*', i)) {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? sql.length : end + 2;
		} else break;
	}
	const match = /^[A-Za-z]+/.exec(sql.slice(i, i + 16));
	return match ? match[0].toUpperCase() : '';
}

const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

/** Convert a viborm value to something `sql.exec` binds. */
function toBindValue(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (value === undefined) return null;
	if (typeof value === 'bigint') {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: value.toString();
	}
	if (ArrayBuffer.isView(value)) {
		const view = value as ArrayBufferView;
		return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
	}
	return value;
}

const EXTENDED_CODE = /\(extended: (SQLITE_[A-Z0-9_]+)\)/;
const BASE_CODE = /\b(SQLITE_[A-Z0-9_]+)\b/;

/**
 * workerd raises plain `Error`s whose message ends with `: SQLITE_X (extended: SQLITE_X_Y)`. viborm
 * keys its constraint mapping on `error.code`, so derive it from the message when it is absent.
 */
function annotateSqliteError(error: unknown): unknown {
	if (!(error instanceof Error) || (error as { code?: unknown }).code !== undefined) return error;
	const code = EXTENDED_CODE.exec(error.message)?.[1] ?? BASE_CODE.exec(error.message)?.[1];
	if (code) {
		try {
			Object.defineProperty(error, 'code', { value: code, configurable: true, enumerable: false });
		} catch {
			/* frozen error: leave it to viborm's message matching */
		}
	}
	return error;
}

/**
 * viborm's SQLite catalog read names every table, and the platform's `_cf_*` tables answer PRAGMAs
 * with SQLITE_AUTH. viborm only filters them for D1, so add the filter to that exact statement.
 */
const CATALOG_READ =
	/WHERE\s+type\s*=\s*'table'\s+AND\s+name\s+NOT\s+LIKE\s+'sqlite_%'\s+AND\s+name\s*<>\s*\?/i;
function hidePlatformTables(sql: string): string {
	return CATALOG_READ.test(sql) && !sql.includes("NOT GLOB '_cf_*'")
		? sql.replace(CATALOG_READ, (match) => `${match} AND name NOT GLOB '_cf_*'`)
		: sql;
}

export class DurableObjectSqliteDriver extends Driver<DurableObjectStorage, DurableObjectStorage> {
	// DO SQLite refuses temporary objects (SQLITE_AUTH), as D1 does.
	readonly adapter: DatabaseAdapter = new SQLiteAdapter({ temporaryObjects: false });
	readonly maxBindParametersPerStatement: number | undefined = DO_MAX_BOUND_PARAMETERS;
	readonly result: DriverResultParser = sqliteResultParser;
	readonly supportsTransactions = true;
	readonly supportsBatch = false;
	/** Declares viborm's SQLite migration claim: see the file header for how each member is met. */
	readonly sqliteMigrationCapability = SQLITE_MIGRATION_CAPABILITY;
	protected override readonly serializeTransactions = true;

	readonly storage: DurableObjectStorage;
	/** Open `BEGIN`/`SAVEPOINT` frames, outermost first. */
	private readonly frames: Frame[] = [];

	constructor(storage: DurableObjectStorage) {
		super('sqlite', DRIVER_NAME);
		this.storage = storage;
		this.client = storage;
	}

	protected async initClient(): Promise<DurableObjectStorage> {
		return this.storage;
	}

	protected async closeClient(): Promise<void> {
		// The platform owns the storage; only frames this driver opened are ours to close.
		await this.rollbackFrames(0);
	}

	protected async execute<T>(
		client: DurableObjectStorage,
		sql: string,
		params: unknown[],
		_context?: QueryExecutionContext
	): Promise<QueryResult<T>> {
		return this.run<T>(client, sql, params);
	}

	protected async executeRaw<T>(
		client: DurableObjectStorage,
		sql: string,
		params: unknown[] | undefined,
		_context?: QueryExecutionContext
	): Promise<QueryResult<T>> {
		const local = await this.runFrameStatement(sql);
		if (local) return { rows: local.rows as T[], rowCount: local.rows.length };
		return this.run<T>(client, sql, params ?? []);
	}

	private run<T>(storage: DurableObjectStorage, sql: string, params: unknown[]): QueryResult<T> {
		const statement = hidePlatformTables(sql);
		try {
			const cursor = storage.sql.exec(statement, ...params.map(toBindValue));
			if (cursor.columnNames.length > 0) {
				const rows = cursor.toArray() as T[];
				return { rows, rowCount: rows.length };
			}
			// Writes and DDL: step the cursor to completion.
			cursor.toArray();
			if (!WRITE_KEYWORDS.has(leadingKeyword(statement))) return { rows: [] as T[], rowCount: 0 };
			const meta = storage.sql
				.exec<{ changes: number; rowid: number }>(
					'SELECT changes() AS changes, last_insert_rowid() AS rowid'
				)
				.one();
			const insertId =
				leadingKeyword(statement) !== 'UPDATE' &&
				leadingKeyword(statement) !== 'DELETE' &&
				meta.changes > 0 &&
				meta.rowid > 0
					? meta.rowid
					: undefined;
			return {
				rows: [] as T[],
				rowCount: meta.changes,
				...(insertId === undefined ? {} : { insertId })
			};
		} catch (error) {
			throw annotateSqliteError(error);
		}
	}

	// ----- transactions -----

	/**
	 * SQLite serializes writers and the platform runs one thread, so `Serializable` holds by
	 * construction; weaker levels would misreport the guarantee. `timeout` races the callback and
	 * rolls back; `maxWait` is the serialization queue.
	 */
	protected override transactionOptionSupport() {
		return {
			isolationLevel: 'serializable-only' as const,
			isolationLevelReason:
				'Durable Object SQLite runs one writer on one thread and has no statement to weaken isolation, so only Serializable can be honored truthfully',
			timeout: true,
			maxWait: 'queue' as const
		};
	}

	protected async transaction<T>(
		_client: DurableObjectStorage,
		fn: (tx: DurableObjectStorage) => Promise<T>,
		_context?: QueryExecutionContext
	): Promise<T> {
		const depth = this.frames.length;
		return this.storage.transaction(async () => {
			try {
				return await fn(this.storage);
			} finally {
				// Frames the body left open would keep their transactions pending forever.
				await this.rollbackFrames(depth);
			}
		});
	}

	/**
	 * Statements Durable Objects refuse, answered by the frame stack: `BEGIN`, `COMMIT`/`END`,
	 * `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO`, plus `PRAGMA busy_timeout`. Returns the
	 * statement's rows when it was one of them, `undefined` when it must go to SQLite.
	 */
	private async runFrameStatement(sql: string): Promise<{ rows: unknown[] } | undefined> {
		if (BEGIN_STATEMENT.test(sql)) {
			await this.openFrame(null);
			return { rows: [] };
		}
		const savepoint = SAVEPOINT_STATEMENT.exec(sql);
		if (savepoint) {
			await this.openFrame(savepoint[1]!);
			return { rows: [] };
		}
		if (COMMIT_STATEMENT.test(sql)) {
			await this.commitFrames(0);
			return { rows: [] };
		}
		if (ROLLBACK_STATEMENT.test(sql)) {
			await this.rollbackFrames(0);
			return { rows: [] };
		}
		const rollbackTo = ROLLBACK_TO_STATEMENT.exec(sql);
		if (rollbackTo) {
			const index = this.indexOfFrame(rollbackTo[1]!);
			if (index === -1) return { rows: [] };
			// SQLite keeps the savepoint open after ROLLBACK TO: roll it back, then re-open it.
			await this.rollbackFrames(index);
			await this.openFrame(rollbackTo[1]!);
			return { rows: [] };
		}
		const release = RELEASE_STATEMENT.exec(sql);
		if (release) {
			const index = this.indexOfFrame(release[1]!);
			if (index !== -1) await this.commitFrames(index);
			return { rows: [] };
		}
		// `busy_timeout` is refused by the platform (SQLITE_AUTH); there is no lock wait to configure.
		if (BUSY_TIMEOUT_READ.test(sql)) return { rows: [{ timeout: 0 }] };
		if (BUSY_TIMEOUT_WRITE.test(sql)) return { rows: [] };
		return undefined;
	}

	private indexOfFrame(name: string): number {
		for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.name === name) return i;
		return -1;
	}

	private async openFrame(name: string | null): Promise<void> {
		let release!: () => void;
		let fail!: (reason: unknown) => void;
		const decision = new Promise<void>((resolve, reject) => {
			release = resolve;
			fail = reject;
		});
		let started!: () => void;
		const startedSignal = new Promise<void>((resolve) => {
			started = resolve;
		});
		// The transaction owns SQLite's (save)point for as long as `decision` is pending; statements
		// run by the caller in between belong to it because SQLite has a single connection.
		const done = this.storage.transaction(async () => {
			started();
			await decision;
		});
		done.catch(() => undefined);
		await Promise.race([
			startedSignal,
			done.then(() => {
				throw new Error('Durable Object transaction ended before it started');
			})
		]);
		this.frames.push({
			name,
			commit: async () => {
				release();
				await done;
			},
			rollback: async () => {
				fail(FRAME_ROLLBACK);
				try {
					await done;
				} catch (error) {
					if (error !== FRAME_ROLLBACK) throw error;
				}
			}
		});
	}

	/** Commits frames `from..top`, innermost first. The first failure stops and rolls back the rest. */
	private async commitFrames(from: number): Promise<void> {
		while (this.frames.length > from) {
			const frame = this.frames.pop()!;
			try {
				await frame.commit();
			} catch (error) {
				await this.rollbackFrames(from).catch(() => undefined);
				throw annotateSqliteError(error);
			}
		}
	}

	/** Rolls frames `from..top` back, innermost first. */
	private async rollbackFrames(from: number): Promise<void> {
		let failure: unknown;
		while (this.frames.length > from) {
			try {
				await this.frames.pop()!.rollback();
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure !== undefined) throw failure;
	}

	/**
	 * Runs before a table recreation's `PRAGMA foreign_keys = OFF`. A pending write in the current
	 * event makes that pragma a silent no-op, so settle it first; viborm reads the pragma back and
	 * refuses the recreation when it still reads 1.
	 */
	protected async beforeForeignKeysOff(): Promise<void> {
		await this.storage.sync();
	}
}

const drivers = new WeakMap<DurableObjectStorage, DurableObjectSqliteDriver>();

/**
 * The driver of a Durable Object's storage. One instance per `ctx.storage`: viborm serializes its
 * transactions and statements per driver, so every client on this storage must share it.
 */
export function createDurableObjectSqliteDriver(storage: DurableObjectStorage): DurableObjectSqliteDriver {
	let driver = drivers.get(storage);
	if (!driver) {
		driver = new DurableObjectSqliteDriver(storage);
		drivers.set(storage, driver);
	}
	return driver;
}
