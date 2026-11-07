import { describe, expect, it } from 'vitest';
import { AI_ACTIONS, specById } from '../../../src/lib/components/editor/ai/actions';
import { isUnavailableError, textUpTo } from '../../../src/lib/components/editor/ai/run';
import { compareFiles, markdownOf } from '../../../src/lib/components/history/diff-text';
import { toVersion } from '../../../src/lib/components/history/history-client';
import { AI_WRITE_ACTIONS } from '../../../src/lib/shared/schemas';

const para = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });

describe('AI actions', () => {
	it('cover every action of the plan: continue, summarize, improve, fix spelling, translate, change tone, explain', () => {
		const actions = new Set(AI_ACTIONS.map((spec) => spec.action));
		for (const wanted of ['continue', 'summarize', 'improve', 'fix_spelling', 'translate', 'change_tone', 'explain'] as const) {
			expect(actions.has(wanted)).toBe(true);
			expect((AI_WRITE_ACTIONS as readonly string[]).includes(wanted)).toBe(true);
		}
		expect(new Set(AI_ACTIONS.map((spec) => spec.id)).size).toBe(AI_ACTIONS.length);
		// Every one is reachable from `/ai`.
		for (const spec of AI_ACTIONS) expect(spec.keywords).toContain('ai');
	});

	it('translate names its language and change tone its tone; continue is slash-only', () => {
		expect(specById('translate_french')).toMatchObject({ action: 'translate', language: 'French', replaces: true });
		expect(specById('tone_casual')).toMatchObject({ action: 'change_tone', tone: 'casual' });
		expect(specById('continue')).toMatchObject({ replaces: false, toolbar: false });
	});
});

describe('ai run helpers', () => {
	it('textUpTo reads the page to the caret block, nested blocks included', () => {
		const doc = { children: [para('a', 'one'), { ...para('b', 'two'), children: [para('c', 'three')] }, para('d', 'four')] };
		expect(textUpTo(doc as never, 'a')).toBe('one');
		expect(textUpTo(doc as never, 'c')).toBe('one\ntwo\nthree');
		expect(textUpTo(doc as never, 'd')).toBe('one\ntwo\nthree\nfour');
	});

	it('recognises the server saying AI is unavailable', () => {
		expect(isUnavailableError({ code: 'SERVICE_UNAVAILABLE', data: { code: 'AI_UNAVAILABLE' } })).toBe(true);
		expect(isUnavailableError({ code: 'INTERNAL_SERVER_ERROR', data: { code: 'AI_UNAVAILABLE' } })).toBe(true);
		expect(isUnavailableError({ code: 'NOT_FOUND' })).toBe(false);
		expect(isUnavailableError(new Error('x'))).toBe(false);
	});
});

describe('history panel helpers', () => {
	it('turns a listed entry into the panel version, keyed by its id', () => {
		const version = toVersion({
			id: '2026-11-07-pm',
			createdAt: '2026-11-08T00:00:01.000Z',
			authorIds: ['u1'],
			size: 290,
			summary: '3 blocks',
			blocks: 3,
			date: '2026-11-07',
			slot: 'pm',
			moreAuthors: 2
		});
		expect(version).toMatchObject({ key: '2026-11-07-pm', date: '2026-11-07', slot: 'pm', bytes: 290, blocks: 3, editors: ['u1'], more: 2 });
		expect(version.at).toBe(Date.parse('2026-11-08T00:00:01.000Z'));
		// An entry from an older server (no date, slot or blocks) still reads.
		expect(toVersion({ id: '2026-01-02-am', createdAt: '2026-01-02T12:00:00.000Z', authorIds: [], size: 1 })).toMatchObject({ date: '2026-01-02', slot: 'am', blocks: 0, more: 0 });
	});

	it('compares the version (old) with the page now (new) as Markdown', () => {
		const version = { children: [para('a', 'First draft.')] };
		const now = { children: [para('a', 'First draft.'), para('b', 'Added later.')] };
		const [old, current] = compareFiles(version as never, now as never);
		expect(old.contents).toBe('First draft.\n');
		expect(current.contents).toBe('First draft.\n\nAdded later.\n');
		expect(markdownOf(null)).toBe('');
		expect(markdownOf({ children: [] } as never)).toBe('');
	});
});
