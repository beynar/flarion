/** Quick find, the search page, snippets, filters, trash, semantic merging and hostile MATCH input. */
import { describe, expect, test } from 'vitest';
import { buildMatch, looksLikeQuestion, reciprocalRankFusion } from '../../../src/server/search/match';
import { quickFind, recordVisit, searchPages, type VectorSearch } from '../../../src/server/search/query';
import { actorOf, addPage, batch, bodyItem, createWorkspace, nextRank, numOf, op, rows, withDb, type Fixture } from './helpers';

const reindex = (ws: Fixture) => ws.stub.reindexAll();
const ids = (r: { hits: { id: string }[] }) => r.hits.map((h) => h.id);

/** A search context over the object's own database with the owner's visibility set. */
async function context(ws: Fixture, vector: VectorSearch | null = null, actor = ws.owner) {
	const visible = await ws.stub.visibleNums({ userId: actor.userId, role: actor.role });
	return { visible, vector };
}
const run = <T>(ws: Fixture, fn: (db: Parameters<Parameters<typeof withDb>[1]>[0]) => Promise<T>) => withDb(ws, (db) => fn(db));

describe('match building and fusion (pure)', () => {
	test('user input becomes quoted phrases under a text column filter', () => {
		expect(buildMatch('hello world')).toBe('text : ("hello" "world")');
		expect(buildMatch('hello wor', { prefix: true })).toBe('text : ("hello" "wor" *)');
		expect(buildMatch('NEAR(a b) AND title:x*')).toBe('text : ("NEAR" "a" "b" "AND" "title" "x")');
		expect(buildMatch('"""  ---  ***')).toBeNull();
		expect(buildMatch('café Œuvre')).toBe('text : ("café" "Œuvre")');
		expect(buildMatch('how do we launch?', { dropStopwords: true })).toBe('text : ("launch")');
		expect(buildMatch('what is the', { dropStopwords: true })).toBe('text : ("what" "is" "the")'); // nothing else to ask for
	});

	test('question heuristic', () => {
		for (const q of ['how do we ship?', 'What is the plan', 'launch plan?', 'one two three four five six seven']) expect(looksLikeQuestion(q)).toBe(true);
		for (const q of ['launch plan', 'roadmap 2027', 'q3 budget review notes', '']) expect(looksLikeQuestion(q)).toBe(false);
	});

	test('reciprocal rank fusion sums 1/(60+rank) and breaks ties by first appearance', () => {
		const fused = reciprocalRankFusion([
			['a', 'b', 'c'],
			['c', 'a']
		]);
		expect(fused.map((r) => r.id)).toEqual(['a', 'c', 'b']);
		expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
		expect(fused[1]!.score).toBeCloseTo(1 / 63 + 1 / 61, 10);
		expect(reciprocalRankFusion([['x', 'y'], ['y', 'x']]).map((r) => r.id)).toEqual(['x', 'y']); // a tie: x came first
		expect(reciprocalRankFusion([['a', 'a', 'b']]).map((r) => r.id)).toEqual(['a', 'b']);
	});
});

