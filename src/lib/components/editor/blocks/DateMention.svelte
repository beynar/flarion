<!--
	A `date_mention` atom: the date as a chip ("Today", "Next Friday", "Nov 7 → Nov 9"), and, when the page may
	be edited, the picker in a popover. Its data is a `DateValue` (`start`, optional `end`; a time is part of the
	ISO string), written through one `patchData` per change.
-->
<script lang="ts">
	import { Popover } from 'entasis/popover';
	import { tooltip } from 'entasis/tooltip';
	import type { InlineBlockView } from 'edytor';
	import type { DateValue } from '#lib/shared/dates.ts';
	import { formatDateMention } from '#lib/shared/blocks/date-label.ts';
	import { getEditorContext } from '../context.ts';
	import DatePicker from './DatePicker.svelte';

	let { block }: { block: InlineBlockView } = $props();

	const ctx = getEditorContext();
	const value = $derived({ start: String(block.data?.start ?? ''), end: (block.data?.end as string | null | undefined) ?? null } satisfies DateValue);
	const label = $derived(formatDateMention(value) ?? 'Invalid date');
	const canEdit = $derived(!(ctx?.readonly() ?? false) && !(block.handle?.edytor.readonly ?? false));

	function set(next: DateValue) {
		const handle = block.handle;
		handle?.edytor.patchData({ block: handle.blockId, atom: handle.id }, [
			{ path: ['start'], value: next.start },
			{ path: ['end'], value: next.end ?? null }
		]);
	}
</script>

{#snippet chip(attach?: (node: HTMLElement) => void)}
	<span
		class="edytor-mention flarion-date"
		data-flarion-kind="date_mention"
		data-testid="date-mention"
		data-selected={block.selected ? 'true' : undefined}
		{@attach (node) => attach?.(node)}
		{@attach tooltip({ content: value.start, position: 'top', delay: 400 })}
	>
		<span aria-hidden="true">📅</span> {label}
	</span>
{/snippet}

{#if canEdit}
	<Popover position="bottom-start">
		{#snippet trigger(popover)}
			{@render chip(popover.trigger)}
		{/snippet}
		{#snippet children()}
			<DatePicker {value} onSet={set} />
		{/snippet}
	</Popover>
{:else}
	{@render chip()}
{/if}

<style>
	.flarion-date {
		cursor: pointer;
		white-space: nowrap;
	}
</style>
