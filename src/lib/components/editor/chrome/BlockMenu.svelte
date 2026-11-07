<script lang="ts">
	import Floating from './Floating.svelte';
	import MaskIcon from './MaskIcon.svelte';
	import { Input, Separator } from '../ui/index.ts';
	import { MenuOption } from 'entasis/menu-option';
	import { Switch } from 'entasis/switch';
	import { words } from './words.svelte.js';
	import { iconOf } from './icons.js';
	import { PALETTE } from './palette.js';
	import { blockMoves } from '../moves.svelte.ts';
	import {
		type BlockMenuAction,
		type BlockMenuColor,
		type BlockMenuController,
		type KindRow
	} from 'edytor';

	/** Notion's block menu, drawn for `createBlockMenuPlugin({ menu })`. */
	let { controller }: { controller: BlockMenuController } = $props();
	/** The menu's element: its flyout stands beside it (the flyout's `anchor`). */
	let menuNode = $state<HTMLElement>();
	const rows = $derived(controller.rows);
	const labels = $derived(words.blockMenu);

	/**
	 * Flarion's two page-level rows, after edytor's own: "Move to…" (another page, through the page picker) and
	 * "Turn into page" (a subpage holding the blocks). They need a workspace around the editor, so they exist only when the
	 * editor view registered `blockMoves`; a search keeps the ones it names.
	 */
	const pageRows = $derived.by(() => {
		if (!blockMoves.current) return [];
		const all = [
			{ id: 'moveTo', label: 'Move to…', run: (ids: string[]) => blockMoves.current?.moveTo(ids) },
			{ id: 'turnIntoPage', label: 'Turn into page', run: (ids: string[]) => void blockMoves.current?.turnIntoPage(ids) }
		];
		const query = controller.query.trim().toLowerCase();
		return query ? all.filter((row) => row.label.toLowerCase().includes(query) || 'move page subpage'.includes(query)) : all;
	});
	const runPageRow = (run: (ids: string[]) => void) => {
		const ids = controller.blocks.map((block) => block.id);
		controller.close(false);
		run(ids);
	};

	type Row = BlockMenuAction | KindRow | BlockMenuColor;
	/** A row's shape: a colour (`field`), a kind (`value`), or an action. */
	const shape = (row: Row) => ('field' in row ? 'color' : 'value' in row ? 'kind' : 'action');

	/**
	 * The heading over row `index` of `rows` (a flyout's with `flyout`) where
	 * its group starts: Turn into over the kinds, Color over the colours (in
	 * the Color flyout, one per field).
	 */
	const heading = (rows: Row[], index: number, flyout: boolean) => {
		const [row, before] = [rows[index]!, rows[index - 1]];
		const group = (of: Row) => (flyout && 'field' in of ? of.field : shape(of));
		if (shape(row) === 'action' || (before && group(before) === group(row))) return;
		if (!('field' in row)) return labels.turnInto;
		if (!flyout) return labels.color;
		return row.field === 'color' ? labels.textColor : labels.backgroundColor;
	};

	/**
	 * A row's own attributes (its pointer, its test id; its ARIA is the controller's `option` attachment): hovering
	 * makes it the keyboard's row (an action's also opens or closes its flyout), a click runs it as Enter does.
	 */
	const attributes = (row: Row, index: number, flyout: boolean): Record<string, any> => {
		const select = () => (flyout ? (controller.flyoutIndex = index) : (controller.index = index));
		const own = {
			'data-selected': (flyout ? controller.flyoutIndex : controller.index) === index,
			onclick: () => {
				select();
				controller.run(row);
			}
		};
		if ('field' in row)
			return {
				...own,
				'data-field': row.field,
				'data-current': controller.isCurrentColor(row),
				'data-testid': `block-menu-${row.id}`,
				onpointermove: select
			};
		if ('value' in row)
			return {
				...own,
				'data-current': flyout ? row === controller.currentKind : undefined,
				onpointermove: select
			};
		return {
			...own,
			'data-checked': row.checked,
			'data-submenu': row.submenu ? 'true' : undefined,
			'data-testid': `block-menu-${row.id}`,
			onpointerenter: () => {
				select();
				if (row.submenu) controller.openFlyout(row.submenu);
				else controller.flyout = false;
			}
		};
	};

	/**
	 * A colour row's swatch: its text colour on a white square, or its
	 * background; the theme token, with Notion's light value (the palette's).
	 */
	const swatch = (row: Row) => {
		if (!('field' in row) || row.value === null) return undefined;
		const light = PALETTE.find(({ name }) => name.toLowerCase() === row.value)!;
		return `var(--edytor-${row.field}-${row.value}, ${row.field === 'color' ? light.text : light.background})`;
	};
</script>

