<script lang="ts">
	import Floating from './Floating.svelte';
	import { Alert } from 'entasis/alert';
	import { Button } from '../ui/index.ts';
	import { Textarea } from '../ui/index.ts';
	import { words } from './words.svelte.js';
	import type { EquationEditor } from 'edytor';

	/**
	 * Notion's equation editor, drawn for `createEquationPlugin({ panel })`:
	 * the TeX source in a field, KaTeX's error under it, and Done. The
	 * equation itself is the preview: each keystroke writes it.
	 */
	let { editor }: { editor: EquationEditor } = $props();

	const labels = $derived(words.equation);
</script>

<Floating
	anchor={() => editor.anchor}
	placement={editor.display ? 'bottom' : 'bottom-start'}
	gap={6}
	haspopup="grid"
	class="box-border flex w-[400px] max-w-[calc(100vw-32px)] flex-col gap-1.5 p-2"
	role="dialog"
	aria-label={labels.editor}
	data-edytor-equation-editor
>
	<div class="flex items-start gap-2">
		<Textarea
			class="flex-1 font-mono"
			aria-label={labels.editor}
			placeholder={labels.placeholder}
			rows={editor.display ? 3 : 1}
			spellcheck="false"
			autocomplete="off"
			autocapitalize="off"
			value={editor.expression}
			oninput={(event) => editor.set(event.currentTarget.value)}
			{@attach editor.field}
		></Textarea>
		<Button
			variant="default"
			data-edytor-equation-done
			onmousedown={(event) => event.preventDefault()}
			onclick={() => editor.close()}>{labels.done} <span aria-hidden="true">↵</span></Button
		>
	</div>
	{#if editor.error}
		<div data-edytor-equation-editor-error role="status">
			<Alert color="danger" variant="soft" size="small">{editor.error}</Alert>
		</div>
	{/if}
</Floating>
