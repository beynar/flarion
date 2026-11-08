/**
 * Nightly logical backups of Workspace DOs to R2 (docs/PLAN.md "Operations": "Backups").
 *
 *   backups/ws/{workspaceId}/{YYYY-MM-DD}.jsonl.gz     one logical export per day (format: ./format.ts)
 *   backups/ws/{workspaceId}/LATEST.json               manifest of the last successful backup
 *
 * The prefix `backups/` shares the files bucket but not a namespace with anything else: user files are
 * `ws/{workspaceId}/{fileId}` and are only reachable through the Workspace DO's `file` rows (a file route never takes
 * a key from the request), page snapshots and history are `ws/{ws}/pages/...`, and workspace deletion removes
 * `ws/{id}/`. The upload sweep and the purge Workflow never list `backups/`; this module owns it, with a 30 day retention.
 *
 * `runBackup` pages through the Workspace DO (`backupBegin` / `backupBatch` / `backupEnd`, about 1 MiB per RPC reply),
 * gzips as it goes and streams to R2 (multipart past 8 MiB), so memory stays flat whatever the workspace holds. The
 * object holds its commit queue between begin and end (up to 60 s, then the fence lifts on its own): a backup that
 * saw no write is `consistent`; one that did is retried, and kept flagged `consistent: false` after the last try
 * (restore a flagged backup only when point-in-time recovery cannot help, see docs/ops/restore.md).
 */
import type { BackupHeader, ExportBatch, ExportCursor } from '../objects/workspace/backup';
import { GzipSink, LineDigest, R2Sink, type BackupTrailer } from './format';

export const BACKUP_PREFIX = 'backups/ws/';
export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export const backupKey = (workspaceId: string, day: string) => `${BACKUP_PREFIX}${workspaceId}/${day}.jsonl.gz`;
export const manifestKey = (workspaceId: string) => `${BACKUP_PREFIX}${workspaceId}/LATEST.json`;
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The Workspace DO calls a backup and a restore make (plain promises over Durable Object RPC). */
export interface BackupDoApi {
	backupBegin(holdMs?: number): Promise<BackupHeader>;
	backupBatch(header: BackupHeader, cursor: ExportCursor | null): Promise<ExportBatch>;
	backupEnd(): Promise<{ headSeq: number }>;
	importBegin(header: BackupHeader, options?: { force?: boolean }): Promise<void>;
	importBatch(header: BackupHeader, lines: string[]): Promise<number>;
	importFinish(header: BackupHeader, trailer: BackupTrailer): Promise<{ counts: Record<string, number>; replayed: number }>;
	replayIndexing(): Promise<{ pages: number }>;
	restoreToTimestamp(timestamp: number): Promise<never>;
	afterRestore(): Promise<{ pages: number }>;
}

export const workspaceBackupApi = (env: Pick<Env, 'WORKSPACE'>, workspaceId: string): BackupDoApi =>
	env.WORKSPACE.getByName(workspaceId) as unknown as BackupDoApi;

export interface BackupManifest {
	workspaceId: string;
	key: string;
	createdAt: string;
	rows: number;
	bytes: number;
	headSeq: number;
	consistent: boolean;
	databaseBytes: number;
	tables: Record<string, number>;
}

export interface BackupResult extends BackupManifest {
	attempts: number;
	pruned: number;
}

export interface BackupOptions {
	now?: number;
	api?: BackupDoApi;
	partBytes?: number;
	/** Tries before a backup that saw writes is kept flagged inconsistent. */
	attempts?: number;
	holdMs?: number;
}

type BackupEnv = Pick<Env, 'FILES' | 'WORKSPACE'> & { METRICS?: AnalyticsEngineDataset };

/** One export attempt: header, rows, trailer, straight into R2. Throws (after aborting the upload) on any failure. */
async function exportOnce(env: BackupEnv, api: BackupDoApi, workspaceId: string, key: string, options: BackupOptions): Promise<BackupManifest> {
	const header = await api.backupBegin(options.holdMs);
	const metadata = { workspaceId, headSeq: String(header.headSeq), format: String(header.v) };
	const sink = new R2Sink(env.FILES, key, options.partBytes, metadata);
	const gzip = new GzipSink((chunk) => sink.push(chunk));
	const digest = new LineDigest();
	const counts: Record<string, number> = Object.fromEntries(header.tables.map((t) => [t.name, 0]));
	let rows = 0;
	let headSeqEnd = header.headSeq;
	try {
		const headerLine = JSON.stringify(header);
		await digest.add(headerLine);
		await gzip.write(headerLine);
		let cursor: ExportCursor | null = null;
		do {
			const batch: ExportBatch = await api.backupBatch(header, cursor);
			for (const line of batch.lines) {
				await digest.add(line);
				await gzip.write(line);
				// Lines start with `{"t":"` (6 characters), then the table name.
				const table = line.slice(6, line.indexOf('"', 6));
				counts[table] = (counts[table] ?? 0) + 1;
				rows++;
			}
			cursor = batch.cursor;
		} while (cursor);
		headSeqEnd = (await api.backupEnd()).headSeq;
		const trailer: BackupTrailer = { end: true, rows, counts, sha256: await digest.finish(), headSeqEnd };
		await gzip.write(JSON.stringify(trailer));
		await gzip.close();
		await sink.complete();
	} catch (error) {
		await gzip.abort(error);
		await sink.abort();
		await api.backupEnd().catch(() => {});
		throw error;
	}
	return {
		workspaceId,
		key,
		createdAt: header.createdAt,
		rows,
		bytes: sink.bytes,
		headSeq: headSeqEnd,
		consistent: headSeqEnd === header.headSeq,
		databaseBytes: header.databaseBytes,
		tables: counts
	};
}

