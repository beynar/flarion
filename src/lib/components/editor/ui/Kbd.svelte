<script lang="ts">
	import { Kbd, type KbdProps } from 'entasis/kbd';

	/** A key hint: entasis `Kbd` (its keys are the children's text). */
	let { children, ...rest }: Omit<KbdProps, 'children' | 'keys'> & { children?: import('svelte').Snippet } = $props();
</script>

<Kbd size="small" {...rest} {children} />
