<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { cn } from './cn.ts';

	let { class: className, value = $bindable(), ...rest }: HTMLTextareaAttributes = $props();
</script>

<textarea
	class={cn(
		'min-h-16 w-full rounded-[6px] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-input-fill)] px-2 py-1.5 text-sm text-[color:var(--app-text)] outline-none placeholder:text-[color:var(--app-text-tertiary)] focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent)]/25',
		className
	)}
	bind:value
	{...rest}
></textarea>
