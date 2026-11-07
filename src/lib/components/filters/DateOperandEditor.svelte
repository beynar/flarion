<script lang="ts">
	import type { DateOperand, DateUnit } from '#lib/shared/dates.ts';
	import { Select } from 'entasis/select';
	import { DateInput } from 'entasis/date-input';
	import { NumberInput } from 'entasis/number-input';
	import { SegmentedControl } from 'entasis/segmented-control';
	import { calendarDate, toDateOnly } from '#lib/components/properties/helpers.ts';
	import { DATE_UNIT_CHOICES } from './logic.ts';

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
	const modeItems = [
		{ value: 'exact', label: 'Exact date' },
		...PRESETS.map((p) => ({ value: p.id, label: p.label })),
		{ value: 'custom', label: 'Custom…' }
	];
	const unitItems = $derived(DATE_UNIT_CHOICES.map((u) => ({ value: u.unit as string, label: `${u.label}${count === 1 ? '' : 's'}` })));
	const DIRECTIONS = [
		{ value: 'ago', label: 'ago' },
		{ value: 'ahead', label: 'from now' }
	];
</script>

<span class="inline-flex min-w-0 flex-wrap items-center gap-1" data-testid="date-operand">
	<Select
		size="small"
		class="w-36"
		items={modeItems}
		value={mode}
		disabled={readonly}
		alignItemWithTrigger={false}
		triggerAttrs={{ 'aria-label': label, 'data-testid': 'date-operand-mode' }}
		onValueChange={(v) => v && pick(v)}
	/>
	{#if value.kind === 'exact'}
		<span data-testid="date-operand-day">
			<DateInput
				size="small"
				class="w-32"
				label="{label} (day)"
				theme={{ label: { base: 'sr-only' } }}
				format="yyyy/mm/dd"
				closeOnSelect
				disabled={readonly}
				value={calendarDate(value.date)}
				onValueChange={(date) => date && onChange({ kind: 'exact', date: toDateOnly(date) })}
			/>
		</span>
	{:else if mode === 'custom'}
		<NumberInput
			size="small"
			class="w-20"
			min={1}
			max={1000}
			showControls={false}
			format={{ useGrouping: false, maximumFractionDigits: 0 }}
			disabled={readonly}
			value={count}
			inputAttrs={{ 'aria-label': `${label} (count)` }}
			onValueCommit={({ value: n }) => custom({ count: n || 1 })}
		/>
		<Select
			size="small"
			items={unitItems}
			value={value.kind === 'relative' ? value.unit : 'day'}
			disabled={readonly}
			alignItemWithTrigger={false}
			triggerAttrs={{ 'aria-label': `${label} (unit)` }}
			onValueChange={(v) => v && custom({ unit: v as DateUnit })}
		/>
		<SegmentedControl size="small" label="{label} (direction)" items={DIRECTIONS} value={ahead ? 'ahead' : 'ago'} disabled={readonly} onValueChange={(v) => custom({ ahead: v === 'ahead' })} />
	{/if}
</span>
