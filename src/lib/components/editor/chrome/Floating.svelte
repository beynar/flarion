<script lang="ts">
	/**
	 * The surface every positioned menu of the chrome stands on: an entasis `Popover` panel (its raised, rounded
	 * surface and its motion) held open by the controller (`controller.isOpen` mounts the snippet) and placed against
	 * the controller's `anchor` (a virtual element read live: the caret, the selection, a handle) by Floating UI
	 * (`float`), which entasis's own positioner uses. The popover is `inline`, never portaled: the controllers keep the
	 * keyboard, the focus and the ARIA, and a panel moved to the body layer would drop the focus of the field they just
	 * focused. It never closes itself (focus out, outside press and Escape are the controller's) and never locks scroll.
	 */
	import { Popover } from 'entasis/popover';
	import type { Snippet } from 'svelte';
	import type { VirtualElement } from '@floating-ui/dom';
	import { float, type FloatOptions } from './float.js';
	import { keepFocus } from './keepFocus.js';

	let {
		anchor,
		placement = 'bottom-start',
		gap = 8,
		fallback,
		haspopup = 'menu',
		class: className = '',
		element = $bindable<HTMLElement | undefined>(),
		children,
		...rest
	}: {
		anchor: () => VirtualElement | Element | null | undefined;
		placement?: FloatOptions['placement'];
		gap?: FloatOptions['gap'];
		fallback?: FloatOptions['fallback'];
		haspopup?: 'menu' | 'listbox' | 'grid' | true;
		/** Classes of the content element (its size). */
		class?: string;
		/** The surface's content element (a flyout stands against it). */
		element?: HTMLElement;
		children: Snippet;
		[key: string]: unknown;
	} = $props();
</script>

<div class="fixed z-50" {@attach float(anchor, { placement, gap, fallback })}>
	<Popover open inline trigger={false} {haspopup} focusOnOpen={false} closeOnFocusOut={false} closeOnClickOutside={false} closeOnEscape={false} lockScroll={false} mobileSheet={false} tabBridge={false} directedTransition={false} class="p-0! w-auto! max-w-none!">
		<div role="presentation" class={className} bind:this={element} onmousedown={keepFocus} {...rest}>
			{@render children()}
		</div>
	</Popover>
</div>
