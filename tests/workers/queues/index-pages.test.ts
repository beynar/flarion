import { describe, expect, it, vi } from 'vitest';
import { createDocument, type JSONBlock, type JSONDoc } from 'edytor/crdt/edytor';
import { queue } from '../../../src/server/queues/consumer';
import {
	INDEX_WINDOW_SECONDS,
	PAGE_MENTION_PREFIX,
	backoffSeconds,
	extractPageIndexItem,
	indexPages,
	type JobMessage
} from '../../../src/server/queues/index-pages';
import type { IndexPageJob, PageIndexItem } from '../../../src/server/queues/types';
import { claimsFor, connect, mint, pageStub, seed, testEnv, uniqueId, waitSaved } from '../rooms/helpers';

/** A room document with every thing the extractor reads: headings, lists, atoms, a subpage, an equation. */
const richDoc = (): JSONDoc => {
	const blocks: JSONBlock[] = [
		{ id: 'h1', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Roadmap ' }, { text: '2027', marks: { bold: true } }] },
		{ id: 'p1', type: 'paragraph', content: [{ text: 'Owner ' }, { type: 'mention', data: { id: 'user-ada', label: 'Ada' } }, { text: ' reviews ' }, { type: 'pageLink', data: { id: 'page-spec', title: 'Spec', icon: '📄' } }] },
		{ id: 'p2', type: 'paragraph', content: [{ type: 'mention', data: { id: `${PAGE_MENTION_PREFIX}page-notes`, label: 'Notes' } }, { text: ' and ' }, { type: 'mention', data: { id: 'user-ada', label: 'Ada' } }] },
		{
			id: 'h2',
			type: 'toggle-heading',
			data: { level: 'h2' },
			content: [{ text: 'Details' }],
			children: [{ id: 'li1', type: 'bulleted-list-item', content: [{ text: 'nested point' }] }]
		},
		{ id: 'sub', type: 'page', data: { pageId: 'page-child', title: 'Child page' } },
		{ id: 'eq', type: 'equation', data: { expression: 'E=mc^2' } },
		{ id: 'dv', type: 'database_view', data: { collectionId: 'c1', viewId: null, localFilter: null } },
		{ id: 'blank', type: 'paragraph', content: [] }
	];
	return createDocument({ value: { children: blocks } as never, actor: { id: 'ada' } }).toJSON() as JSONDoc;
};

describe('extractPageIndexItem', () => {
	const item = extractPageIndexItem(richDoc(), { pageId: 'pg', version: 7, editedAt: 1234, editedBy: 'bob' });

	it('reads plain text block by block, nested blocks and atoms included', () => {
		expect(item.text.split('\n')).toEqual([
			'Roadmap 2027',
			'Owner Ada reviews Spec',
			'Notes and Ada',
			'Details',
			'nested point',
			'Child page',
			'E=mc^2'
		]);
	});

	it('lists headings in order with their level and block id', () => {
		expect(item.outline).toEqual([
			{ level: 1, text: 'Roadmap 2027', blockId: 'h1' },
			{ level: 2, text: 'Details', blockId: 'h2' }
		]);
	});

	it('finds page links, page mentions and subpages, and user mentions apart', () => {
		expect(item.links).toEqual(
			expect.arrayContaining([
				{ to: 'page-spec', kind: 'link' },
				{ to: 'page-notes', kind: 'mention' },
				{ to: 'page-child', kind: 'subpage' }
			])
		);
		expect(item.links).toHaveLength(3);
		expect(item.mentions).toEqual([
			{ userId: 'user-ada', blockId: 'p1' },
			{ userId: 'user-ada', blockId: 'p2' }
		]);
	});

	it('carries the version, edit time and editor', () => {
		expect(item).toMatchObject({ pageId: 'pg', version: 7, editedAt: 1234, editedBy: 'bob' });
	});

	it('an empty page is an empty item', () => {
		expect(extractPageIndexItem({ children: [] }, { pageId: 'x', version: 1, editedAt: 1, editedBy: null })).toEqual({
			pageId: 'x',
			version: 1,
			text: '',
			outline: [],
			links: [],
			mentions: [],
			editedAt: 1,
			editedBy: null
		});
	});
});

// ───────────── the batch: dedupe, throttle, group, ingest ─────────────

class FakeMessage implements JobMessage<IndexPageJob> {
	acked = false;
	retried: { delaySeconds?: number } | null = null;
	constructor(
		readonly body: IndexPageJob,
		readonly attempts = 1
	) {}
	ack() {
		this.acked = true;
	}
	retry(options?: { delaySeconds?: number }) {
		this.retried = options ?? {};
	}
}

const job = (workspaceId: string, pageId: string, version: number): IndexPageJob => ({ type: 'index-page', workspaceId, pageId, version });

/** `env` with the real Page DOs and KV, and a spy standing in for each Workspace DO's `ingestPages`. */
function spyEnv(options: { failFor?: string } = {}) {
	const calls: Array<{ workspaceId: string; items: PageIndexItem[] }> = [];
	const env = {
		CACHE: testEnv.CACHE,
		PAGE: testEnv.PAGE,
		WORKSPACE: {
			getByName: (workspaceId: string) => ({
				ingestPages: async (items: PageIndexItem[]) => {
					if (options.failFor === workspaceId) throw new Error('workspace down');
					calls.push({ workspaceId, items });
				}
			})
		}
	} as unknown as Parameters<typeof indexPages>[0];
	return { env, calls };
}

async function writtenPage(ws: string, page: string, text: string, userId = 'ada') {
	const client = connect(page, await mint(claimsFor(ws, page, userId)), { userId, value: seed(text) });
	await waitSaved(client);
	return client;
}

describe('indexPages (the batch)', () => {
	it('reads a real room, ingests the extracted item once and acks', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		const ada = await writtenPage(ws, page, 'Hello index');
		const version = (await pageStub(ws, page).lastUpdated())!;
		const { env, calls } = spyEnv();
		const message = new FakeMessage(job(ws, page, version));

		const result = await indexPages(env, [message]);

		expect(result).toMatchObject({ indexed: 1, throttled: 0, failed: 0 });
		expect(message.acked).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].workspaceId).toBe(ws);
		expect(calls[0].items).toEqual([
			{ pageId: page, version, text: 'Hello index', outline: [], links: [], mentions: [], editedAt: version, editedBy: 'ada' }
		]);
		ada.close();
	});

	it('collapses jobs for one page to the newest version and acks the rest', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		(await writtenPage(ws, page, 'one')).close();
		const { env, calls } = spyEnv();
		const [a, b, c] = [new FakeMessage(job(ws, page, 100)), new FakeMessage(job(ws, page, 300)), new FakeMessage(job(ws, page, 200))];

		const result = await indexPages(env, [a, b, c]);

		expect(result).toMatchObject({ indexed: 1, duplicates: 2 });
		expect([a.acked, b.acked, c.acked]).toEqual([true, true, true]);
		expect(calls).toHaveLength(1);
		expect(calls[0].items.map((item) => item.version)).toEqual([300]);
	});

	it('sends at most one index per page every 30 seconds, and never loses the later edit', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		(await writtenPage(ws, page, 'one')).close();
		const { env, calls } = spyEnv();
		const t0 = Date.now();

		const first = new FakeMessage(job(ws, page, 1));
		await indexPages(env, [first], t0);
		expect(first.acked).toBe(true);

		// A newer version 10 s later is held back until the window is over...
		const second = new FakeMessage(job(ws, page, 2));
		const early = await indexPages(env, [second], t0 + 10_000);
		expect(early).toMatchObject({ indexed: 0, throttled: 1 });
		expect(second.acked).toBe(false);
		expect(second.retried?.delaySeconds).toBeGreaterThanOrEqual(INDEX_WINDOW_SECONDS - 10);
		expect(second.retried?.delaySeconds).toBeLessThanOrEqual(INDEX_WINDOW_SECONDS - 9);
		expect(calls).toHaveLength(1);

		// ...an already indexed version is a duplicate, never retried...
		const stale = new FakeMessage(job(ws, page, 1));
		await indexPages(env, [stale], t0 + 12_000);
		expect(stale.acked).toBe(true);

		// ...and the held one goes through once the window has passed.
		const later = new FakeMessage(job(ws, page, 2));
		await indexPages(env, [later], t0 + 31_000);
		expect(later.acked).toBe(true);
		expect(calls).toHaveLength(2);
	});

	it('groups items by workspace, one Workspace DO call each, at most 100 pages per call', async () => {
		const wsA = uniqueId('ws');
		const wsB = uniqueId('ws');
		const pagesA = Array.from({ length: 103 }, () => uniqueId('pg'));
		const pageB = uniqueId('pg');
		const { env, calls } = spyEnv();
		const messages = [
			...pagesA.map((page, i) => new FakeMessage(job(wsA, page, 1000 + i))),
			new FakeMessage(job(wsB, pageB, 5))
		];

		const result = await indexPages(env, messages);

		expect(result.indexed).toBe(104);
		expect(messages.every((m) => m.acked)).toBe(true);
		const forA = calls.filter((call) => call.workspaceId === wsA);
		expect(forA.map((call) => call.items.length).sort((a, b) => b - a)).toEqual([100, 3]);
		expect(calls.filter((call) => call.workspaceId === wsB)).toHaveLength(1);
		// every item matches the contract shape
		for (const { items } of calls) {
			for (const item of items) {
				expect(item).toEqual({
					pageId: expect.any(String),
					version: expect.any(Number),
					text: expect.any(String),
					outline: expect.any(Array),
					links: expect.any(Array),
					mentions: expect.any(Array),
					editedAt: expect.any(Number),
					editedBy: null
				});
			}
		}
	});

	it('retries a failed ingest with backoff and still acks the other workspaces', async () => {
		const bad = uniqueId('ws');
		const good = uniqueId('ws');
		const { env, calls } = spyEnv({ failFor: bad });
		const failing = new FakeMessage(job(bad, uniqueId('pg'), 1), 3);
		const ok = new FakeMessage(job(good, uniqueId('pg'), 1));

		const result = await indexPages(env, [failing, ok]);

		expect(result).toMatchObject({ indexed: 1, failed: 1 });
		expect(failing.acked).toBe(false);
		expect(failing.retried).toEqual({ delaySeconds: backoffSeconds(3) });
		expect(ok.acked).toBe(true);
		expect(calls.map((call) => call.workspaceId)).toEqual([good]);
	});

	it('backs off exponentially up to five minutes', () => {
		expect([1, 2, 3, 4, 5, 10].map(backoffSeconds)).toEqual([5, 10, 20, 40, 80, 300]);
	});
});

describe('queue consumer routing', () => {
	it('routes index-page to the indexer and acks the no-op job types', async () => {
		const ws = uniqueId('ws');
		const page = uniqueId('pg');
		(await writtenPage(ws, page, 'routed')).close();
		const ingest = vi.fn(async () => {});
		const env = {
			CACHE: testEnv.CACHE,
			PAGE: testEnv.PAGE,
			WORKSPACE: { getByName: () => ({ ingestPages: ingest }) }
		};
		const messages = [
			new FakeMessage(job(ws, page, 1)),
			new FakeMessage({ type: 'ai-property', workspaceId: ws, pageId: page, propertyId: 'p' } as never),
			new FakeMessage({ type: 'email', template: 'invite', to: 'a@b.c', data: {} } as never),
			new FakeMessage({ type: 'mystery' } as never)
		];
		await queue({ queue: 'flarion-jobs', messages, ackAll() {}, retryAll() {} } as never, env as never, {} as never);
		expect(messages.map((m) => m.acked)).toEqual([true, true, true, true]);
		expect(ingest).toHaveBeenCalledTimes(1);
	});
});
