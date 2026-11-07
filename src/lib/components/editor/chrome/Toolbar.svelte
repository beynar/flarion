<script lang="ts">
	import Floating from './Floating.svelte';
	import MaskIcon from './MaskIcon.svelte';
	import { MenuOption } from 'entasis/menu-option';
	import { Button, Input, Separator } from '../ui/index.ts';
	import { css } from './ui.js';
	import { words } from './words.svelte.js';
	import { iconOf, linkIcon } from './icons.js';
	import type { ToolbarController } from 'edytor';
	import { PALETTE } from './palette.js';
	import { AI_ACTIONS, type AiSpec } from '../ai/actions.ts';
	import { aiOffered, aiRuntime } from '../ai/state.svelte.ts';

	/** Notion's selection toolbar, drawn for `createToolbarPlugin({ toolbar })`. */
	let { controller }: { controller: ToolbarController } = $props();

	const labels = $derived(words.toolbar);
	/** The bar's content element: the panels hang from it. */
	let bar = $state<HTMLElement>();
	/** The marks' own looks (bold is bold, italic is italic...). */
	const MARK_CLASS: Record<string, string> = {
		bold: 'font-bold',
		italic: 'italic font-serif',
		underline: 'underline underline-offset-2',
		strike: 'line-through',
		code: 'font-mono text-xs'
	};

	// Write with AI: the selection toolbar's panel (the same actions as `/ai`), shown while AI is offered (docs/PLAN.md "AI features").
	let aiOpen = $state(false);
	const aiRows = AI_ACTIONS.filter((spec) => spec.toolbar);
	const keep = (event: MouseEvent) => event.preventDefault();
	$effect(() => {
		if (controller.panel) aiOpen = false;
	});
	function runAi(spec: AiSpec) {
		aiOpen = false;
		void aiRuntime.current?.run(spec);
	}
</script>

<!--
	The bar's id, role, placement mark and publication to the view's root (`popup`), its roving tab stop and Escape
	(`keys`) and the link field's keys (`linkField`) are the controller's attachments, laid on the entasis surface's
	content element (`Floating`) and on entasis `Button`s / `TextInput`. The panels (Turn into, Color, Link, AI) are
	second surfaces anchored to the bar.
-->
<Floating
	anchor={() => controller.anchor}
	placement="top"
	class="flex h-9 items-center gap-px whitespace-nowrap px-1"
	role="toolbar"
	aria-label={labels.bar}
	tabindex="-1"
	data-testid="selection-toolbar"
	bind:element={bar}
	{@attach controller.popup}
	{@attach controller.keys}
