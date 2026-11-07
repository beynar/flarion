<script lang="ts">
	import { tick } from 'svelte';
	import { Command } from 'entasis/command';
	import { Button } from 'entasis/button';
	import { gearSixIcon } from 'entasis/icons/gearSix';
	import { checkIcon } from 'entasis/icons/check';
	import { plusIcon } from 'entasis/icons/plus';
	import OptionTag from '#lib/components/shell/OptionTag.svelte';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import { optionByName, optionColorName, optionsOf, statusGroups } from './helpers.ts';

	/**
	 * The list inside a select, multi-select or status popover: search, the options (status shows its
	 * groups), a "Create" row for text that matches nothing, and a link into the options editor.
	 */
	let {
		def,
		selected,
		canEdit,
		onPick,
		onCreate,
		onEditOptions
	}: {
		def: PropertyDef;
		selected: readonly string[];
		/** May create options and open the options editor. */
		canEdit: boolean;
		/** Toggles an option: the caller sets, adds or removes it. */
		onPick: (id: string) => void;
		onCreate: (name: string) => void;
		onEditOptions: () => void;
	} = $props();

	let search = $state('');
	let root = $state<HTMLElement>();
	const CREATE = '__create__';
	const q = $derived(search.trim().toLowerCase());

	const items = $derived.by(() => {
		const match = (name: string) => !q || name.toLowerCase().includes(q);
		const groups =
			def.type === 'status'
				? statusGroups(def).map((g) => ({ heading: g.name, options: g.options.filter((o) => match(o.name)) }))
				: [{ heading: 'Select an option or create one', options: optionsOf(def).filter((o) => match(o.name)) }];
		const out = groups
			.filter((g) => g.options.length)
			.map((g) => ({ heading: g.heading, items: g.options.map((o) => ({ value: o.id, label: o.name })) }));
		if (canEdit && q && !optionByName(def, search)) {
			out.push({ heading: '', items: [{ value: CREATE, label: `Create "${search.trim()}"` }] });
		}
		return out;
	});

	const byId = $derived(new Map(optionsOf(def).map((o) => [o.id, o])));
</script>

<div class="flex w-[260px] flex-col" data-testid="select-picker" bind:this={root}>
	<Command
		bind:search
		{items}
		shouldFilter={false}
		autoHighlight="always"
		placeholder={def.type === 'status' ? 'Search for a status…' : 'Search or create an option…'}
		onSelect={(value) => {
			if (value === CREATE) {
				onCreate(search.trim());
				search = '';
				// Keep typing: the list re-renders around the new option.
				void tick().then(() => root?.querySelector('input')?.focus());
			} else onPick(value);
		}}
	>
		{#snippet item(it)}
			{#if it.value === CREATE}
				<span class="flex items-center gap-2 text-sm">
					{@render plusIcon({ size: 14 })}
					<span class="truncate">{it.label}</span>
				</span>
			{:else}
				{@const o = byId.get(it.value)}
				<span class="flex w-full min-w-0 items-center gap-2" data-testid="select-option" data-option-id={it.value}>
					<span class="min-w-0 flex-1">
						<OptionTag color={optionColorName(o?.color)} label={it.label} />
					</span>
					{#if selected.includes(it.value)}
						<span class="text-[color:var(--app-text-secondary)]" aria-label="Selected">{@render checkIcon({ size: 14 })}</span>
					{/if}
				</span>
			{/if}
		{/snippet}
		{#snippet empty()}
			<div class="px-3 py-4 text-center text-sm text-[color:var(--app-text-tertiary)]">
				{canEdit ? 'Type to create an option.' : 'No options.'}
			</div>
		{/snippet}
		{#snippet footer()}
			{#if canEdit}
				<div class="border-t border-[color:var(--app-hairline)] p-1">
					<Button variant="ghost" color="neutral" size="small" fullWidth prefix={gearSixIcon} class="justify-start font-normal text-[color:var(--app-text-secondary)]" data-testid="edit-options" onclick={onEditOptions}>Edit options</Button>
				</div>
			{/if}
		{/snippet}
	</Command>
</div>
