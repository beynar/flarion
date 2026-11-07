/**
 * Workspace-side bookkeeping of uploaded files (docs/PLAN.md "Files and media"). The Worker streams bytes to
 * R2; this module owns what the plan keeps in the Workspace DO: the `file` table, the storage quota, and the
 * permission check on the page that owns a file. Every function takes a {@link FilesContext}, so the
 * Workspace DO class only forwards (`WorkspaceDO.files*`).
 *
 * The table is created here (`ensureFilesTable`, `CREATE TABLE IF NOT EXISTS`, called from the object's
 * constructor) and not as a viborm model: viborm only widens an estate's managed-table scope with a fresh
 * estate, which a deployed object cannot adopt. Everything is additive and idempotent.
 *
 * Lifecycle: `begin` inserts an uncommitted row (its size counts against the quota at once, so parallel
 * uploads cannot overshoot), the Worker `PUT`s the bytes to `ws/{workspaceId}/{fileId}`, `complete` checks
 * R2 holds them and commits the row. A weekly sweep removes rows never committed.
 */
import {
	DEFAULT_STORAGE_QUOTA_BYTES,
	MAX_FILE_BYTES,
	MAX_PARTS,
	MULTIPART_PART_BYTES,
	SINGLE_PUT_MAX_BYTES,
	UNCOMMITTED_MAX_AGE_MS,
	fileKey
} from '../../files/constants';
import type { Actor } from '../../auth/session';
import { WorkspaceError } from './errors';

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

export interface FilesContext {
	sql: SqlStorage;
	env: Pick<Env, 'FILES'>;
	workspaceId: string;
	/** The level the actor holds on a page, or `null` when the page is hidden or gone. */
	level(pageId: string): Promise<PageLevel | null>;
	now?: number;
}

export interface FileRecord {
	id: string;
	pageId: string;
	name: string;
	size: number;
	type: string;
	r2Key: string;
	createdBy: string;
	createdAt: number;
	committed: boolean;
	deletedAt: number | null;
	uploadId: string | null;
}

type FileRow = {
	id: string;
	page_id: string;
	name: string;
	size: number;
	type: string;
	r2_key: string;
	created_by: string;
	created_at: number;
	committed: number;
	deleted_at: number | null;
	upload_id: string | null;
};

const toRecord = (row: FileRow): FileRecord => ({
	id: row.id,
	pageId: row.page_id,
	name: row.name,
	size: row.size,
	type: row.type,
	r2Key: row.r2_key,
	createdBy: row.created_by,
	createdAt: row.created_at,
	committed: row.committed === 1,
	deletedAt: row.deleted_at,
	uploadId: row.upload_id
});

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

const QUOTA_KEY = 'quota';

export function storageQuota(sql: SqlStorage): number {
	const row = sql.exec<{ value: string }>('SELECT value FROM file_meta WHERE key = ?', QUOTA_KEY).toArray()[0];
	const value = row ? Number(row.value) : NaN;
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_STORAGE_QUOTA_BYTES;
}

/** Operators (and tests) change a workspace's quota here; `null` restores the default. */
export function setStorageQuota(sql: SqlStorage, bytes: number | null): number {
	if (bytes === null) sql.exec('DELETE FROM file_meta WHERE key = ?', QUOTA_KEY);
	else sql.exec('INSERT OR REPLACE INTO file_meta (key, value) VALUES (?, ?)', QUOTA_KEY, String(Math.max(0, Math.floor(bytes))));
	return storageQuota(sql);
}

/** Bytes the workspace holds: committed files and uploads still in flight. */
export function storageUsed(sql: SqlStorage): number {
	return sql.exec<{ used: number | null }>('SELECT SUM(size) AS used FROM file WHERE deleted_at IS NULL').one().used ?? 0;
}

export const filesUsage = (sql: SqlStorage) => ({
	used: storageUsed(sql),
	quota: storageQuota(sql),
	files: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM file WHERE deleted_at IS NULL AND committed = 1').one().n
});

/** A name safe to put in a header and a path: no separators or control characters, at most 255 characters. */
export function sanitizeName(name: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
	return (cleaned || 'file').slice(0, 255);
}

/** A MIME type as `type/subtype` in lower case, else `application/octet-stream`. */
export function sanitizeType(type: string): string {
	const base = type.split(';')[0]!.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base) ? base : 'application/octet-stream';
}

