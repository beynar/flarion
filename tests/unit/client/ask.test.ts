import { describe, expect, it } from 'vitest';
import { citationsOf, isAiUnavailable, mergeCitations, runAsk, toCitation, type AskCall } from '#lib/components/ai/ask.ts';
import { MAX_THREADS, ThreadStore, titleOf, type StoredThread } from '#lib/components/ai/threads.ts';

async function* stream(events: unknown[], delay = 0): AsyncGenerator<unknown> {
	for (const event of events) {
		if (delay) await new Promise((r) => setTimeout(r, delay));
		yield event;
	}
}
const call = (events: unknown[], seen: unknown[] = []): AskCall => async (input) => {
	seen.push(input);
	return stream(events);
};
const signal = () => new AbortController().signal;

describe('citations', () => {
	it('reads every shape the backend has used', () => {
		expect(toCitation({ pageId: 'p', title: 'T', snippet: 'a &amp; b' })).toEqual({ pageId: 'p', title: 'T', snippet: 'a & b' });
		expect(toCitation({ id: 'q', title: '' })).toEqual({ pageId: 'q', title: 'Untitled' });
		expect(toCitation({ title: 'no id' })).toBeNull();
		expect(citationsOf({ type: 'sources', pages: [{ id: 'a', title: 'A' }] })).toEqual([{ pageId: 'a', title: 'A' }]);
		expect(citationsOf({ type: 'citations', citations: [{ pageId: 'a', title: 'A' }] })).toEqual([{ pageId: 'a', title: 'A' }]);
		expect(citationsOf({ type: 'citation', pageId: 'a', title: 'A' })).toEqual([{ pageId: 'a', title: 'A' }]);
		expect(citationsOf({ type: 'delta', text: 'x' })).toBeNull();
	});

	it('merges by page and keeps the first snippet', () => {
		expect(mergeCitations([{ pageId: 'a', title: 'A' }], [{ pageId: 'a', title: 'A', snippet: 's' }, { pageId: 'b', title: 'B' }])).toEqual([
			{ pageId: 'a', title: 'A', snippet: 's' },
			{ pageId: 'b', title: 'B' }
		]);
	});
});

describe('runAsk', () => {
	it('streams tokens, then the sources, then done', async () => {
		const deltas: string[] = [];
		const cites: number[] = [];
		const seen: unknown[] = [];
		const outcome = await runAsk(
			call([{ type: 'delta', text: 'Hel' }, { type: 'delta', text: 'lo' }, { type: 'sources', pages: [{ id: 'p1', title: 'One', snippet: 'x' }] }, { type: 'done', threadId: 't1' }], seen),
			{ question: 'hi', under: 'root' },
			signal(),
			{ onDelta: (_p, all) => deltas.push(all), onCitations: (c) => cites.push(c.length) }
		);
		expect(deltas).toEqual(['Hel', 'Hello']);
		expect(outcome).toEqual({ kind: 'done', threadId: 't1', text: 'Hello', citations: [{ pageId: 'p1', title: 'One', snippet: 'x' }] });
		expect(cites.at(-1)).toBe(1);
		expect(seen).toEqual([{ question: 'hi', under: 'root' }]);
	});

	it('stops cleanly when aborted and keeps the partial answer', async () => {
		const controller = new AbortController();
		const ask: AskCall = async (_input, { signal: s }) =>
			(async function* () {
				yield { type: 'delta', text: 'part' };
				controller.abort();
				if (s.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
				yield { type: 'delta', text: 'never' };
			})();
		const outcome = await runAsk(ask, { question: 'q' }, controller.signal);
		expect(outcome).toEqual({ kind: 'aborted', text: 'part', citations: [] });
	});

	it.each([
		[{ code: 'SERVICE_UNAVAILABLE', data: { code: 'AI_UNAVAILABLE' } }],
		[{ code: 'NOT_IMPLEMENTED', status: 501 }],
		[{ status: 503, message: 'down' }]
	])('reports %j as unavailable', async (error) => {
		expect(isAiUnavailable(error)).toBe(true);
		const outcome = await runAsk(async () => { throw error; }, { question: 'q' }, signal());
		expect(outcome.kind).toBe('unavailable');
	});

	it('reports other failures with what was streamed so far', async () => {
		const ask: AskCall = async () =>
			(async function* () {
				yield { type: 'delta', text: 'half' };
				throw new Error('boom');
			})();
		expect(await runAsk(ask, { question: 'q' }, signal())).toEqual({ kind: 'failed', message: 'boom', text: 'half', citations: [] });
		// an error after tokens is a failure, not "unavailable"
		const late: AskCall = async () => (async function* () { yield { type: 'delta', text: 'x' }; throw { code: 'SERVICE_UNAVAILABLE' }; })();
		expect((await runAsk(late, { question: 'q' }, signal())).kind).toBe('failed');
	});

	it('asks again without the thread when the server no longer knows it', async () => {
		const seen: { threadId?: string }[] = [];
		const ask: AskCall = async (input) => {
			seen.push(input);
			if (input.threadId) throw { code: 'NOT_FOUND', message: 'no thread' };
			return stream([{ type: 'delta', text: 'ok' }, { type: 'done', threadId: 'fresh' }]);
		};
		const outcome = await runAsk(ask, { question: 'q', threadId: 'old' }, signal());
		expect(seen.map((s) => s.threadId)).toEqual(['old', undefined]);
		expect(outcome).toMatchObject({ kind: 'done', threadId: 'fresh', text: 'ok' });
	});
});

describe('ThreadStore', () => {
	const memory = () => {
		const data = new Map<string, string>();
		return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
	};
	const thread = (id: string, at: number, text = id): StoredThread => ({
		id,
		title: titleOf([{ id: 'm', role: 'user', content: text }]),
		updatedAt: at,
		messages: [{ id: 'm', role: 'user', content: text }]
	});

	it('lists newest first, replaces by id and drops empty threads', () => {
		const store = new ThreadStore(memory(), 'k');
		store.save(thread('a', 1));
		store.save(thread('b', 2));
		store.save({ ...thread('a', 3), title: 'again' });
		expect(store.list().map((t) => [t.id, t.title])).toEqual([['a', 'again'], ['b', 'b']]);
		store.save({ ...thread('b', 4), messages: [] });
		expect(store.list().map((t) => t.id)).toEqual(['a']);
		store.remove('a');
		expect(store.list()).toEqual([]);
	});

	it('caps the history and survives bad storage', () => {
		const store = new ThreadStore(memory(), 'k');
		for (let i = 0; i < MAX_THREADS + 5; i++) store.save(thread(`t${i}`, i));
		expect(store.list()).toHaveLength(MAX_THREADS);
		expect(store.list()[0]!.id).toBe(`t${MAX_THREADS + 4}`);
		const bad = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
		const broken = new ThreadStore(bad, 'k');
		expect(broken.list()).toEqual([]);
		expect(() => broken.save(thread('x', 1))).not.toThrow();
		expect(new ThreadStore(null, 'k').list()).toEqual([]);
	});

	it('titles a thread from its first question', () => {
		expect(titleOf([])).toBe('New chat');
		expect(titleOf([{ id: '1', role: 'user', content: `  ${'word '.repeat(30)}` }]).endsWith('…')).toBe(true);
	});
});
