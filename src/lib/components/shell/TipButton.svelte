<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import { Button, type ButtonProps } from 'entasis/button';
	import { Kbd } from 'entasis/kbd';
	import { tooltip } from 'entasis/tooltip';

	/**
	 * An entasis `Button` with an entasis tooltip (`tooltip()` attachment): Notion shows a tooltip on every icon button,
	 * with the shortcut in a `Kbd` when there is one. `Button.label` is only an aria-label, so the tooltip is added here.
	 * `attach` carries a Popover or PopupMenu trigger attachment onto the same element.
	 */
	let {
		tip,
		keys,
		position = 'bottom',
		attach,
		...rest
	}: ButtonProps & {
		tip: string;
		/** The shortcut, one entry per key: `['⌘', 'K']`. */
		keys?: string[];
		position?: 'top' | 'bottom' | 'left' | 'right' | 'bottom-start' | 'bottom-end' | 'right-start';
		attach?: Attachment<HTMLElement>;
	} = $props();
</script>

{#snippet tipWithKeys()}
	<span class="flex items-center gap-2">
		{tip}
		<Kbd size="small" keys={keys ?? []} />
	</span>
{/snippet}

<Button label={tip} {...rest} {@attach tooltip({ content: keys?.length ? tipWithKeys : tip, position, delay: 400, offset: 6 })} {@attach attach} />