const bad = (message: string) => new WorkspaceError('BAD_REQUEST', message);
const notFoundFile = () => new WorkspaceError('NOT_FOUND', 'File not found');

function readRow(sql: SqlStorage, fileId: string): FileRecord | null {
	const row = sql.exec<FileRow>('SELECT * FROM file WHERE id = ?', fileId).toArray()[0];
	return row ? toRecord(row) : null;
}

export interface BeginInput {
	pageId: string;
	name: string;
	size: number;
	type: string;
}

export interface BeginResult {
	fileId: string;
	uploadUrl: string;
	multipart: boolean;
	partSize?: number;
}

/** `files.begin`: `update` on the page, room in the quota, then an uncommitted row and where to send the bytes. */
export async function beginUpload(ctx: FilesContext, actor: Actor, input: BeginInput): Promise<BeginResult> {
	const level = await ctx.level(input.pageId);
	if (level === null) throw new WorkspaceError('NOT_FOUND', 'Page not found');
	if (!atLeast(level, 'update')) throw new WorkspaceError('FORBIDDEN', 'You cannot upload files to this page');
	if (!Number.isInteger(input.size) || input.size < 0) throw bad('Invalid file size');
	if (input.size > MAX_FILE_BYTES) throw bad(`Files are limited to ${MAX_FILE_BYTES} bytes`);
	const used = storageUsed(ctx.sql);
	const quota = storageQuota(ctx.sql);
	if (used + input.size > quota) {
		throw bad(`Storage quota exceeded: ${used} of ${quota} bytes used, this file needs ${input.size} more`);
	}
	const multipart = input.size > SINGLE_PUT_MAX_BYTES;
	if (multipart && Math.ceil(input.size / MULTIPART_PART_BYTES) > MAX_PARTS) throw bad('File too large for multipart upload');
	const id = crypto.randomUUID();
	ctx.sql.exec(
		'INSERT INTO file (id, page_id, name, size, type, r2_key, created_by, created_at, committed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
		id,
		input.pageId,
		sanitizeName(input.name),
		input.size,
		sanitizeType(input.type),
		fileKey(ctx.workspaceId, id),
		actor.userId,
		ctx.now ?? Date.now()
	);
	const query = `?ws=${encodeURIComponent(ctx.workspaceId)}`;
	return multipart
		? { fileId: id, uploadUrl: `/files/${id}/parts${query}`, multipart: true, partSize: MULTIPART_PART_BYTES }
		: { fileId: id, uploadUrl: `/files/${id}${query}`, multipart: false };
}

/**
 * The pending upload `actor` may send bytes for: theirs (`begin` was theirs), not committed, and the page
 * still writable by them. What `PUT /files/:fileId` and the parts endpoints ask first.
 */
export async function pendingUpload(ctx: FilesContext, actor: Actor, fileId: string): Promise<FileRecord> {
	const file = readRow(ctx.sql, fileId);
	if (!file || file.deletedAt !== null || file.createdBy !== actor.userId) throw notFoundFile();
	if (file.committed) throw new WorkspaceError('CONFLICT', 'This upload is already complete');
	if (!atLeast(await ctx.level(file.pageId), 'update')) throw new WorkspaceError('FORBIDDEN', 'You cannot upload files to this page');
	return file;
}

/** Records the R2 multipart upload of a pending file. */
export function recordUploadId(ctx: FilesContext, fileId: string, uploadId: string): void {
	ctx.sql.exec('UPDATE file SET upload_id = ? WHERE id = ? AND committed = 0', uploadId, fileId);
}

/** What the file's owner page lets `actor` read, or `null` for no such file, an uncommitted one, or a hidden page. */
export async function readableFile(ctx: FilesContext, fileId: string): Promise<FileRecord | null> {
	const file = readRow(ctx.sql, fileId);
	if (!file || !file.committed || file.deletedAt !== null) return null;
	return atLeast(await ctx.level(file.pageId), 'read') ? file : null;
}

export interface CommittedFile {
	id: string;
	pageId: string;
	name: string;
	size: number;
	type: string;
}

const info = (file: FileRecord): CommittedFile => ({
	id: file.id,
	pageId: file.pageId,
	name: file.name,
	size: file.size,
	type: file.type
});

