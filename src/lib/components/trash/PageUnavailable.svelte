<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from 'entasis/button';
	import { rpc } from '#lib/client/rpc.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { confirmPurge } from './confirm.ts';
	import { lookupTrashEntry, purgePage, restorePage, wasTrashedHere, type TrashEntry } from './trash-actions.ts';

	/**
	 * What an open page shows when its subscription has no row for it: "This page was moved to Trash" (with Restore
	 * and Delete forever) when it is in the Trash, otherwise "This page doesn't exist" (it never did, was purged, or
	 * access was withdrawn). Restoring needs nothing more: the page's own subscription brings the page back.
	 */
	let { store, pageId, ws }: { store: WorkspaceStore; pageId: string; ws: string } = $props();

	let entry = $state<TrashEntry | null>(null);
	let checking = $state(true);
	let busy = $state(false);

	// Looks the page up in the Trash; again when a different page is shown or this tab trashed it meanwhile.
	$effect(() => {
		const id = pageId;
		let current = true;
		checking = true;
		entry = null;
		void lookupTrashEntry({ page: rpc.page }, id).then((found) => {
			if (!current) return;
			entry = found;
			checking = false;
		});
		return () => (current = false);
	});

	const trashed = $derived(!!entry || (checking && wasTrashedHere(pageId)));

	async function restore() {
		busy = true;
		try {
			if (await restorePage(store, pageId)) entry = null;
		} finally {
			busy = false;
		}
	}

	async function purge() {
		const done = await confirmPurge(entry?.title ?? 'this page', () => purgePage({ page: rpc.page }, pageId));
		if (done) await goto(`/${ws}`);
	}
</script>

{#if trashed}
	<div class="mx-auto mt-24 flex max-w-[460px] flex-col items-center gap-2 px-6 text-center" role="alert" data-testid="page-trashed">
		<div class="text-5xl">🗑️</div>
		<h1 class="text-xl font-semibold">This page was moved to Trash</h1>
		<p class="text-sm text-[color:var(--app-text-secondary)]">
			{#if entry}<span class="font-medium">{entry.icon ?? ''} {entry.title || 'Untitled'}</span> stays in Trash for 30 days.{:else}It stays in Trash for 30 days.{/if}
		</p>
		<div class="mt-2 flex items-center gap-2">
			<Button size="small" data-testid="page-trashed-restore" disabled={busy || !store.canEdit || !entry} onclick={() => void restore()}>Restore</Button>
			<Button size="small" variant="ghost" color="danger" data-testid="page-trashed-purge" disabled={busy || !entry} onclick={() => void purge()}>Delete forever</Button>
		</div>
		<a href={`/${ws}`} class="mt-1 text-sm text-[color:var(--app-accent)]">Back to home</a>
	</div>
{:else if checking}
	<div class="mx-auto mt-24 h-6 w-48 animate-pulse rounded bg-[color:var(--app-hover)]" aria-busy="true"></div>
{:else}
	<div class="mx-auto mt-24 flex max-w-[420px] flex-col items-center gap-2 px-6 text-center" role="alert" data-testid="page-unavailable">
		<div class="text-5xl">🔎</div>
		<h1 class="text-xl font-semibold">This page doesn't exist</h1>
		<p class="text-sm text-[color:var(--app-text-secondary)]">It may have been deleted, or you may not have access.</p>
		<a href={`/${ws}`} class="text-sm text-[color:var(--app-accent)]">Back to home</a>
	</div>
{/if}
