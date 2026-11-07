<!--
	The list layout: entasis Sortable list, one row per page with its icon, title and the shown properties. Rows
	drag into place under manual order.
-->
<script lang="ts">
	import { SortableList } from 'entasis/sortable-list';
	import { plusIcon } from 'entasis/icons/plus';
	import type { ViewData } from '#lib/client/workspace.svelte.ts';
	import type { ViewRow } from '#lib/shared/protocol.ts';
	import type { ViewEnv } from './env.ts';
	import CardProps from './CardProps.svelte';

	let { env, data }: { env: ViewEnv; data: ViewData } = $props();

	let items = $state.raw<ViewRow[]>([]);
	$effect.pre(() => {
		items = data.rows;
	});
	const reorder = $derived(env.editable && env.manualOrder);

	function reordered({ items: next, item }: { items: ViewRow[]; item: ViewRow }) {
		const at = next.findIndex((r) => r.id === item.id);
		void env.moveRow(item.id, { after: next[at - 1]?.id ?? null, before: next[at + 1]?.id ?? null });
	}
	let infinite = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = infinite;
		if (!el || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && env.loadMore());
		io.observe(el);
		return () => io.disconnect();
	});
</script>

<div class="list" data-testid="view-list">
	<SortableList
		bind:items
		disabled={!reorder}
		handle={reorder}
		size="small"
		class="rows"
		theme={{ root: { base: 'm-0 flex list-none p-0 gap-0' }, item: { base: 'relative flex items-center text-neutral outline-none rounded-none border-0 border-b border-neutral-muted bg-transparent p-0! gap-1! text-sm!' } }}
	>
		{#snippet item({ item: row })}
			<a
				class="row"
				href={env.href(row.id)}
				data-testid="list-row"
				data-row-id={row.id}
				onclick={(e) => {
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
					e.preventDefault();
					env.open(row.id, e);
				}}
			>
				{#if row.icon}<span class="icon" aria-hidden="true">{row.icon}</span>{/if}
				<span class="title" class:placeholder={!row.title} data-testid="view-row-title">{row.title || 'Untitled'}</span>
				<CardProps {env} {row} inline />
			</a>
		{/snippet}
		{#snippet empty()}
			<div class="none" data-testid="view-empty">No pages yet</div>
		{/snippet}
	</SortableList>
	{#if data.rows.length < data.total}
		<div bind:this={infinite} class="sentinel"></div>
	{/if}
	<div class="foot">
		{#if env.editable}
			<button type="button" class="add" data-testid="view-add-row" onclick={() => void env.newRow()}>{@render plusIcon({ size: 14 })} New page</button>
		{/if}
		<span class="count" data-testid="view-count">{data.total} {data.total === 1 ? 'page' : 'pages'}</span>
	</div>
</div>

<style>
	.list {
		min-width: 0;
		padding-top: 4px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 34px;
		padding: 0 6px;
		color: var(--app-text);
		text-decoration: none;
		min-width: 0;
		width: 100%;
	}
	.row:hover {
		background: var(--app-hover);
	}
	.icon {
		font-size: 15px;
	}
	.title {
		font-weight: 500;
		white-space: nowrap;
		margin-right: 8px;
	}
	.title.placeholder {
		color: var(--app-text-tertiary);
		font-weight: 400;
	}
	.none {
		padding: 12px 6px;
		color: var(--app-text-secondary);
	}
	.sentinel {
		height: 1px;
	}
	.foot {
		display: flex;
		align-items: center;
		min-height: 34px;
		padding: 0 4px;
		font-size: 13px;
		color: var(--app-text-secondary);
	}
	.add {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 26px;
		padding: 0 8px;
		border-radius: var(--app-radius-control);
		cursor: pointer;
	}
	.add:hover {
		background: var(--app-hover);
		color: var(--app-text);
	}
	.count {
		margin-left: auto;
		font-size: 12px;
	}
</style>
