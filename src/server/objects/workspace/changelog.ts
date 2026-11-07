/**
 * The change log: one `change` row per logical change, appended inside the commit's transaction.
 * The last row's `seq` is the commit's sequence number. Retention is 7 days plus a size cap, pruned
 * by the object's alarm; `log_floor` (in `meta`) is the highest seq ever deleted, so a reconnecting
 * client knows whether every change after its `seq` is still there.
 */
import { DbNull } from 'viborm';
import type { WorkspaceClient, WorkspaceDb, WorkspaceTx } from '../../db/workspace.client';
import type { ChangeRecord } from './eav';
import { asJson, chunks, qmarks, rawAll, rawRun } from './util';

export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Size cap: rows kept at most, oldest pruned first. */
export const LOG_MAX_ROWS = 200_000;
/** Edits by one actor to one property within this window collapse into one row. */
export const COALESCE_MS = 5000;
export const LOG_FLOOR_KEY = 'log_floor';

/** Kinds that coalesce: live typing (a title with a 300 ms debounce) writes one value many times. */
const COALESCED_KINDS: ReadonlySet<string> = new Set(['setProp']);

export interface LogRow {
	seq: number;
	ts: number;
	actor: string;
	commitId: string;
	kind: string;
	page: string | null;
	prop: string | null;
	old: unknown;
	new: unknown;
}

interface RawLogRow {
	seq: number;
	ts: number;
	actor: string;
	commitId: string;
	kind: string;
	page: string | null;
	prop: string | null;
	oldJson: unknown;
	newJson: unknown;
}

const toLogRow = (r: RawLogRow): LogRow => ({
	seq: r.seq,
	ts: r.ts,
	actor: r.actor,
	commitId: r.commitId,
	kind: r.kind,
	page: r.page,
	prop: r.prop,
	old: r.oldJson ?? null,
	new: r.newJson ?? null
});

/**
 * Appends `records` as one commit. Returns the rows written (coalesced rows included) and the commit's
 * seq: the last row's, or the log's head when the ops changed nothing.
 */
export async function appendChanges(
	tx: WorkspaceTx,
	input: { commitId: string; actor: string; now: number; records: readonly ChangeRecord[] }
): Promise<{ seq: number; rows: LogRow[] }> {
	const rows: LogRow[] = [];
	for (const record of input.records) {
		let old = asJson(record.old);
		if (COALESCED_KINDS.has(record.kind) && record.page !== null && record.prop !== null) {
			const prior = await tx.change.findFirst({
				where: { page: record.page, prop: record.prop },
				orderBy: { seq: 'desc' }
			});
			if (
				prior &&
				prior.actor === input.actor &&
				prior.kind === record.kind &&
				input.now - prior.ts <= COALESCE_MS
			) {
				// Delete the superseded row and append a fresh one: the new row has a later seq, so a client
				// that already holds the old value replays the new one. The original `old` is kept.
				await tx.change.delete({ where: { seq: prior.seq } });
				old = prior.oldJson ?? null;
				const at = rows.findIndex((r) => r.seq === prior.seq);
				if (at >= 0) rows.splice(at, 1);
			}
		}
		const created = await tx.change.create({
			data: {
				ts: input.now,
				actor: input.actor,
				commitId: input.commitId,
				kind: record.kind,
				page: record.page,
				prop: record.prop,
				oldJson: (old === null ? DbNull : old) as never,
				newJson: (asJson(record.new) === null ? DbNull : record.new) as never
			}
		});
		rows.push(
			toLogRow({
				seq: created.seq,
				ts: input.now,
				actor: input.actor,
				commitId: input.commitId,
				kind: record.kind,
				page: record.page,
				prop: record.prop,
				oldJson: old,
				newJson: asJson(record.new)
			})
		);
	}
	const seq = rows.length > 0 ? rows[rows.length - 1].seq : await headSeq(tx);
	return { seq, rows };
}

/** The sequence number of the newest change (0 for an empty log). */
export async function headSeq(db: WorkspaceDb): Promise<number> {
	const row = await db.change.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } });
	if (row) return row.seq;
	// An emptied log still has a floor: seq numbers never go back (AUTOINCREMENT).
	return logFloor(db);
}

export async function logFloor(db: WorkspaceDb): Promise<number> {
	const row = await db.meta.findUnique({ where: { key: LOG_FLOOR_KEY } });
	return typeof row?.value === 'number' ? row.value : 0;
}

/** Changes after `seq`, oldest first. */
export async function changesSince(db: WorkspaceDb, seq: number, limit = 10_000): Promise<LogRow[]> {
	const rows = await db.change.findMany({ where: { seq: { gt: seq } }, orderBy: { seq: 'asc' }, take: limit });
	return (rows as RawLogRow[]).map(toLogRow);
}

export interface PruneResult {
	deleted: number;
	floor: number;
	remaining: number;
}

/**
 * Deletes changes older than the retention and, beyond the size cap, the oldest ones; records the new
 * floor. Also drops idempotency records of mutations that old.
 */
export async function pruneLog(
	db: WorkspaceClient,
	now: number,
	options: { retentionMs?: number; maxRows?: number } = {}
): Promise<PruneResult> {
	const retention = options.retentionMs ?? LOG_RETENTION_MS;
	const maxRows = options.maxRows ?? LOG_MAX_ROWS;
	return db.$transaction(async (tx) => {
		const cutoff = now - retention;
		let floor = await logFloor(tx);
		let deleted = 0;
		const old = await tx.change.findFirst({
			where: { ts: { lt: cutoff } },
			orderBy: { seq: 'desc' },
			select: { seq: true }
		});
		// Rows are appended in time order, so "older than the cutoff" is a prefix of the log.
		if (old) {
			deleted += await rawRun(tx, 'DELETE FROM change WHERE seq <= ?', old.seq);
			floor = Math.max(floor, old.seq);
		}
		const total = await tx.change.count();
		if (total > maxRows) {
			const edge = await tx.change.findMany({
				orderBy: { seq: 'asc' },
				skip: total - maxRows - 1,
				take: 1,
				select: { seq: true }
			});
			if (edge[0]) {
				deleted += await rawRun(tx, 'DELETE FROM change WHERE seq <= ?', edge[0].seq);
				floor = Math.max(floor, edge[0].seq);
			}
		}
		await tx.meta.upsert({
			where: { key: LOG_FLOOR_KEY },
			create: { key: LOG_FLOOR_KEY, value: floor },
			update: { value: floor }
		});
		await rawRun(tx, 'DELETE FROM mutation WHERE ts < ?', cutoff);
		const remaining = await tx.change.count();
		return { deleted, floor, remaining };
	});
}

/** Distinct values helper for batched `IN` lists in raw queries. */
export async function rawInChunks<T>(
	db: WorkspaceDb,
	sql: (marks: string) => string,
	ids: readonly string[]
): Promise<T[]> {
	const out: T[] = [];
	for (const part of chunks(ids)) out.push(...(await rawAll<T>(db, sql(qmarks(part.length)), ...part)));
	return out;
}
