<script lang="ts">
	import { plusIcon } from 'entasis/icons/plus';
	import { trashIcon } from 'entasis/icons/trash';
	import { xIcon } from 'entasis/icons/x';
	import { MAX_SORTS, type SortSpec } from '#lib/shared/filter-ast.ts';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import { sortableProps } from './logic.ts';
	import { controlClass, ghostButtonClass, iconButtonClass } from './styles.ts';

	/** The multi-key sort list of a view: a property and a direction per row, at most five, no property twice. */
	let {
		sorts,
		properties,
		readonly = false,
		onChange
	}: {
		sorts: SortSpec[];
		properties: PropertyDef[];
		readonly?: boolean;
		onChange: (sorts: SortSpec[]) => void;
	} = $props();

	const sortable = $derived(sortableProps(properties));
	const unused = $derived(sortable.filter((d) => !sorts.some((s) => s.prop === d.id)));
	const nameOf = (id: string) => properties.find((p) => p.id === id)?.name ?? 'Unknown property';

	const replace = (i: number, patch: Partial<SortSpec>) => onChange(sorts.map((s, j) => (j === i ? { ...s, ...patch } : s)));
	const add = () => {
		const first = unused[0];
		if (first) onChange([...sorts, { prop: first.id, dir: 'asc' }]);
	};
</script>

<div class="flex min-w-[320px] flex-col gap-1.5 p-3" data-testid="sort-editor">
	{#if sorts.length === 0}
		<p class="px-0.5 text-sm text-[color:var(--app-text-tertiary)]">No sorting. Rows follow their manual order.</p>
	{/if}
	{#each sorts as sort, i (sort.prop)}
		<div class="flex items-center gap-1" data-testid="sort-row" data-prop={sort.prop}>
			<select
				class="{controlClass} min-w-0 flex-1"
				aria-label="Sort property"
				data-testid="sort-prop"
				disabled={readonly}
				value={sort.prop}
				onchange={(e) => replace(i, { prop: e.currentTarget.value })}
			>
				<option value={sort.prop}>{nameOf(sort.prop)}</option>
				{#each unused as d (d.id)}
					<option value={d.id}>{d.name}</option>
				{/each}
			</select>
			<select
				class="{controlClass} w-[116px]"
				aria-label="Sort direction"
				data-testid="sort-dir"
				disabled={readonly}
				value={sort.dir}
				onchange={(e) => replace(i, { dir: e.currentTarget.value as 'asc' | 'desc' })}
			>
				<option value="asc">Ascending</option>
				<option value="desc">Descending</option>
			</select>
			{#if !readonly}
				<button type="button" class={iconButtonClass} aria-label="Remove sort" data-testid="sort-remove" onclick={() => onChange(sorts.filter((_, j) => j !== i))}>
					{@render xIcon({ size: 14 })}
				</button>
			{/if}
		</div>
	{/each}
	{#if !readonly}
		<div class="flex items-center gap-1 {sorts.length ? 'border-t border-[color:var(--app-hairline)] pt-1.5' : ''}">
			<button
				type="button"
				class={ghostButtonClass}
				data-testid="sort-add"
				disabled={sorts.length >= MAX_SORTS || unused.length === 0}
				title={sorts.length >= MAX_SORTS ? `A view sorts by at most ${MAX_SORTS} properties` : undefined}
				onclick={add}
			>
				{@render plusIcon({ size: 14 })} Add sort
			</button>
			{#if sorts.length}
				<span class="flex-1"></span>
				<button type="button" class="{ghostButtonClass} hover:text-[color:var(--app-danger)]" data-testid="sort-clear" onclick={() => onChange([])}>
					{@render trashIcon({ size: 14 })} Delete sort
				</button>
			{/if}
		</div>
	{/if}
</div>
