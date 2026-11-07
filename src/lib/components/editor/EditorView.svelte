<!--
	One mounted editor: the plugin list, the sync props and the page-level behaviour that needs the
	editor instance (subpage creation, link clicks). `Editor.svelte` mounts it once a room token is in
	hand and again whenever the page changes (plugins are read once, at mount).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import {
		type Block,
		Edytor,
		SyncRefusedError,
		commentsController,
		createCommentsClient,
		type EdytorInstance,
		type Uploader
	} from 'edytor';
	import { toast } from 'entasis/toast';
	import { createRpc, type Rpc } from '#lib/client/rpc.ts';
	import { useWorkspace, type WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { BLOCK_KIND, KINDS_VERSION } from '#lib/shared/blocks/kinds.ts';
	import { TITLE_PROP_ID } from '#lib/shared/property-types.ts';
	import { runAiWrite, type WriteCall } from './ai/run.ts';
	import { aiRuntime, type AiRuntime } from './ai/state.svelte.ts';
	import { setEditorContext, type AncestorRef, type DatabaseRef } from './context.ts';
	import MoveBlocksDialog from './MoveBlocksDialog.svelte';
	import { blockMoves, type BlockMoves } from './moves.svelte.ts';
	import { createEditorPlugins } from './plugins.ts';
	import { createUploader } from './uploads.ts';
	import { rpcUnfurl, type Unfurl } from './unfurl.ts';
	import type { PagesSearch, PeopleSearch } from './mentions.ts';

	type RoomToken = { token: string; expiresAt: number; access: 'read' | 'comment' | 'write' };

	let {
		workspaceId,
		pageId,
		initial,
		getRoomToken,
		user,
		readonly = false,
		onSubpage,
		resolvePage,
		searchPages,
		searchPeople,
		resolvePerson,
		onNavigate,
		upload,
		unfurl,
		resolveAncestors,
		searchDatabases,
		client,
		onRefused,
		edytor = $bindable()
	}: {
		workspaceId: string;
		pageId: string;
		initial: RoomToken;
		getRoomToken: () => Promise<RoomToken>;
		user: { id: string; name: string; color?: string };
		readonly?: boolean;
		onSubpage?: (input: { parentId: string; title?: string }) => Promise<{ id: string }>;
		resolvePage?: (id: string) => { title: string; icon: string | null } | undefined;
		searchPages?: PagesSearch;
		searchPeople?: PeopleSearch;
		resolvePerson?: (id: string) => { name: string } | undefined;
		onNavigate?: (pageId: string) => void;
		upload?: Uploader;
		unfurl?: Unfurl;
		resolveAncestors?: (pageId: string) => AncestorRef[];
		searchDatabases?: (query: string) => DatabaseRef[] | Promise<DatabaseRef[]>;
		/** The `/rpc` client the editor's own calls go through (default: the app's, scoped to the workspace). */
		client?: Rpc;
		onRefused: (refusal: SyncRefusedError) => void;
		edytor?: EdytorInstance;
	} = $props();

	// Everything this view is built from is read once (the plugins and sync props are), and the parent
	// remounts it per page (`{#key}`): so the setup runs untracked, in one place.
	const setup = untrack(() => {
		const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
		const server = `${origin.replace(/^http/, 'ws')}/rooms`;
		/** `params` is read at every dial: a refreshed token reaches the next reconnect. */
		const params = $state<Record<string, string>>({
			token: initial.token,
			workspace: workspaceId,
			kinds: String(KINDS_VERSION)
		});
		const href = (id: string) => `/${workspaceId}/${id}`;
		const room = pageId;
		return { origin, server, params, href, room };
	});
	const { origin, server, params, href, room } = setup;
	const refresh = async () => {
		params.token = (await getRoomToken()).token;
	};

	/**
	 * A subpage block is inserted synchronously (edytor's `create` cannot wait), with a provisional id; the
	 * workspace creates the real page, and the block is re-pointed at it. Opening the provisional page
	 * waits for the real id. A failed creation removes the block.
	 */
	const provisional = new Map<string, Promise<string>>();
	/** The first block (depth first) of `type` whose data satisfies `match`. */
	const findBlock = (type: string, match: (data: Record<string, unknown>) => boolean) => {
		const search = (blocks: readonly Block[]): Block | undefined => {
			for (const block of blocks) {
				if (block.type === type && match((block.data ?? {}) as Record<string, unknown>)) return block;
				const inner = search(block.children);
				if (inner) return inner;
			}
			return undefined;
		};
		return edytor?.root ? search(edytor.root.children) : undefined;
	};
	const findPageBlock = (id: string) => findBlock('page', (data) => data.pageId === id);
	const subpage = untrack(() => onSubpage);
	const createSubpage = subpage
		? () => {
				const temp = `new_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
				const created = subpage({ parentId: pageId, title: 'Untitled' }).then(({ id }) => {
					const block = findPageBlock(temp);
					if (block) edytor?.patchData(block.id, [{ path: ['pageId'], value: id }]);
					return id;
				});
				provisional.set(temp, created);
				created.catch((error) => {
					console.error('subpage creation failed', error);
					const block = findPageBlock(temp);
					if (block) edytor?.deleteBlock(block.id);
				});
				return { pageId: temp, title: 'Untitled' };
			}
		: undefined;
	const open = (target: string, how: { newTab: boolean }) => {
		const pending = provisional.get(target);
		const go = (id: string) => (how.newTab || !onNavigate ? window.open(href(id), '_blank') : onNavigate(id));
		if (pending) void pending.then(go).catch(() => {});
		else go(target);
	};

	const people = new Map<string, { name: string; color?: string }>();
	untrack(() => people.set(user.id, { name: user.name, color: user.color }));

	// Files, bookmark unfurls and inline databases go through the app's `/rpc`, scoped to this workspace.
	const api = untrack(() => client ?? createRpc({ getWorkspaceId: () => workspaceId }));
	const isReadonly = () => readonlyNow;
	let readonlyNow = $state(untrack(() => readonly));
	$effect(() => {
		readonlyNow = readonly;
	});

	/**
	 * An inline database is a new page (`isDatabase`) under this one, a collection whose members are the pages
	 * under it (`$parent = that page`), and a default table view. The client chooses one id for all three (a
	 * database page's collection has the page's id), so the block that names it is valid before the calls return.
	 */
	const createInlineDatabase = async (id: string) => {
		try {
			await api.page.create({ id, parentId: pageId, isDatabase: true, values: { [TITLE_PROP_ID]: 'Untitled database' } });
			await api.collection.create({ id, pageId: id, sourceAst: { and: [{ prop: '$parent', op: 'is', value: id }] } });
			await api.view.create({ collectionId: id, type: 'table', name: 'Table' });
		} catch (error) {
			console.error('inline database creation failed', error);
			const block = findBlock(BLOCK_KIND.databaseView, (data) => data.collectionId === id);
			if (block) edytor?.deleteBlock(block.id);
		}
	};

	// ───────────── Write with AI (docs/PLAN.md "AI features") ─────────────
	// Drafts stream from `ai.write` into a shared suggestion (`ai/run.ts`). The development server has no Workers AI: a dev
	// build asks for the fake model when `localStorage['flarion:fake-ai']` is `1` (the server honours it only under
	// `ENVIRONMENT=development`), which is how the editor's end-to-end tests run the whole flow.
	const fakeAi = () => {
		if (!import.meta.env.DEV) return false;
		try {
			return localStorage.getItem('flarion:fake-ai') === '1';
		} catch {
			return false;
		}
	};
	const withFakeAi: typeof fetch = (input, init) => {
		const request = new Request(input as Request, init);
		request.headers.set('x-flarion-fake-ai', '1');
		return fetch(request);
	};
	const aiApi = untrack(() => (fakeAi() ? createRpc({ getWorkspaceId: () => workspaceId, fetch: withFakeAi }) : api));
	const writeCall: WriteCall = (input) => aiApi.ai.write(input);
	const aiHost: AiRuntime = {
		run: async (spec) => {
			if (edytor) await runAiWrite({ edytor, pageId, write: writeCall, notify: (title) => toast.info({ title }) }, spec);
		},
		readonly: isReadonly
	};
	$effect(() => {
		aiRuntime.current = aiHost;
		return () => {
			if (aiRuntime.current === aiHost) aiRuntime.current = undefined;
		};
	});

	// ───────────── Moving blocks to another page, Turn into page (edytor's export, import, commit) ─────────────
	// Both need the workspace around the editor (the page picker, the tree); the standalone test page has none.
	const store: WorkspaceStore | undefined = (() => {
		try {
			return useWorkspace();
		} catch {
			return undefined;
		}
	})();
	let moveDialog = $state<{ open: boolean; ids: string[] }>({ open: false, ids: [] });

	/** The first block's text, for a new page's title. */
	const titleOfBlocks = (ids: string[]) => {
		const first = edytor?.value ? findInJson(edytor.value.children, ids[0]) : undefined;
		const text = (first?.content ?? []).map((part) => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('').trim();
		return text.slice(0, 80) || 'Untitled';
	};
	const findInJson = <T extends { id?: string; children?: T[] }>(blocks: readonly T[] | undefined, id: string | undefined): T | undefined => {
		for (const block of blocks ?? []) {
			if (block.id === id) return block;
			const inner = findInJson(block.children, id);
			if (inner) return inner;
		}
		return undefined;
	};
	/** `{ parent, index }` of a block among its siblings, from the document's JSON. */
	const positionOf = (id: string): { parent: string | null; index: number } | null => {
		const walk = (blocks: readonly { id?: string; children?: unknown[] }[], parent: string | null): { parent: string | null; index: number } | null => {
			for (const [index, block] of blocks.entries()) {
				if (block.id === id) return { parent, index };
				const inner = walk((block.children ?? []) as { id?: string; children?: unknown[] }[], block.id ?? null);
				if (inner) return inner;
			}
			return null;
		};
		return edytor?.value ? walk(edytor.value.children as { id?: string; children?: unknown[] }[], null) : null;
	};

	const moveBlocksTo = async (ids: string[], toPage: string) => {
		try {
			await api.page.moveBlocks({ from: pageId, to: toPage, ids });
			const target = store?.resolvePage(toPage);
			toast.success({ title: `Moved to ${target?.title || 'Untitled'}` });
		} catch (error) {
			console.error('move blocks failed', error);
			toast.danger({ title: 'Could not move the blocks', description: error instanceof Error ? error.message : undefined });
		}
	};
	const turnIntoPage = async (ids: string[]) => {
		if (!subpage || ids.length === 0 || !edytor) return;
		const at = positionOf(ids[0]!);
		try {
			const title = titleOfBlocks(ids);
			const { id } = await subpage({ parentId: pageId, title });
			// A subpage block where the blocks were, then the blocks leave for the new page.
			if (at) edytor.insertBlocks({ parent: at.parent, index: at.index }, [{ type: 'page', data: { pageId: id, title } }]);
			await api.page.moveBlocks({ from: pageId, to: id, ids });
		} catch (error) {
			console.error('turn into page failed', error);
			toast.danger({ title: 'Could not turn the blocks into a page', description: error instanceof Error ? error.message : undefined });
		}
	};
	const moves: BlockMoves = {
		moveTo: (ids) => (moveDialog = { open: true, ids }),
		turnIntoPage
	};
	$effect(() => {
		if (!store || isReadonly()) {
			if (blockMoves.current === moves) blockMoves.current = undefined;
			return;
		}
		blockMoves.current = moves;
		return () => {
			if (blockMoves.current === moves) blockMoves.current = undefined;
		};
	});

	setEditorContext({
		workspaceId: untrack(() => workspaceId),
		pageId: untrack(() => pageId),
		resolveAncestors: untrack(() => resolveAncestors),
		resolvePage: untrack(() => resolvePage),
		searchDatabases: untrack(() => searchDatabases),
		open: (target, how) => open(target, how),
		href,
		readonly: isReadonly
	});

	const plugins = untrack(() => createEditorPlugins({
		upload: upload ?? createUploader({ workspaceId, pageId, rpc: api }),
		unfurl: unfurl ?? rpcUnfurl(api),
		custom: { createInlineDatabase, readonly: isReadonly },
		ai: { run: aiHost.run, readonly: isReadonly },
		open,
		href,
		title: (id) => resolvePage?.(id)?.title,
		createSubpage,
		searchPeople: searchPeople
			? async (q) => {
					const found = await searchPeople(q);
					for (const person of found) people.set(person.id, { name: person.name });
					return found;
				}
			: undefined,
		searchPages,
		comments: createCommentsClient({
			server: `${origin}/rooms/comments`,
			room,
			params: () => ({ token: params.token, workspace: params.workspace })
		}),
		user,
		people: (id) => people.get(id) ?? untrack(() => resolvePerson?.(id)),
		marqueeContainer: '[data-flarion-editor]'
	}));

	// Dev server only: the editor instance for the browser tests (`window.__edytor`), like the store's `__flarion`.
	$effect(() => {
		if (import.meta.env.DEV && edytor) (window as unknown as { __edytor?: unknown }).__edytor = edytor;
	});

	/**
	 * Someone who may comment but not edit has a read-only editor, and edytor hides its selection toolbar (and
	 * ignores the shortcut) in a read-only view. A small "Comment" button over the selection starts the thread
	 * instead: the room writes the anchor for them (`document.access === 'comment'`).
	 */
	const commentOnly = $derived(readonly && initial.access === 'comment');
	let commentAt = $state<{ top: number; left: number } | null>(null);
	let view = $state<HTMLElement>();
	$effect(() => {
		if (!commentOnly || !view) return;
		const root = view;
		const track = () => {
			const selection = document.getSelection();
			const inside = selection && !selection.isCollapsed && selection.rangeCount > 0 && root.querySelector('[data-edytor]')?.contains(selection.anchorNode);
			if (!inside) return (commentAt = null);
			const rect = selection.getRangeAt(0).getBoundingClientRect();
			commentAt = { top: Math.max(8, rect.top - 40), left: Math.max(8, rect.left) };
		};
		document.addEventListener('selectionchange', track);
		return () => {
			document.removeEventListener('selectionchange', track);
			commentAt = null;
		};
	});
	const startComment = () => {
		if (edytor && commentsController(edytor as never)?.start()) commentAt = null;
	};

	/** Clicks on `[[` page links stay in the app (a full navigation would reload it); modified clicks are the browser's. */
	const onclickcapture = (event: MouseEvent) => {
		if (!onNavigate || event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const link = (event.target as Element | null)?.closest?.('a.edytor-page-link');
		const target = link?.getAttribute('href')?.split('/').pop();
		if (!target) return;
		event.preventDefault();
		onNavigate(decodeURIComponent(target));
	};
</script>

{#if store}
	<MoveBlocksDialog
		{store}
		fromPageId={pageId}
		count={moveDialog.ids.length}
		bind:open={moveDialog.open}
		onpick={(target) => void moveBlocksTo(moveDialog.ids, target)}
	/>
{/if}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flarion-editor-view" {onclickcapture} bind:this={view}>
	{#if commentOnly && commentAt}
		<button
			type="button"
			class="flarion-comment-button"
			style="top: {commentAt.top}px; left: {commentAt.left}px"
			data-testid="comment-selection"
			onmousedown={(event) => event.preventDefault()}
			onclick={startComment}
		>
			💬 Comment
		</button>
	{/if}
	<Edytor
		bind:edytor
		{plugins}
		{server}
		{room}
		{params}
		actor={{ id: user.id, name: user.name, color: user.color }}
		{readonly}
		allowNesting
		aria-label="Page content"
		onSyncExpired={refresh}
		onSyncRefused={onRefused}
	/>
</div>

<style>
	.flarion-comment-button {
		position: fixed;
		z-index: 30;
		height: var(--app-button-height-small, 28px);
		padding: 0 10px;
		border: 1px solid var(--app-hairline-strong);
		border-radius: var(--app-radius-control);
		background: var(--app-page);
		color: var(--app-text);
		box-shadow: var(--app-shadow-menu);
		font-size: var(--app-font-size-small, 13px);
		cursor: pointer;
	}
	.flarion-comment-button:hover {
		background: var(--app-hover);
	}
</style>
