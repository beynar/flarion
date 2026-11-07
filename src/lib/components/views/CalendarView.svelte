<!--
	The calendar layout: entasis Event calendar over a date property. Pages with a date show on their day (a
	range spans days; a date with a time shows in the week and day views); dragging or resizing an event writes the
	date back (`setProp`). Drag over empty days to start a page there. The host loads the visible range plus a
	month either side.
-->
<script lang="ts">
	import { EventCalendar, type EventCalendarItem, type EventCalendarItemsChangePayload, type EventCalendarSlotSelectPayload, type EventCalendarRangeChangeInfo } from 'entasis/event-calendar';
	import { Empty } from 'entasis/empty';
	import type { ViewData } from '#lib/client/workspace.svelte.ts';
	import { parseIsoDate, type DateValue } from '#lib/shared/dates.ts';
	import type { ViewEnv } from './env.ts';
	import { addDaysIso, dateProps, isoDay, rowDates, toDateValue } from './view-model.ts';

	let { env, data, onRange }: { env: ViewEnv; data: ViewData; onRange: (from: string, to: string) => void } = $props();

	const dp = $derived(dateProps(env.view, env.properties));
	const timeZone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

	const timed = (iso: string) => iso.includes('T');

	function toItem(row: ViewData['rows'][number]): EventCalendarItem | null {
		if (!dp.start) return null;
		const d = rowDates(row.values[dp.start.id], dp.end ? row.values[dp.end.id] : undefined);
		if (!d) return null;
		const base = { id: row.id, title: row.title || 'Untitled', draggable: env.editable, resizable: env.editable };
		if (timed(d.start)) {
			const start = new Date(parseIsoDate(d.start)!.ms);
			const end = d.end ? new Date(parseIsoDate(d.end)!.ms) : new Date(start.getTime() + 3_600_000);
			return { ...base, start, end, allDay: false } as EventCalendarItem;
		}
		const last = d.end ? d.end.slice(0, 10) : d.start;
		return { ...base, start: d.start as `${number}-${number}-${number}`, end: addDaysIso(last, 1) as `${number}-${number}-${number}`, allDay: true } as EventCalendarItem;
	}

	let items = $state.raw<EventCalendarItem[]>([]);
	$effect.pre(() => {
		items = data.rows.flatMap((r) => toItem(r) ?? []);
	});
	const undated = $derived(data.rows.filter((r) => !toItem(r)).length);

	function valueOf(item: EventCalendarItem): DateValue {
		if (item.allDay) {
			const start = item.start as string;
			const end = addDaysIso(item.end as string, -1);
			return toDateValue(start, end);
		}
		const iso = (d: Date) => d.toISOString().replace(/\.000Z$/, 'Z');
		return toDateValue(iso(item.start as Date), iso(item.end as Date));
	}

	function changed({ change }: EventCalendarItemsChangePayload) {
		if (!dp.start || !('item' in change) || !change.item || (change.kind !== 'move' && change.kind !== 'resize' && change.kind !== 'update')) return;
		const v = valueOf(change.item);
		// A single-date property keeps one date: moving a ranged event moves its start (its end rides along).
		void env.setValue(change.item.id, dp.start.id, v);
	}

	function selected({ slot }: EventCalendarSlotSelectPayload) {
		if (!dp.start || !env.editable) return;
		const value = slot.allDay ? toDateValue(slot.start, addDaysIso(slot.end, -1)) : ({ start: slot.start.toISOString().replace(/\.000Z$/, 'Z') } as DateValue);
		void env.newRow({ [dp.start.id]: value });
	}

	let date = $state(new Date());
	function ranged(info: EventCalendarRangeChangeInfo) {
		onRange(isoDay(info.renderRange.start.getTime()), isoDay(info.renderRange.end.getTime()));
	}
</script>

<div class="calendar" data-testid="view-calendar">
	{#if !dp.start}
		<Empty size="small" title="No date property yet" description="Add a date property to this database to place its pages on the calendar." data-testid="calendar-needs-date" />
	{:else}
		<EventCalendar
			bind:items
			bind:date
			{timeZone}
			views={['month', 'week', 'day']}
			month={{ fixedWeeks: false, showOutsideDays: true }}
			interactions={{ drag: env.editable, resize: env.editable, selectSlot: env.editable, keyboard: true, singlePointer: false, clipboard: false }}
			onItemsChange={changed}
			onSelect={selected}
			onRangeChange={ranged}
			onItemClick={({ occurrence, event }) => env.open(occurrence.item.id, event)}
			density="compact"
			class="notion-calendar"
			itemTooltip={false}
		/>
		{#if undated}
			<div class="foot" data-testid="calendar-undated">{undated} {undated === 1 ? 'page has' : 'pages have'} no date</div>
		{/if}
	{/if}
	<div class="count" data-testid="view-count">{data.total} {data.total === 1 ? 'page' : 'pages'}</div>
</div>

<style>
	.calendar {
		min-width: 0;
		padding-top: 8px;
	}
	.calendar :global(.notion-calendar) {
		height: 640px;
	}
	.foot,
	.count {
		padding: 6px 4px;
		font-size: 12px;
		color: var(--app-text-secondary);
	}
	.count {
		text-align: right;
	}
</style>