/**
 * `files.complete`: finishes a multipart upload (R2 assembles `parts`), checks R2 holds exactly the bytes
 * `begin` announced, and commits the row. Idempotent for the file's creator.
 */
export async function completeUpload(
	ctx: FilesContext,
	actor: Actor,
	fileId: string,
	parts?: { partNumber: number; etag: string }[]
): Promise<CommittedFile> {
	const existing = readRow(ctx.sql, fileId);
	if (existing?.committed && existing.createdBy === actor.userId && existing.deletedAt === null) return info(existing);
	const file = await pendingUpload(ctx, actor, fileId);
	if (file.uploadId) {
		if (!parts || parts.length === 0) throw bad('A multipart upload needs its parts');
		const upload = ctx.env.FILES.resumeMultipartUpload(file.r2Key, file.uploadId);
		try {
			await upload.complete([...parts].sort((a, b) => a.partNumber - b.partNumber));
		} catch (error) {
			throw bad(`Could not assemble the upload: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const head = await ctx.env.FILES.head(file.r2Key);
	if (!head) throw bad('The file has not been uploaded');
	if (head.size !== file.size) {
		await ctx.env.FILES.delete(file.r2Key);
		throw bad(`The uploaded file is ${head.size} bytes, expected ${file.size}`);
	}
	ctx.sql.exec('UPDATE file SET committed = 1, upload_id = NULL WHERE id = ?', fileId);
	return info({ ...file, committed: true });
}

/** `files.abort`: drops a pending upload (its multipart upload and bytes included). Only the creator may. */
export async function abortUpload(ctx: FilesContext, actor: Actor, fileId: string): Promise<void> {
	const file = readRow(ctx.sql, fileId);
	if (!file || file.createdBy !== actor.userId) throw notFoundFile();
	if (file.committed) throw bad('This file is already uploaded');
	await discardPending(ctx, file);
}

async function discardPending(ctx: FilesContext, file: FileRecord): Promise<void> {
	if (file.uploadId) {
		try {
			await ctx.env.FILES.resumeMultipartUpload(file.r2Key, file.uploadId).abort();
		} catch {
			// Already completed or aborted.
		}
	}
	await ctx.env.FILES.delete(file.r2Key);
	ctx.sql.exec('DELETE FROM file WHERE id = ?', file.id);
}

/** `files.get`: a committed file the actor may read on its page. */
export async function getFile(ctx: FilesContext, fileId: string): Promise<CommittedFile> {
	const file = await readableFile(ctx, fileId);
	if (!file) throw notFoundFile();
	return info(file);
}

/**
 * The weekly sweep (cron `0 4 * * SUN`): uploads begun before `cutoff` and never committed lose their row,
 * their multipart upload and their bytes. Returns how many it removed.
 */
export async function sweepUncommitted(
	sql: SqlStorage,
	env: Pick<Env, 'FILES'>,
	workspaceId: string,
	options: { now?: number; maxAgeMs?: number } = {}
): Promise<number> {
	const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? UNCOMMITTED_MAX_AGE_MS);
	const stale = sql.exec<FileRow>('SELECT * FROM file WHERE committed = 0 AND created_at < ?', cutoff).toArray();
	const ctx: FilesContext = { sql, env, workspaceId, level: async () => null };
	for (const row of stale) await discardPending(ctx, toRecord(row));
	return stale.length;
}

/**
 * Purge of pages (docs/PLAN.md "Files and media": "Purge deletes files referenced only by purged pages"):
 * every file owned by `pageIds` loses its row and its bytes. A file belongs to the one page it was uploaded to.
 */
export async function purgeFilesOfPages(
	sql: SqlStorage,
	env: Pick<Env, 'FILES'>,
	workspaceId: string,
	pageIds: readonly string[]
): Promise<number> {
	let removed = 0;
	const ctx: FilesContext = { sql, env, workspaceId, level: async () => null };
	for (let i = 0; i < pageIds.length; i += 50) {
		const chunk = pageIds.slice(i, i + 50);
		const rows = sql
			.exec<FileRow>(`SELECT * FROM file WHERE page_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)
			.toArray();
		for (const row of rows) {
			await discardPending(ctx, toRecord(row));
			removed++;
		}
	}
	return removed;
}
