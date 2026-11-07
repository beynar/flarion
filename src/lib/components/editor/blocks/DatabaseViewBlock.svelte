<!--
	The body of a `database_view` block: a header (the database's icon and title, a view switcher, "Open as page")
	over `ViewHost`, or, while a linked view has no database yet, a picker. The block's data is atomic
	(`collectionId`, `viewId`, `localFilter`), so two people pointing it at different databases never mix.
-->
<script lang="ts">
	import { Button } from 'entasis/button';
	import { tooltip } from 'entasis/tooltip';
	import { Combobox, type ComboboxOption } from 'entasis/combobox';
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

	// ───────────── the picker of a linked view (an entasis Combobox that asks the workspace as the person types) ─────────────
	const databases = async (query: string | undefined, { signal }: { signal: AbortSignal }): Promise<ComboboxOption[]> => {
		const found = (await ctx?.searchDatabases?.(query ?? '')) ?? [];
		if (signal.aborted) return [];
		return found.map((result: DatabaseRef) => ({ value: result.id, label: result.title || 'Untitled', data: { icon: result.icon ?? '▦' } }));
	};

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
				<Button size="small" variant="ghost" onclick={unlink} data-testid="database-unlink" label="Show a different database" {@attach tooltip({ content: 'Show a different database', position: 'top', delay: 400 })}>Change</Button>
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
			<!-- The editor must not see the keys typed in the search. -->
			<div role="presentation" onkeydown={(event) => event.stopPropagation()} data-testid="database-picker-field">
				<Combobox
					items={databases}
					filter={() => true}
					autoHighlight
					openOnFocus
					showAllOnFocus
					size="small"
					placeholder="Link to a database…"
					noOptionsText="No databases found"
					loadingText="Searching…"
					fieldAttrs={{ 'data-testid': 'database-search' } as never}
					onValueChange={({ value }) => value && choose(value)}
				>
					{#snippet item(option: ComboboxOption)}
						<span class="flex items-center gap-2" data-testid="database-result">
							<span aria-hidden="true">{option.data?.icon}</span>
							<span>{option.label}</span>
						</span>
					{/snippet}
				</Combobox>
			</div>
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
	.picker {
		padding: 10px 12px;
		border-radius: 6px;
		background: var(--app-hover);
	}
	.hint {
		color: var(--app-text-secondary);
		font-size: 13px;
		padding: 4px 8px;
		margin: 0;
	}
</style>
