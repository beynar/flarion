<script lang="ts">
	import { words } from './words.svelte.js';
	import TriggerMenu from './TriggerMenu.svelte';
	import type { PageLinkItem, TriggerMenuController } from 'edytor';
	import { MenuOption } from 'entasis/menu-option';

	/** Notion's `[[` menu, drawn for `createPageLinkPlugin({ menu })`: a page's icon and title. */
	let { controller }: { controller: TriggerMenuController<PageLinkItem> } = $props();
</script>

<TriggerMenu {controller} said={words.pageLink}>
	{#snippet row(item: PageLinkItem, index: number, attrs: (index: number) => Record<string, unknown>)}
		<MenuOption
			role="option"
			size="small"
			density="compact"
			highlighted={controller.index === index}
			{@attach controller.option(index)}
			attrs={{ ...attrs(index), 'data-testid': 'trigger-menu-item' }}
			onclick={() => void controller.pick(item)}
		>
			{#snippet prefix()}<span aria-hidden="true">{item.icon ?? '📄'}</span>{/snippet}
			<span class="title truncate">{item.title}</span>
		</MenuOption>
	{/snippet}
</TriggerMenu>
