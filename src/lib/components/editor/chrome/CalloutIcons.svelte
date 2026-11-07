<script lang="ts">
	import Floating from './Floating.svelte';
	import { Button } from '../ui/index.ts';
	import { words } from './words.svelte.js';
	import type { CalloutIconPicker } from 'edytor';

	/**
	 * Notion's callout icon picker, drawn for `createRichTextPlugin({ callout:
	 * { picker } })`: a grid of the view's icons, then Remove icon.
	 */
	let { picker }: { picker: CalloutIconPicker } = $props();
</script>

<!-- The icon grid has no entasis equivalent (`Command` and `Menu` are lists: audit NE-3), so the cells are `Button`s on an entasis `Popover` surface. -->
<Floating
	anchor={() => picker.anchor}
	gap={4}
	haspopup="grid"
	class="callout-icons flex flex-col gap-1 p-1.5 outline-none"
	aria-label={words.calloutIcons.picker}
	{@attach picker.keys}
	{@attach picker.popup}
>
	<div class="callout-icons-grid" role="none" style:--callout-icon-columns={picker.columns}>
		{#each picker.icons as icon, index (index)}
			<Button
				variant="ghost"
				data-edytor-callout-icon-choice
				data-selected={picker.index === index}
				data-current={icon === picker.current}
				{@attach picker.option(index)}
				onmouseenter={() => (picker.index = index)}
				onclick={() => picker.pick(index)}>{icon}</Button
			>
		{/each}
	</div>
	<Button
		variant="ghost"
		class="callout-icons-remove"
		data-edytor-callout-icon-remove
		data-selected={picker.index === picker.icons.length}
		{@attach picker.option(picker.icons.length)}
		onmouseenter={() => (picker.index = picker.icons.length)}
		onclick={() => picker.pick(picker.icons.length)}>{words.calloutIcons.remove}</Button
	>
</Floating>

<style>
	.callout-icons-grid {
		display: grid;
		grid-template-columns: repeat(var(--callout-icon-columns), 32px);
		gap: 2px;
	}
	.callout-icons-grid :global(button) {
		width: 32px;
		height: 32px;
		padding: 0;
		font-size: 20px;
		line-height: 32px;
	}
	:global(.callout-icons button[data-selected='true']) {
		background: var(--app-hover);
	}
	:global(.callout-icons button[data-current='true']) {
		box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--app-accent) 57%, transparent);
	}
	:global(.callout-icons .callout-icons-remove) {
		justify-content: flex-start;
		color: var(--app-text-secondary);
	}
</style>
