<script lang="ts">
	import { Popover } from 'entasis/popover';
	import { Command } from 'entasis/command';
	import { Button } from 'entasis/button';
	import { plusIcon } from 'entasis/icons/plus';
	import { caretLeftIcon } from 'entasis/icons/caretLeft';
	import type { PropertyDef, PropertyType } from '#lib/shared/property-types.ts';
	import { CREATABLE_TYPES, suggestName, typeLabel } from './helpers.ts';
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
		/** Every property name in the workspace, for the default name of a new one. */
		names: readonly { name: string }[];
		onCreate: (type: PropertyType, name: string) => void;
		onAttach: (def: PropertyDef) => void;
	} = $props();

	let open = $state(false);
	let search = $state('');
	let step = $state<{ type: PropertyType } | null>(null);
	let name = $state('');

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
		}
	}
	function create(close: () => void) {
		if (!step || !name.trim()) return;
		onCreate(step.type, name.trim());
		close();
	}
</script>

<Popover position="bottom-start" focusOnOpen="first" modal={false} bind:open offset={4}>
	{#snippet trigger(popover)}
		<button
			type="button"
			class="inline-flex w-fit items-center gap-1.5 rounded-[var(--app-radius-control)] px-1.5 text-sm text-[color:var(--app-text-tertiary)] hover:bg-[color:var(--app-hover)] hover:text-[color:var(--app-text-secondary)]"
			style="height: var(--app-button-height)"
			data-testid="add-property"
			aria-label="Add a property"
			{@attach popover.trigger}
		>
			{@render plusIcon({ size: 14 })} Add a property
		</button>
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
				<button type="button" class="flex w-fit items-center gap-1 rounded px-1 text-sm text-[color:var(--app-text-secondary)] hover:bg-[color:var(--app-hover)]" onclick={() => (step = null)}>
					{@render caretLeftIcon({ size: 14 })} New property
				</button>
				<input
					class="rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-page)] px-2 text-sm outline-none focus:border-[color:var(--app-accent)]"
					style="height: var(--app-input-height)"
					aria-label="Property name"
					placeholder="Property name"
					bind:value={name}
					{@attach (el) => {
						el.focus();
						el.select();
					}}
				/>
				<div class="flex items-center gap-1.5 px-1 text-xs text-[color:var(--app-text-tertiary)]">
					{@render icon({ size: 14 })}
					{typeLabel(step.type)}
				</div>
				<Button type="submit" size="small" disabled={!name.trim()}>Create property</Button>
			</form>
		{:else}
			<div class="w-[260px]" data-testid="add-property-menu">
				<Command bind:search {items} shouldFilter={false} autoHighlight="always" placeholder="Search or add a property…" onSelect={(v) => select(v, () => popover.close())} />
			</div>
		{/if}
	{/snippet}
</Popover>
