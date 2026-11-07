<script lang="ts">
	import Floating from './Floating.svelte';
	import { Input } from '../ui/index.ts';
	import { MenuOption } from 'entasis/menu-option';
	import { words } from './words.svelte.js';
	import type { LanguageMenu } from 'edytor';

	/**
	 * The code language list, drawn for `createCodePlugin({ menu })`: a search field holding the keys (a `combobox`
	 * naming the highlighted row) over the listbox of languages. Entasis `Popover`, `TextInput` and `MenuOption` rows.
	 */
	let { menu }: { menu: LanguageMenu } = $props();
</script>

<Floating
	anchor={() => menu.anchor}
	gap={4}
	haspopup="listbox"
	class="box-border flex w-[220px] flex-col p-1"
	data-edytor-code-language-menu
>
	<Input
		type="text"
		placeholder={words.code.search}
		aria-label={words.code.language}
		spellcheck="false"
		autocomplete="off"
		autocapitalize="off"
		value={menu.query}
		oninput={(event) => menu.search(event.currentTarget.value)}
		{@attach menu.keys}
	/>
	<div class="mt-1 max-h-[280px] overflow-y-auto" data-edytor-code-language-list aria-label={words.code.language} {@attach menu.popup}>
		{#each menu.items as item, index (item.item.id)}
			<!-- The field keeps the focus (its keys): a row is pressed, never focused. Its role and ARIA are the
			`option` attachment's. -->
			<MenuOption
				role="option"
				size="small"
				density="compact"
				highlighted={item.selected}
				{@attach menu.option(index)}
				attrs={{
					'data-edytor-code-language-option': item.item.id,
					'data-current': item.current ? '' : undefined,
					'data-selected': item.selected,
					onpointermove: item.select
				}}
				onclick={item.run}
			>
				{item.item.label}
				{#snippet suffix()}{#if item.current}<span class="text-sm">✓</span>{/if}{/snippet}
			</MenuOption>
		{/each}
	</div>
	{#if menu.rows.length === 0}
		<div class="text-neutral/70 px-2 py-1" data-edytor-code-language-empty role="status">{words.code.noResults}</div>
	{/if}
</Floating>
