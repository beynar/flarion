/**
 * Search indexing seams (owner: Accounts, AI, API). The Sync core calls these from the Workspace DO:
 * - `indexChanges` inside `apply()`'s transaction, after `afterWrite`, so titles and text property
 *   values are indexed in the write transaction (docs/PLAN.md "Search": Freshness).
 * - `indexBodies` from `ingestPages` (body text from the batched queue consumer).
 * - `removeFromIndex` when pages are purged.
 * - `reindexAll`: an idempotent rebuild of the whole index from the page rows and `page_text` (backfill).
 *
 * Layout of the FTS5 table `search(page_num UNINDEXED, field, text)`, porter + unicode61:
 * - `field = 'title'`: one row per page with a title (boosted at query time);
 * - `field = 'property'`: one row per page holding its text, url, email and phone values, one per line;
 * - `field = 'body'`: one row per paragraph-aligned chunk of about 1,200 characters of body text.
 *
 * Everything goes through the raw surface of the db/tx handed in (`$queryRawUnsafe`/`$executeRawUnsafe`),
 * never `ctx.storage.sql`, which is off limits while a transaction is open.
 */
import type { PageIndexItem } from '../queues/types';
import type { ChangeRecord } from '../objects/workspace/eav';
import type { WorkspaceClient, WorkspaceDb, WorkspaceTx } from '../db/workspace.client';
import { chunks, MAX_PARAMS, qmarks, rawAll, rawRun, rawRunQuiet } from '../objects/workspace/util';
import { chunkForFullText, cleanText } from './chunk';
import { loadEavRegistry } from '../objects/workspace/eav/registry';
import { TITLE_PROP_ID } from '../../lib/shared/property-types';

/** Property types whose values are indexed as text. */
export const INDEXED_PROPERTY_TYPES = ['text', 'url', 'email', 'phone', 'ai'] as const;
/** Rows per multi-row INSERT (three bound parameters each, under the platform's 100). */
const ROWS_PER_INSERT = 30;

interface Row {
	num: number;
	field: 'title' | 'property' | 'body';
	text: string;
}

async function insertRows(db: WorkspaceDb, rows: readonly Row[]): Promise<void> {
	for (const part of chunks(rows, ROWS_PER_INSERT)) {
		await rawRunQuiet(
			db,
			`INSERT INTO search (page_num, field, text) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`,
			...part.flatMap((r) => [r.num, r.field, r.text])
		);
	}
}

/** Deletes the rows of the given fields for the pages: one statement per 90 pages. */
async function deleteRows(db: WorkspaceDb, nums: readonly number[], fields: readonly Row['field'][] | null): Promise<void> {
	for (const part of chunks(nums, MAX_PARAMS - 3)) {
		const where = fields ? ` AND field IN (${qmarks(fields.length)})` : '';
		await rawRunQuiet(db, `DELETE FROM search WHERE page_num IN (${qmarks(part.length)})${where}`, ...part, ...(fields ?? []));
	}
}

/** The strings of a property value that read as text (a text value is a string). */
const textOf = (value: unknown): string => (typeof value === 'string' ? cleanText(value).trim() : '');

async function textPropertyIds(db: WorkspaceDb): Promise<Set<string>> {
	const rows = await rawAll<{ id: string }>(
		db,
		`SELECT id FROM property WHERE deleted_at IS NULL AND type IN (${qmarks(INDEXED_PROPERTY_TYPES.length)})`,
		...INDEXED_PROPERTY_TYPES
	);
	return new Set(rows.map((r) => r.id));
}

interface PageForIndex {
	num: number;
	title: string;
	props_json: string | null;
}

/** Title and property rows of pages as they are in the database now. */
function rowsOfPages(pages: readonly PageForIndex[], textProps: ReadonlySet<string>): Row[] {
	const rows: Row[] = [];
	for (const page of pages) {
		const title = cleanText(page.title ?? '').trim();
		if (title) rows.push({ num: page.num, field: 'title', text: title });
		let props: Record<string, unknown> = {};
		try {
			props = page.props_json ? (JSON.parse(page.props_json) as Record<string, unknown>) : {};
		} catch {
			/* a corrupt props_json indexes no properties; the next write rebuilds it */
		}
		const parts: string[] = [];
		for (const [id, value] of Object.entries(props)) if (textProps.has(id)) parts.push(textOf(value));
		const text = parts.filter(Boolean).join('\n');
		if (text) rows.push({ num: page.num, field: 'property', text });
	}
	return rows;
}

/** Replaces the title and property rows of the pages (by `num`) with what their rows hold now. */
async function reindexPages(db: WorkspaceDb, nums: readonly number[]): Promise<void> {
	if (nums.length === 0) return;
	const textProps = await textPropertyIds(db);
	for (const part of chunks(nums, MAX_PARAMS)) {
		const pages = await rawAll<PageForIndex>(
			db,
			`SELECT num, title, props_json FROM page WHERE num IN (${qmarks(part.length)})`,
			...part
		);
		await deleteRows(db, part, ['title', 'property']);
		await insertRows(db, rowsOfPages(pages, textProps));
	}
}

