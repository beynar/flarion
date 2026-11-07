<script lang="ts">
	import { Command } from 'entasis/command';
	import { Avatar } from 'entasis/avatar';
	import { checkIcon } from 'entasis/icons/check';
	import type { Member } from '#lib/shared/schemas.ts';

	/** A searchable list of workspace members (guests included) to toggle on a person property. */
	let {
		members,
		selected,
		onPick
	}: {
		members: readonly Member[];
		selected: readonly string[];
		onPick: (userId: string) => void;
	} = $props();

	let search = $state('');
	const q = $derived(search.trim().toLowerCase());
	const items = $derived([
		{
			heading: 'Select a person',
			items: members
				.filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().startsWith(q))
				.map((m) => ({ value: m.userId, label: m.name, description: m.email }))
		}
	]);
	const byId = $derived(new Map(members.map((m) => [m.userId, m])));
</script>

<div class="w-[260px]" data-testid="person-picker">
	<Command bind:search {items} shouldFilter={false} autoHighlight="always" placeholder="Search for a person…" onSelect={(v) => onPick(v)}>
		{#snippet item(it)}
			<span class="flex w-full min-w-0 items-center gap-2" data-testid="person-option" data-user-id={it.value}>
				<Avatar size="small" name={byId.get(it.value)?.name ?? it.label} />
				<span class="min-w-0 flex-1 truncate text-sm">{it.label}</span>
				{#if selected.includes(it.value)}
					<span class="text-[color:var(--app-text-secondary)]" aria-label="Selected">{@render checkIcon({ size: 14 })}</span>
				{/if}
			</span>
		{/snippet}
		{#snippet empty()}
			<div class="px-3 py-4 text-center text-sm text-[color:var(--app-text-tertiary)]">No one found.</div>
		{/snippet}
	</Command>
</div>
