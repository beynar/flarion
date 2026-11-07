<script lang="ts">
	import { words } from './words.svelte.js';
	import type { CodeHeader } from 'edytor';
	import { buttonVariants } from '../ui/index.ts';
	import { Mermaid } from 'entasis/mermaid';

	// shadcn's ghost button, as classes: one per code block, so no component boundary.
	const ghost = buttonVariants({ variant: 'ghost', size: 'xs' });

	/**
	 * Notion's code header, drawn for `createCodePlugin({ header })`: the
	 * language's button (or its label where it cannot change) and Copy.
	 */
	let { header }: { header: CodeHeader } = $props();
	const labels = $derived(words.code);

	/** A `mermaid` block also draws its diagram (entasis Mermaid), under the code, read live from its lines. */
	const diagram = $derived(
		header.language === 'mermaid'
			? (header.block?.children.map((line) => line.firstText?.stringContent ?? '').join('\n') ?? '')
			: null
	);
</script>

<div class="code-bar">
{#if header.editable}
	<!-- The language list (`LanguageMenu`): one key patched (`patchData`, one undo step). -->
	<button
		type="button"
		class={ghost}
		data-edytor-code-language
		aria-label="{labels.language}: {header.label}"
		{@attach header.button}
		>{header.label}<svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10"
			><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg
		></button
	>
{:else}
	<span data-edytor-code-language>{header.label}</span>
{/if}
<button
	type="button"
	class={ghost}
	data-edytor-code-copy
	onmousedown={(e) => e.preventDefault()}
	onclick={(e) => {
		e.preventDefault();
		e.stopPropagation();
		void header.copy();
	}}>{header.copied ? labels.copied : labels.copy}</button
>
</div>

{#if diagram !== null}
	<div class="mermaid-preview" data-flarion-mermaid contenteditable="false">
		{#if diagram.trim()}
			<Mermaid chart={diagram} size="small" errorForgiving controls={{ fit: true, zoomIn: true, zoomOut: true, expand: true }} />
		{:else}
			<span class="mermaid-empty">Type a Mermaid diagram above</span>
		{/if}
	</div>
{/if}

<style>
	/*
	 * The header's colors are custom properties a theme may set:
	 * `--edytor-code-chrome-color` (the language and Copy),
	 * `--edytor-code-chrome-hover` (their background under the pointer),
	 * `--edytor-code-accent` (their focus ring).
	 */
	button,
	span {
		font-size: 12px;
		line-height: 20px;
		/* The foreground at three quarters: shadcn's muted text on the muted panel misses AA at 12px. */
		color: var(--edytor-code-chrome-color, color-mix(in oklab, var(--app-text) 75%, transparent));
	}
	/* The language: a button with its chevron, which opens the language list. */
	button[data-edytor-code-language] {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin: 0;
		padding: 0 4px 0 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font-family: inherit;
		cursor: pointer;
	}
	button[data-edytor-code-language] svg {
		opacity: 0.7;
	}
	button[data-edytor-code-language]:hover,
	button[data-edytor-code-language]:global([aria-expanded='true']) {
		background: var(--edytor-code-chrome-hover, var(--app-hover));
	}
	button:focus-visible {
		outline: 2px solid var(--edytor-code-accent, var(--app-accent));
		outline-offset: 1px;
	}
	span[data-edytor-code-language] {
		padding: 0 6px;
	}
	[data-edytor-code-copy] {
		padding: 0 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font-family: inherit;
		cursor: pointer;
		opacity: 0;
		transition: opacity 150ms ease;
	}
	:global([data-edytor-type='code']:hover) [data-edytor-code-copy],
	[data-edytor-code-copy]:focus-visible {
		opacity: 1;
	}
	/* The diagram sits under the code: the header's wrapper steps aside (`display: contents`) so the
	 * buttons keep their place over the panel and the preview becomes the block's last flex item. */
	.mermaid-preview {
		order: 3;
		width: 100%;
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--app-hairline);
		background: var(--app-page);
		border-radius: 6px;
		overflow: hidden;
	}
	.mermaid-empty {
		color: var(--app-text-tertiary);
		font-size: 12px;
	}
	:global([data-edytor-type='code']:has([data-flarion-mermaid])) {
		display: flex;
		flex-direction: column;
	}
	:global([data-edytor-type='code']:has([data-flarion-mermaid]) pre.th-code) {
		order: 2;
	}
	:global([data-edytor-type='code']:has([data-flarion-mermaid]) > [data-edytor-code-header]) {
		display: contents;
	}
	.code-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
	}
	:global([data-edytor-type='code']:has([data-flarion-mermaid])) .code-bar {
		position: absolute;
		top: 6px;
		left: 10px;
		right: 8px;
		width: auto;
	}
	/* A touch screen shows it: a touch that revealed it would cost the tap
	 * (iOS Safari takes it for a hover and sends no click, the language
	 * button's included). */
	@media (hover: none) {
		[data-edytor-code-copy] {
			opacity: 1;
		}
	}
	[data-edytor-code-copy]:hover {
		background: var(--edytor-code-chrome-hover, var(--app-hover));
	}
</style>
