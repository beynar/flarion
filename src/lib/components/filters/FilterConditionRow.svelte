<script lang="ts">
	import { Select } from 'entasis/select';
	import { Button } from 'entasis/button';
	import { xIcon } from 'entasis/icons/x';
	import type { Condition, FilterValue } from '#lib/shared/filter-ast.ts';
	import type { FilterOp } from '#lib/shared/property-types.ts';
	import type { BuilderApi } from './api.ts';
	import FilterValueEditor from './FilterValue.svelte';
	import { changeOp, isCompleteCondition, opsFor, removeAt, retarget, setAtPath, type Path } from './logic.ts';

	/** One condition: property, operator, value and a remove button. */
	let { condition, path, api }: { condition: Condition; path: Path; api: BuilderApi } = $props();

	const def = $derived(api.registry.get(condition.prop));
	const ops = $derived(def ? opsFor(def) : []);
	const kind = $derived(ops.find((o) => o.op === condition.op)?.kind ?? 'none');
	const incomplete = $derived(!isCompleteCondition(condition, api.registry));

	const propItems = $derived([
		...api.filterable.map((d) => ({ value: d.id, label: d.name })),
		...(def ? [] : [{ value: condition.prop, label: 'Unknown property', disabled: true }])
	]);
	const opItems = $derived([
		...ops.map((o) => ({ value: o.op as string, label: o.label })),
		...(def && !ops.some((o) => o.op === condition.op) ? [{ value: condition.op as string, label: condition.op as string }] : [])
	]);

	const set = (next: Condition, typing = false) => api.edit((root) => setAtPath(root, path, next), typing);

	function pickProp(id: string | null) {
		const next = id ? api.registry.get(id) : undefined;
		if (next && next.id !== condition.prop) set(retarget(next));
	}
	function pickOp(op: string | null) {
		if (def && op) set(changeOp(condition, op as FilterOp, def));
	}
	function setValue(value: FilterValue | undefined, immediate: boolean) {
		const { value: _old, ...rest } = condition;
		void _old;
		set(value === undefined ? rest : { ...rest, value }, !immediate);
	}
</script>

<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-testid="filter-condition" data-prop={condition.prop} data-op={condition.op} data-incomplete={incomplete}>
	<Select
		size="small"
		class="w-32"
		items={propItems}
		value={condition.prop}
		disabled={api.readonly}
		alignItemWithTrigger={false}
		triggerAttrs={{ 'aria-label': 'Property', 'data-testid': 'filter-prop' }}
		onValueChange={pickProp}
	/>
	<Select
		size="small"
		class="w-32"
		items={opItems}
		value={condition.op}
		disabled={api.readonly || !def}
		alignItemWithTrigger={false}
		triggerAttrs={{ 'aria-label': 'Operator', 'data-testid': 'filter-op' }}
		onValueChange={pickOp}
	/>
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
		<Button variant="ghost" size="small" squared label="Remove condition" prefix={xIcon} data-testid="filter-remove" onclick={() => api.edit((root) => removeAt(root, path))} />
	{/if}
</div>
