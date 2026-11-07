<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from './cn.ts';

	let { class: className, children, ...rest }: HTMLAttributes<HTMLElement> = $props();
</script>

<kbd
	class={cn(
		'pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-[3px] px-1 font-sans text-xs font-medium text-[color:var(--app-text-secondary)] select-none',
		className
	)}
	{...rest}>{@render children?.()}</kbd
>
