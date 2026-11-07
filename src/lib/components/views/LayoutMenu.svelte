<!--
	"Layout": the view's type and the options of that type: wrapped cells and the frozen first column of a table,
	the card size and cover of a gallery or board, the date property of a calendar, the start and end dates of a
	timeline, the page icon on cards.
-->
<script lang="ts">
	import { Switch } from 'entasis/switch';
	import { Select } from 'entasis/select';
	import { RadioInput } from 'entasis/radio-input';
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
	const typeItems = VIEW_TYPE_ORDER.map((t) => ({ value: t, label: VIEW_LABELS[t], icon: VIEW_ICONS[t] }));
	/** A Select's value is a string: `none` stands for "unset" in the cover and end-date choices. */
	const NONE = 'none';
	const named = (defs: { id: string; name: string }[]) => defs.map((d) => ({ value: d.id, label: d.name }));
	const coverItems = $derived([{ value: NONE, label: 'Page cover' }, ...named(fileDefs)]);
	const sizeItems = CARD_SIZES.map((s) => ({ value: s as string, label: s[0].toUpperCase() + s.slice(1) }));
	const dateItems = $derived(named(dateDefs));
	const endItems = $derived([{ value: NONE, label: "None (use the date's range)" }, ...named(dateDefs)]);
	const orNull = (v: string | null) => (v && v !== NONE ? v : null);
	const set = (patch: Record<string, unknown>) => void env.setOption(patch).catch(() => undefined);
</script>

<div class="flex w-[300px] flex-col gap-2.5 p-3" data-testid="layout-menu">
	<div data-testid="layout-types">
		<RadioInput
			label="Layout"
			mode="card"
			size="small"
			items={typeItems}
			value={env.view.type}
			disabled={!env.editable}
			onValueChange={(v) => v && setType(v)}
			theme={{
				radiosInputContainer: { base: 'grid-cols-2 gap-1.5' },
				radiosInputItem: { base: 'items-center! py-0! min-h-8!' },
				radiosInputItemTrack: { base: 'top-1/2! -translate-y-1/2' },
				radiosInputItemThumb: { base: 'top-1/2! -translate-y-1/2' }
			}}
		/>
	</div>

	{#if env.view.type === 'table'}
		<div class="flex items-center justify-between gap-3 text-sm">
			<span>Wrap all columns</span>
			<Switch size="small" value={!!o.wrapCells} onValueChange={(v) => set({ wrapCells: !!v })} disabled={!env.editable} inputAttrs={{ 'aria-label': 'Wrap all columns', 'data-testid': 'opt-wrap' }} />
		</div>
		<div class="flex items-center justify-between gap-3 text-sm">
			<span>Freeze first column</span>
			<Switch size="small" value={!!o.frozenFirstColumn} onValueChange={(v) => set({ frozenFirstColumn: !!v })} disabled={!env.editable} inputAttrs={{ 'aria-label': 'Freeze first column', 'data-testid': 'opt-frozen' }} />
		</div>
	{/if}
	{#if env.view.type === 'gallery' || env.view.type === 'board'}
		<Select
			size="small"
			class="w-full"
			label="Card preview"
			labelPosition="left"
			items={coverItems}
			value={o.coverProp ?? NONE}
			disabled={!env.editable}
			alignItemWithTrigger={false}
			triggerAttrs={{ 'data-testid': 'opt-cover' }}
			onValueChange={(v) => set({ coverProp: orNull(v) })}
		/>
	{/if}
	{#if env.view.type === 'gallery'}
		<Select
			size="small"
			class="w-full"
			label="Card size"
			labelPosition="left"
			items={sizeItems}
			value={o.cardSize ?? 'medium'}
			disabled={!env.editable}
			alignItemWithTrigger={false}
			triggerAttrs={{ 'data-testid': 'opt-size' }}
			onValueChange={(v) => v && set({ cardSize: v })}
		/>
	{/if}
	{#if env.view.type === 'calendar' || env.view.type === 'timeline'}
		<Select
			size="small"
			class="w-full"
			label={env.view.type === 'timeline' ? 'Start date' : 'Show calendar by'}
			labelPosition="left"
			items={dateItems}
			value={dp.start?.id ?? null}
			placeholder="No date property"
			disabled={!env.editable}
			alignItemWithTrigger={false}
			triggerAttrs={{ 'data-testid': 'opt-date' }}
			onValueChange={(v) => set({ dateProp: orNull(v) })}
		/>
	{/if}
	{#if env.view.type === 'timeline'}
		<Select
			size="small"
			class="w-full"
			label="End date"
			labelPosition="left"
			items={endItems}
			value={o.endDateProp ?? NONE}
			disabled={!env.editable}
			alignItemWithTrigger={false}
			triggerAttrs={{ 'data-testid': 'opt-end-date' }}
			onValueChange={(v) => set({ endDateProp: orNull(v) })}
		/>
	{/if}
	{#if env.view.type === 'calendar' && dateDefs.length === 0}
		<p class="text-xs text-[color:var(--app-text-secondary)]">Add a date property to place pages on the calendar.</p>
	{/if}
</div>
