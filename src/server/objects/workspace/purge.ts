/**
 * Purge: what leaves the Workspace DO's database when trashed pages are deleted for good (docs/PLAN.md "Soft
 * delete and trash", "Purge after 30 days"). The Workflow (`workflows/purge.ts`) and `page.purge` run the same
 * path: plan, `purgePageRows` (this module), search rows, Page DO rooms, files, vectors.
 *
 * `purgePageRows` runs on the base client inside a commit, after an explicit assert by the caller (the
 * governed client cannot hard-delete): it takes the EAV rows, relation cells of other pages, collection members,
 * links, indexed text, grants, collections (with their views) and finally the page rows themselves. The change
 * log keeps the rows (sequence numbers must never go back) but loses their old and new values.
 */
import type { WorkspaceDb, WorkspaceTx } from '../../db/workspace.client';
import { purgePageEav, type ChangeRecord, type EavOpContext } from './eav';
import { chunks, MAX_PARAMS, qmarks, rawAll, rawRun, isoTime } from './util';

/** A purged page: its id and dense number (search rows and visits are keyed by it). */
export interface PurgedPage {
	id: string;
	num: number;
}

/** Tombstones older than this many days are purged. */
export const TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * The pages among `ids` that can go now: tombstoned, and whose children all go too (a page still holding a child
 * outside the set stays, and so do its ancestors in the set). Order is kept.
 */
export async function purgeable(db: WorkspaceDb, ids: readonly string[]): Promise<PurgedPage[]> {
	const rows = new Map<string, { id: string; num: number; parent_id: string | null }>();
	for (const part of chunks(ids, MAX_PARAMS)) {
		for (const r of await rawAll<{ id: string; num: number; parent_id: string | null }>(
			db,
			`SELECT id, num, parent_id FROM page WHERE id IN (${qmarks(part.length)}) AND deleted_at IS NOT NULL`,
			...part
		)) {
			rows.set(r.id, r);
		}
	}
	const blocked = new Set<string>();
	for (const part of chunks([...rows.keys()], MAX_PARAMS)) {
		for (const r of await rawAll<{ id: string; parent_id: string }>(db, `SELECT id, parent_id FROM page WHERE parent_id IN (${qmarks(part.length)})`, ...part)) {
			if (!rows.has(r.id)) blocked.add(r.parent_id);
		}
	}
	// A blocked page keeps its ancestors too.
	for (const id of [...blocked]) {
		let up = rows.get(id)?.parent_id ?? null;
		while (up && rows.has(up) && !blocked.has(up)) {
			blocked.add(up);
			up = rows.get(up)?.parent_id ?? null;
		}
	}
	return ids.filter((id) => rows.has(id) && !blocked.has(id)).map((id) => ({ id, num: (rows.get(id) as { num: number }).num }));
}

/**
 * Tombstones past the cutoff, deepest first (a child before its parent), at most `limit`. A batch never cuts a
 * parent away from children that are not in it, so the caller can purge batch after batch until none is left.
 */
export async function planPurge(db: WorkspaceDb, cutoffMs: number, limit = 500): Promise<PurgedPage[]> {
	const rows = await rawAll<{ id: string }>(
		db,
		`WITH RECURSIVE exp(id, num, parent_id) AS (
			SELECT id, num, parent_id FROM page WHERE deleted_at IS NOT NULL AND deleted_at < ?
		), depth(id, d) AS (
			SELECT id, 0 FROM exp WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM exp)
			UNION ALL
			SELECT e.id, depth.d + 1 FROM exp e JOIN depth ON e.parent_id = depth.id
		)
		SELECT e.id AS id FROM exp e JOIN depth ON depth.id = e.id ORDER BY depth.d DESC, e.num LIMIT ?`,
		isoTime(cutoffMs),
		limit
	);
	return purgeable(db, rows.map((r) => r.id));
}

