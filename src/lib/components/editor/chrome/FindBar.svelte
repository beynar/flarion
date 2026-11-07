<script lang="ts">
	import Floating from './Floating.svelte';
	import { Button } from '../ui/index.ts';
	import { Input } from '../ui/index.ts';
	import { words } from './words.svelte.js';
	import type { FindController } from 'edytor';

	/** Notion's find bar, drawn for `createFindPlugin({ bar })`: the query, the count, the steps, Replace. */
	let { find }: { find: FindController } = $props();

	const labels = $derived(words.find);
	const count = $derived(
		find.matches.length ? labels.count(find.current + 1, find.matches.length) : labels.noResults
	);

	/** A button of the bar: `data-edytor-find-<name>`, its name and hint, its text, its action. */
	type Control = {
		name: string;
		label?: string;
		hint?: string;
		text: string;
		run: () => unknown;
		pressed?: boolean;
		disabled?: boolean;
	};
	const none = $derived(!find.matches.length);
	const searching: Control[] = $derived([
		{
			name: 'case',
			label: labels.matchCase,
			hint: labels.matchCase,
			text: 'Aa',
			run: () => (find.caseSensitive = !find.caseSensitive),
			pressed: find.caseSensitive
		},
		{
			name: 'previous',
			label: labels.previous,
			hint: labels.previousHint,
			text: '↑',
			run: find.previous,
			disabled: none
		},
		{
			name: 'next',
			label: labels.next,
			hint: labels.nextHint,
			text: '↓',
			run: find.next,
			disabled: none
		},
		{
			name: 'close',
			label: labels.close,
			hint: labels.closeHint,
			text: '✕',
			run: () => find.close()
		}
	]);
	const replacing: Control[] = $derived([
		{ name: 'replace', text: labels.replace, run: find.replace, disabled: none },
		{ name: 'replace-all', text: labels.replaceAll, run: find.replaceAll, disabled: none }
	]);
</script>

{#snippet buttons(list: Control[])}
	{#each list as button (button.name)}
		<Button
			variant="ghost"
			{...{ [`data-edytor-find-${button.name}`]: '' }}
			aria-label={button.label}
			title={button.hint}
			aria-pressed={button.pressed}
			disabled={button.disabled}
			onclick={() => button.run()}>{button.text}</Button
		>
	{/each}
{/snippet}

<Floating
	anchor={() => find.anchor}
	placement="top-end"
	gap={({ rects }) => -rects.floating.height - 8}
	class="find-bar flex flex-col gap-1.5 px-2 py-1.5"
	role="search"
	aria-label={labels.bar}
	data-edytor-find
>
	<div data-edytor-find-row>
		<Input
			class="field-find"
			data-edytor-find-query
			type="text"
			placeholder={labels.queryPlaceholder}
			aria-label={labels.query}
			autocomplete="off"
			spellcheck="false"
			value={find.query}
			oninput={(event) => (find.query = event.currentTarget.value)}
			{@attach find.field}
		/>
		<span data-edytor-find-count aria-live="polite">{find.query ? count : ''}</span>
		{@render buttons(searching)}
	</div>
	{#if find.canReplace}
		<div data-edytor-find-row>
			<Input
				class="field-find"
				data-edytor-find-replacement
				type="text"
				placeholder={labels.replaceWith}
				aria-label={labels.replaceWith}
				autocomplete="off"
				spellcheck="false"
				bind:value={find.replacement}
				{@attach find.replaceField}
			/>
			{@render buttons(replacing)}
		</div>
	{/if}
</Floating>

<style>
	:global([data-edytor-find-row]) {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	:global([data-edytor-find] .field-find) {
		width: 200px;
	}
	[data-edytor-find-count] {
		min-width: 64px;
		color: var(--app-text-secondary);
		font-size: 12px;
		text-align: center;
		white-space: nowrap;
	}
</style>
