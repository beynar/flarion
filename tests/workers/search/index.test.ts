/** FTS5 index writes: in the write transaction, body replacement, purge, backfill, trash. */
import { describe, expect, test } from 'vitest';
import { indexBodies, indexChanges, removeFromIndex } from '../../../src/server/search/index-writes';
import { chunkForFullText } from '../../../src/server/search/chunk';
import { addPage, batch, bodyItem, createWorkspace, ftsRows, numOf, op, rows, withDb } from './helpers';

const setProp = (pageId: string, prop: string) => ({ kind: 'setProp', page: pageId, prop, old: null, new: null });

describe('titles and properties are indexed in the write transaction', () => {
	test('a committed transaction leaves title and text-property rows; a rolled-back one leaves none', async () => {
		const ws = await createWorkspace('fts-tx');
		await ws.stub.apply(ws.owner, batch([op({ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } })]));
		await ws.stub.apply(ws.owner, batch([op({ op: 'createProperty', property: { id: 'site', name: 'Site', type: 'url', config: {} } })]));
		await ws.stub.apply(ws.owner, batch([op({ op: 'createProperty', property: { id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } } })]));
		await addPage(ws, 'a', 'Quarterly planning', { values: { notes: 'budget review', site: 'https://example.com/plan', amount: 42 } });
		await withDb(ws, async (db) => {
			// Start from a clean slate for the page: whatever the Sync core indexed during `apply` goes away.
			await db.$executeRawUnsafe('DELETE FROM search');
		});

		// Rolled back: nothing remains.
		await withDb(ws, async (db) => {
			await expect(
				db.$transaction(async (tx) => {
					await indexChanges(tx, [setProp('a', 'notes')] as never);
					const inside = await tx.$queryRawUnsafe<{ n: number }>('SELECT COUNT(*) AS n FROM search');
					expect(inside[0]!.n).toBe(2); // visible to the transaction itself
					throw new Error('rollback');
				})
			).rejects.toThrow('rollback');
		});
		expect(await ftsRows(ws, 'a')).toEqual([]);

		// Committed: a title row and one property row; the number is not text.
		await withDb(ws, (db) => db.$transaction((tx) => indexChanges(tx, [setProp('a', 'notes')] as never)));
		const found = await ftsRows(ws, 'a');
		expect(found.map((r) => r.field)).toEqual(['title', 'property']);
		expect(found[0]!.text).toBe('Quarterly planning');
		expect(found[1]!.text).toContain('budget review');
		expect(found[1]!.text).toContain('https://example.com/plan');
		expect(found[1]!.text).not.toContain('42');
	});

	test('re-indexing a page replaces its rows; a deleted property leaves the index', async () => {
		const ws = await createWorkspace('fts-replace');
		await ws.stub.apply(ws.owner, batch([op({ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } })]));
		await addPage(ws, 'a', 'First title', { values: { notes: 'alpha' } });
		await ws.stub.apply(ws.owner, batch([op({ op: 'setProp', page: 'a', prop: 'title', value: 'Second title' })]));
		await withDb(ws, (db) => db.$transaction((tx) => indexChanges(tx, [setProp('a', 'title')] as never)));
		const found = await ftsRows(ws, 'a');
		expect(found.filter((r) => r.field === 'title').map((r) => r.text)).toEqual(['Second title']);
		expect(found.filter((r) => r.field === 'property')).toHaveLength(1);

		await ws.stub.apply(ws.owner, batch([op({ op: 'deleteProperty', id: 'notes' })]));
		await withDb(ws, (db) => db.$transaction((tx) => indexChanges(tx, [{ kind: 'deleteProperty', page: null, prop: 'notes', old: null, new: null }] as never)));
		expect((await ftsRows(ws, 'a')).map((r) => r.field)).toEqual(['title']);
	});
});

