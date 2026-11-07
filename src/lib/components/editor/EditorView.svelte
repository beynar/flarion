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
		createCommentsClient,
		type EdytorInstance,
		type Uploader
	} from 'edytor';
	import { KINDS_VERSION } from '#lib/shared/blocks/kinds.ts';
	import { createEditorPlugins } from './plugins.ts';
	import { stubUpload } from './uploads.ts';
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
		onNavigate,
		upload = stubUpload,
		unfurl,
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
		onNavigate?: (pageId: string) => void;
		upload?: Uploader;
		unfurl?: Unfurl;
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
	const findPageBlock = (id: string) => {
		const search = (blocks: readonly Block[]): Block | undefined => {
			for (const block of blocks) {
				if (block.type === 'page' && (block.data as { pageId?: string } | undefined)?.pageId === id) return block;
				const inner = search(block.children);
				if (inner) return inner;
			}
			return undefined;
		};
		return edytor?.root ? search(edytor.root.children) : undefined;
	};
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

	const plugins = untrack(() => createEditorPlugins({
		upload,
		unfurl: unfurl ?? rpcUnfurl(workspaceId),
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
		people: (id) => people.get(id),
		marqueeContainer: '[data-flarion-editor]'
	}));

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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flarion-editor-view" {onclickcapture}>
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
