<!--
	The table layout: entasis Data table over the view's window. Rows are virtualized (a window holds up to a
	thousand), cells edit in place with the property cells of the page header, columns resize (widths persist in the
	view's `columns_json`), the first column can freeze, cells can wrap, rows drag into place under manual order, and
	a "+" header adds a property. The sort is the view's (server side): headers sort through their menu.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { DataTable, type DataTableColumn, type DataTableState } from 'entasis/data-table';
	import { Popover } from 'entasis/popover';
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
	let items = $state.raw<ViewRow[]>([]);
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
	$effect(() => {
		const el = root?.querySelector<HTMLElement>('[data-slot="scroll-viewport"], [data-scroll-viewport], .overflow-auto, [style*="overflow"]');
		void items.length;
		if (!el) return;
		const near = () => {
			if (el.scrollTop + el.clientHeight > el.scrollHeight - 6 * ROW) untrack(() => env.loadMore());
		};
		el.addEventListener('scroll', near, { passive: true });
		near();
		return () => el.removeEventListener('scroll', near);
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

	function addProperty(type: PropertyType, name: string) {
		const def = newPropertyDef(type, name);
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
				row: { base: 'state-layer grid min-w-full border-b border-neutral-muted transition-colors min-h-[36px]!' },
				cell: { base: 'relative flex min-w-0 items-center overflow-hidden border-neutral-muted border-r outline-none min-h-[36px]! p-0!' }
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
						<Popover position="bottom-start" modal={false} offset={4}>
							{#snippet trigger(popover)}
								<button type="button" class="hmenu" aria-label="{def.name} options" data-testid="column-menu" {@attach popover.trigger}>
									{@render caretDownIcon({ size: 12 })}
								</button>
							{/snippet}
							{#snippet children(popover)}
								<div class="menu" data-testid="column-menu-body">
									<button type="button" class="mitem" disabled={!env.editable} onclick={() => (sortBy(def.id, 'asc'), popover.close())}>
										{@render sortAscendingIcon({ size: 16 })} Sort ascending
									</button>
									<button type="button" class="mitem" disabled={!env.editable} onclick={() => (sortBy(def.id, 'desc'), popover.close())}>
										{@render sortDescendingIcon({ size: 16 })} Sort descending
									</button>
									{#if def.id !== TITLE_PROP_ID}
										<button type="button" class="mitem" disabled={!env.editable} data-testid="column-hide" onclick={() => (hide(def.id), popover.close())}>
											{@render eyeSlashIcon({ size: 16 })} Hide
										</button>
									{/if}
								</div>
							{/snippet}
						</Popover>
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
				<div class="empty" data-testid="view-empty">No pages yet</div>
			{/snippet}
		</DataTable>
	{/key}

	<div class="foot">
		{#if env.editable}
			<button type="button" class="add" data-testid="view-add-row" onclick={() => void env.newRow()}>
				{@render plusIcon({ size: 14 })} New page
			</button>
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
	.hmenu {
		display: inline-flex;
		padding: 2px;
		border-radius: 4px;
		opacity: 0;
		cursor: pointer;
		color: var(--app-text-secondary);
	}
	.head:hover .hmenu,
	.hmenu:focus-visible {
		opacity: 1;
	}
	.hmenu:hover {
		background: var(--app-hover);
	}
	.menu {
		display: flex;
		flex-direction: column;
		min-width: 190px;
		padding: 4px;
	}
	.mitem {
		display: flex;
		align-items: center;
		gap: 8px;
		height: var(--app-row-height);
		padding: 0 8px;
		border-radius: var(--app-radius-control);
		font-size: 14px;
		text-align: left;
		cursor: pointer;
		color: var(--app-text);
	}
	.mitem:hover:not(:disabled) {
		background: var(--app-hover);
	}
	.tcell {
		display: flex;
		align-items: center;
		width: 100%;
		min-height: 36px;
		padding: 0 8px;
	}
	.vcell {
		display: flex;
		align-items: center;
		width: 100%;
		min-height: 36px;
		padding: 0 2px;
		min-width: 0;
		overflow: hidden;
	}
	.vcell.wrap {
		align-items: flex-start;
		padding-block: 4px;
	}
	.empty {
		padding: 16px;
		color: var(--app-text-secondary);
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
	.add {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 26px;
		padding: 0 8px;
		border-radius: var(--app-radius-control);
		color: var(--app-text-secondary);
		cursor: pointer;
	}
	.add:hover {
		background: var(--app-hover);
		color: var(--app-text);
	}
	.count {
		margin-left: auto;
		font-size: 12px;
	}
</style>
