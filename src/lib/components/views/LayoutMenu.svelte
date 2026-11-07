<!--
	"Layout": the view's type and the options of that type: wrapped cells and the frozen first column of a table,
	the card size and cover of a gallery or board, the date property of a calendar, the start and end dates of a
	timeline, the page icon on cards.
-->
<script lang="ts">
	import { Switch } from 'entasis/switch';
	import { checkIcon } from 'entasis/icons/check';
	import type { ViewType } from '#lib/shared/definitions.ts';
	import { defaultGroupProp, dateProps, optionsOfView, CARD_SIZES, GROUPED_TYPES } from './view-model.ts';
	import type { ViewEnv } from './env.ts';
	import { VIEW_ICONS, VIEW_LABELS, VIEW_TYPE_ORDER } from './view-icons.ts';

	let { env }: { env: ViewEnv } = $props();

	const o = $derived(optionsOfView(env.view));
	const dateDefs = $derived(env.properties.filter((p) => p.type === 'date'));
	const fileDefs = $derived(env.properties.filter((p) => p.type === 'files'));
	const dp = $derived(dateProps(env.view, env.properties));

	function setType(type: ViewType) {
		if (type === env.view.type) return;
		const g = GROUPED_TYPES.has(type) && !env.view.groupBy ? defaultGroupProp(env.properties) : null;
		void env.updateView({ type, ...(g ? { groupBy: { prop: g.id } } : {}) }).catch(() => undefined);
	}
	const set = (patch: Record<string, unknown>) => void env.setOption(patch).catch(() => undefined);
</script>

<div class="menu" data-testid="layout-menu">
	<div class="heading">Layout</div>
	<div class="types">
		{#each VIEW_TYPE_ORDER as type (type)}
			{@const Icon = VIEW_ICONS[type]}
			<button type="button" class="type" class:on={env.view.type === type} data-testid="layout-{type}" disabled={!env.editable} onclick={() => setType(type)}>
				{@render Icon({ size: 18 })}
				<span>{VIEW_LABELS[type]}</span>
				{#if env.view.type === type}<span class="check">{@render checkIcon({ size: 14 })}</span>{/if}
			</button>
		{/each}
	</div>

	{#if env.view.type === 'table'}
		<label class="opt"><span>Wrap all columns</span><Switch size="small" value={!!o.wrapCells} onValueChange={(v) => set({ wrapCells: !!v })} disabled={!env.editable} inputAttrs={{ 'aria-label': 'Wrap all columns', 'data-testid': 'opt-wrap' }} /></label>
		<label class="opt"><span>Freeze first column</span><Switch size="small" value={!!o.frozenFirstColumn} onValueChange={(v) => set({ frozenFirstColumn: !!v })} disabled={!env.editable} inputAttrs={{ 'aria-label': 'Freeze first column', 'data-testid': 'opt-frozen' }} /></label>
	{/if}
	{#if env.view.type === 'gallery' || env.view.type === 'board'}
		<label class="opt">
			<span>Card preview</span>
			<select value={o.coverProp ?? ''} onchange={(e) => set({ coverProp: e.currentTarget.value || null })} disabled={!env.editable} data-testid="opt-cover" aria-label="Card preview">
				<option value="">Page cover</option>
				{#each fileDefs as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
			</select>
		</label>
	{/if}
	{#if env.view.type === 'gallery'}
		<label class="opt">
			<span>Card size</span>
			<select value={o.cardSize ?? 'medium'} onchange={(e) => set({ cardSize: e.currentTarget.value })} disabled={!env.editable} data-testid="opt-size" aria-label="Card size">
				{#each CARD_SIZES as s (s)}<option value={s}>{s[0].toUpperCase() + s.slice(1)}</option>{/each}
			</select>
		</label>
	{/if}
	{#if env.view.type === 'calendar' || env.view.type === 'timeline'}
		<label class="opt">
			<span>{env.view.type === 'timeline' ? 'Start date' : 'Show calendar by'}</span>
			<select value={dp.start?.id ?? ''} onchange={(e) => set({ dateProp: e.currentTarget.value || null })} disabled={!env.editable} data-testid="opt-date" aria-label="Date property">
				{#each dateDefs as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
			</select>
		</label>
	{/if}
	{#if env.view.type === 'timeline'}
		<label class="opt">
			<span>End date</span>
			<select value={o.endDateProp ?? ''} onchange={(e) => set({ endDateProp: e.currentTarget.value || null })} disabled={!env.editable} data-testid="opt-end-date" aria-label="End date property">
				<option value="">None (use the date's range)</option>
				{#each dateDefs as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
			</select>
		</label>
	{/if}
	{#if env.view.type === 'calendar' && dateDefs.length === 0}
		<p class="hint">Add a date property to place pages on the calendar.</p>
	{/if}
</div>

<style>
	.menu {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 280px;
		padding: 6px;
	}
	.heading {
		padding: 4px 6px;
		font-size: 12px;
		color: var(--app-text-tertiary);
	}
	.types {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
		margin-bottom: 6px;
	}
	.type {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 8px;
		border-radius: var(--app-radius-control);
		cursor: pointer;
		text-align: left;
	}
	.type:hover:not(:disabled) {
		background: var(--app-hover);
	}
	.type.on {
		background: var(--app-active);
	}
	.check {
		margin-left: auto;
		display: inline-flex;
	}
	.opt {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 32px;
		padding: 0 6px;
	}
	.opt select {
		max-width: 150px;
		height: 26px;
		border: 1px solid var(--app-hairline-strong);
		border-radius: var(--app-radius-control);
		background: var(--app-page);
		color: var(--app-text);
		padding: 0 4px;
	}
	.hint {
		margin: 4px 6px;
		font-size: 12px;
		color: var(--app-text-secondary);
	}
</style>