/** Archived teamspaces past the cutoff with no page left. */
export async function purgeableTeamspaces(db: WorkspaceDb, cutoffMs: number): Promise<string[]> {
	return (
		await rawAll<{ id: string }>(
			db,
			'SELECT t.id AS id FROM teamspace t WHERE t.deleted_at IS NOT NULL AND t.deleted_at < ? AND NOT EXISTS (SELECT 1 FROM page p WHERE p.teamspace_id = t.id)',
			isoTime(cutoffMs)
		)
	).map((r) => r.id);
}

/** Deletes archived teamspaces (their members and grants go with them). Returns the ids removed. */
export async function purgeTeamspaceRows(tx: WorkspaceTx, ids: readonly string[]): Promise<string[]> {
	const done: string[] = [];
	for (const id of ids) {
		const gone = await rawAll<{ n: number }>(tx, 'SELECT 1 AS n FROM teamspace WHERE id = ? AND deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM page WHERE teamspace_id = ?)', id, id);
		if (gone.length === 0) continue;
		await rawRun(tx, 'DELETE FROM teamspace_member WHERE teamspace_id = ?', id);
		await rawRun(tx, 'DELETE FROM "grant" WHERE teamspace_id = ?', id);
		await rawRun(tx, 'DELETE FROM teamspace WHERE id = ?', id);
		done.push(id);
	}
	return done;
}

/**
 * Deletes the pages (tombstones only) and everything that hangs off them. Returns who went, and the change
 * records of the other pages that lost a relation target. Pages that are live, unknown or still have a child
 * outside `ids` are left alone.
 */
export async function purgePageRows(
	tx: WorkspaceTx,
	ids: readonly string[],
	ctx: EavOpContext
): Promise<{ purged: PurgedPage[]; records: ChangeRecord[] }> {
	const pages = await purgeable(tx, ids);
	const records: ChangeRecord[] = [];
	for (const page of pages) records.push(...(await purgePageEav(tx, page.id, ctx)));
	for (const part of chunks(pages, MAX_PARAMS)) {
		const partIds = part.map((p) => p.id);
		const partNums = part.map((p) => p.num);
		const idMarks = qmarks(partIds.length);
		const numMarks = qmarks(partNums.length);
		// Links of the pages (both directions), the indexed body text, recent visits.
		await rawRun(tx, `DELETE FROM link WHERE from_page IN (${numMarks})`, ...partNums);
		await rawRun(tx, `DELETE FROM link WHERE to_page IN (${numMarks})`, ...partNums);
		await rawRun(tx, `DELETE FROM page_text WHERE page_num IN (${numMarks})`, ...partNums);
		await rawRun(tx, `DELETE FROM open_room WHERE page_id IN (${idMarks})`, ...partIds);
		// What was said about them in the log (titles, values) goes; the rows stay so sequence numbers never move.
		await rawRun(tx, `UPDATE change SET old_json = NULL, new_json = NULL WHERE page IN (${idMarks})`, ...partIds);
		await rawRun(tx, `DELETE FROM "grant" WHERE page_id IN (${idMarks})`, ...partIds);
		// A database page takes its collection, views and members.
		await rawRun(tx, `DELETE FROM view WHERE collection_id IN (SELECT id FROM collection WHERE page_id IN (${idMarks}))`, ...partIds);
		await rawRun(tx, `DELETE FROM collection_member WHERE collection_id IN (SELECT id FROM collection WHERE page_id IN (${idMarks}))`, ...partIds);
		await rawRun(tx, `DELETE FROM collection WHERE page_id IN (${idMarks})`, ...partIds);
		// Children first is not needed once nothing points at the set from outside: detach, then delete.
		await rawRun(tx, `UPDATE page SET parent_id = NULL WHERE id IN (${idMarks})`, ...partIds);
	}
	for (const part of chunks(pages, MAX_PARAMS)) {
		await rawRun(tx, `DELETE FROM page WHERE id IN (${qmarks(part.length)})`, ...part.map((p) => p.id));
	}
	return { purged: pages, records };
}
