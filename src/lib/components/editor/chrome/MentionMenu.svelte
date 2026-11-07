<script lang="ts">
	import { words } from './words.svelte.js';
	import TriggerMenu from './TriggerMenu.svelte';
	import type { MentionItem, TriggerMenuController } from 'edytor';
	import { Avatar } from 'entasis/avatar';
	import { Button } from '../ui/index.ts';
	import { cn } from '../ui/cn.ts';
	import { row as rowClass } from './ui.js';

	/** Notion's `@` menu, drawn for `createMentionPlugin({ menu })`: a person's avatar, name and line. */
	let { controller }: { controller: TriggerMenuController<MentionItem> } = $props();

	/** An avatar's URL when it is one an `img` may load (http, https, a data image), else nothing. */
	const avatarOf = (src: unknown) =>
		typeof src === 'string' && /^(https?:|data:image\/)/i.test(src.trim()) ? src : undefined;
</script>

<TriggerMenu {controller} said={words.mention}>
	{#snippet row(item: MentionItem, index: number)}
		<Button
			variant="ghost"
			class={cn(rowClass, 'row h-auto min-h-8 py-1')}
			data-selected={controller.index === index}
			{@attach controller.option(index)}
			data-testid="trigger-menu-item"
			data-mention-kind={controller.trigger.name}
			onmousemove={() => (controller.index = index)}
			onclick={() => void controller.pick(item)}
		>
			<Avatar name={item.label} src={avatarOf(item.avatar)} size="small" alt="" />
			<span class="name truncate">{item.label}</span>
			{#if item.description}<span class="description text-[color:var(--app-text-secondary)] ml-auto truncate text-xs"
					>{item.description}</span
				>{/if}
		</Button>
	{/snippet}
</TriggerMenu>
