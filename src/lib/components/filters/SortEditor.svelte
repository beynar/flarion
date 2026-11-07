<script lang="ts">
	import { Select } from 'entasis/select';
	import { Button } from 'entasis/button';
	import { Tooltip } from 'entasis/tooltip';
	import { plusIcon } from 'entasis/icons/plus';
	import { trashIcon } from 'entasis/icons/trash';
	import { xIcon } from 'entasis/icons/x';
	import { MAX_SORTS, type SortSpec } from '#lib/shared/filter-ast.ts';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import { sortableProps } from './logic.ts';

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
	/** A row's property choices: its own, then the ones no other row sorts by. */
	const propItems = (current: string) => [{ value: current, label: nameOf(current) }, ...unused.map((d) => ({ value: d.id, label: d.name }))];
	const DIRS = [
		{ value: 'asc', label: 'Ascending' },
		{ value: 'desc', label: 'Descending' }
	];

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
			<Select
				size="small"
				class="min-w-0 flex-1"
				items={propItems(sort.prop)}
				value={sort.prop}
				disabled={readonly}
				alignItemWithTrigger={false}
				triggerAttrs={{ 'aria-label': 'Sort property', 'data-testid': 'sort-prop' }}
				onValueChange={(v) => v && replace(i, { prop: v })}
			/>
			<Select
				size="small"
				class="w-[128px]"
				items={DIRS}
				value={sort.dir}
				disabled={readonly}
				alignItemWithTrigger={false}
				triggerAttrs={{ 'aria-label': 'Sort direction', 'data-testid': 'sort-dir' }}
				onValueChange={(v) => v && replace(i, { dir: v as 'asc' | 'desc' })}
			/>
			{#if !readonly}
				<Button variant="ghost" size="small" squared label="Remove sort" prefix={xIcon} data-testid="sort-remove" onclick={() => onChange(sorts.filter((_, j) => j !== i))} />
			{/if}
		</div>
	{/each}
	{#if !readonly}
		<div class="flex items-center gap-1 {sorts.length ? 'border-t border-[color:var(--app-hairline)] pt-1.5' : ''}">
			<Tooltip content={`A view sorts by at most ${MAX_SORTS} properties`} disabled={sorts.length < MAX_SORTS}>
				{#snippet trigger(tip)}
					<Button variant="ghost" size="small" prefix={plusIcon} data-testid="sort-add" disabled={sorts.length >= MAX_SORTS || unused.length === 0} focusableWhenDisabled onclick={add} {@attach tip}>Add sort</Button>
				{/snippet}
			</Tooltip>
			{#if sorts.length}
				<span class="flex-1"></span>
				<Button variant="ghost" size="small" color="danger" prefix={trashIcon} data-testid="sort-clear" onclick={() => onChange([])}>Delete sort</Button>
			{/if}
		</div>
	{/if}
</div>