describe('the search page', () => {
	test('titles outrank body text, and each page appears once with a highlighted, escaped snippet', async () => {
		const ws = await createWorkspace('q-rank');
		await addPage(ws, 'body-hit', 'Meeting notes');
		await addPage(ws, 'title-hit', 'Launch plan');
		await addPage(ws, 'both', 'Plan of plans');
		await ws.stub.ingestPages([
			bodyItem('body-hit', 'We discussed the launch plan for the new product, and the plan changed twice. <script>alert(1)</script> & more', 1),
			bodyItem('both', 'The plan is a plan about a plan', 1)
		]);
		await withDb(ws, async (db) => {
			const { indexBodies } = await import('../../../src/server/search/index-writes');
			await indexBodies(db, [bodyItem('body-hit', 'We discussed the launch plan for the new product, and the plan changed twice. <script>alert(1)</script> & more', 1), bodyItem('both', 'The plan is a plan about a plan', 1)]);
		});
		await reindex(ws);

		const result = await ws.stub.searchQuery(ws.owner, { q: 'plan' });
		expect(ids(result)).toHaveLength(3);
		expect(new Set(ids(result)).size).toBe(3);
		expect(result.hits[result.hits.length - 1]!.id).toBe('body-hit');
		expect(result.hits.find((h) => h.id === 'title-hit')).toMatchObject({ field: 'title', snippet: 'Launch <mark>plan</mark>' });
		const body = result.hits.find((h) => h.id === 'body-hit')!;
		expect(body.field).toBe('body');
		expect(body.snippet).toContain('<mark>plan</mark>');
		expect(body.snippet).not.toContain('<script>');
		expect(body.snippet).not.toContain('\u0001');
		// Stemming: "planning" finds "plan".
		expect(ids(await ws.stub.searchQuery(ws.owner, { q: 'planning' }))).toHaveLength(3);
	});

	test('the ranking SQL multiplies bm25 by the title boost (a title hit of equal strength wins)', async () => {
		const ws = await createWorkspace('q-boost');
		await addPage(ws, 'in-body', 'Untitled thing');
		await addPage(ws, 'in-title', 'Zebra');
		await ws.stub.ingestPages([bodyItem('in-body', 'zebra', 1)]);
		await withDb(ws, async (db) => (await import('../../../src/server/search/index-writes')).indexBodies(db, [bodyItem('in-body', 'zebra', 1)]));
		await reindex(ws);
		expect(ids(await ws.stub.searchQuery(ws.owner, { q: 'zebra' }))).toEqual(['in-title', 'in-body']);
	});

	test('paginates with a cursor and filters by creator, edit date and subtree', async () => {
		const ws = await createWorkspace('q-filter');
		await ws.stub.syncMember({ userId: 'ann', role: 'member', name: 'Ann' });
		const ann = actorOf(ws.id, 'ann', 'member');
		await addPage(ws, 'root', 'Report root');
		await addPage(ws, 'child', 'Report child', { parent: 'root' });
		await addPage(ws, 'grand', 'Report grandchild', { parent: 'child' });
		await addPage(ws, 'anns', 'Report by Ann', { actor: ann });
		await addPage(ws, 'old', 'Report from long ago');
		await rows(ws.stub, "UPDATE page SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'old'");
		await rows(ws.stub, "UPDATE page SET updated_at = '2026-03-01T00:00:00.000Z' WHERE id = 'child'");
		await reindex(ws);
		const q = (extra: Record<string, unknown>) => ws.stub.searchQuery(ws.owner, { q: 'report', ...extra } as never);

		expect(ids(await q({ createdBy: 'ann' }))).toEqual(['anns']);
		expect(new Set(ids(await q({ under: 'root' })))).toEqual(new Set(['root', 'child', 'grand']));
		expect(new Set(ids(await q({ under: 'child' })))).toEqual(new Set(['child', 'grand']));
		expect(ids(await q({ editedBefore: '2021-01-01T00:00:00Z' }))).toEqual(['old']);
		expect(ids(await q({ editedAfter: '2026-02-01T00:00:00Z', editedBefore: '2026-04-01T00:00:00Z' }))).toEqual(['child']);
		expect((await q({ under: 'root', createdBy: 'ann' })).hits).toEqual([]);

		const desc = ids(await q({ sort: 'edited_desc' }));
		expect(desc[desc.length - 1]).toBe('old');
		const asc = ids(await q({ sort: 'edited_asc' }));
		expect(asc[0]).toBe('old');

		const first = await q({ limit: 2 });
		expect(first.hits).toHaveLength(2);
		expect(first.nextCursor).toBeTruthy();
		const second = await q({ limit: 2, cursor: first.nextCursor! });
		const third = await q({ limit: 2, cursor: second.nextCursor! });
		expect([...ids(first), ...ids(second), ...ids(third)].sort()).toEqual(['anns', 'child', 'grand', 'old', 'root']);
		expect(third.nextCursor).toBeNull();
	});

	test('a result path lists the ancestors the actor can see, root first', async () => {
		const ws = await createWorkspace('q-path');
		await addPage(ws, 'top', 'Handbook');
		await addPage(ws, 'mid', 'Policies', { parent: 'top' });
		await addPage(ws, 'leaf', 'Vacation policy', { parent: 'mid' });
		await reindex(ws);
		const hit = (await ws.stub.searchQuery(ws.owner, { q: 'vacation' })).hits[0]!;
		expect(hit).toMatchObject({ id: 'leaf', path: ['Handbook', 'Policies'] });
	});

	test('trashed pages are excluded, even when the caller hands over a visibility set that still holds them', async () => {
		const ws = await createWorkspace('q-trash');
		await addPage(ws, 'live', 'Garden live');
		await addPage(ws, 'gone', 'Garden gone');
		await reindex(ws);
		expect(ids(await ws.stub.searchQuery(ws.owner, { q: 'garden' })).sort()).toEqual(['gone', 'live']);
		const goneNum = await numOf(ws, 'gone');
		await ws.stub.apply(ws.owner, batch([op({ op: 'trash', page: 'gone' })]));
		expect(ids(await ws.stub.searchQuery(ws.owner, { q: 'garden' }))).toEqual(['live']);
		// The SQL itself filters deleted pages: a stale visibility set cannot resurrect them.
		const stale = { visible: new Set([goneNum, await numOf(ws, 'live')]), vector: null };
		expect(ids(await run(ws, (db) => searchPages({ db, ...stale }, { q: 'garden' })))).toEqual(['live']);
		expect((await ws.stub.searchQuick(ws.owner, { q: 'garden' })).items.map((i) => i.id)).toEqual(['live']);
		await ws.stub.apply(ws.owner, batch([op({ op: 'restore', page: 'gone' })]));
		expect(ids(await ws.stub.searchQuery(ws.owner, { q: 'garden' })).sort()).toEqual(['gone', 'live']);
	});
});

