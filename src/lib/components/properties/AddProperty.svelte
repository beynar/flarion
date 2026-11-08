<script lang="ts">
	import { Popover } from 'entasis/popover';
	import { Command } from 'entasis/command';
	import { Button } from 'entasis/button';
	import { TextInput } from 'entasis/text-input';
	import { focusInput } from '#lib/components/pickers/focus.ts';
	import { plusIcon } from 'entasis/icons/plus';
	import { caretLeftIcon } from 'entasis/icons/caretLeft';
	import type { PropertyDef, PropertyType } from '#lib/shared/property-types.ts';
	import AiConfigForm from './AiConfigForm.svelte';
	import { CREATABLE_TYPES, aiConfigValid, aiSourceCandidates, defaultAiConfig, normalizeAiConfig, suggestName, typeLabel, type AiConfig } from './helpers.ts';
	import { TYPE_ICONS } from './icons.ts';

	/**
	 * "Add a property": pick a type (then name it) or attach an existing workspace property that this
	 * page does not show yet. The registry is workspace-wide, so "existing" are the other properties.
	 */
	let {
		existing,
		names,
		onCreate,
		onAttach
	}: {
		/** Registry properties not shown on this page. */
		existing: readonly PropertyDef[];
		/** Every property in the workspace: the default name of a new one, and the sources an AI property can read. */
		names: readonly Pick<PropertyDef, 'id' | 'name' | 'type'>[];
		/** `config` is set for types that ask for one (AI); the others start from their defaults. */
		onCreate: (type: PropertyType, name: string, config?: Record<string, unknown>) => void;
		onAttach: (def: PropertyDef) => void;
	} = $props();

	let open = $state(false);
	let search = $state('');
	let step = $state<{ type: PropertyType } | null>(null);
	let name = $state('');
	let aiConfig = $state<AiConfig>(defaultAiConfig());
	const canCreate = $derived(!!name.trim() && (step?.type !== 'ai' || aiConfigValid(aiConfig)));

	$effect(() => {
		if (!open) {
			step = null;
			search = '';
		}
	});

	const q = $derived(search.trim().toLowerCase());
	const items = $derived.by(() => {
		const out: { heading: string; items: { value: string; label: string; icon: (typeof TYPE_ICONS)[PropertyType] }[] }[] = [];
		const ex = existing.filter((d) => !q || d.name.toLowerCase().includes(q));
		if (ex.length) out.push({ heading: 'Existing properties', items: ex.map((d) => ({ value: `existing:${d.id}`, label: d.name, icon: TYPE_ICONS[d.type] })) });
		const types = CREATABLE_TYPES.filter((t) => !q || typeLabel(t).toLowerCase().includes(q));
		if (types.length) out.push({ heading: 'New property', items: types.map((t) => ({ value: `type:${t}`, label: typeLabel(t), icon: TYPE_ICONS[t] })) });
		return out;
	});

	function select(value: string, close: () => void) {
		if (value.startsWith('existing:')) {
			const d = existing.find((x) => x.id === value.slice(9));
			if (d) onAttach(d);
			close();
		} else {
			const type = value.slice(5) as PropertyType;
			step = { type };
			name = suggestName(type, names);
			aiConfig = defaultAiConfig();
		}
	}
	function create(close: () => void) {
		if (!step || !canCreate) return;
		onCreate(step.type, name.trim(), step.type === 'ai' ? normalizeAiConfig(aiConfig) : undefined);
		close();
	}
</script>

<Popover position="bottom-start" focusOnOpen="first" modal={false} bind:open offset={4}>
	{#snippet trigger(popover)}
		<Button
			variant="ghost"
			color="neutral"
			size="small"
			class="font-normal text-[color:var(--app-text-tertiary)]"
			prefix={plusIcon}
			data-testid="add-property"
			label="Add a property"
			{@attach popover.trigger}
		>
			Add a property
		</Button>
	{/snippet}
	{#snippet children(popover)}
		{#if step}
			{@const icon = TYPE_ICONS[step.type]}
			<form
				class="flex w-[260px] flex-col gap-2 p-2"
				data-testid="new-property-form"
				onsubmit={(e) => {
					e.preventDefault();
					create(() => popover.close());
				}}
			>
				<Button type="button" variant="ghost" color="neutral" size="small" class="w-fit" prefix={caretLeftIcon} onclick={() => (step = null)}>New property</Button>
				<div {@attach focusInput}>
					<TextInput size="small" placeholder="Property name" bind:value={name} inputAttrs={{ 'aria-label': 'Property name' }} />
				</div>
				<div class="flex items-center gap-1.5 px-1 text-xs text-[color:var(--app-text-tertiary)]">
					{@render icon({ size: 14 })}
					{typeLabel(step.type)}
				</div>
				{#if step.type === 'ai'}
					<AiConfigForm config={aiConfig} candidates={aiSourceCandidates(names)} onChange={(c) => (aiConfig = c)} />
				{/if}
				<Button type="submit" size="small" disabled={!canCreate}>Create property</Button>
			</form>
		{:else}
			<div class="w-[260px]" data-testid="add-property-menu">
				<Command bind:search {items} shouldFilter={false} autoHighlight="always" placeholder="Search or add a property…" onSelect={(v) => select(v, () => popover.close())} />
			</div>
		{/if}
	{/snippet}
</Popover>