describe('body chunks', () => {
	test('are replaced when a page is ingested again, and other fields stay', async () => {
		const ws = await createWorkspace('fts-body');
		await addPage(ws, 'a', 'Garden notes');
		await withDb(ws, (db) => db.$transaction((tx) => indexChanges(tx, [setProp('a', 'title')] as never)));
		await withDb(ws, (db) => indexBodies(db, [bodyItem('a', 'tomatoes need sun\nbasil needs water', 1)]));
		expect((await ftsRows(ws, 'a')).filter((r) => r.field === 'body').map((r) => r.text)).toEqual(['tomatoes need sun\nbasil needs water']);

		await withDb(ws, (db) => indexBodies(db, [bodyItem('a', 'carrots only', 2)]));
		const found = await ftsRows(ws, 'a');
		expect(found.filter((r) => r.field === 'body').map((r) => r.text)).toEqual(['carrots only']);
		expect(found.filter((r) => r.field === 'title')).toHaveLength(1);
	});

	test('a long body is split into paragraph-aligned chunks; an unknown page is skipped', async () => {
		const paragraph = (n: number) => `paragraph ${n} ${'lorem ipsum '.repeat(40)}`.trim();
		const text = Array.from({ length: 12 }, (_, i) => paragraph(i)).join('\n');
		const pieces = chunkForFullText(text);
		expect(pieces.length).toBeGreaterThan(3);
		for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(1200);
		expect(pieces.join('\n')).toBe(text);

		const ws = await createWorkspace('fts-long');
		await addPage(ws, 'a', 'Long');
		await withDb(ws, (db) => indexBodies(db, [bodyItem('a', text), bodyItem('ghost', 'nothing')]));
		expect((await ftsRows(ws, 'a')).filter((r) => r.field === 'body')).toHaveLength(pieces.length);
		expect(await rows(ws.stub, "SELECT COUNT(*) AS n FROM search WHERE text LIKE '%nothing%'")).toEqual([{ n: 0 }]);
	});

	test('an older version than the page_text already held is ignored', async () => {
		const ws = await createWorkspace('fts-stale');
		await addPage(ws, 'a', 'Versions');
		await ws.stub.ingestPages([bodyItem('a', 'newest words', 5)]);
		await withDb(ws, (db) => indexBodies(db, [bodyItem('a', 'newest words', 5)]));
		await withDb(ws, (db) => indexBodies(db, [bodyItem('a', 'stale words', 3)]));
		expect((await ftsRows(ws, 'a')).filter((r) => r.field === 'body').map((r) => r.text)).toEqual(['newest words']);
	});
});

describe('purge and backfill', () => {
	test('removeFromIndex deletes every row and visit of the pages, and nothing else', async () => {
		const ws = await createWorkspace('fts-purge');
		await addPage(ws, 'a', 'Doomed');
		await addPage(ws, 'b', 'Survivor');
		await withDb(ws, (db) => indexBodies(db, [bodyItem('a', 'doomed body'), bodyItem('b', 'survivor body')]));
		await withDb(ws, (db) => db.$transaction((tx) => indexChanges(tx, [setProp('a', 'title'), setProp('b', 'title')] as never)));
		const [a, b] = [await numOf(ws, 'a'), await numOf(ws, 'b')];
		await rows(ws.stub, 'INSERT INTO visit (user_id, page_num, visited_at) VALUES (?, ?, 1), (?, ?, 2)', 'u', a, 'u', b);
		expect((await ftsRows(ws, 'a')).length).toBeGreaterThan(0);

		await withDb(ws, (db) => removeFromIndex(db, [a]));
		await withDb(ws, (db) => removeFromIndex(db, [a])); // idempotent
		expect(await ftsRows(ws, 'a')).toEqual([]);
		expect((await ftsRows(ws, 'b')).length).toBeGreaterThan(0);
		expect(await rows(ws.stub, 'SELECT page_num FROM visit')).toEqual([{ page_num: b }]);
	});

	test('reindexAll rebuilds titles, properties and bodies from the rows, idempotently, and drops rows of missing pages', async () => {
		const ws = await createWorkspace('fts-backfill');
		await ws.stub.apply(ws.owner, batch([op({ op: 'createProperty', property: { id: 'notes', name: 'Notes', type: 'text', config: {} } })]));
		await addPage(ws, 'a', 'Backfilled page', { values: { notes: 'property words' } });
		await ws.stub.ingestPages([bodyItem('a', 'body words here', 1)]);
		// Simulate a workspace that predates search: no rows, plus a stray row of a page that no longer exists.
		await rows(ws.stub, 'DELETE FROM search');
		await rows(ws.stub, "INSERT INTO search (page_num, field, text) VALUES (9999, 'body', 'ghost text')");

		const snapshot = async () => (await rows<{ n: number; field: string; text: string }>(ws.stub, 'SELECT page_num AS n, field, text FROM search ORDER BY n, field, text')).map((r) => `${r.field}:${r.text}`);
		const first = await ws.stub.reindexAll();
		expect(first.pages).toBeGreaterThanOrEqual(2); // "Getting started" and the new page
		const once = await snapshot();
		expect(once).toContain('title:Backfilled page');
		expect(once).toContain('property:property words');
		expect(once).toContain('body:body words here');
		expect(once.join('|')).not.toContain('ghost');
		await ws.stub.reindexAll();
		expect(await snapshot()).toEqual(once);
	});
});
