/** Chunking at headings, hash skips, deletes, model changes, purge and the quiet "AI down" path. */
import { describe, expect, test } from 'vitest';
import { chunkForEmbedding, hashChunk, EMBED_CHUNK_CHARS } from '../../../src/server/search/chunk';
import { embedPages, workspaceEmbedStore, type EmbedDeps } from '../../../src/server/search/embed';
import { deletePageVectors, pageIdOfVector, type VectorIndex } from '../../../src/server/search/vectors';
import { testEnv } from '../helpers';
import { addPage, bodyItem, createWorkspace, rows, type Fixture } from './helpers';

const heading = (text: string, level = 1) => ({ level, text, blockId: `b-${text}` });

/** A fake Vectorize index that remembers what it holds. */
class FakeIndex implements VectorIndex {
	vectors = new Map<string, { values: number[]; metadata?: Record<string, string | number> }>();
	upserts: string[][] = [];
	deletes: string[][] = [];
	async upsert(vectors: { id: string; values: number[]; metadata?: Record<string, string | number> }[]) {
		this.upserts.push(vectors.map((v) => v.id));
		for (const v of vectors) this.vectors.set(v.id, { values: v.values, metadata: v.metadata });
	}
	async deleteByIds(ids: string[]) {
		this.deletes.push(ids);
		for (const id of ids) this.vectors.delete(id);
	}
	async query() {
		return { matches: [] };
	}
}

/** A fake embedding function: records the texts it is asked for, returns a 4-dimensional vector per text. */
function fakeEmbed() {
	const calls: string[][] = [];
	const embed = async (texts: string[]) => {
		calls.push(texts);
		return texts.map((t) => [t.length, 1, 0, 0]);
	};
	return { embed, calls };
}

async function setup(label: string, deps: { failEmbed?: boolean } = {}) {
	const ws = await createWorkspace(label);
	await addPage(ws, 'a', 'Doc A');
	await addPage(ws, 'b', 'Doc B');
	const index = new FakeIndex();
	const fake = fakeEmbed();
	const options: EmbedDeps = {
		store: workspaceEmbedStore(testEnv, ws.id),
		index,
		embed: deps.failEmbed ? async () => Promise.reject(new Error('ai down')) : fake.embed,
		model: 'model-1'
	};
	return { ws, index, fake, options };
}

const stored = (ws: Fixture, pageId: string) =>
	rows<{ idx: number; hash: string; model: string; version: number }>(ws.stub, 'SELECT idx, hash, model, version FROM embed_chunk WHERE page_id = ? ORDER BY idx', pageId);

const DOC = 'Intro\nFirst paragraph of the intro.\nDetails\nThe details live here.\nPricing\nCosts are low.';
const OUTLINE = [heading('Intro'), heading('Details'), heading('Pricing')];

