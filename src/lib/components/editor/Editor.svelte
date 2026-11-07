<!--
	The page body: edytor mounted with every bundled plugin (see `plugins.ts`), the editing chrome, and
	a room connection to `/rooms/:pageId` kept alive with short-lived tokens. The page header (icon,
	cover, title, properties) is outside it: `#lib/components/page-header/PageHeader.svelte`.

	Props are the contract the App UI codes against. Uploads (`files.begin` -> `PUT /files/:id` -> `files.complete`),
	bookmark unfurls (`files.unfurl`), the inline database and the page lock (`page.lock.*`, shown as a banner and a
	read-only view) are wired here; `upload`, `unfurl` and `fetchLock` override them for the standalone test page.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import 'katex/dist/katex.min.css';
	import type { SyncRefusedError, Uploader, EdytorInstance } from 'edytor';
	import type { Rpc } from '#lib/client/rpc.ts';
	import { CLOSE } from '#lib/shared/protocol.ts';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { lockIcon } from 'entasis/icons/lock';
	import { sparkleIcon } from 'entasis/icons/sparkle';
	import EditorView from './EditorView.svelte';
	import type { AncestorRef, DatabaseRef } from './context.ts';
	import { aiState } from './ai/state.svelte.ts';
	import { pageLocks, rpcLockFetcher, type LockFetcher } from './page-lock.svelte.ts';
	import type { Unfurl } from './unfurl.ts';
	import type { PagesSearch, PeopleSearch } from './mentions.ts';

	type RoomToken = { token: string; expiresAt: number; access: 'read' | 'comment' | 'write' };

	let {
		workspaceId,
		pageId,
		getRoomToken,
		user,
		readonly = false,
		access,
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
		fetchLock,
		client,
		edytor = $bindable()
	}: {
		workspaceId: string;
		pageId: string;
		getRoomToken: () => Promise<RoomToken>;
		user: { id: string; name: string; color?: string };
		readonly?: boolean;
		/**
		 * The level the page's permissions give this person right now (the live tree row's `access`). The room's
		 * access comes from the token in hand, which only narrows; when a grant raises the level, the token is
		 * too narrow, so a fresh one is fetched and the view remounts with it (the room redialed already, with
		 * the old token, and would hand back the old access).
		 */
		access?: 'read' | 'comment' | 'update' | 'full';
		onSubpage?: (input: { parentId: string; title?: string }) => Promise<{ id: string }>;
		resolvePage?: (id: string) => { title: string; icon: string | null } | undefined;
		searchPages?: PagesSearch;
		searchPeople?: PeopleSearch;
		/** A person's name by id (comment authors): the workspace's members. */
		resolvePerson?: (id: string) => { name: string } | undefined;
		onNavigate?: (pageId: string) => void;
		/** Stores an image, file, video or audio and answers its URL. Default: R2 through `files.begin`/`PUT`/`files.complete`. */
		upload?: Uploader;
		/** Reads a bookmark's title and cover. Default: `files.unfurl` (the Worker fetches it, cached in KV). */
		unfurl?: Unfurl;
		/** The pages above a page, root first: the breadcrumb block reads them (reactive in the App UI store). */
		resolveAncestors?: (pageId: string) => AncestorRef[];
		/** Databases matching a search (the linked view's picker). */
		searchDatabases?: (query: string) => DatabaseRef[] | Promise<DatabaseRef[]>;
		/** Reads the page lock (default `page.lock.get`). */
		fetchLock?: LockFetcher;
		/** The `/rpc` client the editor's own calls use (default: the app's). */
		client?: Rpc;
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

	// A raised permission needs a new token (see `access`): once per level, so a server that keeps answering
	// narrower than the tree cannot make this loop.
	const ROOM_RANK = { read: 0, comment: 1, write: 2 } as const;
	let upgradedFor: string | undefined;
	$effect(() => {
		if (!access || !initial || failure) return;
		const wanted = access === 'full' || access === 'update' ? 'write' : access;
		if (ROOM_RANK[wanted] > ROOM_RANK[initial.access] && upgradedFor !== wanted) {
			upgradedFor = wanted;
			attempt++;
		}
	});

	const refused = (refusal: SyncRefusedError) => {
		if (refusal.code === CLOSE.RELOAD_REQUIRED) failure = 'reload';
		else if (refusal.code === 4400) failure = 'invalid';
		else if (refusal.code === CLOSE.FORBIDDEN) failure = 'denied';
	};

	let mounted = $state(false);
	onMount(() => (mounted = true));

	// The page lock lives in the room: read it now and while the page is open. A locked page is read-only for
	// everyone without full access (the room refuses their edits anyway); the banner says why.
	$effect(() => {
		const id = pageId;
		const fetcher = fetchLock ?? rpcLockFetcher;
		return pageLocks.watch(id, fetcher);
	});
	const lock = $derived(pageLocks.get(pageId));
	const lockedOut = $derived(!!lock?.locked && !lock.bypass);
</script>

<div class="flarion-editor edytor-notion" data-flarion-editor data-testid="editor">
	{#if lock?.locked}
		<div class="flarion-editor-banner" role="status" data-testid="editor-locked">
			<Alert color="warning" variant="soft" size="small">
				{#snippet prefix()}{@render lockIcon({ size: 16 })}{/snippet}
				{lockedOut ? 'This page is locked. Only people with full access can edit it.' : 'This page is locked. You can still edit it because you have full access.'}
			</Alert>
		</div>
	{/if}
	{#if aiState.unavailable}
		<div class="flarion-editor-banner" role="status" data-testid="ai-unavailable">
			<Alert color="info" variant="soft" size="small">
				{#snippet prefix()}{@render sparkleIcon({ size: 16 })}{/snippet}
				AI writing is unavailable right now, so it is turned off. Everything else works.
				<Button size="small" variant="ghost" data-testid="ai-retry" onclick={() => aiState.reset()}>Try again</Button>
			</Alert>
		</div>
	{/if}
	{#if failure === 'reload'}
		<div class="flarion-editor-banner" role="alert" data-testid="editor-reload">
			<Alert color="primary" variant="soft" size="small">
				Flarion was updated.
				<Button size="small" variant="ghost" onclick={() => location.reload()}>Reload to continue</Button>
			</Alert>
		</div>
	{:else if failure === 'denied'}
		<div class="flarion-editor-banner" role="alert">
			<Alert color="danger" variant="soft" size="small">You no longer have access to this page.</Alert>
		</div>
	{:else if failure === 'invalid'}
		<div class="flarion-editor-banner" role="alert">
			<Alert color="danger" variant="soft" size="small">This page could not be opened.</Alert>
		</div>
	{:else if failure === 'token'}
		<div class="flarion-editor-banner" role="alert">
			<Alert color="danger" variant="soft" size="small">
				Could not connect to this page.
				<Button size="small" variant="ghost" onclick={() => attempt++}>Try again</Button>
			</Alert>
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
				readonly={readonly || initial.access !== 'write' || lockedOut}
				{onSubpage}
				{resolvePage}
				{searchPages}
				{searchPeople}
				{resolvePerson}
				{onNavigate}
				{upload}
				{unfurl}
				{resolveAncestors}
				{searchDatabases}
				{client}
				onRefused={refused}
				bind:edytor
			/>
		{/key}
	{:else if !failure}
		<div class="flarion-editor-loading" aria-busy="true"></div>
	{/if}
</div>

<style>
	/* The same column as the page header: the document lines up with the title. */
	.flarion-editor {
		--column-pad: var(--app-page-padding-x-narrow);
		position: relative;
		box-sizing: border-box;
		width: 100%;
		max-width: calc(var(--app-page-width) + 2 * var(--column-pad));
		margin-inline: auto;
		padding-inline: var(--column-pad);
		min-height: 40vh;
		background: var(--app-page);
		color: var(--app-text);
		font-size: var(--app-font-size-document);
	}
	@media (min-width: 768px) {
		.flarion-editor {
			--column-pad: var(--app-page-padding-x);
		}
	}
	.flarion-editor-banner {
		margin: 0 0 8px;
	}
	.flarion-editor-loading {
		min-height: 120px;
	}
</style>
