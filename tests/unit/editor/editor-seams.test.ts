import { describe, expect, it, vi } from 'vitest';
import { cn } from '../../../src/lib/components/editor/ui/cn';
import { PAGE_MENTION_PREFIX, isPageMention, mentionItems, pageIdOfMention, pageLinkItems } from '../../../src/lib/components/editor/mentions';
import { rpcUnfurl } from '../../../src/lib/components/editor/unfurl';
import { UPLOADS_UNAVAILABLE, stubUpload } from '../../../src/lib/components/editor/uploads';
import { WIRED_PLUGINS } from '../../../src/lib/components/editor/plugins';

// The plugin list pulls in the database view block, whose host navigates with SvelteKit's `goto` (unavailable under Vitest).
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));

describe('upload and unfurl seams', () => {
	it('the standalone editor has no upload and says so on the block', async () => {
		await expect(stubUpload(new File(['x'], 'a.png'), { progress() {} })).rejects.toThrow(UPLOADS_UNAVAILABLE);
	});

	it('unfurl is the files.unfurl procedure and degrades to null on any failure', async () => {
		const call = vi.fn(async () => ({ title: 'Launch', description: 'd' }));
		expect(await rpcUnfurl({ files: { unfurl: call } } as never)('https://example.com')).toEqual({ title: 'Launch', description: 'd' });
		expect(call).toHaveBeenCalledWith({ url: 'https://example.com' });
		expect(await rpcUnfurl({ files: { unfurl: async () => null } } as never)('https://x.y')).toBeNull();
		expect(await rpcUnfurl({ files: { unfurl: async () => Promise.reject(new Error('refused')) } } as never)('https://x.y')).toBeNull();
	});
});

describe('@ mentions and [[ page links', () => {
	it('lists people and prefixed pages together', async () => {
		const items = await mentionItems(
			async (q) => [{ id: 'u1', name: `Ada ${q}` }],
			async () => [{ id: 'p1', title: 'Plan', icon: '🚀' }, { id: 'p2', title: '', icon: null }]
		)('x');
		expect(items.map((i) => i.id)).toEqual(['u1', `${PAGE_MENTION_PREFIX}p1`, `${PAGE_MENTION_PREFIX}p2`]);
		expect(items[1].label).toBe('🚀 Plan');
		expect(items[2].label).toBe('Untitled');
		expect(isPageMention(items[1].id)).toBe(true);
		expect(isPageMention('u1')).toBe(false);
		expect(pageIdOfMention(items[1].id)).toBe('p1');
	});

	it('works without either search, and page links keep the icon only when there is one', async () => {
		expect(await mentionItems()('')).toEqual([]);
		expect(await pageLinkItems()('')).toEqual([]);
		expect(await pageLinkItems(async () => [{ id: 'a', title: 'A', icon: '📄' }, { id: 'b', title: '', icon: null }])('')).toEqual([
			{ id: 'a', title: 'A', icon: '📄' },
			{ id: 'b', title: 'Untitled' }
		]);
	});
});

describe('class joining (the chrome primitives)', () => {
	it('lets a later class of the same utility win and keeps different ones', () => {
		expect(cn('h-9 w-full px-2', 'h-8 w-auto')).toBe('px-2 h-8 w-auto');
		expect(cn('text-sm text-[color:red]', 'text-xs')).toBe('text-[color:red] text-xs');
		expect(cn('hover:bg-[color:red]', 'hover:bg-transparent', false, null, undefined, ['bg-red-500'])).toBe('hover:bg-transparent bg-red-500');
		expect(cn('data-[selected=true]:bg-x', 'data-[selected=true]:bg-y')).toBe('data-[selected=true]:bg-y');
	});
});

describe('the plugin list', () => {
	it('names every bundled plugin of the plan, once', () => {
		const wanted = [
			'createRichTextPlugin', 'createCodePlugin', 'createImagePlugin', 'createVideoPlugin', 'createAudioPlugin', 'createFilePlugin',
			'createEmbedPlugin', 'createBookmarkPlugin', 'createColumnsPlugin', 'createTablePlugin', 'createPagePlugin', 'createPageLinkPlugin',
			'createMentionPlugin', 'createTocPlugin', 'createEquationPlugin', 'createCommentsPlugin', 'createSharedSuggestionsPlugin',
			'createBlockHandlesPlugin', 'createBlockMenuPlugin', 'createSlashMenuPlugin', 'createToolbarPlugin', 'createMarkdownShortcutsPlugin',
			'createArrowMovePlugin', 'createFindPlugin', 'createMarqueePlugin'
		];
		for (const name of wanted) expect(WIRED_PLUGINS.filter((wired) => wired === name)).toHaveLength(1);
		expect(new Set(WIRED_PLUGINS).size).toBe(WIRED_PLUGINS.length);
	});
});
