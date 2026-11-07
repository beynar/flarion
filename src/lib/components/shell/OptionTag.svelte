<script lang="ts">
	import type { BlockColorName } from '#lib/design/notion.tokens.ts';

	/** A select or status option: 20px tall, 3px corners, from the stronger option palette. */
	let { color = 'gray', label }: { color?: BlockColorName | string; label: string } = $props();
</script>

<span
	class="inline-flex items-center truncate px-1.5 text-sm leading-none whitespace-nowrap"
	style="height: var(--app-tag-height); border-radius: var(--app-tag-radius); background: var(--app-option-{color}-bg); color: var(--app-option-{color}-fg);"
>
	{label}
</span>