describe('chunking', () => {
	test('splits at headings, keeps a heading with its text, and is deterministic', () => {
		const chunks = chunkForEmbedding({ text: DOC, outline: OUTLINE });
		expect(chunks).toEqual(['Intro\nFirst paragraph of the intro.', 'Details\nThe details live here.', 'Pricing\nCosts are low.']);
		expect(chunkForEmbedding({ text: DOC, outline: OUTLINE })).toEqual(chunks);
		// Text before the first heading is a chunk of its own; consecutive headings stay together; no outline: one flow.
		expect(chunkForEmbedding({ text: 'Preamble line\nTitle\nSub\nBody', outline: [heading('Title'), heading('Sub', 2)] })).toEqual(['Preamble line', 'Title\nSub\nBody']);
		expect(chunkForEmbedding({ text: 'one\ntwo', outline: [] })).toEqual(['one\ntwo']);
		expect(chunkForEmbedding({ text: '', outline: [] })).toEqual([]);
	});

	test('a long section is cut into pieces of about 500 tokens at paragraph (then word) boundaries', () => {
		const paragraph = (n: number) => `Paragraph ${n}: ${'word '.repeat(150)}`.trim();
		const text = ['Big section', ...Array.from({ length: 10 }, (_, i) => paragraph(i))].join('\n');
		const chunks = chunkForEmbedding({ text, outline: [heading('Big section')] });
		expect(chunks.length).toBeGreaterThan(3);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(EMBED_CHUNK_CHARS);
		expect(chunks[0]!.startsWith('Big section\n')).toBe(true);
		const oneHugeLine = chunkForEmbedding({ text: 'x '.repeat(5000), outline: [] });
		for (const c of oneHugeLine) expect(c.length).toBeLessThanOrEqual(EMBED_CHUNK_CHARS);
	});

	test('hashes are stable and differ with the text', async () => {
		expect(await hashChunk('hello')).toBe(await hashChunk('hello'));
		expect(await hashChunk('hello')).not.toBe(await hashChunk('hello!'));
		expect(await hashChunk('hello')).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe('embedPages', () => {
	test('embeds every chunk once as pageId:chunk with workspace and page metadata; an unchanged page is skipped', async () => {
		const { ws, index, fake, options } = await setup('emb-first');
		const first = await embedPages(testEnv, ws.id, [bodyItem('a', DOC, 1, OUTLINE)], options);
		expect(first).toMatchObject({ embedded: 3, unchanged: 0, deleted: 0, failed: false, unavailable: false });
		expect([...index.vectors.keys()]).toEqual(['a:0', 'a:1', 'a:2']);
		expect(index.vectors.get('a:1')!.metadata).toEqual({ workspaceId: ws.id, pageId: 'a', chunk: 1 });
		expect(fake.calls).toEqual([['Intro\nFirst paragraph of the intro.', 'Details\nThe details live here.', 'Pricing\nCosts are low.']]);
		expect((await stored(ws, 'a')).map((r) => [r.idx, r.model, r.version])).toEqual([[0, 'model-1', 1], [1, 'model-1', 1], [2, 'model-1', 1]]);

		const again = await embedPages(testEnv, ws.id, [bodyItem('a', DOC, 2, OUTLINE)], options);
		expect(again).toMatchObject({ embedded: 0, unchanged: 3, deleted: 0 });
		expect(fake.calls).toHaveLength(1);
		expect(index.upserts).toHaveLength(1);
	});

	test('only the chunks whose hash changed are embedded again', async () => {
		const { ws, index, fake, options } = await setup('emb-changed');
		await embedPages(testEnv, ws.id, [bodyItem('a', DOC, 1, OUTLINE)], options);
		const edited = DOC.replace('The details live here.', 'The details moved elsewhere.');
		const result = await embedPages(testEnv, ws.id, [bodyItem('a', edited, 2, OUTLINE)], options);
		expect(result).toMatchObject({ embedded: 1, unchanged: 2 });
		expect(fake.calls[1]).toEqual(['Details\nThe details moved elsewhere.']);
		expect(index.upserts[1]).toEqual(['a:1']);
	});

	test('chunks that no longer exist are deleted from Vectorize and from the hash table', async () => {
		const { ws, index, options } = await setup('emb-delete');
		await embedPages(testEnv, ws.id, [bodyItem('a', DOC, 1, OUTLINE)], options);
		const shorter = 'Intro\nFirst paragraph of the intro.';
		const result = await embedPages(testEnv, ws.id, [bodyItem('a', shorter, 2, [heading('Intro')])], options);
		expect(result).toMatchObject({ embedded: 0, unchanged: 1, deleted: 2 });
		expect(index.deletes).toEqual([['a:1', 'a:2']]);
		expect([...index.vectors.keys()]).toEqual(['a:0']);
		expect((await stored(ws, 'a')).map((r) => r.idx)).toEqual([0]);
		// An emptied page loses everything.
		await embedPages(testEnv, ws.id, [bodyItem('a', '', 3)], options);
		expect(index.vectors.size).toBe(0);
		expect(await stored(ws, 'a')).toEqual([]);
	});

	test('a changed embedding model re-embeds everything, even with identical hashes', async () => {
		const { ws, index, fake, options } = await setup('emb-model');
		await embedPages(testEnv, ws.id, [bodyItem('a', DOC, 1, OUTLINE)], options);
		const result = await embedPages(testEnv, ws.id, [bodyItem('a', DOC, 1, OUTLINE)], { ...options, model: 'model-2' });
		expect(result).toMatchObject({ embedded: 3, unchanged: 0 });
		expect(fake.calls).toHaveLength(2);
		expect(index.vectors.size).toBe(3);
		expect((await stored(ws, 'a')).map((r) => r.model)).toEqual(['model-2', 'model-2', 'model-2']);
	});

	test('a batch of pages is embedded in one call; a stale version and a missing page are skipped', async () => {
		const { ws, index, fake, options } = await setup('emb-batch');
		await embedPages(testEnv, ws.id, [bodyItem('a', 'Alpha text', 5)], options);
		const result = await embedPages(
			testEnv,
			ws.id,
			[bodyItem('a', 'Alpha stale text', 3), bodyItem('b', 'Beta text', 1), bodyItem('ghost', 'Ghost text', 1)],
			options
		);
		expect(result).toMatchObject({ embedded: 1 });
		expect(fake.calls[1]).toEqual(['Beta text']);
		expect([...index.vectors.keys()].sort()).toEqual(['a:0', 'b:0']);
	});

	test('a failing embedding model leaves nothing recorded, so the next run retries; it never throws', async () => {
		const down = await setup('emb-fail', { failEmbed: true });
		const failed = await embedPages(testEnv, down.ws.id, [bodyItem('a', DOC, 1, OUTLINE)], down.options);
		expect(failed).toMatchObject({ failed: true, embedded: 0 });
		expect(await stored(down.ws, 'a')).toEqual([]);
		const fake = fakeEmbed();
		const retried = await embedPages(testEnv, down.ws.id, [bodyItem('a', DOC, 1, OUTLINE)], { ...down.options, embed: fake.embed });
		expect(retried).toMatchObject({ failed: false, embedded: 3 });
	});

	test('without Workers AI or Vectorize (dev) it does nothing, quietly', async () => {
		const ws = await createWorkspace('emb-dev');
		await addPage(ws, 'a', 'Doc');
		const result = await embedPages(testEnv, ws.id, [bodyItem('a', DOC, 1, OUTLINE)]);
		expect(result).toMatchObject({ unavailable: true, embedded: 0, failed: false });
		expect(await rows(ws.stub, 'SELECT COUNT(*) AS n FROM embed_chunk')).toEqual([{ n: 0 }]);
	});
});

describe('deletePageVectors', () => {
	test('removes every chunk of the pages from Vectorize, forgets the hashes, and is idempotent', async () => {
		const { ws, index, options } = await setup('emb-purge');
		await embedPages(testEnv, ws.id, [bodyItem('a', DOC, 1, OUTLINE), bodyItem('b', 'Beta body', 1)], options);
		expect(index.vectors.size).toBe(4);
		await deletePageVectors(testEnv, ws.id, ['a'], { index, store: options.store });
		expect([...index.vectors.keys()]).toEqual(['b:0']);
		expect(await stored(ws, 'a')).toEqual([]);
		expect((await stored(ws, 'b')).length).toBe(1);
		await deletePageVectors(testEnv, ws.id, ['a'], { index, store: options.store });
		expect(index.vectors.size).toBe(1);
		// No Vectorize binding: a quiet no-op.
		await expect(deletePageVectors(testEnv, ws.id, ['b'])).resolves.toBeUndefined();
		expect((await stored(ws, 'b')).length).toBe(1);
	});

	test('vector ids split at the last colon', () => {
		expect(pageIdOfVector('page-1:3')).toBe('page-1');
		expect(pageIdOfVector('a:b:12')).toBe('a:b');
	});
});

describe('the Workspace DO backfill', () => {
	test('embedAll embeds every live page from page_text; without bindings it reports unavailable', async () => {
		const ws = await createWorkspace('emb-all');
		await addPage(ws, 'a', 'Doc A');
		await ws.stub.ingestPages([bodyItem('a', DOC, 1, OUTLINE)]);
		const results = await ws.stub.embedAll();
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]).toMatchObject({ unavailable: true });
	});
});
