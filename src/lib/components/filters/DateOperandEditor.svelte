<script lang="ts">
	import type { DateOperand, DateUnit } from '#lib/shared/dates.ts';
	import { toDateOnly } from '#lib/components/properties/helpers.ts';
	import { DATE_UNIT_CHOICES } from './logic.ts';
	import { controlClass } from './styles.ts';

	/**
	 * One date operand of a filter: an exact day, or a point relative to today ("Today", "Yesterday",
	 * "1 week ago", "In 2 months"...). Presets cover the usual ones; "Custom…" takes a count, a unit and
	 * a direction.
	 */
	let {
		value,
		readonly = false,
		label = 'Date',
		onChange
	}: {
		value: DateOperand;
		readonly?: boolean;
		label?: string;
		onChange: (value: DateOperand) => void;
	} = $props();

	const PRESETS: { id: string; label: string; unit: DateUnit; offset: number }[] = [
		{ id: 'today', label: 'Today', unit: 'day', offset: 0 },
		{ id: 'yesterday', label: 'Yesterday', unit: 'day', offset: -1 },
		{ id: 'tomorrow', label: 'Tomorrow', unit: 'day', offset: 1 },
		{ id: 'week_ago', label: 'One week ago', unit: 'week', offset: -1 },
		{ id: 'week_ahead', label: 'One week from now', unit: 'week', offset: 1 },
		{ id: 'month_ago', label: 'One month ago', unit: 'month', offset: -1 },
		{ id: 'month_ahead', label: 'One month from now', unit: 'month', offset: 1 }
	];

	// "Custom" stays selected while its fields are edited, even when they happen to equal a preset.
	let forcedCustom = $state(false);
	const mode = $derived.by(() => {
		if (value.kind === 'exact') return 'exact';
		if (forcedCustom) return 'custom';
		return PRESETS.find((p) => p.unit === value.unit && p.offset === value.offset)?.id ?? 'custom';
	});

	function pick(id: string) {
		forcedCustom = id === 'custom';
		if (id === 'exact') return onChange({ kind: 'exact', date: toDateOnly(new Date()) });
		if (id === 'custom') return onChange({ kind: 'relative', unit: value.kind === 'relative' ? value.unit : 'day', offset: value.kind === 'relative' && value.offset !== 0 ? value.offset : -1 });
		const p = PRESETS.find((x) => x.id === id);
		if (p) onChange({ kind: 'relative', unit: p.unit, offset: p.offset });
	}

	const count = $derived(value.kind === 'relative' ? Math.abs(value.offset) : 1);
	const ahead = $derived(value.kind === 'relative' && value.offset > 0);
	function custom(next: { count?: number; ahead?: boolean; unit?: DateUnit }) {
		if (value.kind !== 'relative') return;
		const n = Math.max(1, Math.min(1000, Math.round(next.count ?? count)));
		const dir = (next.ahead ?? ahead) ? 1 : -1;
		onChange({ kind: 'relative', unit: next.unit ?? value.unit, offset: n * dir });
	}
</script>

<span class="inline-flex min-w-0 flex-wrap items-center gap-1" data-testid="date-operand">
	<select class={controlClass} aria-label={label} data-testid="date-operand-mode" disabled={readonly} value={mode} onchange={(e) => pick(e.currentTarget.value)}>
		<option value="exact">Exact date</option>
		{#each PRESETS as p (p.id)}
			<option value={p.id}>{p.label}</option>
		{/each}
		<option value="custom">Custom…</option>
	</select>
	{#if value.kind === 'exact'}
		<input
			type="date"
			class={controlClass}
			aria-label="{label} (day)"
			data-testid="date-operand-day"
			disabled={readonly}
			value={value.date.slice(0, 10)}
			onchange={(e) => e.currentTarget.value && onChange({ kind: 'exact', date: e.currentTarget.value })}
		/>
	{:else if mode === 'custom'}
		<input
			type="number"
			min="1"
			max="1000"
			class="{controlClass} w-16"
			aria-label="{label} (count)"
			disabled={readonly}
			value={count}
			onchange={(e) => custom({ count: Number(e.currentTarget.value) || 1 })}
		/>
		<select class={controlClass} aria-label="{label} (unit)" disabled={readonly} value={value.kind === 'relative' ? value.unit : 'day'} onchange={(e) => custom({ unit: e.currentTarget.value as DateUnit })}>
			{#each DATE_UNIT_CHOICES as u (u.unit)}
				<option value={u.unit}>{u.label}{count === 1 ? '' : 's'}</option>
			{/each}
		</select>
		<select class={controlClass} aria-label="{label} (direction)" disabled={readonly} value={ahead ? 'ahead' : 'ago'} onchange={(e) => custom({ ahead: e.currentTarget.value === 'ahead' })}>
			<option value="ago">ago</option>
			<option value="ahead">from now</option>
		</select>
	{/if}
</span>
