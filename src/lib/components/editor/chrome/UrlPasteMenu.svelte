<script lang="ts">
	import Floating from './Floating.svelte';
	import { MenuOption } from 'entasis/menu-option';
	import { words } from './words.svelte.js';
	import type { UrlPasteController } from 'edytor';

	/** The menu a URL pasted on an empty line opens, drawn for an embed or bookmark plugin's `menu`: entasis `Popover` and `MenuOption` rows. */
	let { controller }: { controller: UrlPasteController } = $props();
</script>

<!--
	The editor keeps the keyboard: its keys move and pick (the plugin's hotkeys). The listbox's id, role and
	publication to the view's root are the controller's `popup` attachment, a row's ARIA its `option(index)`.
-->
<Floating
	anchor={() => controller.anchor}
	gap={4}
	haspopup="listbox"
	class="flex min-w-[200px] flex-col p-1"
	aria-label={words.urlPaste.menu}
	tabindex="-1"
	data-edytor-url-paste-menu
	{@attach controller.popup}
>
	{#each controller.open?.options ?? [] as option, index (option.id)}
		<MenuOption
			role="option"
			size="small"
			density="compact"
			highlighted={controller.index === index}
			{@attach controller.option(index)}
			attrs={{
				'data-edytor-url-paste-option': option.id,
				'data-selected': controller.index === index,
				onpointermove: () => (controller.index = index)
			}}
			onclick={() => controller.pick(option)}
		>
			{#snippet prefix()}<span aria-hidden="true">{option.icon}</span>{/snippet}
			{words.urlPaste[option.id] ?? option.id}
		</MenuOption>
	{/each}
</Floating>