describe('hostile MATCH input', () => {
	test('quotes, operators, column filters and stars never throw and never match syntax', async () => {
		const ws = await createWorkspace('q-hostile');
		await addPage(ws, 'a', 'Garden notes');
		await addPage(ws, 'b', 'Title of the property body');
		await ws.stub.ingestPages([bodyItem('a', 'near the garden wall', 1)]);
		await withDb(ws, async (db) => (await import('../../../src/server/search/index-writes')).indexBodies(db, [bodyItem('a', 'near the garden wall', 1)]));
		await reindex(ws);
		const hostile = [
			'"', '"unbalanced', '""', "'", 'NEAR(a b)', 'NEAR/2', 'a AND', 'AND', 'OR', 'NOT', 'a OR b NOT c', 'text:garden', 'field:title', 'title:garden', '{text}: x',
			'*', 'gar*', '^garden', '(', ')', '((garden', '-garden', '+garden', '\\', '%', '_', '; DROP TABLE search; --', '\u0001', '\u0002garden\u0001', 'a'.repeat(400),
			Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')
		];
		for (const q of hostile) {
			await expect(ws.stub.searchQuery(ws.owner, { q }), q).resolves.toBeTruthy();
			await expect(ws.stub.searchQuick(ws.owner, { q }), q).resolves.toBeTruthy();
		}
		// Column syntax is plain words: "text:garden" asks for the words text AND garden, which no page holds.
		expect((await ws.stub.searchQuery(ws.owner, { q: 'text:garden' })).hits).toEqual([]);
		// The words "title" and "body" are labels of the `field` column, never matched as content.
		expect(ids(await ws.stub.searchQuery(ws.owner, { q: 'title' }))).toEqual(['b']);
		expect((await ws.stub.searchQuery(ws.owner, { q: 'body' })).hits.map((h) => h.id)).toEqual(['b']);
		expect((await ws.stub.searchQuery(ws.owner, { q: 'property' })).hits.map((h) => h.id)).toEqual(['b']);
		// Operators are plain words too, and stars are dropped.
		expect(ids(await ws.stub.searchQuery(ws.owner, { q: 'garden*' }))).toEqual(['a']);
		expect(ids(await ws.stub.searchQuery(ws.owner, { q: 'NEAR(garden wall)' }))).toEqual(['a']); // plain words, no NEAR operator
		expect((await ws.stub.searchQuery(ws.owner, { q: 'NEAR(garden zebra)' })).hits).toEqual([]);
		expect(await rows(ws.stub, 'SELECT COUNT(*) AS n FROM search')).not.toEqual([{ n: 0 }]);
	});
});

