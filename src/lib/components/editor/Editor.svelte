<!--
	The page body: edytor mounted with every bundled plugin (see `plugins.ts`), the editing chrome, and
	a room connection to `/rooms/:pageId` kept alive with short-lived tokens. The page header (icon,
	cover, title, properties) is outside it: `#lib/components/page-header/PageHeader.svelte`.

	Props are the contract the App UI codes against; `upload` and `unfurl` are seams P2 fills.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import 'katex/dist/katex.min.css';
	import type { SyncRefusedError, Uploader, EdytorInstance } from 'edytor';
	import { CLOSE } from '#lib/shared/protocol.ts';
	import EditorView from './EditorView.svelte';
	import type { Unfurl } from './unfurl.ts';
	import type { PagesSearch, PeopleSearch } from './mentions.ts';

	type RoomToken = { token: string; expiresAt: number; access: 'read' | 'comment' | 'write' };

	let {
		workspaceId,
		pageId,
		getRoomToken,
		user,
		readonly = false,
		onSubpage,
		resolvePage,
		searchPages,
		searchPeople,
		onNavigate,
		upload,
		unfurl,
		edytor = $bindable()
	}: {
		workspaceId: string;
		pageId: string;
		getRoomToken: () => Promise<RoomToken>;
		user: { id: string; name: string; color?: string };
		readonly?: boolean;
		onSubpage?: (input: { parentId: string; title?: string }) => Promise<{ id: string }>;
		resolvePage?: (id: string) => { title: string; icon: string | null } | undefined;
		searchPages?: PagesSearch;
		searchPeople?: PeopleSearch;
		onNavigate?: (pageId: string) => void;
		/** Stores an image, file, video or audio and answers its URL. Defaults to a stub that throws "uploads arrive in P2". */
		upload?: Uploader;
		/** Reads a bookmark's title and cover. Defaults to the `/rpc` seam P2 fills. */
		unfurl?: Unfurl;
		/** The editor instance, once it exists. */
		edytor?: EdytorInstance;
	} = $props();

	let initial = $state<RoomToken>();
	let failure = $state<'token' | 'reload' | 'denied' | 'invalid'>();
	let attempt = $state(0);

	// A token before the first dial: `params` is read when the view mounts. Page changes remount (`{#key}`).
	$effect(() => {
		void pageId;
		void attempt;
		initial = undefined;
		failure = undefined;
		let current = true;
		// The caller's function may touch its own state: never a dependency of this effect.
		untrack(() => getRoomToken()).then(
			(token) => current && (initial = token),
			(error) => {
				console.error('room token failed', error);
				if (current) failure = 'token';
			}
		);
		return () => (current = false);
	});

	const refused = (refusal: SyncRefusedError) => {
		if (refusal.code === CLOSE.RELOAD_REQUIRED) failure = 'reload';
		else if (refusal.code === 4400) failure = 'invalid';
		else if (refusal.code === CLOSE.FORBIDDEN) failure = 'denied';
	};

	let mounted = $state(false);
	onMount(() => (mounted = true));
</script>

<div class="flarion-editor edytor-notion" data-flarion-editor data-testid="editor">
	{#if failure === 'reload'}
		<div class="flarion-editor-banner" role="alert" data-testid="editor-reload">
			Flarion was updated. <button type="button" onclick={() => location.reload()}>Reload to continue</button>
		</div>
	{:else if failure === 'denied'}
		<div class="flarion-editor-banner" role="alert">You no longer have access to this page.</div>
	{:else if failure === 'invalid'}
		<div class="flarion-editor-banner" role="alert">This page could not be opened.</div>
	{:else if failure === 'token'}
		<div class="flarion-editor-banner" role="alert">
			Could not connect to this page. <button type="button" onclick={() => attempt++}>Try again</button>
		</div>
	{/if}
	{#if mounted && initial && !failure}
		{#key `${workspaceId}:${pageId}`}
			<EditorView
				{workspaceId}
				{pageId}
				{initial}
				{getRoomToken}
				{user}
				readonly={readonly || initial.access === 'read'}
				{onSubpage}
				{resolvePage}
				{searchPages}
				{searchPeople}
				{onNavigate}
				{upload}
				{unfurl}
				onRefused={refused}
				bind:edytor
			/>
		{/key}
	{:else if !failure}
		<div class="flarion-editor-loading" aria-busy="true"></div>
	{/if}
</div>

<style>
	.flarion-editor {
		position: relative;
		width: 100%;
		min-height: 40vh;
		background: var(--app-page);
		color: var(--app-text);
		font-size: var(--app-font-size-document);
	}
	.flarion-editor-banner {
		margin: 0 0 8px;
		padding: 8px 12px;
		border-radius: var(--app-radius-control);
		background: var(--app-hover);
		color: var(--app-text);
		font-size: var(--app-font-size-chrome);
	}
	.flarion-editor-banner button {
		margin-left: 8px;
		color: var(--app-accent);
		text-decoration: underline;
		cursor: pointer;
	}
	.flarion-editor-loading {
		min-height: 120px;
	}
</style>
