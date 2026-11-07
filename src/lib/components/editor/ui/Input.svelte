<script lang="ts">
	import { TextInput } from 'entasis/text-input';
	import type { HTMLInputAttributes } from 'svelte/elements';

	/**
	 * The chrome's text field: entasis `TextInput`. Everything it does not own (ARIA, `data-*`, the controllers'
	 * `{@attach controller.keys}`) goes to the `<input>` through `inputAttrs`, which entasis spreads onto it.
	 */
	let {
		class: className,
		value = $bindable(''),
		placeholder,
		disabled,
		readonly,
		type,
		oninput,
		...rest
	}: HTMLInputAttributes = $props();
</script>

<TextInput
	size="small"
	class={className as string | undefined}
	type={(type === 'url' || type === 'email' ? type : 'text') as 'text'}
	bind:value={value as string}
	placeholder={placeholder ?? undefined}
	disabled={disabled ?? undefined}
	readOnly={readonly ?? undefined}
	inputAttrs={{ ...rest, oninput } as never}
/>
