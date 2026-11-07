<script lang="ts">
	import { Popover } from 'entasis/popover';
	import { Command } from 'entasis/command';
	import type { Snippet } from 'svelte';
	import { EMOJI_GROUPS } from '#lib/components/page-header/emojis.ts';

	/**
	 * The emoji picker shared by the page header, the sidebar and the teamspace dialogs: an entasis
	 * Popover around a Command (search, groups, keyboard) with a Remove row. `button` renders the
	 * trigger and receives the Popover's `attach`.
	 */
	let {
		current,
		onpick,
		button,
		position = 'bottom-start'
	}: {
		current: string | null;
		onpick: (icon: string | null) => void;
		button: Snippet<[{ attach: import('svelte/attachments').Attachment<HTMLElement>; open: boolean }]>;
		position?: 'bottom-start' | 'bottom-end' | 'right-start' | 'top-start';
	} = $props();

	const items = EMOJI_GROUPS.map((group) => ({
		heading: group.heading,
		items: group.emojis.map(([emoji, name]) => ({ value: emoji, label: `${emoji}  ${name.split(' ')[0]}`, keywords: name.split(' ') }))
	}));
</script>

<Popover {position} focusOnOpen="first" modal={false}>
	{#snippet trigger(popover)}
		{@render button({ attach: popover.trigger, open: popover.isOpen })}
	{/snippet}
	{#snippet children(popover)}
		<div class="icon-picker" data-testid="icon-picker">
			<Command
				{items}
				placeholder="Filter emojis…"
				onSelect={(value) => {
					onpick(value);
					popover.close();
				}}
			/>
			{#if current}
				<button
					type="button"
					class="icon-remove"
					data-testid="icon-remove"
					onclick={() => {
						onpick(null);
						popover.close();
					}}>Remove icon</button
				>
			{/if}
		</div>
	{/snippet}
</Popover>

<style>
	.icon-picker {
		width: 320px;
		max-height: 380px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.icon-remove {
		margin: 0;
		padding: 6px 12px;
		border-top: 1px solid var(--app-hairline);
		color: var(--app-text-secondary);
		font-size: var(--app-font-size-chrome);
		text-align: left;
		cursor: pointer;
	}
	.icon-remove:hover {
		background: var(--app-hover);
	}
</style>