{#snippet list(rows: Row[], flyout: boolean)}
	{#each rows as row, index (`${shape(row)}:${row.id}`)}
		{@const title = heading(rows, index, flyout)}
		{@const { onclick, onpointermove, onpointerenter, ...attrs } = attributes(row, index, flyout)}
		{@const current = 'value' in row && flyout && row === controller.currentKind}
		{@const checked = 'checked' in row ? row.checked : undefined}
		{#if title}<div class="text-neutral/70 px-2 pt-1.5 pb-1 text-xs font-medium select-none" role="presentation">{title}</div>{/if}
		{#if row.id === 'delete' || row.id === 'duplicate'}<Separator class="my-1" />{/if}
		<MenuOption
			role="menuitem"
			size="small"
			density="compact"
			color={'icon' in row && 'danger' in row && row.danger ? 'danger' : 'neutral'}
			highlighted={(flyout ? controller.flyoutIndex : controller.index) === index}
			{@attach controller.option(index, flyout)}
			attrs={{ ...attrs, onpointermove, onpointerenter }}
			{onclick}
		>
			{#snippet prefix()}
				{#if 'field' in row}
					<span
						aria-hidden="true"
						class="inline-grid size-5 shrink-0 place-items-center rounded-[4px] text-[13px] font-medium shadow-[inset_0_0_0_1px_var(--app-hairline)]"
						style="{row.field === 'background' ? `background: ${swatch(row) ?? 'var(--app-page)'}` : `color: ${swatch(row) ?? 'var(--app-text)'}`}"
						>{row.field === 'background' ? '' : 'A'}</span
					>
				{:else}
					<MaskIcon icon={iconOf('value' in row ? row.id : row.icon)} />
				{/if}
			{/snippet}
			{row.label}
			{#snippet suffix()}
				{#if 'field' in row || 'value' in row}
					{#if current || ('field' in row && controller.isCurrentColor(row))}<span class="text-sm">✓</span>{/if}
				{:else if checked !== undefined}
					<!-- A kind's switch (a table's Header row): entasis Switch, display only (the row is the control). -->
					<Switch size="small" value={checked} readOnly class="pointer-events-none" inputAttrs={{ tabindex: -1, 'aria-hidden': 'true' }} />
				{:else if row.submenu}
					<span class="text-base leading-none">›</span>
				{:else if row.hint}
					<span class="text-neutral/70 text-xs">{row.hint}</span>
				{/if}
			{/snippet}
		</MenuOption>
	{/each}
{/snippet}

<!--
	The keys, the ids, the roles and the publication to the view's root are the controller's attachments (`keys`,
	`popup`, `flyoutMenu`, `option`). The surfaces are entasis `Popover` (`Floating`), the rows `MenuOption`s, the
	search a `TextInput`.
-->
<div class="block-menu-frame contents" data-edytor-block-menu-frame>
	<Floating
		anchor={() => controller.anchor}
		placement="right-start"
		fallback={['left-start']}
		haspopup="menu"
		class="flex w-[265px] max-h-[min(70vh,480px)] flex-col overflow-hidden"
		data-testid="block-menu"
		data-edytor-block-menu
		bind:element={menuNode}
	>
		<div class="px-2 pt-2 pb-1">
			<Input
				placeholder={labels.search}
				aria-label={labels.searchLabel}
				value={controller.query}
				{@attach controller.keys}
				oninput={(event) => controller.search(event.currentTarget.value)}
			/>
		</div>
		<div class="overflow-y-auto p-1" aria-label={labels.menu} {@attach controller.popup}>
			{#if !controller.query}
				<div class="text-neutral/70 px-2 pt-1.5 pb-1 text-xs font-medium select-none" role="presentation">
					{controller.currentKind?.label ?? labels.block}
				</div>
			{/if}
			{@render list(rows, false)}
			{#each pageRows as row (row.id)}
				<MenuOption
					role="menuitem"
					size="small"
					density="compact"
					attrs={{ 'data-testid': `block-menu-${row.id}` }}
					onclick={() => runPageRow(row.run)}
				>
					{#snippet prefix()}<MaskIcon icon={iconOf(`action.${row.id}`)} />{/snippet}
					{row.label}
				</MenuOption>
			{/each}
			{#if rows.length === 0 && pageRows.length === 0}
				<div class="text-neutral/70 px-2 py-1.5" role="presentation">{labels.noResults}</div>
			{/if}
		</div>
	</Floating>
	<!-- The open flyout: a new element for each (its id, name and opening). -->
	{#each controller.flyout ? [controller.flyout] : [] as flyout (flyout)}
		<Floating
			anchor={() => menuNode}
			placement="right-start"
			gap={4}
			fallback={['left-start']}
			haspopup="menu"
			class="flex w-[220px] max-h-[min(480px,calc(100vh-16px))] flex-col overflow-hidden"
			role="menu"
			aria-label={flyout === 'color' ? labels.color : labels.turnInto}
			{@attach controller.flyoutMenu}
		>
			<div class="overflow-y-auto p-1" role="presentation">
				{@render list(controller.flyoutRows, true)}
			</div>
		</Floating>
	{/each}
</div>
