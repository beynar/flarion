<script lang="ts">
	import Floating from './Floating.svelte';
	import { tooltip } from 'entasis/tooltip';
	import { Button } from '../ui/index.ts';
	import { words } from './words.svelte.js';
	import { linkIcon } from './icons.js';
	import type { ToolbarController } from 'edytor';

	/** The card under a hovered link, drawn for `createToolbarPlugin({ card })`. */
	let { controller }: { controller: ToolbarController } = $props();
	const labels = $derived(words.toolbar);
</script>

<!--
	The link card (`link.card`, Notion): the hovered link's URL with Open,
	Edit and Remove, just below the link. No press on it takes the editor's
	focus (its host cancels each `mousedown`).
-->
<Floating
	anchor={() => controller.cardAnchor}
	gap={0}
	class="link-card box-border flex h-9 max-w-[420px] items-center gap-0.5 whitespace-nowrap pr-1 pl-2 text-[13px]"
	role="toolbar"
	aria-label={labels.card}
	data-testid="link-card"
	data-edytor-link-card
>
	<span class="link-card-url" style:--link-card-icon={linkIcon} {@attach tooltip({ content: controller.hoveredHref, position: 'top', delay: 400 })}
		>{controller.hoveredHref}</span
	>
	<Button
		variant="ghost"
		data-testid="link-card-open"
		title={labels.openLink}
		onclick={() => controller.openHovered()}>{labels.open}</Button
	>
	<Button
		variant="ghost"
		data-testid="link-card-edit"
		title={labels.editLink}
		onclick={() => controller.editHovered()}>{labels.edit}</Button
	>
	<Button
		variant="ghost"
		data-testid="link-card-remove"
		title={labels.removeLink}
		onclick={() => controller.removeHovered()}>{labels.remove}</Button
	>
</Floating>

<style>
	.link-card-url {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		margin-right: 4px;
		overflow: hidden;
		color: var(--app-text-secondary);
		text-overflow: ellipsis;
	}
	.link-card-url::before {
		content: '';
		flex: none;
		width: 16px;
		height: 16px;
		background: currentColor;
		-webkit-mask: var(--link-card-icon) center / 16px no-repeat;
		mask: var(--link-card-icon) center / 16px no-repeat;
	}
</style>
