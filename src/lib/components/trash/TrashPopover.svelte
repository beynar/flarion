<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { Popover } from 'entasis/popover';
	import { Button } from 'entasis/button';
	import { toast } from 'entasis/toast';
	import { arrowCounterClockwiseIcon } from 'entasis/icons/arrowCounterClockwise';
	import { trashIcon } from 'entasis/icons/trash';
	import { rpc } from '#lib/client/rpc.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { confirmPurge } from './confirm.ts';
	import { TrashList } from './trash-list.svelte.ts';
	import { deletedAgo, purgePage, restorePage, type TrashEntry } from './trash-actions.ts';

	/**
	 * The sidebar's Trash popover (Notion's): a searchable list of the latest deletions with restore and delete
	 * forever, and a link to the full screen. Anchored on the footer row that opens it (`anchor`).
	 */
	let {
		store,
		ws,
		open = $bindable(false),
		anchor
	}: { store: WorkspaceStore; ws: string; open?: boolean; anchor: HTMLElement | null } = $props();

	const list = new TrashList(rpc, 20);
	const titleOf = (e: TrashEntry) => e.title || 'Untitled';

	// Each opening reads the latest deletions (and starts a fresh search).
	$effect(() => {
		if (!open) return;
		untrack(() => {
			list.q = '';
			void list.reload();
		});
		return () => list.dispose();
	});

	async function restore(entry: TrashEntry) {
		if (!(await restorePage(store, entry.id))) return;
		list.remove(entry.id);
		toast.success({ title: `Restored '${titleOf(entry)}'`, actions: [{ content: 'Open', onclick: () => void goto(`/${ws}/${entry.id}`) }] });
	}

	async function purge(entry: TrashEntry) {
		if (!(await confirmPurge(titleOf(entry), () => purgePage({ page: rpc.page }, entry.id)))) return;
		list.remove(entry.id);
		toast.info({ title: `Deleted '${titleOf(entry)}' forever` });
	}
</script>

<Popover bind:open ref={anchor} trigger={false} position="right-end" offset={8} modal={false} focusOnOpen="first">
	{#snippet children(popover)}
		<div class="flex w-[340px] flex-col" data-testid="trash-popover">
			<div class="border-b border-[color:var(--app-hairline)] p-2">
				<input
					type="search"
					class="w-full rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-page)] px-2 text-sm outline-none focus:border-[color:var(--app-accent)]"
					style="height: var(--app-input-height)"
					placeholder="Search pages in Trash"
					aria-label="Search pages in Trash"
					data-testid="trash-popover-search"
					value={list.q}
					oninput={(e) => list.search(e.currentTarget.value)}
				/>
			</div>
			<ul class="max-h-[320px] min-h-[64px] overflow-y-auto py-1" data-state={list.status}>
				{#each list.items as entry (entry.id)}
					<li class="group flex items-center gap-2 px-2" style="min-height: var(--app-table-row-height)" data-testid="trash-popover-row" data-page-id={entry.id}>
						<span class="w-5 shrink-0 text-center">{entry.icon ?? '📄'}</span>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm">{titleOf(entry)}</span>
							<span class="block truncate text-xs text-[color:var(--app-text-tertiary)]">Deleted {deletedAgo(entry.deletedAt)}</span>
						</span>
						<Button variant="ghost" size="small" label="Restore" prefix={arrowCounterClockwiseIcon} disabled={!store.canEdit} data-testid="trash-popover-restore" onclick={() => void restore(entry)} />
						<Button variant="ghost" size="small" color="danger" label="Delete forever" prefix={trashIcon} data-testid="trash-popover-purge" onclick={() => void purge(entry)} />
					</li>
				{:else}
					<li class="px-3 py-4 text-center text-sm text-[color:var(--app-text-secondary)]" data-testid="trash-popover-empty">
						{#if list.status === 'loading' || list.status === 'idle'}Loading…{:else if list.status === 'error'}{list.error}{:else if list.q.trim()}No results{:else}Nothing in Trash{/if}
					</li>
				{/each}
			</ul>
			<div class="flex items-center justify-between border-t border-[color:var(--app-hairline)] px-3 py-1.5 text-xs text-[color:var(--app-text-secondary)]">
				<span>Pages stay here for 30 days.</span>
				<a
					href={`/${ws}/trash`}
					class="text-[color:var(--app-accent)] hover:underline"
					data-testid="trash-popover-open"
					onclick={() => popover.close()}>Open Trash</a
				>
			</div>
		</div>
	{/snippet}
</Popover>
