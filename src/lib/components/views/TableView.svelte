<!--
	The table layout: entasis Data table over the view's window. Rows are virtualized (a window holds up to a
	thousand), cells edit in place with the property cells of the page header, columns resize (widths persist in the
	view's `columns_json`), the first column can freeze, cells can wrap, rows drag into place under manual order, and
	a "+" header adds a property. The sort is the view's (server side): headers sort through their menu.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { DataTable, type DataTableColumn, type DataTableState } from 'entasis/data-table';
	import { PopupMenu } from 'entasis/popup-menu';
	import type { MenuItem } from 'entasis/menu';
	import { Button } from 'entasis/button';
	import { Empty } from 'entasis/empty';
	import { plusIcon } from 'entasis/icons/plus';
	import { caretDownIcon } from 'entasis/icons/caretDown';
	import { sortAscendingIcon } from 'entasis/icons/sortAscending';
	import { sortDescendingIcon } from 'entasis/icons/sortDescending';
	import { eyeSlashIcon } from 'entasis/icons/eyeSlash';
	import type { ViewData } from '#lib/client/workspace.svelte.ts';
	import PropertyEditor from '#lib/components/properties/PropertyEditor.svelte';
	import AddProperty from '#lib/components/properties/AddProperty.svelte';
	import { TYPE_ICONS } from '#lib/components/properties/icons.ts';
	import { newPropertyDef } from '#lib/components/properties/helpers.ts';
	import { TITLE_PROP_ID, type PropertyDef, type PropertyType } from '#lib/shared/property-types.ts';
	import type { ViewRow } from '#lib/shared/protocol.ts';
	import type { ViewEnv } from './env.ts';
	import TitleCell from './TitleCell.svelte';
	import { allColumns, columnsFromEntries, optionsOfView, withColumnShown } from './view-model.ts';

	let { env, data, focusId = $bindable(null) }: { env: ViewEnv; data: ViewData; focusId?: string | null } = $props();

	const ROW = 36;
	const HEADER = 34;
	const o = $derived(optionsOfView(env.view));
	const wrap = $derived(!!o.wrapCells);
	const frozen = $derived(!!o.frozenFirstColumn);
	const reorder = $derived(env.editable && env.manualOrder);

	// The rows the table shows: a local copy, so a drag can reorder them before the server confirms.
	let items = $state.raw<ViewRow[]>(untrack(() => data.rows));
	$effect.pre(() => {
		items = data.rows;
	});

	const defs = $derived(new Map(env.columns.map((c) => [c.def.id, c.def])));
	const columns = $derived<DataTableColumn<ViewRow>[]>(
		env.columns.map((c) => ({
			id: c.def.id,
			accessor: (row: ViewRow) => (c.def.id === TITLE_PROP_ID ? row.title : (row.values[c.def.id] ?? null)),
			header: c.def.name,
			width: c.width,
			minWidth: 80,
			resizable: true,
			sortable: false,
			pinnable: false,
			hideable: false,
			reorderable: false
		}))
	);
	// What changes the table's structure rebuilds it: the columns, freezing and wrapping (not their widths).
	const structure = $derived(`${env.columns.map((c) => c.def.id).join(',')}|${frozen}|${wrap}|${reorder}`);

	// ───────────── size ─────────────
	let innerHeight = $state(900);
	const maxHeight = $derived(env.fullPage ? Math.max(360, innerHeight - 250) : 520);
	const height = $derived(Math.max(HEADER + 3 * ROW, Math.min(maxHeight, HEADER + Math.max(items.length, 1) * ROW + 14)));

	// ───────────── widths persist ─────────────
	let sizing: Record<string, number> = {};
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	function onStateChange(state: DataTableState) {
		const next = state.columnSizing ?? {};
		if (JSON.stringify(next) === JSON.stringify(sizing)) return;
		sizing = { ...next };
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			if (!env.editable) return;
			const entries = allColumns(env.view, env.collection, env.properties);
			const widths = { ...Object.fromEntries(env.view.columns.columns.filter((c) => c.width).map((c) => [c.prop, c.width!])), ...sizing };
			void env.updateView({ columns: { columns: columnsFromEntries(entries, widths), options: env.view.columns.options } }).catch(() => undefined);
		}, 400);
	}

	// ───────────── infinite window ─────────────
	let root = $state<HTMLElement | null>(null);
	// A capturing listener on the table's root sees the scroll of whichever element the table scrolls in (the viewport is created, and
	// replaced, while the page hydrates: a listener on the first match could be on an element that is gone before anyone scrolls).
	$effect(() => {
		const host = root;
		void items.length;
		if (!host) return;
		const near = (el: HTMLElement) => {
			if (el.scrollTop + el.clientHeight > el.scrollHeight - 6 * ROW) untrack(() => env.loadMore());
		};
		const onScroll = (event: Event) => {
			if (event.target instanceof HTMLElement && event.target !== document.documentElement) near(event.target);
		};
		host.addEventListener('scroll', onScroll, { capture: true, passive: true });
		const el = host.querySelector<HTMLElement>('[data-slot="scroll-viewport"], [data-scroll-viewport], .overflow-auto, [style*="overflow"]');
		if (el) near(el);
		return () => host.removeEventListener('scroll', onScroll, { capture: true });
	});

	// ───────────── writes ─────────────
	function moved(p: { row: ViewRow; after: ViewRow | null; before: ViewRow | null }) {
		void env.moveRow(p.row.id, { after: p.after?.id ?? null, before: p.before?.id ?? null });
	}

	function sortBy(prop: string, dir: 'asc' | 'desc') {
		void env.updateView({ sorts: [{ prop, dir }] }).catch(() => undefined);
	}
	const sortOf = (prop: string) => env.view.sorts.find((s) => s.prop === prop)?.dir;

	function hide(prop: string) {
		void env.updateView({ columns: { columns: withColumnShown(env.view, env.collection, env.properties, prop, false), options: env.view.columns.options } }).catch(() => undefined);
	}

	function addProperty(type: PropertyType, name: string, config?: Record<string, unknown>) {
		const def = newPropertyDef(type, name, undefined, config);
		void (async () => {
			try {
				await env.store.createProperty(def);
				const columns = withColumnShown(env.view, env.collection, [...env.properties, def], def.id, true);
				await env.updateView({ columns: { columns, options: env.view.columns.options } });
			} catch {
				// reported by the store
			}
		})();
	}
	function attach(def: PropertyDef) {
		void env.updateView({ columns: { columns: withColumnShown(env.view, env.collection, env.properties, def.id, true), options: env.view.columns.options } }).catch(() => undefined);
	}
	/** The menu under a column header: sort either way, hide (the title stays). */
	const headerMenu = (def: PropertyDef): MenuItem[] => [
		{ type: 'option', title: 'Sort ascending', prefix: sortAscendingIcon, disabled: !env.editable, 'data-testid': 'column-sort-asc', onclick: () => sortBy(def.id, 'asc') } as MenuItem,
		{ type: 'option', title: 'Sort descending', prefix: sortDescendingIcon, disabled: !env.editable, 'data-testid': 'column-sort-desc', onclick: () => sortBy(def.id, 'desc') } as MenuItem,
		...(def.id !== TITLE_PROP_ID
			? [{ type: 'option', title: 'Hide', prefix: eyeSlashIcon, disabled: !env.editable, 'data-testid': 'column-hide', onclick: () => hide(def.id) } as MenuItem]
			: [])
	];
	const hiddenDefs = $derived(allColumns(env.view, env.collection, env.properties).filter((e) => e.hidden).map((e) => e.def));
	const canWriteRow = (row: ViewRow) => env.editable && row.access !== 'read' && row.access !== 'comment';
