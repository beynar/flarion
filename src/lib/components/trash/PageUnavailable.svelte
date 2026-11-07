<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from 'entasis/button';
	import { Empty } from 'entasis/empty';
	import { Skeleton } from 'entasis/skeleton';
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
	<div class="mx-auto mt-24 max-w-[460px] px-6" role="alert" data-testid="page-trashed">
		<Empty
			title="This page was moved to Trash"
			actions={[
				{ content: 'Restore', size: 'small', 'data-testid': 'page-trashed-restore', disabled: busy || !store.canEdit || !entry, onclick: () => void restore() },
				{ content: 'Delete forever', size: 'small', variant: 'ghost', color: 'danger', 'data-testid': 'page-trashed-purge', disabled: busy || !entry, onclick: () => void purge() }
			]}
		>
			{#snippet media()}<span class="text-5xl">🗑️</span>{/snippet}
			{#snippet description()}
				{#if entry}<span class="font-medium">{entry.icon ?? ''} {entry.title || 'Untitled'}</span> stays in Trash for 30 days.{:else}It stays in Trash for 30 days.{/if}
			{/snippet}
			{#snippet footer()}<Button variant="link" size="small" href={`/${ws}`}>Back to home</Button>{/snippet}
		</Empty>
	</div>
{:else if checking}
	<div aria-busy="true" class="mx-auto mt-24 w-48"><Skeleton class="h-6 w-48" /></div>
{:else}
	<div class="mx-auto mt-24 max-w-[420px] px-6" role="alert" data-testid="page-unavailable">
		<Empty title="This page doesn't exist" description="It may have been deleted, or you may not have access.">
			{#snippet media()}<span class="text-5xl">🔎</span>{/snippet}
			{#snippet footer()}<Button variant="link" size="small" href={`/${ws}`}>Back to home</Button>{/snippet}
		</Empty>
	</div>
{/if}