/** Backs one workspace up, writes the manifest, applies retention. */
export async function runBackup(env: BackupEnv, workspaceId: string, options: BackupOptions = {}): Promise<BackupResult> {
	const now = options.now ?? Date.now();
	const api = options.api ?? workspaceBackupApi(env, workspaceId);
	const key = backupKey(workspaceId, dayOf(now));
	const attempts = Math.max(1, options.attempts ?? 3);
	let manifest: BackupManifest | null = null;
	let tried = 0;
	try {
		while (tried < attempts) {
			tried++;
			manifest = await exportOnce(env, api, workspaceId, key, options);
			if (manifest.consistent) break;
		}
		const done = manifest as BackupManifest;
		await env.FILES.put(manifestKey(workspaceId), JSON.stringify(done), { httpMetadata: { contentType: 'application/json' } });
		const pruned = await pruneBackups(env, workspaceId, now);
		record(env, workspaceId, 'ok', done.bytes, done.rows, done.consistent);
		console.log(`[backup] ${workspaceId}: ${done.rows} rows, ${done.bytes} bytes, seq ${done.headSeq}${done.consistent ? '' : ' (INCONSISTENT: writes during the export)'}, pruned ${pruned}`);
		return { ...done, attempts: tried, pruned };
	} catch (error) {
		record(env, workspaceId, 'failed', 0, 0, false);
		console.error(`[backup] ${workspaceId} failed:`, error instanceof Error ? (error.stack ?? error.message) : error);
		throw error;
	}
}

/** The metrics hook: one Analytics Engine point per backup (a no-op without the binding, as in local dev). */
function record(env: { METRICS?: AnalyticsEngineDataset }, workspaceId: string, outcome: 'ok' | 'failed', bytes: number, rows: number, consistent: boolean): void {
	try {
		env.METRICS?.writeDataPoint({ indexes: [`backup:${workspaceId}`.slice(0, 96)], blobs: ['backup', outcome, workspaceId, consistent ? 'consistent' : 'inconsistent'], doubles: [bytes, rows] });
	} catch {
		// metrics never fail a backup
	}
}

// ───────────────────────────── listing and retention ─────────────────────────────

export interface BackupEntry {
	key: string;
	day: string;
	size: number;
	uploaded: string;
}

const DAY_KEY = /\/(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
	const out: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor, limit: 1000 });
		out.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return out;
}

/** The backups of a workspace, newest first. */
export async function listBackups(env: Pick<Env, 'FILES'>, workspaceId: string): Promise<BackupEntry[]> {
	const objects = await listAll(env.FILES, `${BACKUP_PREFIX}${workspaceId}/`);
	return objects
		.flatMap((o) => {
			const day = DAY_KEY.exec(o.key)?.[1];
			return day ? [{ key: o.key, day, size: o.size, uploaded: o.uploaded.toISOString() }] : [];
		})
		.sort((a, b) => (a.day < b.day ? 1 : -1));
}

/**
 * Deletes backups older than 30 days, always keeping the newest one (a workspace whose backups stopped must not lose
 * its last good copy to retention). Returns how many objects went.
 */
export async function pruneBackups(env: Pick<Env, 'FILES'>, workspaceId: string, now = Date.now(), options: { keepNewest?: boolean } = {}): Promise<number> {
	const entries = await listBackups(env, workspaceId);
	const cutoff = dayOf(now - RETENTION_DAYS * DAY_MS);
	const keepNewest = options.keepNewest !== false;
	const doomed = entries.filter((e, i) => e.day < cutoff && !(keepNewest && i === 0)).map((e) => e.key);
	for (let i = 0; i < doomed.length; i += 1000) await env.FILES.delete(doomed.slice(i, i + 1000));
	if (!keepNewest && entries.length === doomed.length) await env.FILES.delete(manifestKey(workspaceId));
	return doomed.length;
}

/** Workspace ids that have a backup prefix. */
export async function backedUpWorkspaces(env: Pick<Env, 'FILES'>): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.FILES.list({ prefix: BACKUP_PREFIX, delimiter: '/', cursor, limit: 1000 });
		for (const p of page.delimitedPrefixes) ids.push(p.slice(BACKUP_PREFIX.length, -1));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return ids;
}

/**
 * Backups of workspaces that are not live any more (deleted in D1, or gone from it after the 30-day purge): their
 * objects age out by the same retention, and the whole prefix is gone once the last one is older than 30 days.
 */
export async function pruneOrphanBackups(env: Pick<Env, 'FILES'>, liveIds: ReadonlySet<string>, now = Date.now()): Promise<{ workspaces: number; deleted: number }> {
	let deleted = 0;
	let workspaces = 0;
	for (const id of await backedUpWorkspaces(env)) {
		if (liveIds.has(id)) continue;
		workspaces++;
		deleted += await pruneBackups(env, id, now, { keepNewest: false });
	}
	return { workspaces, deleted };
}
