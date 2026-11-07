<script lang="ts">
	import Floating from './Floating.svelte';
	import MaskIcon from './MaskIcon.svelte';
	import { Button } from '../ui/index.ts';
	import { Input } from '../ui/index.ts';
	import { words } from './words.svelte.js';
	import { alignIcons, altIcon } from './icons.js';
	import type { ImageToolbar } from 'edytor';

	/**
	 * Notion's image toolbar, drawn for `createImageToolbarPlugin({ toolbar })`: the
	 * three alignments and the alt text's button, and the alt text field
	 * under them. A press on the toolbar keeps the editor's focus; the alt
	 * field takes it.
	 */
	let { controls }: { controls: ImageToolbar } = $props();
	const labels = $derived(words.image);
	/** The toolbar's buttons: the three alignments, then the alt text's (no `align`). */
	const buttons = $derived([
		{ align: 'left', label: labels.alignLeft, icon: alignIcons.left },
		{ align: 'center', label: labels.alignCenter, icon: alignIcons.center },
		{ align: 'right', label: labels.alignRight, icon: alignIcons.right },
		{ align: undefined, label: labels.alt, icon: altIcon }
	] as const);
	const keep = (event: MouseEvent) => event.preventDefault();
	/** The bar's content element: the alt text panel hangs from it. */
	let bar = $state<HTMLElement>();
</script>

{#if controls.box}
	{@const box = controls.box}
	<!-- Its role is the controller's `bar`. -->
	<Floating
		anchor={() => controls.anchor}
		placement="top-end"
		gap={({ rects }) => ({ mainAxis: -rects.floating.height - 6, crossAxis: 6 })}
		class="image-toolbar flex gap-0.5 p-0.5"
		aria-label={labels.toolbar}
		data-image-toolbar
		bind:element={bar}
		{@attach controls.bar}
	>
		{#each buttons as { align, label, icon } (icon)}
			<Button
				variant="ghost"
				data-edytor-image-align={align}
				data-edytor-image-alt-toggle={align ? undefined : ''}
				aria-label={label}
				title={label}
				aria-pressed={align ? box.align === align : undefined}
				aria-expanded={align ? undefined : controls.editing === box.id}
				onmousedown={keep}
				onclick={() => (align ? controls.align(align) : controls.toggleAlt())}
				><MaskIcon {icon} size={18} /></Button
			>
		{/each}
	</Floating>
	{#if controls.editing === box.id && bar}
		<Floating anchor={() => bar} placement="bottom-end" gap={4} class="w-60 p-1" data-edytor-image-alt-panel>
			<Input
				data-edytor-image-alt
				aria-label={labels.alt}
				placeholder={labels.altPlaceholder}
				value={controls.alt}
				oninput={(event) => controls.setAlt(event.currentTarget.value)}
				{@attach controls.altField}
			/>
		</Floating>
	{/if}
{/if}
