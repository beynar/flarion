/**
 * P4 gate, "no search result or AI answer cites a hidden page", Ask AI half. Random trees, teamspaces (every privacy and
 * level), roles, grants and trashed subtrees (the permission matrix's scenarios). Every page holds the same needle and
 * secret markers of its own in several chunks, so the only thing deciding who may read what is permissions.
 *
 * The vector index is ADVERSARIAL: it ignores the workspace filter and the `topK` it is asked for and returns EVERY chunk
 * of EVERY page (hidden and trashed ones first), plus chunk numbers that do not exist and pages that do not exist. For
 * every kind of caller:
 *   - the passages are exactly chunks of pages the reference model says are readable (and are the real text of that chunk);
 *   - no marker of a page the caller cannot read appears in a passage, in the prompt sent to the model, or in the answer's
 *     citations; and the citations name only readable pages with their real titles;
 *   - nothing is crowded out: the number of pages cited is what the readable set allows (filtering before ranking).
 * Together with `tests/workers/search/visibility.test.ts` (search, quick find and the semantic leg) this is the gate.
 */
import { describe, expect, test } from 'vitest';
import type { AiAskEvent } from '../../../src/lib/shared/schemas';
import { startAsk, retrievePassages, MAX_PAGES, type AskWorkspace, type ChunkSearch, type Passage } from '../../../src/server/ai/ask';
import type { ModelRequest, TextModel } from '../../../src/server/ai/client';
import { createWorkspaceClient } from '../../../src/server/db/workspace.client';
import { chunkForEmbedding } from '../../../src/server/search/chunk';
import { levelOf, visibleSet, type Asker } from '../permissions/model';
import { generate, load } from '../permissions/scenario';
import { workspaceStub } from '../socket/helpers';
import { actorOf, freshId, inside } from '../workspace/helpers';

const SEEDS = [3, 11, 29, 47, 101, 2026];
const NEEDLE = 'zzneedleqq';
const CHUNKS_PER_PAGE = 3;
const marker = (pageId: string, chunk: number) => `SECRET-${pageId}-C${chunk}-END`;

/** The body of a page: `CHUNKS_PER_PAGE` headed sections, each carrying its own marker (a heading splits the chunks). */
const bodyOf = (pageId: string) =>
	Array.from({ length: CHUNKS_PER_PAGE }, (_, k) => `Heading ${k}\n${NEEDLE} paragraph ${k} of ${pageId} ${marker(pageId, k)} ${'filler '.repeat(40)}`).join('\n');
const outline = JSON.stringify(Array.from({ length: CHUNKS_PER_PAGE }, (_, k) => ({ level: 1, text: `Heading ${k}`, blockId: `b${k}` })));

interface Who {
	name: string;
	asker: Asker;
	userId?: string;
	role: 'owner' | 'admin' | 'member' | 'guest';
}

