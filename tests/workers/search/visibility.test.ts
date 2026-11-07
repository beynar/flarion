/**
 * Property test, a precursor to P4's gate ("no search result cites a hidden page"): random trees, teamspaces
 * (every privacy and level), roles, grants and trashed subtrees (the permission matrix's scenarios). Every
 * page holds the same needle in its title and body, so the only thing deciding who sees what is permissions.
 * For every kind of caller, search, quick find and the semantic leg (a fake vector index that returns EVERY
 * page, hidden and trashed ones first) must return exactly the pages the reference model says are readable,
 * and nothing in a hit (title, snippet, path) may come from a page the caller cannot read.
 */
import { describe, expect, test } from 'vitest';
import { workspaceStub } from '../socket/helpers';
import { actorOf, inside, rows } from '../workspace/helpers';
import { levelOf, visibleSet, type Asker } from '../permissions/model';
import { generate, load, prng } from '../permissions/scenario';
import { quickFind, searchPages, type SearchInput, type VectorSearch } from '../../../src/server/search/query';
import { createWorkspaceClient } from '../../../src/server/db/workspace.client';
import { freshId } from '../workspace/helpers';

const SEEDS = [3, 11, 29, 47, 101, 2026];
const NEEDLE = 'zzneedleqq';

interface Who {
	name: string;
	asker: Asker;
	actor: { userId?: string; role: 'owner' | 'admin' | 'member' | 'guest' | 'anonymous'; shareToken?: string };
}

