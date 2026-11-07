/**
 * Every bundled edytor plugin of the plan's table (docs/PLAN.md "Pages and blocks"), wired once.
 * The menus, handles, panels and cards are drawn by `chrome/` (the ready-made edytor chrome, ported
 * to the app's Notion tokens); each factory takes the chrome snippet that draws it.
 *
 * Order matters (first listed wins a kind, a key or a veto): the custom kinds, then the media and
 * block plugins, then the menus, then rich text last.
 */
import {
	createArrowMovePlugin,
	createAudioPlugin,
	createBlockHandlesPlugin,
	createBlockMenuPlugin,
	createBookmarkPlugin,
	createCalloutIconsPlugin,
	createCodePlugin,
	createColumnsPlugin,
	createCommentsPlugin,
	createEmbedPlugin,
	createEquationPlugin,
	createFilePlugin,
	createFindPlugin,
	createImagePlugin,
	createImageToolbarPlugin,
	createMarkdownShortcutsPlugin,
	createMarqueePlugin,
	createMediaEmptyPlugin,
	createMentionPlugin,
	createPageLinkPlugin,
	createPagePlugin,
	createRichTextPlugin,
	createSharedSuggestionsPlugin,
	createSlashMenuPlugin,
	createSuggestionBarPlugin,
	createSuggestionsPlugin,
	createTablePlugin,
	createTocPlugin,
	createToolbarPlugin,
	createVideoPlugin,
	richTextPlaceholder,
	type CommentsClient,
	type Plugin,
	type Uploader
} from 'edytor';
import * as chrome from './chrome/chrome.svelte';
import { createCustomKindsPlugin, type CustomKindsHost } from './custom-kinds.svelte';
import { mentionItems, pageLinkItems, type PagesSearch, type PeopleSearch } from './mentions.ts';
import type { Unfurl } from './unfurl.ts';

export interface EditorPluginInput {
	upload: Uploader;
	unfurl: Unfurl;
	/** Opens a page (subpage block, page link click). */
	open: (pageId: string, how: { newTab: boolean }) => void;
	href: (pageId: string) => string;
	/** A page's current title and icon (reactive in the App UI store). */
	title: (pageId: string) => string | null | undefined;
	/** Creates the page behind a subpage block; see `Editor.svelte` for the optimistic id. */
	createSubpage?: () => string | { pageId: string; title?: string } | null;
	searchPeople?: PeopleSearch;
	searchPages?: PagesSearch;
	comments: CommentsClient;
	user: { id: string; name: string; color?: string };
	people: (id: string) => { name: string; color?: string } | undefined;
	/** Selector of the element around the editor whose empty area starts a marquee. */
	marqueeContainer: string;
	/** What the custom blocks' slash commands ask of the editor view (database creation, read-only). */
	custom: CustomKindsHost;
}

/** The plugin names as wired, in list order (the Editor's tests and the report read this). */
export const WIRED_PLUGINS = [
	'customKinds (database_view, breadcrumb, date_mention)',
	'createBlockHandlesPlugin',
	'createArrowMovePlugin',
	'createImagePlugin',
	'createFilePlugin',
	'createVideoPlugin',
	'createAudioPlugin',
	'createMediaEmptyPlugin',
	'createImageToolbarPlugin',
	'createEmbedPlugin',
	'createBookmarkPlugin',
	'createCodePlugin',
	'createMarkdownShortcutsPlugin',
	'createMentionPlugin',
	'createPageLinkPlugin',
	'createPagePlugin',
	'createSlashMenuPlugin',
	'createToolbarPlugin',
	'createBlockMenuPlugin',
	'createColumnsPlugin',
	'createFindPlugin',
	'createMarqueePlugin',
	'createTocPlugin',
	'createTablePlugin',
	'createEquationPlugin',
	'createSuggestionsPlugin',
	'createSuggestionBarPlugin',
	'createSharedSuggestionsPlugin',
	'createCalloutIconsPlugin',
	'createCommentsPlugin',
	'createRichTextPlugin'
] as const;

export function createEditorPlugins(input: EditorPluginInput): Plugin[] {
	return [
		createCustomKindsPlugin(input.custom),
		// Chrome that sits beside blocks.
		createBlockHandlesPlugin({ handle: chrome.blockHandle }),
		createArrowMovePlugin(),
		// The placeholder of an empty block ("Type '/' for commands").
		() => ({ placeholder: richTextPlaceholder }),
		// Media: uploads go through the seam (`uploads.ts`), embeds only from the allowlist.
		createImagePlugin({ upload: input.upload }),
		createFilePlugin({ upload: input.upload }),
		createVideoPlugin({ upload: input.upload }),
		createAudioPlugin({ upload: input.upload }),
		createMediaEmptyPlugin({ empty: chrome.mediaEmpty }),
		createImageToolbarPlugin({ toolbar: chrome.imageToolbar }),
		createEmbedPlugin({ menu: chrome.urlPasteMenu }),
		createBookmarkPlugin({ menu: chrome.urlPasteMenu, unfurl: input.unfurl }),
		// Text blocks. `mermaid` code is drawn by chrome/CodeHeader.svelte with entasis Mermaid.
		createCodePlugin({ header: chrome.codeHeader, menu: chrome.languageMenu }),
		createMarkdownShortcutsPlugin(),
		// `@` people and pages, `[[` pages, subpages.
		createMentionPlugin({ items: mentionItems(input.searchPeople, input.searchPages), menu: chrome.mentionMenu }),
		createPageLinkPlugin({ search: pageLinkItems(input.searchPages), href: (page) => input.href(page.id), menu: chrome.pageLinkMenu }),
		createPagePlugin({ open: input.open, href: input.href, title: input.title, ...(input.createSubpage ? { create: input.createSubpage } : {}) }),
		// Menus.
		createSlashMenuPlugin({ menu: chrome.slashMenu }),
		createToolbarPlugin({ toolbar: chrome.toolbar, card: chrome.linkCard }),
		createBlockMenuPlugin({ menu: chrome.blockMenu }),
		// Layout and tables.
		createColumnsPlugin(),
		createFindPlugin({ bar: chrome.findBar }),
		createMarqueePlugin({ box: chrome.marqueeBox, container: input.marqueeContainer }),
		createTocPlugin(),
		createTablePlugin({ grip: chrome.tableGrip, menu: chrome.tableMenu, add: chrome.tableAdd }),
		// KaTeX from our bundle (a dependency), its stylesheet imported by Editor.svelte.
		createEquationPlugin({ panel: chrome.equationPanel, katex: () => import('katex') as never }),
		// Suggestions: local ones, their bar, and shared ones (AI drafts stream in as these).
		createSuggestionsPlugin(),
		createSuggestionBarPlugin({ bar: chrome.suggestionBar }),
		createSharedSuggestionsPlugin(),
		createCalloutIconsPlugin({ picker: chrome.calloutIcons }),
		createCommentsPlugin({
			client: input.comments,
			user: input.user,
			users: input.people,
			card: chrome.commentCard,
			header: chrome.commentsHeader
		}),
		// Rich text is on by default; listed last so every kind above wins a conflict.
		createRichTextPlugin()
	];
}
