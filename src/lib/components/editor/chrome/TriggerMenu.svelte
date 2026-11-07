<script lang="ts" generics="T">
	import { words } from './words.svelte.js';
	import type { Snippet } from 'svelte';
	import type { TriggerMenuController } from 'edytor';
	import { MenuOption } from 'entasis/menu-option';
	import Floating from './Floating.svelte';

	/**
	 * A trigger's menu (`@`, `[[`, a plugin's own), drawn for a trigger's
	 * `menu`: its rows are `row`'s (the item and its index), else the item's
	 * label.
	 */
	let {
		controller,
		row,
		said = words.trigger
	}: {
		controller: TriggerMenuController<T>;
		row?: Snippet<[T, number, (index: number) => Record<string, unknown>]>;
		/** The menu's name and its empty and pending texts. */
		said?: { menu: string; searching: string; noResults: string };
	} = $props();
	const items = $derived(controller.items);
	/** A row's own attributes: the keyboard's row (`data-selected`), and hovering makes it the keyboard's. */
	const optionAttrs = (index: number) => ({
		'data-selected': controller.index === index,
		onpointermove: () => (controller.index = index)
	});
</script>

<!--
	The listbox's id, role and publication to the view's root are the controller's `popup` attachment, a row's ARIA
	its `option(index)`. The surface is entasis `Popover` (`Floating`), the rows `MenuOption`s. A press in the menu
	keeps the editor's focus and its caret at the query.
-->
<Floating
	anchor={() => controller.anchor}
	haspopup="listbox"
	class="edytor-trigger-menu flex w-[280px] max-h-[min(40vh,320px)] flex-col overflow-hidden"
	data-testid="trigger-menu"
	data-trigger={controller.char}
>
	<div
		class="edytor-trigger-items flex-1 overflow-y-auto p-1"
		aria-label={said.menu}
		aria-busy={controller.loading}
		{@attach controller.popup}
	>
		<!-- Keyed by position and key: two rows may share a key (a label without an id). -->
		{#each items as item, index (`${index}:${controller.keyOf(item)}`)}
			{#if row}
				{@render row(item, index, optionAttrs)}
			{:else}
				<MenuOption
					role="option"
					size="small"
					density="compact"
					highlighted={controller.index === index}
					{@attach controller.option(index)}
					attrs={{ ...optionAttrs(index), 'data-testid': 'trigger-menu-item' }}
					onclick={() => void controller.pick(item)}
				>
					{controller.labelOf(item)}
				</MenuOption>
			{/if}
		{/each}
		{#if items.length === 0}
			<div class="text-neutral/70 px-2 py-1.5" data-testid="trigger-menu-empty">
				{controller.loading ? said.searching : said.noResults}
			</div>
		{/if}
	</div>
</Floating>
