<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { Popover } from 'entasis/popover';
	import { Button } from 'entasis/button';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { Empty } from 'entasis/empty';
	import { TextInput } from 'entasis/text-input';
	import { toast } from 'entasis/toast';
	import { arrowCounterClockwiseIcon } from 'entasis/icons/arrowCounterClockwise';
	import { magnifyingGlassIcon } from 'entasis/icons/magnifyingGlass';
	import { trashIcon } from 'entasis/icons/trash';
	import { rpc } from '#lib/client/rpc.ts';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import { listTheme } from '#lib/components/lists/list-theme.ts';
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

	const columns: DataTableColumn<TrashEntry>[] = [
		{ id: 'page', accessor: 'title', header: 'Page', cell: page },
		{ id: 'actions', accessor: 'id', header: '', cell: rowActions, align: 'end' }
	];
	const theme = listTheme({ columns: 'grid-cols-[minmax(0,1fr)_64px]!', edge: 'none', header: false });
</script>

{#snippet page(p: { row: TrashEntry })}
	<span class="flex min-w-0 items-center gap-2">
		<span class="w-5 shrink-0 text-center">{p.row.icon ?? '📄'}</span>
		<span class="min-w-0">
			<span class="block truncate text-sm">{titleOf(p.row)}</span>
			<span class="block truncate text-xs text-[color:var(--app-text-tertiary)]">Deleted {deletedAgo(p.row.deletedAt)}</span>
		</span>
	</span>
{/snippet}

{#snippet rowActions(p: { row: TrashEntry })}
	<span class="flex items-center">
		<Button variant="ghost" size="small" label="Restore" prefix={arrowCounterClockwiseIcon} disabled={!store.canEdit} data-testid="trash-popover-restore" onclick={() => void restore(p.row)} />
		<Button variant="ghost" size="small" color="danger" label="Delete forever" prefix={trashIcon} data-testid="trash-popover-purge" onclick={() => void purge(p.row)} />
	</span>
{/snippet}

{#snippet none()}
	<div data-testid="trash-popover-empty">
		<Empty size="small" title={list.status === 'error' ? (list.error ?? 'The Trash could not be loaded.') : list.q.trim() ? 'No results' : 'Nothing in Trash'} />
	</div>
{/snippet}

<!-- The panel caps at max-w-xs (320px) with 12px padding: it clipped the 340px list. -->
<Popover bind:open ref={anchor} trigger={false} position="right-end" offset={8} modal={false} focusOnOpen="first" theme={{ popover: { size: { normal: 'max-w-[356px] p-1' } } }}>
	{#snippet children(popover)}
		<div class="flex w-[340px] flex-col" data-testid="trash-popover">
			<div class="border-b border-[color:var(--app-hairline)] p-2">
				<TextInput
					size="small"
					placeholder="Search pages in Trash"
					prefix={magnifyingGlassIcon}
					value={list.q}
					onValueChange={(v) => list.search(v ?? '')}
					inputAttrs={{ 'aria-label': 'Search pages in Trash', 'data-testid': 'trash-popover-search' }}
				/>
			</div>
			<div class="max-h-[320px] min-h-[64px] overflow-y-auto p-1" data-state={list.status}>
				<DataTable
					items={list.items}
					{columns}
					getRowId={(e) => e.id}
					density="compact"
					pagination={false}
					loading={list.status === 'loading' || list.status === 'idle'}
					empty={none}
					caption="Trashed pages"
					{theme}
					getRowAttrs={(e) => ({ 'data-testid': 'trash-popover-row', 'data-page-id': e.id })}
				/>
			</div>
			<div class="flex items-center justify-between border-t border-[color:var(--app-hairline)] px-3 py-1.5 text-xs text-[color:var(--app-text-secondary)]">
				<span>Pages stay here for 30 days.</span>
				<Button variant="link" size="small" href={`/${ws}/trash`} data-testid="trash-popover-open" onclick={() => popover.close()}>Open Trash</Button>
			</div>
		</div>
	{/snippet}
</Popover>
