/**
 * The `embed_chunk` table of the Workspace DO (see `tables.ts`): which chunk hashes of each page are in
 * Vectorize, and with which embedding model. Runs inside the DO; `embed.ts` reaches it through the DO's
 * `embedDiff`/`embedApply`/`embedChunkIds`/`embedForget` methods.
 */
import type { WorkspaceDb } from '../db/workspace.client';
import { chunks, MAX_PARAMS, qmarks, rawAll, rawRun } from '../objects/workspace/util';

export interface PageChunks {
	pageId: string;
	version: number;
	/** Hash of each chunk, in order: chunk `i` is the vector `pageId:i`. */
	hashes: string[];
}

export interface EmbedPlan {
	pageId: string;
	/** The page is gone, or a newer version is already embedded: do nothing for it. */
	skip: boolean;
	/** Chunk indexes to embed and upsert (new, changed, or embedded with another model). */
	changed: number[];
	/** Chunk indexes that no longer exist and must be deleted from Vectorize. */
	stale: number[];
}

interface Row {
	page_id: string;
	idx: number;
	hash: string;
	model: string;
	version: number;
}

async function existing(db: WorkspaceDb, pageIds: readonly string[]): Promise<Map<string, Row[]>> {
	const out = new Map<string, Row[]>();
	for (const part of chunks([...pageIds], MAX_PARAMS)) {
		const rows = await rawAll<Row>(db, `SELECT page_id, idx, hash, model, version FROM embed_chunk WHERE page_id IN (${qmarks(part.length)})`, ...part);
		for (const r of rows) out.set(r.page_id, [...(out.get(r.page_id) ?? []), r]);
	}
	return out;
}

/** What to embed and delete for each page, given the hashes of its chunks as the body is now. */
export async function diffChunks(db: WorkspaceDb, model: string, pages: readonly PageChunks[]): Promise<EmbedPlan[]> {
	const ids = pages.map((p) => p.pageId);
	const alive = new Set<string>();
	for (const part of chunks(ids, MAX_PARAMS)) {
		for (const r of await rawAll<{ id: string }>(db, `SELECT id FROM page WHERE id IN (${qmarks(part.length)})`, ...part)) alive.add(r.id);
	}
	const held = await existing(db, ids);
	return pages.map((page) => {
		const rows = held.get(page.pageId) ?? [];
		if (!alive.has(page.pageId) || rows.some((r) => r.version > page.version)) {
			return { pageId: page.pageId, skip: true, changed: [], stale: [] };
		}
		const byIdx = new Map(rows.map((r) => [r.idx, r]));
		const changed: number[] = [];
		page.hashes.forEach((hash, i) => {
			const row = byIdx.get(i);
			if (!row || row.hash !== hash || row.model !== model) changed.push(i);
		});
		const stale = rows.filter((r) => r.idx >= page.hashes.length).map((r) => r.idx);
		return { pageId: page.pageId, skip: false, changed, stale };
	});
}

/** Records the pages' chunks as embedded and drops the rows of chunks that no longer exist. */
export async function applyChunks(db: WorkspaceDb, model: string, pages: readonly PageChunks[]): Promise<void> {
	for (const page of pages) {
		await rawRun(db, 'DELETE FROM embed_chunk WHERE page_id = ? AND idx >= ?', page.pageId, page.hashes.length);
		for (const part of chunks(page.hashes.map((hash, idx) => ({ hash, idx })), 18)) {
			await rawRun(
				db,
				`INSERT OR REPLACE INTO embed_chunk (page_id, idx, hash, model, version) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
				...part.flatMap((c) => [page.pageId, c.idx, c.hash, model, page.version])
			);
		}
	}
}

/** The vector ids (`pageId:idx`) held for pages. */
export async function chunkIdsOf(db: WorkspaceDb, pageIds: readonly string[]): Promise<string[]> {
	const out: string[] = [];
	for (const [pageId, rows] of await existing(db, pageIds)) for (const r of rows) out.push(`${pageId}:${r.idx}`);
	return out;
}

export async function forgetChunks(db: WorkspaceDb, pageIds: readonly string[]): Promise<void> {
	for (const part of chunks([...pageIds], MAX_PARAMS)) {
		await rawRun(db, `DELETE FROM embed_chunk WHERE page_id IN (${qmarks(part.length)})`, ...part);
	}
}

/** The Workspace DO's side of the pipeline, as `embed.ts` and `vectors.ts` use it. */
export interface EmbedStore {
	diff(model: string, pages: PageChunks[]): Promise<EmbedPlan[]>;
	apply(model: string, pages: PageChunks[]): Promise<void>;
	chunkIds(pageIds: string[]): Promise<string[]>;
	forget(pageIds: string[]): Promise<void>;
}

type DoMethods = {
	embedDiff(model: string, pages: PageChunks[]): Promise<EmbedPlan[]>;
	embedApply(model: string, pages: PageChunks[]): Promise<void>;
	embedChunkIds(pageIds: string[]): Promise<string[]>;
	embedForget(pageIds: string[]): Promise<void>;
};

/** The store of a workspace, over Durable Object RPC. */
export function workspaceEmbedStore(env: Pick<Env, 'WORKSPACE'>, workspaceId: string): EmbedStore {
	const stub = () => env.WORKSPACE.getByName(workspaceId) as unknown as DoMethods;
	return {
		diff: (model, pages) => stub().embedDiff(model, pages),
		apply: (model, pages) => stub().embedApply(model, pages),
		chunkIds: (pageIds) => stub().embedChunkIds(pageIds),
		forget: (pageIds) => stub().embedForget(pageIds)
	};
}
