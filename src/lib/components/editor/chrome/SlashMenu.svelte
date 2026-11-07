<script lang="ts">
	import { words } from './words.svelte.js';
	import { iconOf } from './icons.js';
	import Floating from './Floating.svelte';
	import MaskIcon from './MaskIcon.svelte';
	import { Input, Kbd, Separator } from '../ui/index.ts';
	import { Button } from 'entasis/button';
	import { MenuOption } from 'entasis/menu-option';
	import type { EditorCommand, SlashMenuController } from 'edytor';

	/**
	 * The slash menu and the `+`'s menu (Notion's), drawn for `createSlashMenuPlugin({ menu })`: entasis `Popover`
	 * (`Floating`) holding `MenuOption` rows, a `TextInput` for the `+`'s filter, `Separator` and `Kbd`.
	 */
	let { controller }: { controller: SlashMenuController } = $props();
	const commands = $derived(controller.commands);
	const labels = $derived(words.slashMenu);

	/** The rows by group, in order (Notion's headings): a `group` per run of one group's rows. */
	const groups = $derived.by(() => {
		const runs: { name: string; rows: { command: EditorCommand; index: number }[] }[] = [];
		commands.forEach((command, index) => {
			const name = command.group ?? '';
			const run = runs.at(-1);
			if (run && run.name === name) run.rows.push({ command, index });
			else runs.push({ name, rows: [{ command, index }] });
		});
		return runs;
	});
</script>

<!--
	The keys of a `+`'s menu (`keys`, on the filter field), the listbox's id, role and publication to the view's
	root (`popup`) and a row's ARIA (`option(index)`) are the controller's attachments, laid on entasis components
	(`MenuOption` and `TextInput` spread them onto their element). A press keeps the focus where it is (`Floating`).
-->
<Floating
	anchor={() => controller.anchor}
	haspopup="listbox"
	class="flex w-[324px] max-h-[min(40vh,380px)] min-h-[120px] flex-col overflow-hidden"
	data-testid="slash-menu"
>
	{#if controller.addition}
		<Input
			class="mx-2 mt-2 w-auto"
			placeholder={labels.filter}
			aria-label={labels.filterLabel}
			role="combobox"
			aria-expanded="true"
			aria-autocomplete="list"
			aria-controls={controller.listId}
			value={controller.query}
			{@attach controller.keys}
			oninput={(event) => controller.search(event.currentTarget.value)}
		/>
	{:else}
		<div class="sr-only" data-testid="slash-menu-query" aria-live="polite">/{controller.query}</div>
	{/if}
	<div class="flex-1 overflow-y-auto p-1" aria-label={labels.list} {@attach controller.popup}>
		{#if commands.length === 0}
			<div class="text-neutral/70 px-2 py-1.5" data-testid="slash-menu-empty">{labels.noResults}</div>
		{/if}
		{#each groups as group, at (`${at}:${group.name}`)}
			<div role="group" aria-label={group.name ? (labels.groups[group.name] ?? group.name) : undefined}>
				{#if group.name}<div class="text-neutral/70 px-2 pt-2 pb-1 text-xs font-medium" aria-hidden="true">
						{labels.groups[group.name] ?? group.name}
					</div>{/if}
				{#each group.rows as { command, index } (command.id)}
					<MenuOption
						role="option"
						size="small"
						density="compact"
						highlighted={controller.index === index}
						{@attach controller.option(index)}
						attrs={{
							'data-command-id': command.id,
							'data-testid': 'slash-menu-item',
							'data-selected': controller.index === index,
							onpointermove: () => (controller.index = index)
						}}
						onclick={() => {
							void controller.run(command);
						}}
					>
						{#snippet prefix()}<MaskIcon icon={iconOf(command.id)} glyph={command.icon ?? '⋮'} />{/snippet}
						{command.label}
						{#snippet suffix()}{#if command.hint}<span class="text-neutral/70 text-xs">{command.hint}</span>{/if}{/snippet}
					</MenuOption>
				{/each}
			</div>
		{/each}
	</div>
	<Separator />
	<Button variant="ghost" size="small" class="w-full justify-between rounded-none" tabindex={-1} onclick={() => controller.dismiss()}>
		<span>{labels.close}</span><Kbd>{labels.closeKey}</Kbd>
	</Button>
</Floating>