/**
 * Indexes titles and text, url, email and phone property values of the pages a commit touched, inside that
 * commit's transaction (a rollback leaves no rows). Property definition changes re-read the pages that held
 * the property (a deleted property's text must leave the index).
 */
export async function indexChanges(tx: WorkspaceTx, records: ChangeRecord[]): Promise<void> {
	const pageIds = new Set<string>();
	const definitionProps = new Set<string>();
	// A write of a number, a checkbox or a select changes nothing the index holds: only titles and text-like properties re-read the page.
	const registry = records.some((r) => r.kind === 'setProp' && r.page) ? await loadEavRegistry(tx as unknown as WorkspaceDb) : null;
	const indexed = (prop: string | null | undefined): boolean => {
		if (!prop || prop === TITLE_PROP_ID) return true;
		const type = registry?.get(prop)?.type;
		return type === undefined || (INDEXED_PROPERTY_TYPES as readonly string[]).includes(type);
	};
	for (const r of records) {
		if (r.kind === 'setProp' && r.page && !indexed(r.prop)) continue;
		if ((r.kind === 'setProp' || r.kind === 'create') && r.page) pageIds.add(r.page);
		else if ((r.kind === 'deleteProperty' || r.kind === 'updateProperty') && r.prop) definitionProps.add(r.prop);
	}
	const nums = new Set<number>();
	for (const part of chunks([...pageIds], MAX_PARAMS)) {
		for (const row of await rawAll<{ num: number }>(tx, `SELECT num FROM page WHERE id IN (${qmarks(part.length)})`, ...part)) {
			nums.add(row.num);
		}
	}
	for (const prop of definitionProps) {
		const like = `%"${prop.replace(/[\\%_"]/g, (c) => `\\${c}`)}"%`;
		for (const row of await rawAll<{ num: number }>(tx, "SELECT num FROM page WHERE props_json LIKE ? ESCAPE '\\'", like)) {
			nums.add(row.num);
		}
	}
	await reindexPages(tx, [...nums]);
}

/**
 * Replaces each page's body rows with chunks of the new text. A page that no longer exists is skipped; an item
 * older than the `page_text` already held for the page is skipped (a newer ingest got there first).
 */
export async function indexBodies(db: WorkspaceDb, items: PageIndexItem[]): Promise<void> {
	const latest = new Map<string, PageIndexItem>();
	for (const item of items) {
		const prior = latest.get(item.pageId);
		if (!prior || item.version >= prior.version) latest.set(item.pageId, item);
	}
	for (const part of chunks([...latest.keys()], MAX_PARAMS)) {
		const pages = await rawAll<{ id: string; num: number; text_version: number | null }>(
			db,
			`SELECT p.id AS id, p.num AS num, t.version AS text_version FROM page p LEFT JOIN page_text t ON t.page_num = p.num
			 WHERE p.id IN (${qmarks(part.length)})`,
			...part
		);
		const rows: Row[] = [];
		const nums: number[] = [];
		for (const page of pages) {
			const item = latest.get(page.id)!;
			if (page.text_version !== null && page.text_version > item.version) continue;
			nums.push(page.num);
			for (const text of chunkForFullText(item.text)) rows.push({ num: page.num, field: 'body', text });
		}
		await deleteRows(db, nums, ['body']);
		await insertRows(db, rows);
	}
}

/** Removes every row of the pages (purge) and their visit records. Idempotent. */
export async function removeFromIndex(db: WorkspaceDb, pageNums: number[]): Promise<void> {
	await deleteRows(db, pageNums, null);
	for (const part of chunks(pageNums, MAX_PARAMS)) {
		await rawRun(db, `DELETE FROM visit WHERE page_num IN (${qmarks(part.length)})`, ...part);
	}
}

/**
 * Backfill: rebuilds titles, properties and bodies (from `page_text`) of every page. Idempotent and resumable:
 * rows of pages that no longer exist go first, then each batch of 50 pages is replaced in its own transaction.
 */
export async function reindexAll(db: WorkspaceClient): Promise<{ pages: number }> {
	await rawRun(db, 'DELETE FROM search WHERE page_num NOT IN (SELECT num FROM page)');
	await rawRun(db, 'DELETE FROM visit WHERE page_num NOT IN (SELECT num FROM page)');
	let after = 0;
	let pages = 0;
	for (;;) {
		const batch = await rawAll<{ num: number; text: string | null }>(
			db,
			'SELECT p.num AS num, t.text AS text FROM page p LEFT JOIN page_text t ON t.page_num = p.num WHERE p.num > ? ORDER BY p.num LIMIT 50',
			after
		);
		if (batch.length === 0) break;
		await db.$transaction(async (tx) => {
			const nums = batch.map((b) => b.num);
			await reindexPages(tx, nums);
			await deleteRows(tx, nums, ['body']);
			const rows: Row[] = [];
			for (const b of batch) for (const text of chunkForFullText(b.text ?? '')) rows.push({ num: b.num, field: 'body', text });
			await insertRows(tx, rows);
		});
		pages += batch.length;
		after = batch[batch.length - 1]!.num;
	}
	return { pages };
}
