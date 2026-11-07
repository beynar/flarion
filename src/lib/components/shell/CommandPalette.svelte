<script lang="ts">
	import { Command } from 'entasis/command';
	import { fileTextIcon } from 'entasis/icons/fileText';
	import { plusIcon } from 'entasis/icons/plus';
	import { sidebarSimpleIcon } from 'entasis/icons/sidebarSimple';
	import { moonIcon } from 'entasis/icons/moon';
	import { trashIcon } from 'entasis/icons/trash';
	import { gearIcon } from 'entasis/icons/gear';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';

	let {
		open = $bindable(false),
		store,
		ws,
		onAction
	}: {
		open?: boolean;
		store: WorkspaceStore;
		ws: string;
		/** Called with the item value for entries that are not plain links. */
		onAction?: (value: string) => void;
	} = $props();

	let search = $state('');

	// P1 matches titles by prefix over the pages the store knows, plus recent visits. P4 adds full
	// text through `rpc.search.quick`.
	const actions = $derived([
		{ value: 'action:new-page', label: 'New page', icon: plusIcon, shortcut: '⌘N', disabled: !store.canEdit },
		{ value: 'action:toggle-sidebar', label: 'Toggle sidebar', icon: sidebarSimpleIcon, shortcut: '⌘\\' },
		{ value: 'action:toggle-dark', label: 'Toggle dark mode', icon: moonIcon, shortcut: '⌘⇧L' },
		{ value: 'action:trash', label: 'Open trash', icon: trashIcon, href: `/${ws}/trash` },
		{ value: 'action:settings', label: 'Open settings', icon: gearIcon, href: `/${ws}/settings` }
	]);

	const groups = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const pageItem = (p: { id: string; title: string; icon: string | null }) => ({
			value: `page:${p.id}`,
			label: p.title || 'Untitled',
			icon: p.icon ?? fileTextIcon
		});
		if (!q) {
			const recent = store.recent
				.map((r) => store.resolvePage(r.id))
				.filter((p): p is NonNullable<typeof p> => !!p)
				.slice(0, 6)
				.map(pageItem);
			return [
				...(recent.length ? [{ heading: 'Recent', items: recent }] : []),
				{ heading: 'Actions', items: actions }
			];
		}
		const pages = store.searchPages(q, 8).map(pageItem);
		const matching = actions.filter((a) => a.label.toLowerCase().split(' ').some((w) => w.startsWith(q)));
		return [
			...(pages.length ? [{ heading: 'Pages', items: pages }] : []),
			...(matching.length ? [{ heading: 'Actions', items: matching }] : [])
		];
	});

	$effect(() => {
		if (!open) search = '';
	});
</script>

<!-- ⌘K is handled by the Command itself (`shortcut`). -->
<Command
	dialog
	shortcut="k"
	bind:open
	bind:search
	items={groups}
	shouldFilter={false}
	autoHighlight="always"
	placeholder="Search pages and actions…"
	onSelect={(value) => onAction?.(value)}
>
	{#snippet empty()}
		<div class="px-3 py-6 text-center text-sm text-[color:var(--app-text-tertiary)]">No pages match “{search}”.</div>
	{/snippet}
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
