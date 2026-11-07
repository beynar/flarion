<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { toast } from 'entasis/toast';
	import { Button } from 'entasis/button';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { rpc } from '#lib/client/rpc.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { confirmPurge } from './confirm.ts';
	import { TrashList } from './trash-list.svelte.ts';
	import { deletedAgo, purgePage, restorePage, type TrashEntry } from './trash-actions.ts';

	let { store, ws }: { store: WorkspaceStore; ws: string } = $props();

	const list = new TrashList(rpc);
	const nameOf = (userId: string | null) => (userId ? (store.members.find((m) => m.userId === userId)?.name ?? 'Someone') : '');
	const titleOf = (e: TrashEntry) => e.title || 'Untitled';

	onMount(() => {
		void list.reload();
		// Another tab or person may have trashed pages meanwhile: read again when the screen is back in front.
		const refresh = () => document.visibilityState === 'visible' && void list.reload();
		window.addEventListener('focus', refresh);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			window.removeEventListener('focus', refresh);
			document.removeEventListener('visibilitychange', refresh);
			list.dispose();
		};
	});

	async function restore(entry: TrashEntry) {
		if (!(await restorePage(store, entry.id))) return;
		list.remove(entry.id);
		toast.success({
			title: `Restored '${titleOf(entry)}'`,
			actions: [{ content: 'Open', onclick: () => void goto(`/${ws}/${entry.id}`) }]
		});
	}

	async function purge(entry: TrashEntry) {
		const done = await confirmPurge(titleOf(entry), () => purgePage({ page: rpc.page }, entry.id));
		if (!done) return;
		list.remove(entry.id);
		toast.info({ title: `Deleted '${titleOf(entry)}' forever` });
	}

	const columns: DataTableColumn<TrashEntry>[] = [
		{ id: 'title', accessor: 'title', header: 'Name', cell: name, minWidth: 160 },
		{ id: 'deletedAt', accessor: 'deletedAt', header: deletedHeader, cell: deleted, width: 130 },
		{ id: 'deletedBy', accessor: 'deletedBy', header: 'Deleted by', cell: by, width: 140 },
		{ id: 'actions', accessor: 'id', header: '', cell: actions, width: 230, align: 'end' }
	];
</script>

{#snippet name(p: { row: TrashEntry })}
	<span class="flex min-w-0 items-center gap-2">
		<span class="w-5 shrink-0 text-center">{p.row.icon ?? '📄'}</span>
		<span class="truncate font-medium">{titleOf(p.row)}</span>
		{#if p.row.pageCount > 1}
			<span class="shrink-0 text-xs text-[color:var(--app-text-tertiary)]">+{p.row.pageCount - 1} {p.row.pageCount === 2 ? 'subpage' : 'subpages'}</span>
		{/if}
	</span>
{/snippet}

{#snippet deletedHeader()}
	<button
		type="button"
		class="inline-flex items-center gap-1 rounded px-1 hover:bg-[color:var(--app-hover)]"
		data-testid="trash-sort-date"
		aria-label="Sort by deletion date"
		onclick={() => list.setSort(list.sort === 'deleted_desc' ? 'deleted_asc' : 'deleted_desc')}
	>
		Deleted <span aria-hidden="true">{list.sort === 'deleted_asc' ? '↑' : list.sort === 'deleted_desc' ? '↓' : ''}</span>
	</button>
{/snippet}

{#snippet by(p: { row: TrashEntry })}
	<span class="truncate text-[color:var(--app-text-secondary)]">{nameOf(p.row.deletedBy)}</span>
{/snippet}

{#snippet deleted(p: { row: TrashEntry })}
	<span class="text-[color:var(--app-text-secondary)]" title={new Date(p.row.deletedAt).toLocaleString()}>{deletedAgo(p.row.deletedAt)}</span>
{/snippet}

{#snippet actions(p: { row: TrashEntry })}
	<span class="flex items-center gap-1">
		<Button variant="ghost" size="small" data-testid="trash-restore" disabled={!store.canEdit} onclick={() => void restore(p.row)}>Restore</Button>
		<Button variant="ghost" size="small" color="danger" data-testid="trash-purge" onclick={() => void purge(p.row)}>Delete forever</Button>
	</span>
{/snippet}

{#snippet empty()}
	<div class="py-10 text-center text-sm text-[color:var(--app-text-secondary)]" data-testid="trash-empty">
		{list.q.trim() ? `No trashed pages match “${list.q.trim()}”.` : 'Nothing in Trash.'}
	</div>
{/snippet}

<div class="mx-auto w-full max-w-[960px] px-[var(--app-page-padding-x-narrow)] pt-8 pb-24 md:px-[var(--app-page-padding-x)]" data-testid="trash-page">
	<h1 class="mb-1 text-3xl font-semibold tracking-tight">Trash</h1>
	<p class="mb-4 text-sm text-[color:var(--app-text-secondary)]">Pages stay here for 30 days, then are deleted forever.</p>

	<div class="mb-3 flex flex-wrap items-center gap-2">
		<input
			type="search"
			class="min-w-0 flex-1 rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-page)] px-2 text-sm outline-none focus:border-[color:var(--app-accent)]"
			style="height: var(--app-input-height); max-width: 360px"
			placeholder="Search trashed pages…"
			aria-label="Search the Trash"
			data-testid="trash-search"
			value={list.q}
			oninput={(e) => list.search(e.currentTarget.value)}
		/>
		<div class="flex items-center gap-1 text-xs text-[color:var(--app-text-secondary)]" role="group" aria-label="Sort">
			<button type="button" class="rounded px-1.5 py-0.5 hover:bg-[color:var(--app-hover)] {list.sort === 'title' ? 'bg-[color:var(--app-active)] text-[color:var(--app-text)]' : ''}" data-testid="trash-sort-title" onclick={() => list.setSort('title')}>Title</button>
			<button type="button" class="rounded px-1.5 py-0.5 hover:bg-[color:var(--app-hover)] {list.sort !== 'title' ? 'bg-[color:var(--app-active)] text-[color:var(--app-text)]' : ''}" data-testid="trash-sort-recent" onclick={() => list.setSort('deleted_desc')}>Date deleted</button>
		</div>
	</div>

	{#if list.status === 'error' && list.items.length === 0}
		<div class="flex items-center gap-3 rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline)] px-3 py-2 text-sm" role="alert" data-testid="trash-error">
			<span class="flex-1 text-[color:var(--app-text-secondary)]">{list.error}</span>
			<Button size="small" variant="ghost" onclick={() => void list.reload()}>Try again</Button>
		</div>
	{:else}
		<div data-testid="trash-table" data-state={list.status}>
			<DataTable
				items={list.items}
				{columns}
				getRowId={(row) => row.id}
				density="compact"
				pagination={false}
				loading={list.status === 'loading'}
				{empty}
				noResults={empty}
				getRowAttrs={(row) => ({ 'data-testid': 'trash-row', 'data-page-id': row.id })}
				theme={{ row: { base: 'min-h-[var(--app-table-row-height)]' } }}
			/>
		</div>
		{#if list.more}
			<div class="mt-3 flex justify-center">
				<Button variant="ghost" size="small" data-testid="trash-load-more" disabled={list.loadingMore} onclick={() => void list.loadMore()}>
					{list.loadingMore ? 'Loading…' : 'Load more'}
				</Button>
			</div>
		{/if}
	{/if}
</div>
