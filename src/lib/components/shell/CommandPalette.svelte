<script lang="ts">
	import { Command } from 'entasis/command';
	import { fileTextIcon } from 'entasis/icons/fileText';
	import { plusIcon } from 'entasis/icons/plus';
	import { sidebarSimpleIcon } from 'entasis/icons/sidebarSimple';
	import { moonIcon } from 'entasis/icons/moon';
	import { trashIcon } from 'entasis/icons/trash';
	import { gearIcon } from 'entasis/icons/gear';
	import { commandItems } from '#lib/client/mock.ts';

	let {
		open = $bindable(false),
		onAction
	}: {
		open?: boolean;
		/** Called with the item value for entries that are not plain links. */
		onAction?: (value: string) => void;
	} = $props();

	const icons = {
		'action:new-page': plusIcon,
		'action:toggle-sidebar': sidebarSimpleIcon,
		'action:toggle-dark': moonIcon,
		'action:trash': trashIcon,
		'action:settings': gearIcon
	} as const;

	const items = commandItems.map((group) => ({
		heading: group.heading,
		items: group.items.map((item) => ({
			...item,
			icon: icons[item.value as keyof typeof icons] ?? fileTextIcon,
			keywords: [group.heading]
		}))
	}));
</script>

<!-- ⌘K is handled by the Command itself (`shortcut`). P0 shell: items are mock data. -->
<Command
	dialog
	shortcut="k"
	bind:open
	{items}
	placeholder="Search pages and actions…"
	onSelect={(value) => onAction?.(value)}
>
	{#snippet footer()}
		<div
			class="flex items-center gap-4 border-t border-[color:var(--app-hairline)] px-3 py-2 text-xs text-[color:var(--app-text-tertiary)]"
		>
			<span>↑↓ Navigate</span>
			<span>↵ Open</span>
			<span>Esc Close</span>
		</div>
	{/snippet}
</Command>
