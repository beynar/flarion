<script lang="ts">
	import { Command } from 'entasis/command';
	import { Empty } from 'entasis/empty';
	import { fileTextIcon } from 'entasis/icons/fileText';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';

	/**
	 * A searchable list of the pages the sidebar store knows (title prefix, recent visits first).
	 * Used for relations and "Move to…". `exclude` hides pages (a move cannot target its own subtree).
	 */
	let {
		store,
		onpick,
		exclude,
		placeholder = 'Search pages…',
		heading
	}: {
		store: WorkspaceStore;
		onpick: (pageId: string) => void;
		exclude?: (pageId: string) => boolean;
		placeholder?: string;
		heading?: string;
	} = $props();

	let search = $state('');

	const items = $derived.by(() => {
		const q = search.trim();
		const list = q ? store.searchPages(q, 40) : store.recent.map((r) => store.resolvePage(r.id)).filter((p): p is NonNullable<typeof p> => !!p).slice(0, 12);
		const rows = (list.length || q ? list : store.searchPages('', 12)).filter((p) => !exclude?.(p.id));
		return [{ heading: heading ?? (q ? 'Pages' : 'Recent'), items: rows.map((p) => ({ value: p.id, label: p.title || 'Untitled', icon: p.icon ?? fileTextIcon })) }];
	});
</script>

<Command bind:search {items} shouldFilter={false} autoHighlight="always" {placeholder} onSelect={(value) => onpick(value)}>
	{#snippet empty()}
		<Empty size="small" title="No pages match" />
	{/snippet}
</Command>
