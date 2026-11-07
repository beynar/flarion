<!--
	"Move to…" for blocks: pick the page that receives them. Reuses the sidebar's page picker; the page the blocks are on
	is not offered. The move itself (`page.moveBlocks`: edytor's export, import and commit) is the caller's.
-->
<script lang="ts">
	import { Dialog } from 'entasis/dialog';
	import type { WorkspaceStore } from '#lib/client/workspace.svelte.ts';
	import PagePicker from '#lib/components/pickers/PagePicker.svelte';

	let {
		store,
		fromPageId,
		count,
		open = $bindable(false),
		onpick
	}: {
		store: WorkspaceStore;
		fromPageId: string;
		count: number;
		open: boolean;
		onpick: (pageId: string) => void;
	} = $props();

	// Only pages the person can edit receive blocks (the server checks too).
	const canReceive = (id: string) => {
		const access = store.page(id)?.access;
		return access === 'update' || access === 'full';
	};
</script>

<Dialog bind:open size="small" closable>
	{#snippet title()}Move {count === 1 ? 'block' : `${count} blocks`} to…{/snippet}
	{#snippet children()}
		<div class="overflow-hidden rounded-[var(--app-radius-panel)] border border-[color:var(--app-hairline)]" data-testid="move-blocks-dialog">
			<PagePicker
				{store}
				heading="Move to a page"
				placeholder="Search for a page…"
				exclude={(id) => id === fromPageId || !canReceive(id)}
				onpick={(id) => {
					open = false;
					onpick(id);
				}}
			/>
		</div>
	{/snippet}
</Dialog>
