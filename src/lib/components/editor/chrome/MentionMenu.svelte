<script lang="ts">
	import { words } from './words.svelte.js';
	import TriggerMenu from './TriggerMenu.svelte';
	import type { MentionItem, TriggerMenuController } from 'edytor';
	import { Avatar } from 'entasis/avatar';
	import { MenuOption } from 'entasis/menu-option';
	import { isPageMention } from '../mentions.ts';

	/** Notion's `@` menu, drawn for `createMentionPlugin({ menu })`: a person's avatar, name and line. */
	let { controller }: { controller: TriggerMenuController<MentionItem> } = $props();

	/** An avatar's URL when it is one an `img` may load (http, https, a data image), else nothing. */
	const avatarOf = (src: unknown) =>
		typeof src === 'string' && /^(https?:|data:image\/)/i.test(src.trim()) ? src : undefined;
</script>

<TriggerMenu {controller} said={words.mention}>
	{#snippet row(item: MentionItem, index: number, attrs: (index: number) => Record<string, unknown>)}
		<MenuOption
			role="option"
			size="small"
			density="compact"
			highlighted={controller.index === index}
			{@attach controller.option(index)}
			attrs={{ ...attrs(index), 'data-testid': 'trigger-menu-item', 'data-mention-kind': controller.trigger.name }}
			onclick={() => void controller.pick(item)}
		>
			{#snippet prefix()}
				{#if isPageMention(item.id)}
					<!-- A page's label already starts with its emoji when it has one; initials of an emoji are garbage. -->
					{#if !/^\p{Extended_Pictographic}/u.test(item.label)}<span aria-hidden="true">📄</span>{/if}
				{:else}
					<Avatar name={item.label} src={avatarOf(item.avatar)} size="small" alt="" />
				{/if}
			{/snippet}
			<span class="name truncate">{item.label}</span>
			{#snippet suffix()}{#if item.description}<span class="description text-neutral/70 truncate text-xs">{item.description}</span>{/if}{/snippet}
		</MenuOption>
	{/snippet}
</TriggerMenu>
