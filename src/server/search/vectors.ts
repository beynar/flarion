/**
 * Vectorize access (owner: Accounts, AI, API). Vectors are `pageId:chunk` with `workspaceId`, `pageId` and
 * `chunk` metadata in the `flarion-chunks` index (1024 dimensions, `@cf/baai/bge-m3`). `VECTORS` and `AI` are
 * optional bindings: without them everything here is a quiet no-op and full-text search carries on
 * (the "AI down" runbook).
 *
 * The index needs a metadata index on `workspaceId` for the query filter
 * (`wrangler vectorize create-metadata-index flarion-chunks --property-name workspaceId --type string`).
 */
import { embed } from '../ai/client';
import { chunks } from '../objects/workspace/util';
import { workspaceEmbedStore, type EmbedStore } from './embed-store';
import type { VectorSearch } from './query';

export const vectorId = (pageId: string, chunk: number): string => `${pageId}:${chunk}`;
/** Splits `pageId:chunk` at the last colon. */
export function pageIdOfVector(id: string): string {
	const at = id.lastIndexOf(':');
	return at < 0 ? id : id.slice(0, at);
}

/** Vectorize allows 1,000 ids per mutation; stay well below. */
const MUTATION_BATCH = 200;

/** What the pipeline needs of a Vectorize index (the binding satisfies it; tests pass a fake). */
export interface VectorIndex {
	upsert(vectors: { id: string; values: number[]; metadata?: Record<string, string | number> }[]): Promise<unknown>;
	deleteByIds(ids: string[]): Promise<unknown>;
	query(
		vector: number[],
		options: { topK: number; filter?: Record<string, unknown>; returnMetadata?: 'none' | 'indexed' | 'all'; returnValues?: boolean }
	): Promise<{ matches: { id: string; score: number }[] }>;
}

export const vectorIndexOf = (env: Pick<Env, 'VECTORS'>): VectorIndex | null => (env.VECTORS as unknown as VectorIndex | undefined) ?? null;

export async function upsertVectors(index: VectorIndex, vectors: Parameters<VectorIndex['upsert']>[0]): Promise<void> {
	for (const part of chunks(vectors, MUTATION_BATCH)) await index.upsert(part);
}

export async function deleteVectors(index: VectorIndex, ids: readonly string[]): Promise<void> {
	for (const part of chunks([...ids], MUTATION_BATCH)) await index.deleteByIds(part);
}

/**
 * Deletes every chunk of the pages from Vectorize (purge Workflow). The ids come from the Workspace DO's
 * `embed_chunk` rows, which are forgotten only after Vectorize accepted the deletion (a retry finds them).
 */
export async function deletePageVectors(
	env: Env,
	workspaceId: string,
	pageIds: string[],
	deps: { index?: VectorIndex | null; store?: EmbedStore } = {}
): Promise<void> {
	const index = deps.index === undefined ? vectorIndexOf(env) : deps.index;
	if (!index || pageIds.length === 0) return;
	const store = deps.store ?? workspaceEmbedStore(env, workspaceId);
	const ids = await store.chunkIds(pageIds);
	if (ids.length > 0) await deleteVectors(index, ids);
	await store.forget(pageIds);
}

/** The semantic leg of search for one workspace; null when Workers AI or Vectorize is not bound. */
export function vectorSearchOf(env: Env, workspaceId: string, deps: { index?: VectorIndex | null } = {}): VectorSearch | null {
	const index = deps.index === undefined ? vectorIndexOf(env) : deps.index;
	if (!index || !env.AI) return null;
	return async (query, topK) => {
		const [vector] = await embed(env, [query]);
		if (!vector) return [];
		const result = await index.query(vector, { topK: Math.min(100, topK), filter: { workspaceId }, returnMetadata: 'none', returnValues: false });
		return result.matches.map((m) => ({ pageId: pageIdOfVector(m.id), score: m.score }));
	};
}
