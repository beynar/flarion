/**
 * The embedding half of the indexing pipeline (docs/PLAN.md "Indexing pipeline"), run by the queue consumer
 * after `ingestPages`: split each page at headings into chunks of about 500 tokens, skip chunks whose hash
 * (and embedding model id) has not changed, embed the rest with Workers AI through AI Gateway, upsert them to
 * Vectorize as `pageId:chunk`, delete chunks that no longer exist, and only then record the hashes.
 *
 * Never throws: a failure is logged and counted, and full-text search is unaffected. Without `env.AI` or
 * `env.VECTORS` (dev) it does nothing. The hashes live in the Workspace DO (`embed_chunk`).
 */
import { embed as defaultEmbed } from '../ai/client';
import type { PageIndexItem } from '../queues/types';
import { chunkForEmbedding, hashChunk } from './chunk';
import { workspaceEmbedStore, type EmbedPlan, type EmbedStore, type PageChunks } from './embed-store';
import { deleteVectors, upsertVectors, vectorId, vectorIndexOf, type VectorIndex } from './vectors';

export { workspaceEmbedStore };
export type { EmbedPlan, EmbedStore, PageChunks };

/** Overridable parts (tests pass fakes; the defaults are the real bindings). */
export interface EmbedDeps {
	store?: EmbedStore;
	embed?: (texts: string[]) => Promise<number[][]>;
	index?: VectorIndex | null;
	model?: string;
}

export interface EmbedResult {
	/** Chunks embedded and upserted. */
	embedded: number;
	/** Chunks skipped because their hash and model were unchanged. */
	unchanged: number;
	/** Vectors deleted because their chunk no longer exists. */
	deleted: number;
	failed: boolean;
	/** No AI or Vectorize binding: nothing was done. */
	unavailable: boolean;
}

export async function embedPages(env: Env, workspaceId: string, items: PageIndexItem[], deps: EmbedDeps = {}): Promise<EmbedResult> {
	const result: EmbedResult = { embedded: 0, unchanged: 0, deleted: 0, failed: false, unavailable: false };
	const index = deps.index === undefined ? vectorIndexOf(env) : deps.index;
	const embed = deps.embed ?? (env.AI ? (texts: string[]) => defaultEmbed(env, texts) : null);
	if (!index || !embed || items.length === 0) {
		result.unavailable = !index || !embed;
		return result;
	}
	const model = deps.model ?? env.AI_EMBEDDING_MODEL;
	const store = deps.store ?? workspaceEmbedStore(env, workspaceId);
	try {
		// The newest version of each page wins.
		const latest = new Map<string, PageIndexItem>();
		for (const item of items) {
			const prior = latest.get(item.pageId);
			if (!prior || item.version >= prior.version) latest.set(item.pageId, item);
		}
		const pages: (PageChunks & { texts: string[] })[] = [];
		for (const item of latest.values()) {
			const texts = chunkForEmbedding(item);
			pages.push({ pageId: item.pageId, version: item.version, texts, hashes: await Promise.all(texts.map(hashChunk)) });
		}
		const plans = new Map((await store.diff(model, pages.map(({ pageId, version, hashes }) => ({ pageId, version, hashes })))).map((p) => [p.pageId, p]));

		const todo: { id: string; pageId: string; idx: number; text: string }[] = [];
		const staleIds: string[] = [];
		const apply: PageChunks[] = [];
		for (const page of pages) {
			const plan = plans.get(page.pageId);
			if (!plan || plan.skip) continue;
			result.unchanged += page.hashes.length - plan.changed.length;
			for (const idx of plan.changed) todo.push({ id: vectorId(page.pageId, idx), pageId: page.pageId, idx, text: page.texts[idx]! });
			for (const idx of plan.stale) staleIds.push(vectorId(page.pageId, idx));
			if (plan.changed.length > 0 || plan.stale.length > 0) apply.push({ pageId: page.pageId, version: page.version, hashes: page.hashes });
		}
		if (todo.length > 0) {
			const vectors = await embed(todo.map((t) => t.text));
			await upsertVectors(
				index,
				todo.map((t, i) => ({ id: t.id, values: vectors[i]!, metadata: { workspaceId, pageId: t.pageId, chunk: t.idx } }))
			);
			result.embedded = todo.length;
		}
		if (staleIds.length > 0) {
			await deleteVectors(index, staleIds);
			result.deleted = staleIds.length;
		}
		if (apply.length > 0) await store.apply(model, apply);
	} catch (error) {
		result.failed = true;
		console.warn(`[search] embedding failed for ${workspaceId}:`, String(error));
	}
	return result;
}
