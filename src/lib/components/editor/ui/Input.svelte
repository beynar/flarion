<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from './cn.ts';

	let { class: className, value = $bindable(), ...rest }: HTMLInputAttributes = $props();
</script>

<input
	class={cn(
		'h-8 w-full min-w-0 rounded-[6px] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-input-fill)] px-2 text-sm text-[color:var(--app-text)] outline-none placeholder:text-[color:var(--app-text-tertiary)] focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent)]/25 disabled:opacity-50',
		className
	)}
	bind:value
	{...rest}
/>
