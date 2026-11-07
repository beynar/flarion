<script lang="ts">
	import { TextArea } from 'entasis/text-area';
	import type { HTMLTextareaAttributes } from 'svelte/elements';

	/** The chrome's multi-line field: entasis `TextArea`; the controllers' attachments and ARIA go to the `<textarea>`. */
	let {
		class: className,
		value = $bindable(''),
		placeholder,
		disabled,
		readonly,
		rows,
		...rest
	}: HTMLTextareaAttributes = $props();
</script>

<TextArea
	size="small"
	class={className as string | undefined}
	bind:value={value as string}
	placeholder={placeholder ?? undefined}
	disabled={disabled ?? undefined}
	readOnly={readonly ?? undefined}
	rows={rows ?? undefined}
	textareaAttrs={rest as never}
/>
