<!--
	The body of a `database_view` block: a header (the database's icon and title, a view switcher, "Open as page")
	over `ViewHost`, or, while a linked view has no database yet, a picker. The block's data is atomic
	(`collectionId`, `viewId`, `localFilter`), so two people pointing it at different databases never mix.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { BlockView } from 'edytor';
	import ViewHost from '#lib/components/views/ViewHost.svelte';
	import type { FilterGroup } from '#lib/shared/filter-ast.ts';
	import { getEditorContext, type DatabaseRef } from '../context.ts';

	let { block }: { block: BlockView } = $props();

	const edytorOf = () => block.handle?.edytor;

	const ctx = getEditorContext();
	const data = $derived(block.data as { collectionId?: string | null; viewId?: string | null; localFilter?: FilterGroup | null });
	const collectionId = $derived(data.collectionId ?? null);
	const viewId = $derived(data.viewId ?? null);
	const readonly = $derived(!!ctx?.readonly() || (block.handle?.edytor.readonly ?? false));
	// A database page's collection has the page's id: its title and icon come from the page.
	const page = $derived(collectionId ? ctx?.resolvePage?.(collectionId) : undefined);

	// ───────────── the picker of a linked view ─────────────
	let query = $state('');
	let results = $state<DatabaseRef[]>([]);
	let searching = $state(false);
	const search = async (q: string) => {
		searching = true;
		try {
			const found = (await ctx?.searchDatabases?.(q)) ?? [];
			if (q === untrack(() => query)) results = found;
		} finally {
			searching = false;
		}
	};
	$effect(() => {
		if (collectionId) return;
		void search(query);
	});

	function choose(id: string) {
		if (readonly) return;
		edytorOf()?.patchData(block.id, [
			{ path: ['collectionId'], value: id },
			{ path: ['viewId'], value: null }
		]);
	}

	function unlink() {
		if (readonly) return;
		edytorOf()?.patchData(block.id, [
			{ path: ['collectionId'], value: null },
			{ path: ['viewId'], value: null }
		]);
	}

	// ───────────── the view switcher (the host's tab bar) ─────────────
	const pickView = (id: string) => {
		if (readonly) return;
		edytorOf()?.patchData(block.id, [{ path: ['viewId'], value: id }]);
	};

	const open = (event: MouseEvent) => {
		if (!collectionId || !ctx?.open) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		ctx.open(collectionId, { newTab: false });
	};
</script>

{#if collectionId && ctx}
	<div class="db" data-testid="database-view" data-collection={collectionId}>
		<div class="head">
			<a class="name" href={ctx.href(collectionId)} onclick={open} data-testid="database-title">
				{#if page?.icon}<span aria-hidden="true">{page.icon}</span>{:else}<span aria-hidden="true">▦</span>{/if}
				<span>{page ? page.title || 'Untitled' : 'Database'}</span>
			</a>
			<span class="spacer"></span>
			{#if !readonly}
				<button type="button" class="link" onclick={unlink} data-testid="database-unlink" title="Show a different database">Change</button>
			{/if}
		</div>
		<ViewHost
			workspaceId={ctx.workspaceId}
			{collectionId}
			{viewId}
			localFilter={data.localFilter ?? null}
			{readonly}
			href={ctx.href}
			onViewChange={pickView}
		/>
	</div>
{:else}
	<div class="db picker" data-testid="database-picker">
		<div class="head"><span aria-hidden="true">▦</span><strong>Linked view of database</strong></div>
		{#if readonly}
			<p class="hint">No database is linked here yet.</p>
		{:else}
			<input
				class="search"
				placeholder="Link to a database…"
				aria-label="Search databases"
				data-testid="database-search"
				bind:value={query}
				onkeydown={(event) => event.stopPropagation()}
			/>
			<ul class="results" data-testid="database-results">
				{#each results as result (result.id)}
					<li>
						<button type="button" data-testid="database-result" onclick={() => choose(result.id)}>
							<span aria-hidden="true">{result.icon ?? '▦'}</span>
							<span>{result.title || 'Untitled'}</span>
						</button>
					</li>
				{:else}
					<li class="hint">{searching ? 'Searching…' : 'No databases found'}</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<style>
	.db {
		margin: 6px 0;
		font-family: var(--app-font-sans, inherit);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 2px 4px 6px;
		font-size: 14px;
	}
	.name {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		color: var(--app-text);
		text-decoration: none;
	}
	.name:hover {
		text-decoration: underline;
	}
	.spacer {
		flex: 1;
	}
	.link {
		font-size: 12px;
		color: var(--app-text-secondary);
		cursor: pointer;
	}
	.link:hover {
		color: var(--app-text);
	}
	.picker {
		padding: 10px 12px;
		border-radius: 6px;
		background: var(--app-hover);
	}
	.search {
		width: 100%;
		box-sizing: border-box;
		padding: 6px 8px;
		border: 1px solid var(--app-hairline-strong);
		border-radius: var(--app-radius-control);
		background: var(--app-page);
		color: var(--app-text);
		font-size: 14px;
	}
	.results {
		margin: 6px 0 0;
		padding: 0;
		list-style: none;
		max-height: 200px;
		overflow: auto;
	}
	.results button {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 5px 8px;
		text-align: left;
		border-radius: var(--app-radius-control);
		cursor: pointer;
	}
	.results button:hover {
		background: var(--app-page);
	}
	.hint {
		color: var(--app-text-secondary);
		font-size: 13px;
		padding: 4px 8px;
		margin: 0;
	}
</style>