describe('no AI answer cites a hidden page, and no hidden text reaches the prompt', () => {
	test.each(SEEDS)('seed %i', { timeout: 120_000 }, async (seed) => {
		const model = generate(seed, { pages: 44, teamspaces: 4, grants: 20 });
		const workspaceId = freshId('ask');
		const stub = workspaceStub(workspaceId);
		await inside(stub, (sql) => load(sql, model));
		await inside(stub, (sql) => {
			for (const p of model.pages.values()) {
				sql.exec('UPDATE page SET title = ? WHERE id = ?', `${NEEDLE} title of ${p.id}x`, p.id);
				sql.exec('INSERT INTO page_text (page_num, version, text, outline_json) VALUES (?, 1, ?, ?)', p.num, bodyOf(p.id), outline);
			}
		});
		await stub.reindexAll();

		const titleOf = new Map([...model.pages.values()].map((p) => [p.id, `${NEEDLE} title of ${p.id}x`]));
		const allIds = [...model.pages.keys()];
		const everyMarker = allIds.flatMap((id) => Array.from({ length: CHUNKS_PER_PAGE }, (_, k) => marker(id, k)));

		const who: Who[] = [...model.users.values()].map((u) => ({ name: `${u.role} ${u.id}`, asker: { kind: 'user', id: u.id }, userId: u.id, role: u.role }));
		let nonEmpty = 0;
		let someHidden = 0;

		for (const w of who) {
			const expectedNums = visibleSet(model, w.asker);
			const expected = new Set([...model.pages.values()].filter((p) => expectedNums.has(p.num) && !p.deleted).map((p) => p.id));
			if (expected.size > 0) nonEmpty++;
			if (expected.size < model.pages.size) someHidden++;

			// Hidden and trashed pages first, then the readable ones; every chunk, plus ones and pages that do not exist.
			const ordered = [...allIds.filter((id) => !expected.has(id)), ...allIds.filter((id) => expected.has(id)), 'ghost-page'];
			const adversarial: ChunkSearch = async () =>
				ordered.flatMap((pageId, i) => Array.from({ length: CHUNKS_PER_PAGE + 3 }, (_, chunk) => ({ pageId, chunk, score: 1 - i / 1000 - chunk / 100000 })));

			const actor = actorOf(workspaceId, w.userId, w.role);
			const visible = await stub.visibleNums({ userId: w.userId, role: w.role });
			expect(visible, `${w.name}: the DO's visibility set agrees with the model`).toEqual(expectedNums);

			const passages = await inside(stub, async (_sql, state) => {
				const db = createWorkspaceClient(state.storage);
				return retrievePassages({ db, visible, vector: adversarial }, `what is the ${NEEDLE} about?`);
			});
			const truth = await inside(stub, async (_sql, state) => {
				const db = createWorkspaceClient(state.storage);
				const out = new Map<string, string[]>();
				for (const p of model.pages.values()) out.set(p.id, chunkForEmbedding({ text: bodyOf(p.id), outline: JSON.parse(outline) }));
				void db;
				return out;
			});

			for (const p of passages) {
				expect(expected.has(p.pageId), `${w.name}: passage from hidden or trashed page ${p.pageId}`).toBe(true);
				expect(p.title).toBe(titleOf.get(p.pageId));
				expect(p.text, `${w.name}: passage text is the real chunk ${p.chunk} of ${p.pageId}`).toBe(truth.get(p.pageId)![p.chunk]);
				for (const m of everyMarker) {
					if (p.text.includes(m)) expect(m.startsWith(`SECRET-${p.pageId}-`), `${w.name}: ${m} inside a passage of ${p.pageId}`).toBe(true);
				}
			}
			// Filtering happens before ranking: hidden chunks listed first crowd nothing out.
			expect(new Set(passages.map((p) => p.pageId)).size, `${w.name}: pages cited`).toBe(Math.min(MAX_PAGES, expected.size));

			// The whole answer path, with a model that records what it is sent and cites every excerpt.
			const requests: ModelRequest[] = [];
			const recorder: TextModel = async function* (request) {
				requests.push(request);
				yield 'Per your pages: ';
				for (let i = 1; i <= 8; i++) yield `[${i}] `;
			};
			const workspace: AskWorkspace = { askRetrieve: async () => passages as Passage[] };
			const events: AiAskEvent[] = [];
			for await (const event of await startAsk(
				{ env: { ENVIRONMENT: 'test', AI_GATEWAY_ID: 'g', AI_TEXT_MODEL: 'm', AI_EMBEDDING_MODEL: 'e' }, request: new Request('http://localhost/rpc/ai/ask'), actor, workspace },
				{ question: `what is the ${NEEDLE} about?` },
				undefined,
				recorder
			)) {
				events.push(event);
			}
			const sources = events.find((e) => e.type === 'sources');
			expect(sources, `${w.name}: a sources event`).toBeTruthy();
			if (sources?.type === 'sources') {
				for (const page of sources.pages) {
					expect(expected.has(page.id), `${w.name}: cites hidden page ${page.id}`).toBe(true);
					expect(page.title).toBe(titleOf.get(page.id));
					for (const m of everyMarker) if (page.snippet?.includes(m)) expect(m.startsWith(`SECRET-${page.id}-`)).toBe(true);
				}
			}
			expect(events.at(-1)?.type).toBe('done');
			if (expected.size === 0) {
				expect(requests, `${w.name}: nothing readable: the model is not called`).toHaveLength(0);
				expect(JSON.stringify(events)).toContain("couldn't find anything");
			} else {
				const sent = requests.flatMap((r) => r.messages.map((m) => m.content)).join('\n');
				const answer = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
				for (const id of allIds) {
					if (expected.has(id)) continue;
					for (let k = 0; k < CHUNKS_PER_PAGE; k++) {
						expect(sent.includes(marker(id, k)), `${w.name}: text of hidden ${id} in the prompt`).toBe(false);
						expect(answer.includes(marker(id, k))).toBe(false);
					}
					expect(sent.includes(`title of ${id}x`), `${w.name}: title of hidden ${id} in the prompt`).toBe(false);
				}
			}
			void levelOf;
		}
		// Not vacuous: somebody reads something, and somebody does not read everything.
		expect(nonEmpty).toBeGreaterThan(2);
		expect(someHidden).toBeGreaterThan(2);
	});

	test('the Workspace DO method (full text only without Vectorize) keeps to readable pages and refuses non-members', async () => {
		const model = generate(5, { pages: 24, teamspaces: 3, grants: 8 });
		const workspaceId = freshId('ask-do');
		const stub = workspaceStub(workspaceId);
		await inside(stub, (sql) => load(sql, model));
		await inside(stub, (sql) => {
			for (const p of model.pages.values()) {
				sql.exec('UPDATE page SET title = ? WHERE id = ?', `${NEEDLE} title of ${p.id}x`, p.id);
				sql.exec('INSERT INTO page_text (page_num, version, text, outline_json) VALUES (?, 1, ?, ?)', p.num, bodyOf(p.id), outline);
			}
		});
		await stub.reindexAll();
		await expect(stub.askRetrieve(actorOf(workspaceId, 'stranger', 'member'), { question: NEEDLE })).rejects.toThrow();
		for (const u of model.users.values()) {
			const expected = new Set([...model.pages.values()].filter((p) => levelOf(model, { kind: 'user', id: u.id }, p.id) >= 0).map((p) => p.id));
			const passages = await stub.askRetrieve(actorOf(workspaceId, u.id, u.role), { question: `what is the ${NEEDLE} about?` });
			for (const p of passages) expect(expected.has(p.pageId), `${u.id}: ${p.pageId}`).toBe(true);
			expect(new Set(passages.map((p) => p.pageId)).size).toBe(Math.min(MAX_PAGES, expected.size));
		}
	});
});
