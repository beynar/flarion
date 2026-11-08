<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { toast } from 'entasis/toast';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { createDataTableState, DataTable, type DataTableColumn, type DataTableState } from 'entasis/data-table';
	import { Empty } from 'entasis/empty';
	import { tooltip } from 'entasis/tooltip';
	import { rpc } from '#lib/client/rpc.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { listTheme } from '#lib/components/lists/list-theme.ts';
	import { confirmPurge } from './confirm.ts';
	import { TrashList } from './trash-list.svelte.ts';
	import { deletedAgo, purgePage, restorePage, type TrashEntry } from './trash-actions.ts';

	let { store, ws, initial = null }: { store: WorkspaceStore; ws: string; initial?: { items: TrashEntry[]; nextCursor: string | null } | null } = $props();

	const list = new TrashList(rpc);
	// The server render read the first page: it is on screen from the first paint, and not asked for again.
	if (untrack(() => initial)) list.seed(untrack(() => initial)!);
	const nameOf = (userId: string | null) => (userId ? (store.members.find((m) => m.userId === userId)?.name ?? 'Deleted user') : '');
	const titleOf = (e: TrashEntry) => e.title || 'Untitled';

	onMount(() => {
		if (list.status !== 'ready') void list.reload();
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
		{ id: 'title', accessor: 'title', header: 'Name', cell: name, sortable: true },
		{ id: 'deletedAt', accessor: 'deletedAt', header: 'Deleted', cell: deleted, sortable: true, class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'deletedBy', accessor: 'deletedBy', header: 'Deleted by', cell: by, class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'actions', accessor: 'id', header: '', cell: actions, align: 'end' }
	];
	// The title column takes the free width; the others keep a fixed one (see listTheme).
	const theme = listTheme({
		columns: 'max-md:grid-cols-[minmax(0,1fr)_216px]! md:grid-cols-[minmax(0,1fr)_120px_140px_216px]!'
	});

	// Sorting and searching are the table's own; the server does the work (`processingMode="manual"`).
	// The server sorts by title (ascending only) or by deletion date (either way): a descending title and a
	// cleared sort both fall back to the newest first.
	let tableState = $state<DataTableState>(createDataTableState(columns, { sorting: [{ id: 'deletedAt', desc: true }] }));
	function onStateChange(next: DataTableState) {
		const sort = next.sorting[0];
		const fallback = !sort || (sort.id === 'title' && sort.desc);
		if (fallback) tableState = { ...next, sorting: [{ id: 'deletedAt', desc: true }] };
		list.setSort(fallback ? 'deleted_desc' : sort.id === 'title' ? 'title' : sort.desc ? 'deleted_desc' : 'deleted_asc');
		if (next.globalFilter !== list.q) list.search(next.globalFilter, 0);
	}
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

{#snippet by(p: { row: TrashEntry })}
	<span class="truncate text-[color:var(--app-text-secondary)]">{nameOf(p.row.deletedBy)}</span>
{/snippet}

{#snippet deleted(p: { row: TrashEntry })}
	<span class="text-[color:var(--app-text-secondary)]" {@attach tooltip({ content: new Date(p.row.deletedAt).toLocaleString() })}>{deletedAgo(p.row.deletedAt)}</span>
{/snippet}

{#snippet actions(p: { row: TrashEntry })}
	<span class="flex items-center gap-1">
		<Button variant="ghost" size="small" data-testid="trash-restore" disabled={!store.canEdit} onclick={() => void restore(p.row)}>Restore</Button>
		<Button variant="ghost" size="small" color="danger" data-testid="trash-purge" onclick={() => void purge(p.row)}>Delete forever</Button>
	</span>
{/snippet}

{#snippet empty()}
	<div data-testid="trash-empty">
		<Empty size="small" title={list.q.trim() ? `No trashed pages match “${list.q.trim()}”.` : 'Nothing in Trash.'} />
	</div>
{/snippet}

<div class="mx-auto w-full max-w-[960px] px-[var(--app-page-padding-x-narrow)] pt-8 pb-24 md:px-[var(--app-page-padding-x)]" data-testid="trash-page">
	<h1 class="mb-1 text-3xl font-semibold tracking-tight">Trash</h1>
	<p class="mb-4 text-sm text-[color:var(--app-text-secondary)]">Pages stay here for 30 days, then are deleted forever.</p>

	{#if list.status === 'error' && list.items.length === 0}
		<div data-testid="trash-error">
			<Alert color="danger" variant="soft" size="small">
				<span class="flex items-center gap-3">
					<span>{list.error}</span>
					<Button size="small" variant="ghost" onclick={() => void list.reload()}>Try again</Button>
				</span>
			</Alert>
		</div>
	{:else}
		<div data-testid="trash-table" data-state={list.status}>
			<DataTable
				items={list.items}
				{columns}
				getRowId={(row) => row.id}
				density="compact"
				pagination={false}
				processingMode="manual"
				rowCount={list.items.length}
				search={{ placeholder: 'Search trashed pages…', debounce: 250 }}
				bind:state={tableState}
				{onStateChange}
				loading={list.status === 'loading'}
				{empty}
				noResults={empty}
				caption="Trashed pages"
				getRowAttrs={(row) => ({ 'data-testid': 'trash-row', 'data-page-id': row.id })}
				{theme}
			/>
		</div>
		{#if list.more}
			<div class="mt-3 flex justify-center">
				<Button variant="ghost" size="small" data-testid="trash-load-more" loading={list.loadingMore} onclick={() => void list.loadMore()}>Load more</Button>
			</div>
		{/if}
	{/if}
</div>
