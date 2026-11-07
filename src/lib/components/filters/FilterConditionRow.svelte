<script lang="ts">
	import { xIcon } from 'entasis/icons/x';
	import type { Condition, FilterValue } from '#lib/shared/filter-ast.ts';
	import type { FilterOp } from '#lib/shared/property-types.ts';
	import type { BuilderApi } from './api.ts';
	import FilterValueEditor from './FilterValue.svelte';
	import { changeOp, isCompleteCondition, opsFor, removeAt, retarget, setAtPath, type Path } from './logic.ts';
	import { controlClass, iconButtonClass } from './styles.ts';

	/** One condition: property, operator, value and a remove button. */
	let { condition, path, api }: { condition: Condition; path: Path; api: BuilderApi } = $props();

	const def = $derived(api.registry.get(condition.prop));
	const ops = $derived(def ? opsFor(def) : []);
	const kind = $derived(ops.find((o) => o.op === condition.op)?.kind ?? 'none');
	const incomplete = $derived(!isCompleteCondition(condition, api.registry));

	const set = (next: Condition, typing = false) => api.edit((root) => setAtPath(root, path, next), typing);

	function pickProp(id: string) {
		const next = api.registry.get(id);
		if (next && next.id !== condition.prop) set(retarget(next));
	}
	function pickOp(op: string) {
		if (def) set(changeOp(condition, op as FilterOp, def));
	}
	function setValue(value: FilterValue | undefined, immediate: boolean) {
		const { value: _old, ...rest } = condition;
		void _old;
		set(value === undefined ? rest : { ...rest, value }, !immediate);
	}
</script>

<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="filter-condition" data-prop={condition.prop} data-op={condition.op} data-incomplete={incomplete}>
	<select class="{controlClass} w-36" aria-label="Property" data-testid="filter-prop" disabled={api.readonly} value={condition.prop} onchange={(e) => pickProp(e.currentTarget.value)}>
		{#each api.filterable as d (d.id)}
			<option value={d.id}>{d.name}</option>
		{/each}
		{#if !def}
			<option value={condition.prop}>Unknown property</option>
		{/if}
	</select>
	<select class="{controlClass} w-36" aria-label="Operator" data-testid="filter-op" disabled={api.readonly || !def} value={condition.op} onchange={(e) => pickOp(e.currentTarget.value)}>
		{#each ops as o (o.op)}
			<option value={o.op}>{o.label}</option>
		{/each}
		{#if def && !ops.some((o) => o.op === condition.op)}
			<option value={condition.op}>{condition.op}</option>
		{/if}
	</select>
	{#if def}
		<FilterValueEditor
			{def}
			op={condition.op}
			{kind}
			value={condition.value}
			store={api.store}
			members={api.members}
			readonly={api.readonly}
			onValue={setValue}
			onOp={(op) => def && set(changeOp(condition, op, def))}
		/>
	{/if}
	{#if incomplete}
		<span class="text-xs text-[color:var(--app-text-tertiary)]" data-testid="filter-incomplete">{def ? 'Needs a value' : 'Property deleted'}</span>
	{/if}
	<span class="flex-1"></span>
	{#if !api.readonly}
		<button type="button" class={iconButtonClass} aria-label="Remove condition" data-testid="filter-remove" onclick={() => api.edit((root) => removeAt(root, path))}>
			{@render xIcon({ size: 14 })}
		</button>
	{/if}
</div>
