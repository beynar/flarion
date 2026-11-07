<!--
	The picker of a date mention: entasis Date input (typed or from its own calendar) and Calendar (single day or
	range), with "End date" and "Include time" switches and a Today shortcut. Every change is committed at once
	through `onSet` (one data write per change); a date-only value has no time zone, a timed one is an instant.
-->
<script lang="ts">
	import { CalendarPrimitive } from 'entasis/calendar';
	import { Button } from 'entasis/button';
	import { DateInput } from 'entasis/date-input';
	import { Switch } from 'entasis/switch';
	import { TimeInput } from 'entasis/time-input';
	import type { DateValue } from '#lib/shared/dates.ts';
	import { composeIso, dayOf, timeOf } from '#lib/shared/blocks/date-label.ts';

	let {
		value,
		onSet,
		canEdit = true
	}: {
		value: DateValue;
		onSet: (value: DateValue) => void;
		canEdit?: boolean;
	} = $props();

	const startDay = $derived(dayOf(value.start));
	const endDay = $derived(value.end ? dayOf(value.end) : null);
	const startTime = $derived(timeOf(value.start));
	const endTime = $derived(value.end ? timeOf(value.end) : null);
	const hasEnd = $derived(!!value.end);
	const timed = $derived(startTime !== null || endTime !== null);

	const day = (date: Date | null | undefined, time: string | null) => (date ? composeIso(date, time) : null);

	function setStart(date: Date | null) {
		if (!canEdit || !date) return;
		const start = composeIso(date, timed ? (startTime ?? '09:00') : null);
		const end = endDay ? composeIso(endDay, timed ? (endTime ?? '10:00') : null) : null;
		// Moving the start past the end drags the end along.
		onSet({ start, ...(end && end >= start ? { end } : {}) });
	}

	function setEnd(date: Date | null) {
		if (!canEdit) return;
		if (!date) return onSet({ start: value.start });
		const end = composeIso(date, timed ? (endTime ?? startTime ?? '10:00') : null);
		onSet({ start: value.start, ...(end >= value.start ? { end } : {}) });
	}

	function pickSingle(date: Date | null) {
		if (date) setStart(date);
	}

	function pickRange(range: [Date | null, Date | null] | null) {
		if (!canEdit || !range?.[0]) return;
		const [a, b] = range;
		const start = composeIso(a, timed ? (startTime ?? '09:00') : null);
		const end = b ? composeIso(b, timed ? (endTime ?? startTime ?? '10:00') : null) : null;
		onSet({ start, ...(end && end >= start ? { end } : {}) });
	}

	function toggleEnd(on: boolean) {
		if (!canEdit || !startDay) return;
		if (!on) return onSet({ start: value.start });
		onSet({ start: value.start, end: composeIso(startDay, timed ? (startTime ?? '09:00') : null) });
	}

	function toggleTime(on: boolean) {
		if (!canEdit || !startDay) return;
		const start = composeIso(startDay, on ? (startTime ?? '09:00') : null);
		const end = endDay ? composeIso(endDay, on ? (endTime ?? '10:00') : null) : null;
		onSet({ start, ...(end ? { end } : {}) });
	}

	function setTime(which: 'start' | 'end', time: string) {
		if (!canEdit || !time || !startDay) return;
		const start = composeIso(startDay, which === 'start' ? time : (startTime ?? '09:00'));
		const end = endDay ? composeIso(endDay, which === 'end' ? time : (endTime ?? time)) : null;
		onSet({ start, ...(end && end >= start ? { end } : {}) });
	}

	const today = () => setStart(new Date());

	/** `TimeInput` holds minutes since midnight; the value holds "HH:MM". */
	const minutesOf = (time: string | null) => {
		const [h, m] = (time ?? '').split(':').map(Number);
		return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null;
	};
	const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
	const toggle = 'flex items-center justify-between px-3 text-sm';
</script>

<div class="flex w-[300px] flex-col" data-testid="date-picker">
	<div class="flex gap-2 px-3 pt-3">
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			<div data-testid="date-picker-start">
				<DateInput
					label="Date"
					value={startDay}
					format="yyyy/mm/dd"
					disabled={!canEdit}
					closeOnSelect
					onValueChange={(date: Date | null) => date && setStart(date)}
				/>
			</div>
			{#if timed}
				<TimeInput
					as="minuteSinceMidnight"
					label="Start time"
					value={minutesOf(startTime)}
					disabled={!canEdit}
					onValueChange={(minutes: number | null) => minutes !== null && setTime('start', hhmm(minutes))}
				/>
			{/if}
		</div>
		{#if hasEnd}
			<div class="flex min-w-0 flex-1 flex-col gap-1">
				<div data-testid="date-picker-end">
					<DateInput
						label="End date"
						value={endDay}
						format="yyyy/mm/dd"
						disabled={!canEdit}
						closeOnSelect
						onValueChange={(date: Date | null) => setEnd(date)}
					/>
				</div>
				{#if timed}
					<TimeInput
						as="minuteSinceMidnight"
						label="End time"
						value={minutesOf(endTime)}
						disabled={!canEdit}
						onValueChange={(minutes: number | null) => minutes !== null && setTime('end', hhmm(minutes))}
					/>
				{/if}
			</div>
		{/if}
	</div>

	<div class="px-1 pt-1" data-testid="date-picker-calendar">
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
		<Button variant="ghost" size="small" class="justify-start rounded-none px-3" disabled={!canEdit} data-testid="date-picker-today" onclick={today}>Today</Button>
	</div>
</div>
