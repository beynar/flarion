/**
 * Index ingestion: what the Editor track's queue consumer hands the Workspace DO in batches of up to 100
 * pages (docs/PLAN.md "Between Durable Objects"). Updates the `link` rows (mention, link, subpage), the
 * plain text kept for P3's FTS5 (`page_text`), and `updated_at`/`updated_by`. FTS5 itself is not built yet.
 */
import type { PageIndexItem } from '../../queues/types';
import type { WorkspaceTx } from '../../db/workspace.client';
import { chunks, isoTime, MAX_PARAMS, rawAll, rawRun } from './util';
import type { ChangeRecord } from './eav';

const LINK_KINDS = new Set(['mention', 'link', 'subpage']);
/** Body text kept per page: enough for search snippets, bounded so one huge page cannot bloat the object. */
export const MAX_PAGE_TEXT = 256 * 1024;

export interface IngestResult {
	indexed: number;
	skipped: number;
	/** Pages whose backlinks changed (their link targets, and the targets they stopped linking to). */
	backlinkTargets: string[];
	records: ChangeRecord[];
}

export async function ingestInTransaction(tx: WorkspaceTx, items: readonly PageIndexItem[]): Promise<IngestResult> {
	// The last item per page wins (the consumer deduplicates, but be safe).
	const latest = new Map<string, PageIndexItem>();
	for (const item of items) {
		const prior = latest.get(item.pageId);
		if (!prior || item.version >= prior.version) latest.set(item.pageId, item);
	}
	const pageIds = [...latest.keys()];
	const wanted = new Set(pageIds);
	for (const item of latest.values()) for (const l of item.links) wanted.add(l.to);

	const nums = new Map<string, { num: number; live: boolean }>();
	for (const part of chunks([...wanted], MAX_PARAMS)) {
		for (const r of await tx.page.findMany({ where: { id: { in: part } }, select: { id: true, num: true, deletedAt: true } })) {
			nums.set(r.id, { num: r.num, live: r.deletedAt === null });
		}
	}

	const result: IngestResult = { indexed: 0, skipped: 0, backlinkTargets: [], records: [] };
	const idOfNum = new Map<number, string>();
	for (const [id, v] of nums) idOfNum.set(v.num, id);
	const targets = new Set<string>();

	for (const item of latest.values()) {
		const self = nums.get(item.pageId);
		if (!self || !self.live) {
			result.skipped++;
			continue;
		}
		const existing = await rawAll<{ version: number }>(tx, 'SELECT version FROM page_text WHERE page_num = ?', self.num);
		if (existing[0] && existing[0].version > item.version) {
			result.skipped++; // a newer version is already indexed
			continue;
		}
		result.indexed++;

		await rawRun(
			tx,
			`INSERT INTO page_text (page_num, version, text, outline_json, edited_at, edited_by) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (page_num) DO UPDATE SET version = excluded.version, text = excluded.text,
			   outline_json = excluded.outline_json, edited_at = excluded.edited_at, edited_by = excluded.edited_by`,
			self.num,
			item.version,
			item.text.slice(0, MAX_PAGE_TEXT),
			JSON.stringify(item.outline),
			item.editedAt,
			item.editedBy
		);

		// Links: replace the page's outgoing rows of the three body kinds with what the body holds now.
		const next = new Set<string>();
		for (const l of item.links) {
			const to = nums.get(l.to);
			if (!to || !LINK_KINDS.has(l.kind) || l.to === item.pageId) continue;
			next.add(`${to.num}|${l.kind}`);
		}
		const before = await rawAll<{ to_page: number; kind: string }>(
			tx,
			'SELECT to_page, kind FROM link WHERE from_page = ?',
			self.num
		);
		const had = new Set(before.map((r) => `${r.to_page}|${r.kind}`));
		const add = [...next].filter((k) => !had.has(k));
		const remove = [...had].filter((k) => !next.has(k));
		// Links that went away may point at pages outside this batch: resolve their ids for the backlinks diff.
		const unknown = [...new Set(remove.map((k) => Number(k.split('|')[0])).filter((n) => !idOfNum.has(n)))];
		for (const part of chunks(unknown, MAX_PARAMS)) {
			for (const r of await tx.page.findMany({ where: { num: { in: part } }, select: { id: true, num: true } })) {
				idOfNum.set(r.num, r.id);
			}
		}
		for (const key of remove) {
			const [to, kind] = key.split('|');
			await rawRun(tx, 'DELETE FROM link WHERE from_page = ? AND to_page = ? AND kind = ?', self.num, Number(to), kind);
		}
		for (const key of add) {
			const [to, kind] = key.split('|');
			await rawRun(tx, 'INSERT OR IGNORE INTO link (from_page, to_page, kind) VALUES (?, ?, ?)', self.num, Number(to), kind);
		}
		if (add.length || remove.length) {
			const ids = (keys: string[]) => [...new Set(keys.map((k) => idOfNum.get(Number(k.split('|')[0]))).filter((x): x is string => !!x))];
			for (const id of [...ids(add), ...ids(remove)]) targets.add(id);
			result.records.push({
				kind: 'links',
				page: item.pageId,
				prop: null,
				old: null,
				new: { add: ids(add), remove: ids(remove) }
			});
		}

		await rawRun(
			tx,
			'UPDATE page SET updated_at = ?, updated_by = COALESCE(?, updated_by) WHERE id = ?',
			isoTime(item.editedAt),
			item.editedBy,
			item.pageId
		);
	}

	result.backlinkTargets = [...targets];
	return result;
}
