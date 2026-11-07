<script lang="ts">
	import { untrack } from 'svelte';
	import { CalendarPrimitive } from 'entasis/calendar';
	import { Switch } from 'entasis/switch';
	import type { DateValue } from '#lib/shared/dates.ts';
	import {
		calendarDate,
		composeDate,
		formatDateText,
		hasTime,
		makeDateValue,
		timeOf
	} from './helpers.ts';

	/**
	 * The date popover: start and end shown as text, an entasis calendar (single day or range), the
	 * "End date" and "Include time" switches and Clear. Commits on every change (`onSet`); `includeTime`
	 * is the property's default and each value remembers its own choice by carrying a time or not.
	 */
	let {
		value,
		includeTime,
		onSet,
		onConfigIncludeTime,
		canEdit = true
	}: {
		value: DateValue | null;
		/** The property's `config.includeTime`. */
		includeTime: boolean;
		onSet: (value: DateValue | null) => void;
		/** Persists the property default when the user toggles "Include time". */
		onConfigIncludeTime?: (on: boolean) => void;
		canEdit?: boolean;
	} = $props();

	// "End date" is a mode of its own: a range with only its start picked is still a range.
	let rangeMode = $state(untrack(() => !!value?.end));
	$effect(() => {
		if (value?.end) rangeMode = true;
	});
	const hasEnd = $derived(rangeMode);
	const timed = $derived(value ? hasTime(value.start) || (!!value.end && hasTime(value.end)) : includeTime);
	const startDay = $derived(value ? calendarDate(value.start) : null);
	const endDay = $derived(value?.end ? calendarDate(value.end) : null);
	const startTime = $derived(value ? timeOf(value.start) : '');
	const endTime = $derived(value?.end ? timeOf(value.end) : '');

	const compose = (day: Date, time: string, on: boolean) => composeDate(day, on ? time || '09:00' : null);

	function pickSingle(d: Date | null) {
		if (!canEdit) return;
		if (!d) return onSet(null);
		onSet(makeDateValue(compose(d, startTime, timed), null));
	}
	function pickRange(r: [Date | null, Date | null] | null) {
		if (!canEdit || !r || !r[0]) return;
		const [a, b] = r;
		// Until the second click lands the value is the start alone.
		onSet(makeDateValue(compose(a, startTime, timed), b ? compose(b, endTime, timed) : null));
	}

	function toggleEnd(on: boolean) {
		rangeMode = on;
		if (!on && value?.end) onSet({ start: value.start });
	}
	function toggleTime(on: boolean) {
		onConfigIncludeTime?.(on);
		if (!value) return;
		const a = startDay;
		const b = endDay;
		if (!a) return;
		onSet(makeDateValue(compose(a, startTime, on), b ? compose(b, endTime, on) : null));
	}
	function setTime(which: 'start' | 'end', time: string) {
		if (!canEdit || !value) return;
		const a = startDay;
		const b = endDay;
		if (!a) return;
		const s = compose(a, which === 'start' ? time : startTime, true);
		const e = b ? compose(b, which === 'end' ? time : endTime, true) : null;
		onSet(makeDateValue(s, e));
	}

	const field =
		'rounded-[var(--app-radius-control)] border border-[color:var(--app-hairline-strong)] bg-[color:var(--app-page)] px-2 text-sm text-[color:var(--app-text)]';
	const toggle = 'flex items-center justify-between px-3 text-sm';
</script>

<div class="flex w-[288px] flex-col" data-testid="date-editor">
	<div class="flex gap-2 px-3 pt-3">
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			<div class="{field} flex items-center truncate" style="height: var(--app-input-height)" data-testid="date-start">
				{value ? formatDateText(value.start).replace(/ \d+:\d\d [AP]M$/, '') : 'Pick a date'}
			</div>
			{#if timed && value}
				<input type="time" class={field} style="height: var(--app-input-height)" aria-label="Start time" value={startTime} disabled={!canEdit} onchange={(e) => setTime('start', e.currentTarget.value)} />
			{/if}
		</div>
		{#if hasEnd}
			<div class="flex min-w-0 flex-1 flex-col gap-1">
				<div class="{field} flex items-center truncate" style="height: var(--app-input-height)" data-testid="date-end">
					{value?.end ? formatDateText(value.end).replace(/ \d+:\d\d [AP]M$/, '') : 'Pick an end date'}
				</div>
				{#if timed && value?.end}
					<input type="time" class={field} style="height: var(--app-input-height)" aria-label="End time" value={endTime} disabled={!canEdit} onchange={(e) => setTime('end', e.currentTarget.value)} />
				{/if}
			</div>
		{/if}
	</div>

	<div class="px-1 pt-1">
		{#key hasEnd}
			{#if hasEnd}
				<CalendarPrimitive type="calendar-range" value={[startDay, endDay]} onValueChange={pickRange} disabled={!canEdit} />
			{:else}
				<CalendarPrimitive type="calendar" value={startDay} onValueChange={pickSingle} disabled={!canEdit} />
			{/if}
		{/key}
	</div>

	<div class="flex flex-col border-t border-[color:var(--app-hairline)] py-1">
		<div class={toggle} style="height: var(--app-row-height)">
			<span>End date</span>
			<Switch size="small" value={hasEnd} disabled={!canEdit} onValueChange={(on) => toggleEnd(!!on)} inputAttrs={{ 'aria-label': 'End date' }} />
		</div>
		<div class={toggle} style="height: var(--app-row-height)">
			<span>Include time</span>
			<Switch size="small" value={timed} disabled={!canEdit} onValueChange={(on) => toggleTime(!!on)} inputAttrs={{ 'aria-label': 'Include time' }} />
		</div>
		{#if value && canEdit}
			<button
				type="button"
				class="px-3 text-left text-sm text-[color:var(--app-text-secondary)] hover:bg-[color:var(--app-hover)]"
				style="height: var(--app-row-height)"
				data-testid="date-clear"
				onclick={() => onSet(null)}
			>
				Clear
			</button>
		{/if}
	</div>
</div>