>
	<Button
		variant="ghost"
		class="toolbar-type font-medium"
		data-stop="turn"
		aria-haspopup="menu"
		aria-expanded={controller.panel === 'turn'}
		onclick={() => controller.togglePanel('turn')}
		>{controller.currentKind?.label ?? labels.text}<span class="toolbar-chevron" aria-hidden="true"></span></Button
	>
	<Separator orientation="vertical" class="mx-0.5 h-5" />
	<Button
		variant="ghost"
		class="toolbar-link"
		data-stop="link"
		data-testid="toolbar-link"
		aria-expanded={controller.panel === 'link'}
		onclick={() => controller.togglePanel('link')}
		><MaskIcon icon={linkIcon} size={18} />{labels.link}</Button
	>
	<Separator orientation="vertical" class="mx-0.5 h-5" />
	{#each controller.marks as item (item.mark)}
		<Button
			variant="ghost"
			class={MARK_CLASS[item.mark] ?? ''}
			data-stop={`mark:${item.mark}`}
			aria-label={item.label}
			title={item.label}
			data-testid={`toolbar-${item.mark}`}
			aria-pressed={controller.isActive(item.mark)}
			onclick={() => controller.toggleMark(item.mark)}>{item.icon}</Button
		>
	{/each}
	<Separator orientation="vertical" class="mx-0.5 h-5" />
	<Button
		variant="ghost"
		class="toolbar-color font-medium underline decoration-2 underline-offset-[3px]"
		data-stop="color"
		aria-label={labels.color}
		title={labels.textColor}
		aria-expanded={controller.panel === 'color'}
		onclick={() => controller.togglePanel('color')}>A<span class="toolbar-chevron" aria-hidden="true"></span></Button
	>
	{#if aiOffered()}
		<Separator orientation="vertical" class="mx-0.5 h-5" />
		<Button
			variant="ghost"
			class="toolbar-ai text-primary font-medium"
			data-stop="ai"
			data-testid="toolbar-ai"
			aria-haspopup="menu"
			aria-expanded={aiOpen}
			title="Write with AI"
			onmousedown={keep}
			onclick={() => (aiOpen = !aiOpen)}>✨ AI<span class="toolbar-chevron" aria-hidden="true"></span></Button
		>
	{/if}
</Floating>

{#snippet panel(name: string, menu: boolean, testid: string | undefined, extra: string, body: import('svelte').Snippet)}
	{#if bar}
		<Floating
			anchor={() => bar}
			placement="bottom-start"
			gap={6}
			haspopup="menu"
			class="box-border max-h-80 overflow-y-auto p-1 {extra}"
			role={menu ? 'menu' : undefined}
			aria-label={name}
			data-testid={testid}
			tabindex={menu ? -1 : undefined}
		>
			{@render body()}
		</Floating>
	{/if}
{/snippet}

{#snippet turnBody()}
	<div class="text-neutral/70 px-2 pt-1.5 pb-1 text-xs font-medium">{labels.turnInto}</div>
	{#each controller.kinds as kind (kind.id)}
		<MenuOption
			role="menuitem"
			size="small"
			density="compact"
			attrs={{ 'data-current': kind === controller.currentKind }}
			onclick={() => controller.turnInto(kind)}
		>
			{#snippet prefix()}<MaskIcon icon={iconOf(kind.id)} size={18} />{/snippet}
			{kind.label}
			{#snippet suffix()}{#if kind === controller.currentKind}<span class="text-sm">✓</span>{/if}{/snippet}
		</MenuOption>
	{/each}
{/snippet}

{#snippet aiBody()}
	<div class="text-neutral/70 px-2 pt-1.5 pb-1 text-xs font-medium">Write with AI</div>
	{#each aiRows as spec (spec.id)}
		<MenuOption role="menuitem" size="small" density="compact" attrs={{ 'data-testid': `toolbar-ai-${spec.id}` }} onclick={() => runAi(spec)}>
			{#snippet prefix()}<MaskIcon icon={iconOf('action.ai')} size={18} />{/snippet}
			{spec.label}
		</MenuOption>
	{/each}
{/snippet}

{#snippet linkBody()}
	<label class="sr-only" for={controller.linkFieldId}>{labels.linkUrl}</label>
	<div class="flex items-center gap-1">
		<Input
			class="flex-1"
			data-testid="toolbar-link-input"
			placeholder={labels.linkPlaceholder}
			value={controller.linkUrl}
			oninput={(event) => controller.setLinkUrl(event.currentTarget.value)}
			{@attach controller.linkField}
		/>
		<Button variant="ghost" data-testid="toolbar-link-apply" title={labels.applyLink} onclick={() => controller.applyLink()}>{labels.apply}</Button>
		<Button variant="ghost" data-testid="toolbar-link-remove" title={labels.removeLink} onclick={() => controller.removeLink()}>{labels.remove}</Button>
	</div>
{/snippet}

{#snippet colorBody()}
	<!-- The text colours (an "A" in the colour), then the backgrounds (a filled square). The nine-colour palette is
	     Notion's own: entasis has no swatch picker (`ColorPicker` is free-form), so the swatches stay `Button`s. -->
	{#each ['color', 'highlight'] as const as mark (mark)}
		{@const text = mark === 'color'}
		<div class="text-neutral/70 px-2 pt-1.5 pb-1 text-xs font-medium">{text ? labels.textColor : labels.backgroundColor}</div>
		<div class="grid grid-cols-5 gap-1 px-1.5 pt-0.5 pb-1.5">
			{#each PALETTE as color (color.name)}
				{@const name = labels.colors[color.name] ?? color.name}
				<Button
					variant="ghost"
					role="menuitem"
					class="toolbar-swatch size-7 p-0 shadow-[inset_0_0_0_1px_var(--app-hairline)]"
					title={text ? labels.colorText(name) : labels.colorBackground(name)}
					onclick={() => controller.setColor(mark, text ? color.text : color.background)}
					style={css({
						color: text ? (color.text ?? 'inherit') : undefined,
						background: text ? undefined : (color.background ?? 'transparent')
					})}>{text ? 'A' : ''}</Button
				>
			{/each}
		</div>
	{/each}
{/snippet}

{#if aiOpen && aiOffered() && !controller.panel}
	{@render panel('Write with AI', true, 'toolbar-ai-panel', 'w-60', aiBody)}
{/if}
{#if controller.panel === 'turn'}
	{@render panel(labels.turnInto, true, undefined, 'w-60', turnBody)}
{:else if controller.panel === 'link'}
	{@render panel(labels.link, false, undefined, 'w-[380px]', linkBody)}
{:else if controller.panel === 'color'}
	{@render panel(labels.color, true, undefined, 'w-60', colorBody)}
{/if}

<style>
	/* The chevron after a label, the toolbar's own glyph (a down caret, drawn in the text color). */
	.toolbar-chevron {
		width: 12px;
		height: 12px;
		background: var(--app-text-secondary);
		-webkit-mask: var(--toolbar-chevron) center / 12px no-repeat;
		mask: var(--toolbar-chevron) center / 12px no-repeat;
		--toolbar-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='black' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
	}
</style>
