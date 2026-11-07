<script lang="ts">
	import { untrack } from 'svelte';
	import { CalendarPrimitive } from 'entasis/calendar';
	import { Switch } from 'entasis/switch';
	import { Button } from 'entasis/button';
	import { DateInput } from 'entasis/date-input';
	import { TimeInput } from 'entasis/time-input';
	import { Separator } from 'entasis/separator';
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

	/** `HH:mm` text <-> the minutes since midnight entasis' TimeInput carries. */
	const toMinutes = (time: string): number | null => {
		const m = /^(\d{1,2}):(\d{2})$/.exec(time);
		return m ? Number(m[1]) * 60 + Number(m[2]) : null;
	};
	const toText = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

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

	/** A day typed or chosen in the start field: the time of day stays. */
	function setStartDay(d: Date | null) {
		// An incomplete date reads as null while typing: clearing the value is the Clear button's job.
		if (!canEdit || !d) return;
		if (d.getTime() === startDay?.getTime()) return;
		const end = endDay && endDay >= d ? compose(endDay, endTime, timed) : null;
		onSet(makeDateValue(compose(d, startTime, timed), end));
	}
	function setEndDay(d: Date | null) {
		if (!canEdit || !value || !startDay || !d) return;
		if (d.getTime() === endDay?.getTime()) return;
		onSet(makeDateValue(compose(startDay, startTime, timed), compose(d, endTime, timed)));
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
	function setTime(which: 'start' | 'end', minutes: number | null) {
		if (!canEdit || !value || minutes === null) return;
		const time = toText(minutes);
		if (time === (which === 'start' ? startTime : endTime)) return;
		const a = startDay;
		const b = endDay;
		if (!a) return;
		const s = compose(a, which === 'start' ? time : startTime, true);
		const e = b ? compose(b, which === 'end' ? time : endTime, true) : null;
		onSet(makeDateValue(s, e));
	}

	const toggle = 'flex items-center justify-between px-3 text-sm';
</script>

<div class="flex w-[288px] flex-col" data-testid="date-editor">
	<div class="flex flex-col gap-2 px-3 pt-3">
		<div class="flex items-start gap-2">
			<div class="min-w-0 flex-1" data-testid="date-start">
				<DateInput size="small" label="Start" format="yyyy/mm/dd" placeholder="Pick a date" disabled={!canEdit} closeOnSelect value={startDay} onValueChange={setStartDay} />
			</div>
			{#if timed && value}
				<div class="w-[96px] shrink-0">
					<TimeInput size="small" label="Time" as="minuteSinceMidnight" disabled={!canEdit} value={toMinutes(startTime)} onValueChange={(m) => setTime('start', m)} fieldAttrs={{ 'aria-label': 'Start time' }} />
				</div>
			{/if}
		</div>
		{#if hasEnd}
			<div class="flex items-start gap-2">
				<div class="min-w-0 flex-1" data-testid="date-end">
					<DateInput size="small" label="End" format="yyyy/mm/dd" placeholder="Pick an end date" disabled={!canEdit || !value} closeOnSelect value={endDay} onValueChange={setEndDay} />
				</div>
				{#if timed && value?.end}
					<div class="w-[96px] shrink-0">
						<TimeInput size="small" label="Time" as="minuteSinceMidnight" disabled={!canEdit} value={toMinutes(endTime)} onValueChange={(m) => setTime('end', m)} fieldAttrs={{ 'aria-label': 'End time' }} />
					</div>
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

	<Separator class="mt-1" />
	<div class="flex flex-col py-1">
		<div class={toggle} style="height: var(--app-row-height)">
			<span>End date</span>
			<Switch size="small" value={hasEnd} disabled={!canEdit} onValueChange={(on) => toggleEnd(!!on)} inputAttrs={{ 'aria-label': 'End date' }} />
		</div>
		<div class={toggle} style="height: var(--app-row-height)">
			<span>Include time</span>
			<Switch size="small" value={timed} disabled={!canEdit} onValueChange={(on) => toggleTime(!!on)} inputAttrs={{ 'aria-label': 'Include time' }} />
		</div>
		{#if value && canEdit}
			<Button variant="ghost" color="neutral" size="small" fullWidth class="justify-start px-3 font-normal text-[color:var(--app-text-secondary)]" data-testid="date-clear" onclick={() => onSet(null)}>Clear</Button>
		{/if}
	</div>
</div>
