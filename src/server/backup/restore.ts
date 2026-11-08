/**
 * Restores of a Workspace DO (docs/PLAN.md "Runbooks": "Restore a workspace: point-in-time recovery of its Workspace
 * DO, then replay indexing for its pages"). Two paths, both started by the admin route (`http/admin-route.ts`):
 *
 *   point in time   `restoreToTimestamp`: the object arms `onNextSessionRestoreBookmark(getBookmarkForTime(ts))` and
 *                   aborts itself, so it wakes up restored. The first call after that (`afterRestore`) replays
 *                   indexing. The object's own storage is rolled back by the restore, so the "replay pending"
 *                   marker lives in KV (`restore:pending:<workspace>`), where the nightly job also finds it when
 *                   the operator's request died between the two steps.
 *   logical export  `restoreFromExport`: reads a `backups/ws/{id}/{day}.jsonl.gz`, verifies it completely (checksum,
 *                   counts, trailer) BEFORE it touches the object, loads it in batches, checks the loaded row counts
 *                   against the trailer, rebuilds the derived tables and replays indexing. The disaster-recovery
 *                   path: it works on a fresh or destroyed object, and on a populated one only with `force`.
 */
import type { BackupTrailer } from './format';
import { BackupCorruptError, readLines, verifyBackup } from './format';
import { backupKey, workspaceBackupApi, type BackupDoApi } from './backup';
import type { BackupHeader } from '../objects/workspace/backup';
import { PITR_WINDOW_MS } from '../objects/workspace/backup';

export const PENDING_PREFIX = 'restore:pending:';
export const pendingKey = (workspaceId: string) => `${PENDING_PREFIX}${workspaceId}`;

export interface PendingRestore {
	workspaceId: string;
	timestamp: number;
	bookmark: string;
	/** Restoring this bookmark undoes the restore (valid for the same 30-day window). */
	undo: string;
	armedAt: number;
}

export class RestoreRefused extends Error {
	override readonly name = 'RestoreRefused';
	constructor(
		message: string,
		readonly status = 409
	) {
		super(message);
	}
}

type RestoreEnv = Pick<Env, 'FILES' | 'WORKSPACE' | 'CACHE'>;

const IMPORT_LINES = 2000;
const IMPORT_BYTES = 1024 * 1024;

export interface ExportRestoreResult {
	key: string;
	rows: number;
	headSeq: number;
	counts: Record<string, number>;
	replayed: number;
}

/**
 * Loads a logical export into the workspace's object. `source` is a backup day (`2026-11-08`) or a full key.
 * Nothing is sent to the object until the whole file has been read and verified.
 */
export async function restoreFromExport(
	env: RestoreEnv,
	workspaceId: string,
	source: { date: string } | { key: string },
	options: { force?: boolean; api?: BackupDoApi } = {}
): Promise<ExportRestoreResult> {
	const key = 'key' in source ? source.key : backupKey(workspaceId, source.date);
	if (!key.startsWith(`backups/ws/${workspaceId}/`)) throw new RestoreRefused('The backup belongs to another workspace', 400);
	const api = options.api ?? workspaceBackupApi(env, workspaceId);

	// 1. Verify everything first: a bad file must never reach the object.
	const first = await env.FILES.get(key);
	if (!first) throw new RestoreRefused(`No backup at ${key}`, 404);
	const { header, trailer } = await verifyBackup(first.body);
	if (header.workspaceId !== workspaceId) throw new RestoreRefused('The backup was made for another workspace', 400);

	// 2. Load it.
	const second = await env.FILES.get(key);
	if (!second) throw new RestoreRefused(`No backup at ${key}`, 404);
	await api.importBegin(header, { force: options.force === true });
	let batch: string[] = [];
	let batchBytes = 0;
	let rows = 0;
	const flush = async () => {
		if (batch.length === 0) return;
		rows += await api.importBatch(header, batch);
		batch = [];
		batchBytes = 0;
	};
	let first_line = true;
	for await (const line of readLines(second.body)) {
		if (first_line) {
			first_line = false; // the header
			continue;
		}
		if (line.startsWith('{"end":true')) break;
		batch.push(line);
		batchBytes += line.length;
		if (batch.length >= IMPORT_LINES || batchBytes >= IMPORT_BYTES) await flush();
	}
	await flush();
	const finished = await api.importFinish(header, trailer);
	console.log(`[restore] ${workspaceId} from ${key}: ${rows} rows, indexing replayed for ${finished.replayed} pages`);
	return { key, rows, headSeq: header.headSeq, counts: finished.counts, replayed: finished.replayed };
}

export function checkPitrTimestamp(timestamp: number, now = Date.now()): void {
	if (!Number.isFinite(timestamp) || timestamp > now) throw new RestoreRefused('timestamp must be a time in the past', 400);
	if (timestamp < now - PITR_WINDOW_MS) throw new RestoreRefused('timestamp is outside the 30-day point-in-time recovery window', 400);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Point-in-time recovery of a workspace, then the replay of its indexing. The object aborts itself, which fails the
 * call that armed it: the marker it left in KV tells that apart from a real failure.
 */
export async function restorePointInTime(
	env: RestoreEnv,
	workspaceId: string,
	timestamp: number,
	options: { api?: BackupDoApi; retryMs?: number; tries?: number; now?: number } = {}
): Promise<{ pending: PendingRestore; replayed: number }> {
	checkPitrTimestamp(timestamp, options.now);
	const api = options.api ?? workspaceBackupApi(env, workspaceId);
	await env.CACHE.delete(pendingKey(workspaceId));
	let armError: unknown = null;
	try {
		await api.restoreToTimestamp(timestamp);
	} catch (error) {
		armError = error;
	}
	const pending = await env.CACHE.get<PendingRestore>(pendingKey(workspaceId), 'json');
	if (!pending) throw armError ?? new RestoreRefused('The object did not arm a restore', 500);
	const replayed = await finishRestore(env, workspaceId, { api, retryMs: options.retryMs, tries: options.tries });
	return { pending, replayed };
}

/** `afterRestore` on the woken object (retried: it is the first call after an abort), then the marker is dropped. */
export async function finishRestore(env: RestoreEnv, workspaceId: string, options: { api?: BackupDoApi; retryMs?: number; tries?: number } = {}): Promise<number> {
	const api = options.api ?? workspaceBackupApi(env, workspaceId);
	const tries = options.tries ?? 5;
	let last: unknown;
	for (let i = 0; i < tries; i++) {
		try {
			const { pages } = await api.afterRestore();
			await env.CACHE.delete(pendingKey(workspaceId));
			return pages;
		} catch (error) {
			last = error;
			await sleep(options.retryMs ?? 500 * (i + 1));
		}
	}
	throw last;
}

/** The nightly safety net: restores whose replay never ran (the operator's request died after arming it). */
export async function finishPendingRestores(env: RestoreEnv): Promise<{ checked: number; finished: string[]; failed: string[] }> {
	const listed = await env.CACHE.list({ prefix: PENDING_PREFIX });
	const out = { checked: listed.keys.length, finished: [] as string[], failed: [] as string[] };
	for (const { name } of listed.keys) {
		const workspaceId = name.slice(PENDING_PREFIX.length);
		try {
			await finishRestore(env, workspaceId, { tries: 2, retryMs: 200 });
			out.finished.push(workspaceId);
		} catch (error) {
			out.failed.push(workspaceId);
			console.error(`[restore] pending replay of ${workspaceId} failed:`, error instanceof Error ? error.message : error);
		}
	}
	return out;
}

export { BackupCorruptError };
export type { BackupHeader, BackupTrailer };
