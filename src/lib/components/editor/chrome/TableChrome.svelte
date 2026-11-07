<script module lang="ts">
	/** A table menu row's icon, by its id. */
	export const TABLE_ICONS: Record<string, string> = {
		'insert-above': 'action.up',
		'insert-below': 'action.down',
		'move-up': 'action.up',
		'move-down': 'action.down',
		'insert-left': 'table.left',
		'insert-right': 'table.right',
		'move-left': 'table.left',
		'move-right': 'table.right',
		'delete-row': 'action.delete',
		'delete-column': 'action.delete'
	};
</script>

<script lang="ts">
	import Floating from './Floating.svelte';
	import MaskIcon from './MaskIcon.svelte';
	import { MenuOption } from 'entasis/menu-option';
	import { Button } from '../ui/index.ts';
	import { words } from './words.svelte.js';
	import { iconOf } from './icons.js';
	import { keepFocus } from './keepFocus.js';
	import type { TableAddPayload, TableChrome, TableGripPayload } from 'edytor';

	/**
	 * Notion's table chrome, drawn for `createTablePlugin({ grip, menu, add })`:
	 * one of a row's or a column's grip (`grip`), its menu (`menu`), or the
	 * `+` under or beside the table (`add`).
	 */
	let { grip, menu, add }: { grip?: TableGripPayload; menu?: TableChrome; add?: TableAddPayload } =
		$props();
</script>

{#if grip}
	<Button
		variant="ghost"
		class="table-grip"
		data-edytor-table-grip={grip.kind}
		aria-label={words.table[`${grip.kind}Menu`]}
		{@attach grip.grip}
		><span aria-hidden="true" class="table-grip-glyph">{grip.kind === 'column' ? '⋯' : '⋮⋮'}</span></Button
	>
{:else if menu}
	<Floating
		anchor={() => menu.anchor}
		gap={4}
		class="table-menu w-[200px] p-1.5 pointer-events-auto"
		aria-label={words.table[`${menu.menu?.kind ?? 'row'}Menu`]}
		{@attach menu.popup}
		{@attach menu.keys}
	>
		{#each menu.items as item (item.item.id)}
			<MenuOption
				role="menuitem"
				size="small"
				density="compact"
				color={item.danger ? 'danger' : 'neutral'}
				disabled={item.disabled}
				highlighted={item.selected}
				{@attach item.option}
				attrs={{
					'data-selected': item.selected,
					'data-testid': `table-menu-${item.item.id}`,
					onpointermove: item.select
				}}
				onclick={item.run}
			>
				{#snippet prefix()}<MaskIcon icon={iconOf(TABLE_ICONS[item.item.id] ?? '')} />{/snippet}
				{words.table[item.item.id.replace(/-./g, (m) => m[1]!.toUpperCase())]}
			</MenuOption>
		{/each}
	</Floating>
{:else if add}
	<Button
		variant="ghost"
		class="table-add"
		data-edytor-table-add={add.kind}
		aria-label={add.kind === 'row' ? words.table.addRow : words.table.addColumn}
		title={add.kind === 'row' ? words.table.addRow : words.table.addColumn}
		onmousedown={keepFocus}
		onclick={add.add}
		><span aria-hidden="true">+</span></Button
	>
{/if}

<style>
	:global(.table-grip),
	:global(.table-add) {
		margin: 0;
		padding: 0;
		border: none;
	}
	:global(.table-grip) {
		width: 18px;
		height: 24px;
		border-radius: 4px;
		background: var(--edytor-table-grip-background, var(--app-page));
		box-shadow:
			0 0 0 1px var(--app-hairline),
			0 2px 4px var(--app-hairline);
		color: var(--app-text-secondary);
		cursor: grab;
	}
	:global(.table-grip[data-dragging='true']) {
		cursor: grabbing;
	}
	:global(.table-grip[data-edytor-table-grip='column']) {
		width: 24px;
		height: 18px;
	}
	.table-grip-glyph {
		font-size: 10px;
		letter-spacing: -2px;
		line-height: 1;
	}
	:global(.table-grip[data-edytor-table-grip='column']) .table-grip-glyph {
		font-size: 14px;
		letter-spacing: 0;
	}
	:global(.table-add) {
		display: block;
		width: 100%;
		height: 16px;
		border-radius: 3px;
		background: var(--app-hover);
		color: var(--app-text-secondary);
		cursor: pointer;
		opacity: 0;
		transition: opacity 80ms ease;
	}
	:global(.table-add[data-edytor-table-add='column']) {
		width: 16px;
		height: 100%;
	}
	:global(.table-add) {
		font-size: 14px;
	}
	:global(.table-add:hover),
	:global(.table-add:focus-visible) {
		opacity: 1;
		background: var(--app-hover);
	}
</style>