</script>

<svelte:window bind:innerHeight />

<div class="tv" bind:this={root} data-testid="view-table" data-rows={items.length}>
	{#key structure}
		<DataTable
			bind:items
			{columns}
			getRowId={(row: ViewRow) => row.id}
			{height}
			virtualize
			overscan={8}
			estimatedRowHeight={ROW}
			sortableRows={reorder}
			onRowMove={moved}
			{onStateChange}
			initialState={{ columnPinning: { left: frozen ? [TITLE_PROP_ID] : [], right: [] } }}
			stickyHeader
			pagination={false}
			getRowAttrs={(row: ViewRow) => ({ 'data-testid': 'view-row', 'data-row-id': row.id })}
			class="notion-table"
			theme={{
				root: { base: '@container relative flex min-w-0 flex-col gap-0' },
				viewport: { base: 'rounded-none border-0 border-b border-neutral-muted bg-surface' },
				headerRow: { base: 'grid border-b border-neutral-muted bg-surface' },
				header: { base: 'z-20 grid bg-surface' },
				headerCell: {
					base: 'group/data-table-header relative flex min-w-0 items-center gap-xs overflow-visible border-neutral-muted border-r h-[34px]! px-2! text-xs font-normal whitespace-nowrap text-[color:var(--app-text-secondary)]'
				},
				row: { base: 'state-layer grid min-w-full border-b border-neutral-muted transition-colors min-h-[var(--app-table-row-height)]!' },
				cell: { base: 'relative flex min-w-0 items-center overflow-hidden border-neutral-muted border-r outline-none min-h-[calc(var(--app-table-row-height)-1px)]! p-0!' }
			}}
		>
			{#snippet header({ column })}
				{@const def = defs.get(column.id)}
				{#if def}
					<span class="head" data-testid="column-header" data-prop={def.id}>
						<span class="hicon">{@render TYPE_ICONS[def.type]({ size: 14 })}</span>
						<span class="hname">{def.name}</span>
						{#if sortOf(def.id)}
							<span class="hsort" aria-label="Sorted {sortOf(def.id) === 'asc' ? 'ascending' : 'descending'}">
								{#if sortOf(def.id) === 'asc'}{@render sortAscendingIcon({ size: 12 })}{:else}{@render sortDescendingIcon({ size: 12 })}{/if}
							</span>
						{/if}
						<PopupMenu position="bottom-start" menu={{ items: headerMenu(def) }}>
							{#snippet trigger(popover)}
								<Button
									variant="ghost"
									size="small"
									squared
									label="{def.name} options"
									prefix={caretDownIcon}
									data-testid="column-menu"
									class="size-5! min-h-0! opacity-0 group-hover/data-table-header:opacity-100 focus-visible:opacity-100"
									{@attach popover.trigger}
								/>
							{/snippet}
						</PopupMenu>
					</span>
				{/if}
			{/snippet}
			{#snippet cell({ row, columnId })}
				{@const def = defs.get(columnId)}
				{#if def?.id === TITLE_PROP_ID}
					<div class="tcell" data-testid="view-title-cell">
						<TitleCell {env} {row} {wrap} autofocus={focusId === row.id} onFocused={() => (focusId = null)} />
					</div>
				{:else if def}
					<div class="vcell" class:wrap data-testid="view-cell" data-prop={def.id} data-name={def.name}>
						<PropertyEditor
							{def}
							value={row.values[def.id] ?? null}
							editable={canWriteRow(row)}
							compact
							store={env.store}
							{...env.lookups}
							{...env.actions(row.id, def)}
						/>
					</div>
				{/if}
			{/snippet}
			{#snippet empty()}
				<Empty size="small" title="No pages yet" data-testid="view-empty" />
			{/snippet}
		</DataTable>
	{/key}

	<div class="foot">
		{#if env.editable}
			<Button variant="ghost" size="small" prefix={plusIcon} data-testid="view-add-row" onclick={() => void env.newRow()}>New page</Button>
			<AddProperty existing={hiddenDefs} names={env.properties} onCreate={addProperty} onAttach={attach} />
		{/if}
		<span class="count" data-testid="view-count">
			{data.total} {data.total === 1 ? 'page' : 'pages'}{items.length < data.total ? ` · showing ${items.length}` : ''}
		</span>
	</div>
</div>

<style>
	.tv {
		min-width: 0;
	}
	.tv :global(.notion-table) {
		font-size: 14px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-width: 0;
	}
	.hicon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--app-text-tertiary);
	}
	.hname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hsort {
		display: inline-flex;
		color: var(--app-accent);
	}
	.tcell {
		display: flex;
		align-items: center;
		width: 100%;
		/* The row's own 1px hairline is part of its 36px (the token): the cell is one less. */
		min-height: calc(var(--app-table-row-height) - 1px);
		padding: 0 8px;
	}
	.vcell {
		display: flex;
		align-items: center;
		width: 100%;
		min-height: calc(var(--app-table-row-height) - 1px);
		padding: 0 2px;
		min-width: 0;
		overflow: hidden;
	}
	.vcell.wrap {
		align-items: flex-start;
		padding-block: 4px;
	}
	.foot {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 34px;
		padding: 0 4px;
		font-size: 13px;
		color: var(--app-text-secondary);
		border-bottom: 1px solid var(--app-hairline);
	}
	.count {
		margin-left: auto;
		font-size: 12px;
	}
</style>