describe('quick find', () => {
	test('title prefixes first (starts-with before contains-a-word), then recents, then full text', async () => {
		const ws = await createWorkspace('q-quick');
		await addPage(ws, 'a', 'Roadmap');
		await addPage(ws, 'e', 'Q3 Roadmap');
		await addPage(ws, 'd', 'Crossroads');
		await addPage(ws, 'b', 'Team notes');
		await addPage(ws, 'z', 'Zebra');
		await ws.stub.ingestPages([bodyItem('b', 'our road to launch', 1)]);
		await withDb(ws, async (db) => (await import('../../../src/server/search/index-writes')).indexBodies(db, [bodyItem('b', 'our road to launch', 1)]));
		await reindex(ws);
		const [nd, nz, nb] = [await numOf(ws, 'd'), await numOf(ws, 'z'), await numOf(ws, 'b')];
		await run(ws, async (db) => {
			await recordVisit(db, ws.owner.userId, nd, 1000);
			await recordVisit(db, ws.owner.userId, nz, 2000);
			await recordVisit(db, 'someone-else', nb, 3000);
		});

		const quick = await ws.stub.searchQuick(ws.owner, { q: 'road' });
		expect(quick.items.map((i) => [i.id, i.source])).toEqual([
			['a', 'title'],
			['e', 'title'],
			['d', 'recent'],
			['b', 'text']
		]);
		// An empty query lists the caller's recents, newest first (never someone else's).
		expect((await ws.stub.searchQuick(ws.owner, { q: '' })).items.map((i) => [i.id, i.source])).toEqual([
			['z', 'recent'],
			['d', 'recent']
		]);
		// The limit applies across sources.
		expect((await ws.stub.searchQuick(ws.owner, { q: 'road', limit: 2 })).items.map((i) => i.id)).toEqual(['a', 'e']);
		// The word being typed is a prefix.
		expect((await ws.stub.searchQuick(ws.owner, { q: 'zeb' })).items.map((i) => i.id)).toEqual(['z']);
	});

	test('visit records only readable pages, keeps the latest 200, and a purge forgets it', async () => {
		const ws = await createWorkspace('q-visit');
		await addPage(ws, 'mine', 'Mine');
		await ws.stub.syncMember({ userId: 'bob', role: 'member', name: 'Bob' });
		const bob = actorOf(ws.id, 'bob', 'member');
		// Bob's Private page is invisible to the owner... the owner is an owner, so use a second member instead.
		await ws.stub.apply(bob, batch([op({ op: 'create', id: 'bobs', parentId: null, rank: nextRank(), teamspaceId: null, values: { title: 'Bobs private' } })]));
		await ws.stub.syncMember({ userId: 'cat', role: 'member', name: 'Cat' });
		const cat = actorOf(ws.id, 'cat', 'member');
		await ws.stub.searchVisit(cat, 'bobs'); // hidden: ignored
		await ws.stub.searchVisit(cat, 'mine');
		await ws.stub.searchVisit(cat, 'nope'); // unknown: ignored
		const visits = await rows<{ user_id: string; page_num: number }>(ws.stub, 'SELECT user_id, page_num FROM visit');
		expect(visits).toEqual([{ user_id: 'cat', page_num: await numOf(ws, 'mine') }]);

		await run(ws, async (db) => {
			for (let i = 0; i < 230; i++) await recordVisit(db, 'busy', 10_000 + i, i);
		});
		const kept = await rows<{ n: number; lo: number }>(ws.stub, "SELECT COUNT(*) AS n, MIN(visited_at) AS lo FROM visit WHERE user_id = 'busy'");
		expect(kept).toEqual([{ n: 200, lo: 30 }]);
	});
});

