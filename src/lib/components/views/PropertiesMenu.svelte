<!--
	"Properties" of a view: which columns it shows, in which order. Visible properties drag to reorder (entasis
	Sortable list) and hide with the eye; the rest of the registry is listed below and shows with one click.
-->
<script lang="ts">
	import { SortableList } from 'entasis/sortable-list';
	import { eyeIcon } from 'entasis/icons/eye';
	import { eyeSlashIcon } from 'entasis/icons/eyeSlash';
	import { TYPE_ICONS } from '#lib/components/properties/icons.ts';
	import { TITLE_PROP_ID, type PropertyDef } from '#lib/shared/property-types.ts';
	import type { ViewEnv } from './env.ts';
	import { allColumns, columnsFromEntries, withColumnShown } from './view-model.ts';

	let { env }: { env: ViewEnv } = $props();

	let query = $state('');
	const entries = $derived(allColumns(env.view, env.collection, env.properties));
	const q = $derived(query.trim().toLowerCase());
	const match = (d: PropertyDef) => !q || d.name.toLowerCase().includes(q);
	const visible = $derived(entries.filter((e) => !e.hidden && e.def.id !== TITLE_PROP_ID && match(e.def)));
	const hidden = $derived(entries.filter((e) => e.hidden && match(e.def)));
	const title = $derived(entries.find((e) => e.def.id === TITLE_PROP_ID));

	const widths = $derived(Object.fromEntries(env.view.columns.columns.filter((c) => c.width).map((c) => [c.prop, c.width!])));
	const save = (list: { def: PropertyDef; hidden: boolean }[]) =>
		env.updateView({ columns: { columns: columnsFromEntries(list, widths), options: env.view.columns.options } }).catch(() => undefined);

	// The list the user drags: a local copy, rewritten when the view's columns change.
	let order = $state.raw<{ id: string; def: PropertyDef }[]>([]);
	$effect(() => {
		order = visible.map((e) => ({ id: e.def.id, def: e.def }));
	});

	function reordered(items: { id: string; def: PropertyDef }[]) {
		const rest = entries.filter((e) => e.def.id === TITLE_PROP_ID || e.hidden);
		const head = title ? [title] : [];
		const byId = new Map(entries.map((e) => [e.def.id, e]));
		void save([...head, ...items.map((i) => byId.get(i.id)!), ...rest.filter((e) => e.def.id !== TITLE_PROP_ID)]);
	}

	const toggle = (id: string, show: boolean) =>
		env.updateView({ columns: { columns: withColumnShown(env.view, env.collection, env.properties, id, show), options: env.view.columns.options } }).catch(() => undefined);
</script>

<div class="menu" data-testid="properties-menu">
	<input class="search" placeholder="Search for a property…" aria-label="Search properties" bind:value={query} />
	<div class="heading">Shown in table</div>
	{#if title && match(title.def)}
		<div class="row locked">
			<span class="icon">{@render TYPE_ICONS.title({ size: 16 })}</span>
			<span class="name">{title.def.name}</span>
		</div>
	{/if}
	<SortableList
		items={order}
		handle={true}
		size="small"
		onReorder={({ items }) => reordered(items)}
		disabled={!env.editable || !!q}
		theme={{ root: { base: 'm-0 flex list-none flex-col p-0 gap-0' }, item: { base: 'relative flex items-center text-neutral outline-none rounded-none border-0 bg-transparent p-0! gap-1! text-sm!' } }}
	>
		{#snippet item({ item })}
			<div class="row" data-testid="properties-visible" data-prop={item.id}>
				<span class="icon">{@render TYPE_ICONS[item.def.type]({ size: 16 })}</span>
				<span class="name">{item.def.name}</span>
				<button type="button" class="eye" aria-label="Hide {item.def.name}" disabled={!env.editable} onclick={() => void toggle(item.id, false)}>
					{@render eyeIcon({ size: 16 })}
				</button>
			</div>
		{/snippet}
	</SortableList>
	{#if hidden.length}
		<div class="heading">Hidden</div>
		{#each hidden as entry (entry.def.id)}
			<div class="row" data-testid="properties-hidden" data-prop={entry.def.id}>
				<span class="icon">{@render TYPE_ICONS[entry.def.type]({ size: 16 })}</span>
				<span class="name dim">{entry.def.name}</span>
				<button type="button" class="eye" aria-label="Show {entry.def.name}" disabled={!env.editable} onclick={() => void toggle(entry.def.id, true)}>
					{@render eyeSlashIcon({ size: 16 })}
				</button>
			</div>
		{/each}
	{/if}
</div>

<style>
	.menu {
		display: flex;
		flex-direction: column;
		width: 280px;
		max-height: 420px;
		overflow: auto;
		padding: 6px;
	}
	.search {
		height: var(--app-input-height);
		padding: 0 8px;
		margin-bottom: 4px;
		border: 1px solid var(--app-hairline-strong);
		border-radius: var(--app-radius-control);
		background: var(--app-page);
		color: var(--app-text);
		outline: none;
	}
	.search:focus {
		border-color: var(--app-accent);
	}
	.heading {
		padding: 6px 6px 2px;
		font-size: 12px;
		color: var(--app-text-tertiary);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		height: var(--app-row-height);
		padding: 0 6px;
		border-radius: var(--app-radius-control);
		width: 100%;
	}
	.row:hover {
		background: var(--app-hover);
	}
	.icon {
		display: inline-flex;
		color: var(--app-text-secondary);
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name.dim {
		color: var(--app-text-secondary);
	}
	.locked {
		opacity: 0.7;
	}
	.eye {
		display: inline-flex;
		padding: 2px;
		border-radius: 4px;
		color: var(--app-text-secondary);
		cursor: pointer;
	}
	.eye:hover:not(:disabled) {
		background: var(--app-hover);
		color: var(--app-text);
	}
</style>
