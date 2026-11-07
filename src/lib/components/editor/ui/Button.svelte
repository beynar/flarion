<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { cn } from './cn.ts';
	import { buttonVariants, type ButtonSize, type ButtonVariant } from './variants.ts';

	/**
	 * A native button in the chrome's looks. Not entasis's Button on purpose: the editor's controllers
	 * attach keys, ARIA and `data-*` state straight to the element (`{@attach controller.option(i)}`),
	 * and a press must not move the editor's focus, which a plain element guarantees.
	 */
	let {
		class: className,
		variant = 'default',
		size = 'default',
		type = 'button',
		children,
		...rest
	}: HTMLButtonAttributes & { variant?: ButtonVariant; size?: ButtonSize } = $props();
</script>

<button {type} class={cn(buttonVariants({ variant, size }), className)} {...rest}>
	{@render children?.()}
</button>
