<!--
	The page's version history (docs/PLAN.md "Pages and blocks": History), opened from the page's "…" menu
	(`historyPanel.show(pageId)`). Full screen: the versions on the right, the selected one compared with the page now
	on the left, and a Restore button for people with `update` access.
-->
<script lang="ts">
	import { Dialog } from 'entasis/dialog';
	import type { EdytorInstance } from 'edytor';
	import { rpc } from '#lib/client/rpc.ts';
	import type { Rpc } from '#lib/client/rpc.ts';
	import HistoryBody from './HistoryBody.svelte';
	import { historyPanel } from './panel-state.svelte.ts';

	let {
		pageId,
		edytor,
		canRestore,
		resolvePerson,
		client = rpc
	}: {
		pageId: string;
		edytor?: EdytorInstance;
		canRestore: boolean;
		resolvePerson?: (id: string) => { name: string } | undefined;
		client?: Rpc;
	} = $props();

	// The panel belongs to one page: moving to another closes it.
	$effect(() => {
		if (historyPanel.pageId !== null && historyPanel.pageId !== pageId) historyPanel.hide();
	});
	const open = $derived(historyPanel.open && historyPanel.pageId === pageId);
</script>

<Dialog
	open={open}
	onOpenChange={(next: boolean) => (next ? historyPanel.show(pageId) : historyPanel.hide())}
	type="fullScreen"
	closable
>
	{#snippet title()}Version history{/snippet}
	{#snippet children()}
		<div class="h-[calc(100dvh-110px)] min-h-[320px]">
			{#if open}
				{#key pageId}
					<HistoryBody {pageId} rpc={client} {edytor} {canRestore} {resolvePerson} onClose={() => historyPanel.hide()} />
				{/key}
			{/if}
		</div>
	{/snippet}
</Dialog>