describe('search never shows a page the caller cannot read', () => {
	test.each(SEEDS)('seed %i', { timeout: 120_000 }, async (seed) => {
		const model = generate(seed, { pages: 44, teamspaces: 4, grants: 20 });
		const id = freshId('vis');
		const stub = workspaceStub(id);
		await inside(stub, (sql) => load(sql, model));
		// Titles and body text carry the needle and the page id; the visit table holds every page for everyone.
		await inside(stub, (sql) => {
			for (const p of model.pages.values()) {
				sql.exec('UPDATE page SET title = ? WHERE id = ?', `${NEEDLE} title of ${p.id}x`, p.id);
				sql.exec('INSERT INTO page_text (page_num, version, text, outline_json) VALUES (?, 1, ?, ?)', p.num, `${NEEDLE} body of ${p.id}x`, '[]');
			}
		});
		await stub.reindexAll();
		await inside(stub, (sql) => {
			for (const u of model.users.values()) for (const p of model.pages.values()) sql.exec('INSERT INTO visit (user_id, page_num, visited_at) VALUES (?, ?, ?)', u.id, p.num, p.num);
		});

		const live = model.grants.find((g) => g.kind === 'public' && !g.revoked);
		const who: Who[] = [...model.users.values()].map((u) => ({ name: `${u.role} ${u.id}`, asker: { kind: 'user', id: u.id }, actor: { userId: u.id, role: u.role } }));
		who.push({ name: 'anonymous', asker: { kind: 'anonymous' }, actor: { role: 'anonymous' } });
		if (live?.token) who.push({ name: 'public link', asker: { kind: 'anonymous', token: live.token }, actor: { role: 'anonymous', shareToken: live.token } });

		const titleOf = new Map([...model.pages.values()].map((p) => [p.id, `${NEEDLE} title of ${p.id}x`]));
		const allIds = [...model.pages.keys()];
		// Hidden and trashed pages first: if filtering happened after ranking or cutting, they would crowd the others out.
		const vector: VectorSearch = async () => allIds.map((pageId, i) => ({ pageId, score: 1 - i / 100 }));

		let nonEmpty = 0;
		let someHidden = 0;
		for (const w of who) {
			const expectedNums = visibleSet(model, w.asker);
			const expected = new Set([...model.pages.values()].filter((p) => expectedNums.has(p.num) && !p.deleted).map((p) => p.id));
			const trashed = [...model.pages.values()].filter((p) => p.deleted);
			expect(trashed.every((p) => !expected.has(p.id))).toBe(true);
			if (expected.size > 0) nonEmpty++;
			if (expected.size < model.pages.size) someHidden++;

			const visible = await stub.visibleNums(w.actor);
			const seen = await inside(stub, async (_sql, state) => {
				const db = createWorkspaceClient(state.storage);
				const collect = async (input: Omit<SearchInput, 'cursor'>, withVector: boolean) => {
					const out: Awaited<ReturnType<typeof searchPages>>['hits'] = [];
					let cursor: string | undefined;
					for (let guard = 0; guard < 60; guard++) {
						const result = await searchPages({ db, visible, vector: withVector ? vector : null }, { ...input, cursor });
						out.push(...result.hits);
						if (!result.nextCursor) break;
						cursor = result.nextCursor;
					}
					return out;
				};
				const text = await collect({ q: NEEDLE, limit: 7 }, false);
				const date = await collect({ q: NEEDLE, limit: 100, sort: 'edited_desc' }, false);
				const semantic = await collect({ q: `what is the ${NEEDLE} about?`, limit: 9 }, true);
				const quick = await quickFind({ db, visible, vector: null }, w.actor.userId ?? null, { q: NEEDLE.slice(0, 8), limit: 30 });
				const recent = await quickFind({ db, visible, vector: null }, w.actor.userId ?? null, { q: '', limit: 30 });
				return { text, date, semantic, quick: quick.items, recent: recent.items };
			});

			const check = (label: string, hits: { id: string; title: string; snippet?: string; path?: string[] }[], exact: boolean) => {
				const got = hits.map((h) => h.id);
				expect(new Set(got).size, `${w.name} ${label}: duplicates`).toBe(got.length);
				for (const hit of hits) {
					expect(expected.has(hit.id), `${w.name} ${label}: ${hit.id} is hidden or trashed`).toBe(true);
					expect(hit.title).toBe(titleOf.get(hit.id));
					const strangers = `${hit.snippet ?? ''} ${(hit.path ?? []).join(' ')}`.match(/of (p\d+)x/g) ?? [];
					for (const s of strangers) {
						const pid = /of (p\d+)x/.exec(s)![1]!;
						expect(expected.has(pid) || pid === hit.id, `${w.name} ${label}: text of ${pid} leaked into a hit for ${hit.id}`).toBe(true);
					}
				}
				if (exact) expect(new Set(got), `${w.name} ${label}: not exactly the readable pages`).toEqual(expected);
			};
			check('text', seen.text, true);
			check('date', seen.date, true);
			check('semantic', seen.semantic, true);
			// Quick find lists up to 30 title hits; all readable pages are among them (a workspace of 44 pages, ≤ 30 readable here or capped).
			check('quick', seen.quick, false);
			expect(seen.quick.length).toBe(Math.min(30, expected.size));
			// Recents (the visit table holds every page for every user): only readable pages, newest first.
			for (const item of seen.recent) expect(expected.has(item.id), `${w.name} recents: ${item.id}`).toBe(true);
			expect(seen.recent.length).toBe(Math.min(30, w.actor.userId ? expected.size : 0));
			// Paths: any path title is the title of a readable page.
			for (const hit of seen.text) for (const t of hit.path) expect([...expected].some((pid) => titleOf.get(pid) === t), `${w.name}: path title ${t}`).toBe(true);
		}
		// Not vacuous: somebody sees something, and somebody does not see everything.
		expect(nonEmpty).toBeGreaterThan(2);
		expect(someHidden).toBeGreaterThan(2);
	});

	test('the DO method refuses non-members and hides everything from a user without access', async () => {
		const model = generate(5, { pages: 20, teamspaces: 3, grants: 6 });
		const id = freshId('vis-rpc');
		const stub = workspaceStub(id);
		await inside(stub, (sql) => load(sql, model));
		await inside(stub, (sql) => {
			for (const p of model.pages.values()) sql.exec('UPDATE page SET title = ? WHERE id = ?', `${NEEDLE} ${p.id}`, p.id);
		});
		await stub.reindexAll();
		await expect(stub.searchQuery(actorOf(id, 'stranger', 'member'), { q: NEEDLE })).rejects.toThrow();
		const guest = actorOf(id, 'g2', 'guest');
		const got = (await stub.searchQuery(guest, { q: NEEDLE, limit: 100 })).hits.map((h) => h.id);
		const expected = [...model.pages.values()].filter((p) => !p.deleted && levelOf(model, { kind: 'user', id: 'g2' }, p.id) >= 0).map((p) => p.id);
		expect(new Set(got)).toEqual(new Set(expected));
		expect(await rows(stub, 'SELECT COUNT(*) AS n FROM search')).not.toEqual([{ n: 0 }]);
	});
});
