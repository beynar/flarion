<!--
	The board layout: entasis Kanban, one column per group of the view's group-by (select, status, person,
	checkbox...). Cards show the shown properties and the cover. Dragging a card to another column writes the
	property (`setProp`, or an add and a remove for a multi-value); dragging within a column reorders it under
	manual order. Each column has its own window with "Load more"; columns hide from their menu and reorder by
	dragging their header (the group-by's `hidden` and `order`).
-->
<script lang="ts">
	import { Kanban, type KanbanCardMove, type KanbanColumnData, type KanbanColumnMove } from 'entasis/kanban';
	import { Popover } from 'entasis/popover';
	import { dotsThreeIcon } from 'entasis/icons/dotsThree';
	import { plusIcon } from 'entasis/icons/plus';
	import { eyeSlashIcon } from 'entasis/icons/eyeSlash';
	import type { ViewData } from '#lib/client/workspace.svelte.ts';
	import OptionTag from '#lib/components/shell/OptionTag.svelte';
	import { GROUP_EMPTY, type GroupBySpec } from '#lib/shared/filter-ast.ts';
	import type { PropValue } from '#lib/shared/property-types.ts';
	import type { ViewRow } from '#lib/shared/protocol.ts';
	import type { ViewEnv } from './env.ts';
	import CardProps from './CardProps.svelte';
	import Cover from './Cover.svelte';
	import { groupMeta, memberName, valueOfGroup } from './view-model.ts';

	let { env, data }: { env: ViewEnv; data: ViewData } = $props();

	type Card = { id: string; title: string; row: ViewRow };
	const spec = $derived(env.view.groupBy);
	const def = $derived(spec ? env.properties.find((p) => p.id === spec.prop) : undefined);
	const hidden = $derived(new Set(spec?.hidden ?? []));
	const meta = (key: string) =>
		groupMeta(def, key, {
			spec,
			member: (id) => memberName(env.lookups.members, id),
			page: (id) => env.lookups.resolvePage?.(id)?.title
		});

	const groups = $derived((data.groups ?? []).filter((g) => !hidden.has(g.key)));
	let columns = $state.raw<KanbanColumnData<Card>[]>([]);
	$effect.pre(() => {
		columns = groups.map((g) => ({
			id: g.key,
			title: meta(g.key).label,
			cards: g.rows.map((row) => ({ id: `${g.key}|${row.id}`, title: row.title, row }))
		}));
	});
	const info = (key: string) => data.groups?.find((g) => g.key === key);
	const hiddenGroups = $derived((spec?.hidden ?? []).map((key) => ({ key, total: data.groups?.find((g) => g.key === key)?.total })));

	// ───────────── writes ─────────────
	function setSpec(patch: Partial<GroupBySpec>) {
		if (!spec) return;
		void env.updateView({ groupBy: { ...spec, ...patch } }).catch(() => undefined);
	}

	function regroup(rowId: string, from: string, to: string) {
		if (!def) return;
		if (def.type === 'multi_select' || def.type === 'person' || def.type === 'relation') {
			const ops = [
				...(from !== GROUP_EMPTY ? [{ op: 'removeOption' as const, page: rowId, prop: def.id, option: from }] : []),
				...(to !== GROUP_EMPTY ? [{ op: 'addOption' as const, page: rowId, prop: def.id, option: to }] : [])
			];
			if (ops.length) void env.store.mutate(ops).catch(() => undefined);
			return;
		}
		const value = valueOfGroup(def, to, spec);
		void env.setValue(rowId, def.id, (value ?? null) as PropValue | null);
	}

	function moved(m: KanbanCardMove<Card>) {
		const rowId = m.card.row.id;
		if (m.from.columnId !== m.to.columnId) regroup(rowId, m.from.columnId, m.to.columnId);
		if (env.manualOrder) {
			const cards = m.columns.find((c) => c.id === m.to.columnId)?.cards ?? [];
			const at = cards.findIndex((c) => c.row.id === rowId);
			if (at !== -1) void env.moveRow(rowId, { after: cards[at - 1]?.row.id ?? null, before: cards[at + 1]?.row.id ?? null });
		}
	}

	function columnMoved(m: KanbanColumnMove<Card>) {
		const keys = columns.map((c) => c.id);
		const next = [...keys];
		const [item] = next.splice(m.from, 1);
		next.splice(m.to, 0, item);
		// Hidden groups keep their place after the visible ones.
		setSpec({ sort: 'manual', order: [...next, ...(spec?.hidden ?? [])] });
	}

	const hide = (key: string) => setSpec({ hidden: [...(spec?.hidden ?? []), key] });
	const show = (key: string) => setSpec({ hidden: (spec?.hidden ?? []).filter((k) => k !== key) });
	const startValue = (key: string) => (def ? valueOfGroup(def, key, spec) : undefined);
	function addCard(key: string) {
		const v = startValue(key);
		void env.newRow(def && v !== undefined ? { [def.id]: v as PropValue } : {});
	}
</script>

<div class="board" class:bleed={env.fullPage} data-testid="view-board" data-groups={columns.length}>
	{#if !spec || !def}
		<div class="note" data-testid="board-needs-group">Group this board by a status, select or person property to see its columns. Use the Group menu above.</div>
	{:else}
		<Kanban
			bind:columns
			onCardMove={moved}
			onColumnMove={columnMoved}
			disabled={!env.editable}
			sortableColumns={env.editable}
			density="compact"
			class="notion-board"
			theme={{
				root: { base: 'flex w-full items-start gap-2 overflow-x-auto p-0 pt-2 scrollbar-none' },
				column: { base: 'flex max-h-full w-full flex-col rounded-md bg-transparent ring-0' },
				columnWrapper: { base: 'min-w-[260px] max-w-[260px] flex-none basis-[260px]' },
				columnHeader: { base: 'flex items-center gap-md px-1! py-1!' },
				list: { base: 'flex min-h-row-lg flex-1 flex-col overflow-y-auto scrollbar-none rounded-md transition-colors gap-2 p-0.5! pt-1! data-[dnd-over=true]:bg-primary/5' },
				card: { base: 'rounded-[6px] text-sm select-none cursor-grab p-0! overflow-hidden bg-[color:var(--app-page)] shadow-[0_0_0_1px_var(--app-hairline),0_1px_2px_rgba(15,15,15,0.06)] hover:bg-[color:var(--app-hover)]' }
			}}
		>
			{#snippet columnHeader({ column })}
				{@const m = meta(column.id)}
				{@const g = info(column.id)}
				<div class="colhead" data-testid="board-column-header" data-group={column.id}>
					{#if m.empty}
						<span class="empty-label">{m.label}</span>
					{:else if m.color}
						<OptionTag color={m.color} label={m.label} />
					{:else}
						<span class="plain">{m.label}</span>
					{/if}
					<span class="count" data-testid="board-column-count">{g?.total ?? column.cards.length}</span>
					<span class="spacer"></span>
					<Popover position="bottom-end" modal={false} offset={4}>
						{#snippet trigger(popover)}
							<button type="button" class="ibtn" aria-label="{m.label} options" data-testid="board-column-menu" {@attach popover.trigger}>
								{@render dotsThreeIcon({ size: 16 })}
							</button>
						{/snippet}
						{#snippet children(popover)}
							<div class="menu">
								<button type="button" class="mitem" disabled={!env.editable} data-testid="board-column-hide" onclick={() => (hide(column.id), popover.close())}>
									{@render eyeSlashIcon({ size: 16 })} Hide
								</button>
							</div>
						{/snippet}
					</Popover>
					{#if env.editable}
						<button type="button" class="ibtn" aria-label="Add a card to {m.label}" data-testid="board-column-add" onclick={() => addCard(column.id)}>
							{@render plusIcon({ size: 16 })}
						</button>
					{/if}
				</div>
			{/snippet}
			{#snippet card({ card, column })}
				{@const row = card.row}
				{@const cover = env.cover(row)}
				<div
					class="card"
					role="link"
					tabindex="0"
					data-testid="board-card"
					data-row-id={row.id}
					data-group={column.id}
					onclick={(e) => {
						if ((e.target as HTMLElement).closest('a,button,input')) return;
						env.open(row.id, e);
					}}
					onkeydown={(e) => e.key === 'Enter' && env.open(row.id, e)}
				>
					<Cover {cover} height={96} />
					<div class="body">
						<div class="ctitle" class:placeholder={!row.title}>
							{#if row.icon}<span aria-hidden="true">{row.icon}</span>{/if}
							<span data-testid="view-row-title">{row.title || 'Untitled'}</span>
						</div>
						<CardProps {env} {row} skip={spec?.prop ? [spec.prop] : []} />
					</div>
				</div>
			{/snippet}
			{#snippet columnFooter({ column })}
				{@const g = info(column.id)}
				{#if g && g.loaded < g.total}
					<button type="button" class="more" data-testid="board-load-more" onclick={() => env.loadMore(column.id)}>Load more ({g.total - g.loaded})</button>
				{/if}
				{#if env.editable}
					<button type="button" class="new" data-testid="board-new" onclick={() => addCard(column.id)}>
						{@render plusIcon({ size: 14 })} New
					</button>
				{/if}
			{/snippet}
		</Kanban>
		{#if hiddenGroups.length}
			<div class="hidden-groups" data-testid="board-hidden-groups">
				<span class="hlabel">Hidden groups</span>
				{#each hiddenGroups as g (g.key)}
					{@const m = meta(g.key)}
					<button type="button" class="hchip" data-testid="board-show-group" onclick={() => show(g.key)}>
						{m.label}{#if g.total !== undefined} <span class="count">{g.total}</span>{/if}
					</button>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.board {
		min-width: 0;
		overflow-x: auto;
		padding-bottom: 12px;
	}
	/* On a database's own page the columns run to the window's edge while the first one stays on the page column. */
	.board.bleed {
		--bleed: var(--app-page-padding-x-narrow);
		overflow: visible;
	}
	@media (min-width: 768px) {
		.board.bleed {
			--bleed: var(--app-page-padding-x);
		}
	}
	.board.bleed :global(.notion-board) {
		width: calc(100% + 2 * var(--bleed));
		margin-inline: calc(-1 * var(--bleed));
		padding-inline: var(--bleed);
	}
	.note {
		padding: 24px 8px;
		color: var(--app-text-secondary);
	}
	.colhead {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-width: 0;
	}
	.count {
		font-size: 12px;
		color: var(--app-text-tertiary);
	}
	.spacer {
		flex: 1;
	}
	.plain,
	.empty-label {
		font-size: 14px;
		color: var(--app-text-secondary);
	}
	.ibtn {
		display: inline-flex;
		padding: 3px;
		border-radius: 4px;
		color: var(--app-text-tertiary);
		cursor: pointer;
	}
	.ibtn:hover {
		background: var(--app-hover);
		color: var(--app-text);
	}
	.menu {
		display: flex;
		flex-direction: column;
		min-width: 160px;
		padding: 4px;
	}
	.mitem {
		display: flex;
		align-items: center;
		gap: 8px;
		height: var(--app-row-height);
		padding: 0 8px;
		border-radius: var(--app-radius-control);
		cursor: pointer;
		text-align: left;
	}
	.mitem:hover:not(:disabled) {
		background: var(--app-hover);
	}
	.card {
		display: flex;
		flex-direction: column;
		cursor: pointer;
		outline: none;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 10px 10px;
	}
	.ctitle {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		font-weight: 500;
		line-height: 1.35;
		word-break: break-word;
	}
	.ctitle.placeholder {
		color: var(--app-text-tertiary);
		font-weight: 400;
	}
	.more,
	.new {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		height: 28px;
		padding: 0 8px;
		border-radius: var(--app-radius-control);
		color: var(--app-text-tertiary);
		cursor: pointer;
		font-size: 14px;
	}
	.more:hover,
	.new:hover {
		background: var(--app-hover);
		color: var(--app-text-secondary);
	}
	.hidden-groups {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 12px;
		font-size: 13px;
		color: var(--app-text-secondary);
	}
	.hchip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 8px;
		border-radius: 4px;
		background: var(--app-hover);
		cursor: pointer;
	}
</style>
