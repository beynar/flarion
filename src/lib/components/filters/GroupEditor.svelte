<script lang="ts">
	import { Switch } from 'entasis/switch';
	import type { GroupBySpec } from '#lib/shared/filter-ast.ts';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import type { Member } from '#lib/shared/schemas.ts';
	import { groupKeyLabel, groupableProps } from './logic.ts';
	import { controlClass, ghostButtonClass } from './styles.ts';

	/**
	 * `GroupBySpec` as the Databases track extends it: `hidden` lists the group keys a board hides and `order` the
	 * manual group order. Both are preserved untouched by every edit here.
	 */
	type GroupSpec = GroupBySpec & { hidden?: string[]; order?: string[] };

	/** The group-by settings of a view: the property, how groups sort, empty groups, date buckets and hidden groups. */
	let {
		groupBy,
		properties,
		members = [],
		readonly = false,
		onChange
	}: {
		groupBy: GroupBySpec | null;
		properties: PropertyDef[];
		/** Names for person groups in the hidden list. */
		members?: readonly Member[];
		readonly?: boolean;
		onChange: (groupBy: GroupBySpec | null) => void;
	} = $props();

	const spec = $derived(groupBy as GroupSpec | null);
	const choices = $derived(groupableProps(properties));
	const def = $derived(spec ? properties.find((p) => p.id === spec.prop) : undefined);
	const hidden = $derived(spec?.hidden ?? []);

	function pickProp(id: string) {
		if (!id) return onChange(null);
		const next = properties.find((p) => p.id === id);
		if (!spec) return onChange({ prop: id });
		if (id === spec.prop) return;
		// Group keys and the bucket belong to the old property; sort and hideEmpty carry over.
		const { hidden: _h, order: _o, bucket: _b, ...rest } = spec;
		void _h, void _o, void _b;
		onChange({ ...rest, prop: id, ...(next?.type === 'date' ? { bucket: 'day' as const } : {}) });
	}
	const patch = (p: Partial<GroupSpec>) => spec && onChange({ ...spec, ...p });
	const show = (key: string) => spec && onChange({ ...spec, hidden: hidden.filter((k) => k !== key) } as GroupBySpec);
</script>

<div class="flex min-w-[280px] flex-col gap-2 p-3" data-testid="group-editor">
	<label class="flex items-center justify-between gap-3 text-sm">
		<span class="text-[color:var(--app-text-secondary)]">Group by</span>
		<select class="{controlClass} w-[160px]" data-testid="group-prop" disabled={readonly} value={spec?.prop ?? ''} onchange={(e) => pickProp(e.currentTarget.value)}>
			<option value="">None</option>
			{#each choices as d (d.id)}
				<option value={d.id}>{d.name}</option>
			{/each}
			{#if spec && !choices.some((d) => d.id === spec.prop)}
				<option value={spec.prop}>{def?.name ?? 'Unknown property'}</option>
			{/if}
		</select>
	</label>

	{#if spec}
		{#if def?.type === 'date'}
			<label class="flex items-center justify-between gap-3 text-sm">
				<span class="text-[color:var(--app-text-secondary)]">Group dates by</span>
				<select class="{controlClass} w-[160px]" data-testid="group-bucket" disabled={readonly} value={spec.bucket ?? 'day'} onchange={(e) => patch({ bucket: e.currentTarget.value as 'day' | 'week' | 'month' | 'year' })}>
					<option value="day">Day</option>
					<option value="week">Week</option>
					<option value="month">Month</option>
					<option value="year">Year</option>
				</select>
			</label>
		{/if}
		<label class="flex items-center justify-between gap-3 text-sm">
			<span class="text-[color:var(--app-text-secondary)]">Sort groups</span>
			<select class="{controlClass} w-[160px]" data-testid="group-sort" disabled={readonly} value={spec.sort ?? 'manual'} onchange={(e) => patch({ sort: e.currentTarget.value as 'manual' | 'asc' | 'desc' })}>
				<option value="manual">Manual</option>
				<option value="asc">Ascending</option>
				<option value="desc">Descending</option>
			</select>
		</label>
		<div class="flex items-center justify-between gap-3 text-sm">
			<span class="text-[color:var(--app-text-secondary)]">Hide empty groups</span>
			<Switch size="small" value={!!spec.hideEmpty} disabled={readonly} onValueChange={(on) => patch({ hideEmpty: !!on })} inputAttrs={{ 'aria-label': 'Hide empty groups', 'data-testid': 'group-hide-empty' }} />
		</div>

		{#if spec.hidden !== undefined}
			<div class="flex flex-col gap-0.5 border-t border-[color:var(--app-hairline)] pt-2" data-testid="group-hidden">
				<span class="text-xs font-medium text-[color:var(--app-text-tertiary)]">Hidden groups</span>
				{#each hidden as key (key)}
					<div class="flex items-center gap-2 text-sm" style="min-height: var(--app-row-height)" data-testid="group-hidden-row" data-key={key}>
						<span class="min-w-0 flex-1 truncate">{groupKeyLabel(def, key, members)}</span>
						{#if !readonly}
							<button type="button" class={ghostButtonClass} data-testid="group-show" onclick={() => show(key)}>Show</button>
						{/if}
					</div>
				{:else}
					<span class="text-sm text-[color:var(--app-text-tertiary)]">No hidden groups.</span>
				{/each}
			</div>
		{/if}
	{/if}
</div>
