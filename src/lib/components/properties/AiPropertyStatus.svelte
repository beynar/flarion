<script lang="ts">
	import { untrack } from 'svelte';
	import { Chip } from 'entasis/chip';
	import { tooltip } from 'entasis/tooltip';
	import { toast } from 'entasis/toast';
	import { arrowsClockwiseIcon } from 'entasis/icons/arrowsClockwise';
	import { Button } from 'entasis/button';
	import { aiRpc } from '#lib/client/ai-rpc.ts';
	import { rpc } from '#lib/client/rpc.ts';
	import type { PropValue } from '#lib/shared/property-types.ts';

	/**
	 * What sits next to an AI property's value in the page header: an "Outdated" chip when the last attempt to refresh it
	 * failed (the text shown is the previous one) or a change still waits for the model, and a "Regenerate" button
	 * (`ai.regenerate`: recomputes now, needs edit access). The markers come from `ai.markers`; they are read when the
	 * page opens, when the value changes (a new value clears them) and after a regenerate. A change waiting for the model
	 * is looked at again every 35 seconds (the queue's 30 s debounce plus a run), at most eight times, because a failed
	 * run raises the stale marker without changing any value, so nothing else would tell this tab.
	 */
	let {
		pageId,
		propId,
		value,
		editable
	}: {
		pageId: string;
		propId: string;
		value: PropValue | null | undefined;
		editable: boolean;
	} = $props();

	let marker = $state<{ pending: boolean; stale: boolean } | null>(null);
	let busy = $state(false);
	let rechecks = 0;

	async function load(page: string, prop: string): Promise<void> {
		try {
			const all = await rpc.ai.markers({ pageId: page });
			// A reply for a page or property this row has since moved off is dropped.
			if (page !== untrack(() => pageId) || prop !== untrack(() => propId)) return;
			marker = all.find((m) => m.propId === prop) ?? null;
		} catch {
			marker = null;
		}
	}

	$effect(() => {
		const page = pageId;
		const prop = propId;
		void value; // a new value changes the markers
		rechecks = 0;
		void load(page, prop);
	});

	$effect(() => {
		if (!marker?.pending || rechecks >= 8) return;
		const page = pageId;
		const prop = propId;
		const timer = setTimeout(() => {
			rechecks++;
			void load(page, prop);
		}, 35_000);
		return () => clearTimeout(timer);
	});

	async function regenerate() {
		if (busy) return;
		busy = true;
		try {
			await aiRpc().ai.regenerate({ pageId, propId });
		} catch (error) {
			toast.danger({ title: 'Could not regenerate', description: error instanceof Error ? error.message : 'Try again in a moment.' });
		} finally {
			busy = false;
			rechecks = 0;
			void load(pageId, propId);
		}
	}

	const outdated = $derived(marker?.stale === true || marker?.pending === true);
	const reason = $derived(
		marker?.stale ? 'The last update failed, so this is the previous text. Regenerate to try again.' : 'The page changed. This text is updated a few seconds after you stop editing.'
	);
</script>

{#if outdated || editable}
	<div class="flex shrink-0 items-center gap-1 pt-px" data-testid="ai-status">
		{#if outdated}
			<span data-testid="ai-stale" data-state={marker?.stale ? 'stale' : 'pending'} {@attach tooltip({ content: reason, position: 'bottom', delay: 300, offset: 6 })}>
				<Chip size="small" variant="soft" color={marker?.stale ? 'warning' : 'neutral'}>{marker?.stale ? 'Outdated' : 'Updating'}</Chip>
			</span>
		{/if}
		{#if editable}
			<Button
				label="Regenerate"
				variant="ghost"
				color="neutral"
				size="small"
				prefix={arrowsClockwiseIcon}
				loading={busy}
				disabled={busy}
				data-testid="ai-regenerate"
				onclick={() => void regenerate()}
			>
				Regenerate
			</Button>
		{/if}
	</div>
{/if}