describe('semantic results (reciprocal rank fusion)', () => {
	async function world() {
		const ws = await createWorkspace('q-semantic');
		await ws.stub.syncMember({ userId: 'dan', role: 'member', name: 'Dan' });
		const dan = actorOf(ws.id, 'dan', 'member');
		await addPage(ws, 'p1', 'Launch plan');
		await addPage(ws, 'p2', 'Launch checklist');
		await addPage(ws, 'p3', 'Shipping guide');
		await addPage(ws, 'p4', 'Secret shipping plan', { actor: ws.owner });
		await ws.stub.apply(ws.owner, batch([op({ op: 'create', id: 'priv', parentId: null, rank: nextRank(), teamspaceId: null, values: { title: 'Owner private launch' } })]));
		await addPage(ws, 'trashed', 'Trashed launch notes');
		await ws.stub.ingestPages([bodyItem('p3', 'Steps to ship the product to customers safely.', 1)]);
		await reindex(ws);
		await ws.stub.apply(ws.owner, batch([op({ op: 'trash', page: 'trashed' })]));
		return { ws, dan };
	}

	test('vector hits are merged with full-text hits; hidden and trashed pages never enter', async () => {
		const { ws, dan } = await world();
		const asked: string[] = [];
		const vector: VectorSearch = async (query) => {
			asked.push(query);
			// Best first; includes a page with no FTS match (p3), one the member cannot see (priv) and a trashed one.
			return [
				{ pageId: 'p3', score: 0.9 },
				{ pageId: 'priv', score: 0.88 },
				{ pageId: 'trashed', score: 0.85 },
				{ pageId: 'p2', score: 0.8 },
				{ pageId: 'ghost', score: 0.7 }
			];
		};
		const ctx = await context(ws, vector, dan);
		const merged = await run(ws, (db) => searchPages({ db, ...ctx }, { q: 'how do we launch?' }));
		expect(asked).toEqual(['how do we launch?']);
		// FTS ("launch", the filler words dropped): p1, p2; vector: p3, p2. RRF: p2 (in both) first, then p1 and p3 (a tie, p1 listed first).
		expect(ids(merged)).toEqual(['p2', 'p1', 'p3']);
		expect(ids(merged)).not.toContain('priv');
		expect(ids(merged)).not.toContain('trashed');
		// A vector-only hit has an escaped excerpt of its body instead of an FTS snippet.
		expect(merged.hits.find((h) => h.id === 'p3')!.snippet).toBe('Steps to ship the product to customers safely.');

		// Not question-like: the vector index is not asked.
		asked.length = 0;
		const plain = await run(ws, (db) => searchPages({ db, ...ctx }, { q: 'launch' }));
		expect(asked).toEqual([]);
		expect(ids(plain).sort()).toEqual(['p1', 'p2']);
	});

	test('the filters apply to vector hits, and a failing vector index degrades to full text', async () => {
		const { ws, dan } = await world();
		const vector: VectorSearch = async () => [{ pageId: 'p3', score: 1 }];
		const ctx = await context(ws, vector, dan);
		const filtered = await run(ws, (db) => searchPages({ db, ...ctx }, { q: 'how do we launch?', createdBy: 'nobody' }));
		expect(filtered.hits).toEqual([]);
		const broken: VectorSearch = async () => {
			throw new Error('vectorize is down');
		};
		const degraded = await run(ws, (db) => searchPages({ db, visible: ctx.visible, vector: broken }, { q: 'how do we launch?' }));
		expect(ids(degraded).sort()).toEqual(['p1', 'p2']);
	});

	test('without Workers AI or Vectorize bindings the DO answers from full text', async () => {
		const { ws } = await world();
		expect(ids(await ws.stub.searchQuery(ws.owner, { q: 'how do we launch?' })).length).toBeGreaterThan(0);
	});
});
