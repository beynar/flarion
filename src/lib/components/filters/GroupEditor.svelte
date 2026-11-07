<script lang="ts">
	import { Switch } from 'entasis/switch';
	import { Select } from 'entasis/select';
	import { Button } from 'entasis/button';
	import type { GroupBySpec } from '#lib/shared/filter-ast.ts';
	import type { PropertyDef } from '#lib/shared/property-types.ts';
	import type { Member } from '#lib/shared/schemas.ts';
	import { groupKeyLabel, groupableProps } from './logic.ts';

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
		if (!id || id === NONE) return onChange(null);
		const next = properties.find((p) => p.id === id);
		if (!spec) return onChange({ prop: id });
		if (id === spec.prop) return;
		// Group keys and the bucket belong to the old property; sort and hideEmpty carry over.
		const { hidden: _h, order: _o, bucket: _b, ...rest } = spec;
		void _h, void _o, void _b;
		onChange({ ...rest, prop: id, ...(next?.type === 'date' ? { bucket: 'day' as const } : {}) });
	}
	/** `none` stands for "no group-by" in the Select (its value is a string or null). */
	const NONE = 'none';
	const propItems = $derived([
		{ value: NONE, label: 'None' },
		...choices.map((d) => ({ value: d.id, label: d.name })),
		...(spec && !choices.some((d) => d.id === spec.prop) ? [{ value: spec.prop, label: def?.name ?? 'Unknown property' }] : [])
	]);
	const BUCKETS = [
		{ value: 'day', label: 'Day' },
		{ value: 'week', label: 'Week' },
		{ value: 'month', label: 'Month' },
		{ value: 'year', label: 'Year' }
	];
	const SORTS = [
		{ value: 'manual', label: 'Manual' },
		{ value: 'asc', label: 'Ascending' },
		{ value: 'desc', label: 'Descending' }
	];
	const patch = (p: Partial<GroupSpec>) => spec && onChange({ ...spec, ...p });
	const show = (key: string) => spec && onChange({ ...spec, hidden: hidden.filter((k) => k !== key) } as GroupBySpec);
</script>

<div class="flex min-w-[280px] flex-col gap-2 p-3" data-testid="group-editor">
	<Select
		size="small"
		class="w-full"
		label="Group by"
		labelPosition="left"
		items={propItems}
		value={spec?.prop ?? NONE}
		disabled={readonly}
		alignItemWithTrigger={false}
		triggerAttrs={{ 'data-testid': 'group-prop' }}
		onValueChange={(v) => v && pickProp(v)}
	/>

	{#if spec}
		{#if def?.type === 'date'}
			<Select
				size="small"
				class="w-full"
				label="Group dates by"
				labelPosition="left"
				items={BUCKETS}
				value={spec.bucket ?? 'day'}
				disabled={readonly}
				alignItemWithTrigger={false}
				triggerAttrs={{ 'data-testid': 'group-bucket' }}
				onValueChange={(v) => v && patch({ bucket: v as 'day' | 'week' | 'month' | 'year' })}
			/>
		{/if}
		<Select
			size="small"
			class="w-full"
			label="Sort groups"
			labelPosition="left"
			items={SORTS}
			value={spec.sort ?? 'manual'}
			disabled={readonly}
			alignItemWithTrigger={false}
			triggerAttrs={{ 'data-testid': 'group-sort' }}
			onValueChange={(v) => v && patch({ sort: v as 'manual' | 'asc' | 'desc' })}
		/>
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
							<Button variant="ghost" size="small" data-testid="group-show" onclick={() => show(key)}>Show</Button>
						{/if}
					</div>
				{:else}
					<span class="text-sm text-[color:var(--app-text-tertiary)]">No hidden groups.</span>
				{/each}
			</div>
		{/if}
	{/if}
</div>
