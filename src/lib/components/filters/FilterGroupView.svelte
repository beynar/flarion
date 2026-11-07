<script lang="ts">
	import { Select } from 'entasis/select';
	import { Button } from 'entasis/button';
	import { Tooltip } from 'entasis/tooltip';
	import { plusIcon } from 'entasis/icons/plus';
	import { trashIcon } from 'entasis/icons/trash';
	import type { FilterGroup } from '#lib/shared/filter-ast.ts';
	import { isGroup } from '#lib/shared/filter-ast.ts';
	import type { BuilderApi } from './api.ts';
	import FilterConditionRow from './FilterConditionRow.svelte';
	import FilterGroupView from './FilterGroupView.svelte';
	import {
		canAddGroup,
		childrenOf,
		defaultCondition,
		insertAt,
		kindOf,
		removeAt,
		setGroupKind,
		type GroupKind,
		type Path
	} from './logic.ts';

	/**
	 * A group of conditions as Notion's advanced filter draws it: "Where" on the first row, the And/Or choice
	 * on the second (it sets the whole group), nested groups in a bordered box, and add buttons underneath.
	 */
	let { group, path, api }: { group: FilterGroup; path: Path; api: BuilderApi } = $props();

	const kind = $derived(kindOf(group));
	const kids = $derived(childrenOf(group));
	const nested = $derived(path.length > 0);
	const KINDS = [
		{ value: 'and', label: 'And' },
		{ value: 'or', label: 'Or' }
	];

	function addCondition() {
		const first = api.filterable[0];
		if (!first) return;
		api.edit((root) => insertAt(root, path, defaultCondition(first)));
	}
	function addGroup() {
		const first = api.filterable[0];
		if (!first) return;
		api.edit((root) => insertAt(root, path, { and: [defaultCondition(first)] }));
	}
</script>

<div
	class="flex flex-col gap-1.5 {nested ? 'rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline)] bg-[color:var(--app-hover)] p-2' : ''}"
	data-testid="filter-group"
	data-level={path.length + 1}
	data-kind={kind}
>
	{#each kids as child, i (i)}
		<div class="flex min-w-0 items-start gap-2">
			<div class="flex shrink-0 items-center text-sm text-[color:var(--app-text-secondary)]" style="width: 76px; height: var(--app-button-height)">
				{#if i === 0}
					<span>Where</span>
				{:else if i === 1 && !api.readonly}
					<Select
						size="small"
						class="w-full"
						items={KINDS}
						value={kind}
						alignItemWithTrigger={false}
						triggerAttrs={{ 'aria-label': 'Group operator', 'data-testid': 'filter-group-kind' }}
						onValueChange={(v) => v && api.edit((root) => setGroupKind(root, path, v as GroupKind))}
					/>
				{:else}
					<span>{kind === 'and' ? 'And' : 'Or'}</span>
				{/if}
			</div>
			{#if isGroup(child)}
				<div class="min-w-0 flex-1">
					<FilterGroupView group={child} path={[...path, i]} {api} />
				</div>
			{:else}
				<FilterConditionRow condition={child} path={[...path, i]} {api} />
			{/if}
		</div>
	{/each}

	{#if !api.readonly}
		<div class="flex flex-wrap items-center gap-x-1">
			<Button variant="ghost" size="small" prefix={plusIcon} data-testid="filter-add-condition" disabled={!api.filterable.length} onclick={addCondition}>Add filter rule</Button>
			<Tooltip content="Groups nest up to three levels" disabled={canAddGroup(path)}>
				{#snippet trigger(tip)}
					<Button
						variant="ghost"
						size="small"
						prefix={plusIcon}
						data-testid="filter-add-group"
						disabled={!canAddGroup(path) || !api.filterable.length}
						focusableWhenDisabled
						onclick={addGroup}
						{@attach tip}>Add filter group</Button
					>
				{/snippet}
			</Tooltip>
			{#if nested}
				<span class="flex-1"></span>
				<Button variant="ghost" size="small" color="danger" prefix={trashIcon} data-testid="filter-remove-group" onclick={() => api.edit((root) => removeAt(root, path))}>Delete group</Button>
			{/if}
		</div>
	{/if}
</div>
