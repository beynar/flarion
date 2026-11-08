<!--
	The timeline layout: entasis Gantt chart over a date range (one date property holding a range, or a start and an
	end property). Dragging a bar moves the dates and resizing an edge changes one of them (`setProp`). The grid on
	the left lists the titles; pages without a date are counted below.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { GanttChart, type GanttTask, type GanttTasksChange } from 'entasis/gantt-chart';
	import { Empty } from 'entasis/empty';
	import type { ViewData } from '#lib/client/workspace.svelte.ts';
	import { DAY_MS, parseIsoDate, type DateValue } from '#lib/shared/dates.ts';
	import type { ViewEnv } from './env.ts';
	import { dateProps, isoDay, rowDates, toDateValue } from './view-model.ts';

	let { env, data, onRange }: { env: ViewEnv; data: ViewData; onRange: (from: string, to: string) => void } = $props();

	const dp = $derived(dateProps(env.view, env.properties));
	const dayOf = (iso: string) => parseIsoDate(iso)!.ms;

	function toTask(row: ViewData['rows'][number]): GanttTask | null {
		if (!dp.start) return null;
		const d = rowDates(row.values[dp.start.id], dp.end ? row.values[dp.end.id] : undefined);
		if (!d) return null;
		const start = dayOf(d.start);
		const dateOnly = !d.start.includes('T');
		const endMs = d.end ? dayOf(d.end) + (dateOnly ? DAY_MS : 0) : start + (dateOnly ? DAY_MS : 3_600_000);
		return {
			id: row.id,
			title: `${row.icon ? row.icon + ' ' : ''}${row.title || 'Untitled'}`,
			start: new Date(start),
			end: new Date(Math.max(endMs, start + 1)),
			draggable: env.editable,
			resizable: env.editable
		} as GanttTask;
	}

	let tasks = $state.raw<GanttTask[]>(untrack(() => data.rows.flatMap((r) => toTask(r) ?? [])));
	$effect.pre(() => {
		tasks = data.rows.flatMap((r) => toTask(r) ?? []);
	});
	const undated = $derived(data.rows.filter((r) => !toTask(r)).length);

	const dateOnlyOf = (rowId: string) => {
		const row = data.rows.find((r) => r.id === rowId);
		const v = row && dp.start ? row.values[dp.start.id] : null;
		const start = v && typeof v === 'object' && 'start' in v ? v.start : '';
		return !start.includes('T');
	};
	const iso = (ms: number, dateOnly: boolean) => (dateOnly ? isoDay(ms) : new Date(ms).toISOString().replace(/\.000Z$/, 'Z'));

	function changed(change: GanttTasksChange) {
		if (!dp.start) return;
		for (const id of change.affectedTaskIds) {
			const next = change.tasks.find((t) => t.id === id);
			const prev = change.previousTasks.find((t) => t.id === id);
			if (!next?.start || !next.end || !prev?.start || !prev.end) continue;
			if (next.start.getTime() === prev.start.getTime() && next.end.getTime() === prev.end.getTime()) continue;
			const dateOnly = dateOnlyOf(id);
			const startIso = iso(next.start.getTime(), dateOnly);
			// The chart's end is exclusive: the stored end is the last day (date-only values).
			const lastMs = dateOnly ? next.end.getTime() - DAY_MS : next.end.getTime();
			const endIso = iso(lastMs, dateOnly);
			if (dp.end) {
				void env.setValue(id, dp.start.id, { start: startIso } as DateValue);
				void env.setValue(id, dp.end.id, { start: endIso } as DateValue);
			} else {
				void env.setValue(id, dp.start.id, toDateValue(startIso, endIso));
			}
		}
	}

	function visible(info: { range: { start: Date; end: Date } }) {
		onRange(isoDay(info.range.start.getTime()), isoDay(info.range.end.getTime()));
	}
</script>

<div class="timeline" data-testid="view-timeline">
	{#if !dp.start}
		<Empty size="small" title="No date property yet" description="Add a date property to this database to place its pages on the timeline." data-testid="timeline-needs-date" />
	{:else}
		<!-- The zoom Select shows its label above the box; Notion's is a bare "Week" menu (the label stays for screen readers). -->
		<GanttChart
			bind:tasks
			timeZone="UTC"
			density="compact"
			class="notion-timeline"
			theme={{ zoomControl: { base: '[&_label]:sr-only' } }}
			layout={{ rowHeight: 36, grid: { columns: [{ id: 'title', title: 'Name', width: 240, sortable: false, editable: false }] } }}
			timeline={{ todayIndicator: true }}
			interactions={{ moveTask: env.editable, resizeStart: env.editable, resizeEnd: env.editable, resizeProgress: false, reorderRows: false, indent: false, outdent: false, createRange: false }}
			mutations={{ task: { onTasksChange: changed } }}
			events={{ onTaskDoubleClick: ({ task, event }) => env.open(task.taskId, event), onVisibleRangeChange: (info) => visible({ range: info.range }) }}
		/>
		{#if undated}
			<div class="foot" data-testid="timeline-undated">{undated} {undated === 1 ? 'page has' : 'pages have'} no date</div>
		{/if}
	{/if}
	<div class="count" data-testid="view-count">{data.total} {data.total === 1 ? 'page' : 'pages'}</div>
</div>

<style>
	.timeline {
		min-width: 0;
		padding-top: 8px;
	}
	.timeline :global(.notion-timeline) {
		height: 460px;
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
