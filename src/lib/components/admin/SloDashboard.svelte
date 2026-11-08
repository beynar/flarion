<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Alert } from 'entasis/alert';
	import { Button } from 'entasis/button';
	import { Card } from 'entasis/card';
	import { Chart } from 'entasis/chart';
	import { Chip } from 'entasis/chip';
	import { DataTable, type DataTableColumn } from 'entasis/data-table';
	import { Skeleton } from 'entasis/skeleton';
	import { Stat } from 'entasis/stat';
	import { rpc } from '#lib/client/rpc.ts';
	import type { SloReport, SloSignal } from '#lib/shared/slo-schemas.ts';
	import { listTheme } from '#lib/components/lists/list-theme.ts';

	/** A report to show instead of asking the server (the dev preview and the e2e check). */
	let { initial = null, seed = null, refreshMs = 60_000 }: { initial?: SloReport | null; seed?: SloReport | null; refreshMs?: number } = $props();

	// `seed` is the report the server render read: on screen from the first paint, then kept fresh like any other.
	let report = $state<SloReport | null>(untrack(() => seed));
	let loading = $state(untrack(() => !seed));
	let error = $state('');

	async function load() {
		if (initial) {
			report = initial;
			loading = false;
			return;
		}
		try {
			report = await rpc.admin.slo();
			error = '';
		} catch (e) {
			error = (e as Error).message || 'Could not load the dashboard';
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		if (!seed || initial) void load();
		const timer = refreshMs > 0 && !initial ? setInterval(load, refreshMs) : undefined;
		return () => timer && clearInterval(timer);
	});

	const colorOf = (s: SloSignal) => (s.status === 'breach' ? 'danger' : s.status === 'ok' ? 'success' : 'neutral');
	const statusLabel = (s: SloSignal) => (s.status === 'breach' ? 'Breached' : s.status === 'ok' ? 'On target' : 'No data');
	const points = (s: SloSignal) => s.series.map((p) => ({ at: new Date(p.t * 1000), value: p.v }));
	const unitOf = (s: SloSignal) => ({ percent: '% errors', ms: 'ms', bytes: 'bytes', ratio: '% of quota', count: 'reconnects' })[s.unit];

	const columns: DataTableColumn<SloSignal>[] = [
		{ id: 'signal', accessor: 'label', header: 'Signal', cell: labelCell },
		{ id: 'target', accessor: 'target', header: 'Target', cell: targetCell, class: 'max-md:hidden', headerClass: 'max-md:hidden' },
		{ id: 'alert', accessor: 'alertWhen', header: 'Alert when', cell: alertCell, class: 'max-lg:hidden', headerClass: 'max-lg:hidden' },
		{ id: 'now', accessor: 'display', header: 'Now', cell: nowCell },
		{ id: 'status', accessor: 'status', header: 'Status', cell: statusCell }
	];
	const theme = listTheme({
		columns:
			'max-md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_104px]! md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_104px]! lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_104px]!'
	});
</script>

{#snippet labelCell(p: { row: SloSignal })}<span class="truncate">{p.row.label}</span>{/snippet}
{#snippet targetCell(p: { row: SloSignal })}<span class="truncate text-xs text-[color:var(--app-text-secondary)]">{p.row.target}</span>{/snippet}
{#snippet alertCell(p: { row: SloSignal })}<span class="truncate text-xs text-[color:var(--app-text-secondary)]">{p.row.alertWhen}</span>{/snippet}
{#snippet nowCell(p: { row: SloSignal })}<span class="truncate" data-testid="slo-now">{p.row.display}</span>{/snippet}
{#snippet statusCell(p: { row: SloSignal })}
	<Chip size="small" variant="soft" color={colorOf(p.row)}>{statusLabel(p.row)}</Chip>
{/snippet}

<section aria-labelledby="slo-h" data-testid="slo-dashboard">
	<div class="mb-4 flex items-center gap-3">
		<div class="flex-1">
			<h1 id="slo-h" class="mb-1 text-3xl font-semibold tracking-tight">Operations</h1>
			<p class="m-0 text-sm text-[color:var(--app-text-secondary)]">
				The operating targets, measured from Analytics Engine{report ? ` · updated ${new Date(report.generatedAt).toLocaleTimeString()}` : ''}.
			</p>
		</div>
		<Button variant="outline" size="small" disabled={loading || initial !== null} onclick={load}>Refresh</Button>
	</div>

	{#if error}
		<Alert color="danger" variant="soft" size="small" data-testid="slo-error">{error}</Alert>
	{:else if loading}
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each Array(6) as _, i (i)}<Skeleton class="h-28" />{/each}
		</div>
	{:else if report && !report.available}
		<Alert color="info" variant="soft" size="small" data-testid="slo-unavailable">{report.message}</Alert>
	{:else if report}
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="slo-stats">
			{#each report.signals as signal (signal.id)}
				<Stat variant="outline" color={colorOf(signal)} trendDirection={signal.status === 'breach' ? 'up' : 'neutral'} data-testid={`slo-${signal.id}`} data-status={signal.status}>
					{#snippet label()}{signal.label}{/snippet}
					{#snippet value()}{signal.display}{/snippet}
					{#snippet trend()}{statusLabel(signal)} · target {signal.target}{/snippet}
					{#snippet description()}{signal.detail ?? ''}{/snippet}
				</Stat>
			{/each}
		</div>

		<h2 class="mt-8 mb-2 text-base font-semibold">Operating targets</h2>
		<DataTable items={report.signals} {columns} getRowId={(s) => s.id} density="compact" pagination={false} caption="Operating targets" {theme} />

		<h2 class="mt-8 mb-2 text-base font-semibold">Last 24 hours</h2>
		<div class="grid gap-3 md:grid-cols-2" data-testid="slo-charts">
			{#each report.signals.filter((s) => s.series.length > 1) as signal (signal.id)}
				<Card variant="outline" size="small">
					<div class="mb-2 text-sm font-medium">{signal.label}</div>
					<Chart
						data={points(signal)}
						marks={[{ type: 'series', x: 'at', y: 'value', area: true, line: true, points: false }]}
						x={{ scale: { type: 'time' } }}
						y={{ scale: { type: 'linear' }, nice: true }}
						label={`${signal.label}, hourly over the last 24 hours (${unitOf(signal)})`}
						height={140}
						legend={false}
					/>
				</Card>
			{/each}
		</div>
	{/if}
</section>
