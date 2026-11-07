<script lang="ts">
	import { Button as EntasisButton, type ButtonProps } from 'entasis/button';
	import { tooltip } from 'entasis/tooltip';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { ButtonSize, ButtonVariant } from './variants.ts';
	import { entasisSize, entasisVariant } from './variants.ts';

	/**
	 * The chrome's button: entasis `Button` (variants and sizes mapped from the chrome's names). The editor's
	 * controllers attach keys, ARIA and `data-*` state straight to it (`{@attach controller.option(i)}`,
	 * entasis spreads attachments onto its `<button>`), and the menus' hosts cancel `mousedown` (`keepFocus`), so a
	 * press never moves the editor's focus. A `title` is an entasis tooltip (`tooltip()`), not a native one.
	 */
	let {
		class: className,
		variant = 'default',
		size = 'default',
		type = 'button',
		title,
		children,
		...rest
	}: HTMLButtonAttributes & { variant?: ButtonVariant; size?: ButtonSize } = $props();
</script>

<EntasisButton
	{type}
	variant={entasisVariant[variant]}
	size={entasisSize[size]}
	squared={size.startsWith('icon') ? true : undefined}
	class={className as string | undefined}
	{...rest as ButtonProps}
	{@attach title ? tooltip({ content: title, position: 'top', delay: 400, offset: 6 }) : undefined}
>
	{@render children?.()}
</EntasisButton>
