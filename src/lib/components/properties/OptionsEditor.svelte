<script lang="ts">
	import { Button } from 'entasis/button';
	import { Collapsible } from 'entasis/collapsible';
	import { TextInput } from 'entasis/text-input';
	import { tooltip } from 'entasis/tooltip';
	import { plusIcon } from 'entasis/icons/plus';
	import { trashIcon } from 'entasis/icons/trash';
	import { caretLeftIcon } from 'entasis/icons/caretLeft';
	import { checkIcon } from 'entasis/icons/check';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import {
		OPTION_COLORS,
		configWithOption,
		configWithOptionChanged,
		configWithoutOption,
		makeOption,
		optionColorLabel,
		optionColorName,
		optionsOf,
		statusGroups,
		type OptionColor
	} from './helpers.ts';

	/**
	 * Create, rename, recolor and delete the options of a select, multi-select or status property.
	 * Every change hands the whole new config to `onConfig` (one `updateProperty`).
	 */
	let {
		def,
		onConfig,
		onBack
	}: {
		def: PropertyDef;
		onConfig: (config: Record<string, unknown>) => void;
		onBack: () => void;
	} = $props();

	let openId = $state<string | null>(null);
	let draft = $state('');
	let newName = $state('');

	const options = $derived(optionsOf(def));
	const groups = $derived(def.type === 'status' ? statusGroups(def) : [{ id: '', name: '', options }]);

	function rename(id: string, name: string, original: string) {
		const t = name.trim();
		if (!t || t === original) return;
		onConfig(configWithOptionChanged(def, id, { name: t.slice(0, 100) }));
	}
	function add(groupId?: string) {
		const o = makeOption(def, newName);
		if (!o) return;
		onConfig(configWithOption(def, o, groupId));
		newName = '';
	}
</script>

<div class="flex w-[280px] flex-col" data-testid="options-editor">
	<div class="flex items-center gap-1 border-b border-[color:var(--app-hairline)] px-1" style="height: var(--app-row-height)">
		<Button variant="ghost" color="neutral" size="small" label="Back to options" prefix={caretLeftIcon} onclick={onBack} />
		<span class="text-sm font-medium">Edit options</span>
	</div>

	<div class="max-h-[320px] overflow-y-auto py-1">
		{#each groups as group (group.id)}
			{#if group.name}
				<div class="px-3 pt-2 pb-1 text-xs text-[color:var(--app-text-tertiary)]">{group.name}</div>
			{/if}
			{#each group.options as o (o.id)}
				<div data-testid="option-row" data-option-id={o.id}>
					<Collapsible
						open={openId === o.id}
						onOpenChange={(next) => {
							openId = next ? o.id : null;
							draft = o.name;
						}}
						theme={{
							trigger: { base: 'h-[var(--app-row-height)] w-full rounded-none px-3 text-sm font-normal hover:bg-[color:var(--app-hover)]' },
							content: { base: 'p-0' }
						}}
					>
						{#snippet trigger()}
							<span class="flex min-w-0 flex-1 items-center gap-2 text-left" aria-label={`Edit option ${o.name}`}>
								<span
									class="size-3 shrink-0 rounded-full"
									style="background: var(--app-option-{optionColorName(o.color)}-bg); box-shadow: inset 0 0 0 1px var(--app-option-{optionColorName(o.color)}-fg)"
								></span>
								<span class="truncate">{o.name}</span>
							</span>
						{/snippet}
						{#snippet children()}
							<div class="flex flex-col gap-2 border-y border-[color:var(--app-hairline)] bg-[color:var(--app-hover)] px-3 py-2">
								<TextInput
									size="small"
									bind:value={draft}
									inputAttrs={{
										'aria-label': 'Option name',
										onblur: () => rename(o.id, draft, o.name),
										onkeydown: (e) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												rename(o.id, draft, o.name);
											}
										}
									}}
								/>
								<!-- Exception (audit NE-4): the nine Notion option colors have no entasis picker
								     (Chip/TagGroup take 7 semantic colors, ColorPicker is free-form), so the swatch row stays custom. -->
								<div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Color">
									{#each OPTION_COLORS as c (c)}
										{@const name = optionColorName(c)}
										{#if c !== 'default'}
											<button
												type="button"
												role="radio"
												aria-checked={optionColorName(o.color) === name}
												aria-label={optionColorLabel(c)}
												class="grid size-6 place-items-center rounded-full"
												style="background: var(--app-option-{name}-bg); color: var(--app-option-{name}-fg); box-shadow: inset 0 0 0 1px var(--app-option-{name}-fg)"
												{@attach tooltip({ content: optionColorLabel(c), position: 'top' })}
												onclick={() => onConfig(configWithOptionChanged(def, o.id, { color: c as OptionColor }))}
											>
												{#if optionColorName(o.color) === name}{@render checkIcon({ size: 12 })}{/if}
											</button>
										{/if}
									{/each}
								</div>
								<Button
									variant="ghost"
									color="danger"
									size="small"
									class="w-fit"
									prefix={trashIcon}
									data-testid="delete-option"
									onclick={() => {
										openId = null;
										onConfig(configWithoutOption(def, o.id));
									}}
								>
									Delete option
								</Button>
							</div>
						{/snippet}
					</Collapsible>
				</div>
			{/each}
		{/each}
		{#if !options.length}
			<div class="px-3 py-3 text-sm text-[color:var(--app-text-tertiary)]">No options yet.</div>
		{/if}
	</div>

	<form
		class="flex items-center gap-1 border-t border-[color:var(--app-hairline)] p-2"
		onsubmit={(e) => {
			e.preventDefault();
			add();
		}}
	>
		<div class="min-w-0 flex-1">
			<TextInput size="small" placeholder="Add an option…" bind:value={newName} inputAttrs={{ 'aria-label': 'Add an option' }} />
		</div>
		<Button type="submit" variant="ghost" color="neutral" size="small" label="Add option" prefix={plusIcon} disabled={!newName.trim()} />
	</form>
</div>
