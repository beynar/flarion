<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from './cn.ts';

	let { class: className, ...rest }: HTMLAttributes<HTMLElement> = $props();
</script>

<div role="separator" class={cn('h-px w-full shrink-0 bg-[color:var(--app-hairline)]', className)} {...rest}></div>
