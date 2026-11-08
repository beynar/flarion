<!--
	Dev only. The operating dashboard over a fixed report, with no server: the e2e check that its stats, table and charts
	render (`tests/e2e/api/slo-dashboard.spec.ts`). The real page is /[ws]/admin.
-->
<script lang="ts">
	import SloDashboard from '#lib/components/admin/SloDashboard.svelte';
	import type { SloReport } from '#lib/shared/slo-schemas.ts';

	const base = 1_794_000_000;
	const hours = (f: (i: number) => number) => Array.from({ length: 24 }, (_, i) => ({ t: base + i * 3600, v: f(i) }));
	const report: SloReport = {
		available: true,
		generatedAt: new Date(base * 1000).toISOString(),
		signals: [
			{ id: 'rpc_availability', label: '/rpc availability', target: '99.9% per month', alertWhen: 'Error rate above 1% for 5 minutes', display: '99.981% over 30 days', value: 99.981, unit: 'percent', status: 'ok', detail: 'Last 5 minutes: 0.04% errors of 1200 requests', series: hours((i) => (i % 7 === 0 ? 0.4 : 0.05)) },
			{ id: 'edit_to_diff', label: 'Edit to collaborator diff, p95', target: '150 ms, same region', alertWhen: 'Above 300 ms for 10 minutes', display: '412 ms', value: 412, unit: 'ms', status: 'breach', detail: '10-minute window, 380 commits', series: hours((i) => 90 + i * 12) },
			{ id: 'reconnects', label: 'Workspace socket reconnects', target: 'Below 1% of sockets per hour', alertWhen: 'Five times the weekly baseline', display: '12 in the last hour (0.6% of connections)', value: 0.006, unit: 'count', status: 'ok', detail: 'Weekly baseline 9.8 an hour', series: hours((i) => 6 + (i % 5)) },
			{ id: 'queue_lag', label: 'Indexing queue lag, p95', target: 'Under 60 s', alertWhen: 'Over 5 minutes', display: '35.0 s', value: 35000, unit: 'ms', status: 'ok', detail: 'Slowest page in the last 10 minutes: 61.0 s', series: hours((i) => 20_000 + i * 600) },
			{ id: 'do_storage', label: 'Workspace DO storage, largest', target: 'Under 5 GB', alertWhen: 'Over 5 GB', display: '2.00 GB', value: 2147483648, unit: 'bytes', status: 'ok', detail: 'Workspace ws-a', series: hours((i) => 1_800_000_000 + i * 12_000_000) },
			{ id: 'page_size', label: 'Page document size, largest', target: 'Under 80% of quota', alertWhen: 'Over 80%', display: 'No data', value: null, unit: 'ratio', status: 'nodata', series: [] }
		]
	};
</script>

<div class="mx-auto w-full max-w-[1000px] px-6 py-8">
	<SloDashboard initial={report} />
</div>
