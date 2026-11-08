/**
 * The SLO dashboard's numbers and the alert cron's verdicts, from one place (docs/PLAN.md "Operating targets").
 *
 * Metrics are Analytics Engine data points (`metrics.ts` has the layout). The Worker cannot read its own dataset, so it
 * asks the Analytics Engine SQL API over HTTPS with a token that may read it (`ANALYTICS_API_TOKEN`, a Worker secret;
 * `CF_ACCOUNT_ID` and `METRICS_DATASET` are plain vars). `sloReport` runs one query per signal in parallel and turns
 * the rows into `{ value, status, series }`; a query that fails only marks its own signal `nodata`.
 *
 * Every signal has a **target** (the plan's table) and an **alert condition** (its "Alert when" column). The
 * dashboard shows the target; `status: 'breach'` means the alert condition holds now. Sampling: Analytics Engine
 * samples under load, so counts are summed with `_sample_interval` and percentiles use `quantileWeighted`.
 */
import type { SloReport, SloSignal } from '../../lib/shared/slo-schemas';

export const THRESHOLDS = {
	/** `/rpc` error rate (5xx share) above this, for five minutes. */
	rpcErrorRate: 0.01,
	/** ...with at least this many requests in the window (a quiet minute of one failure is not an incident). */
	rpcMinRequests: 20,
	rpcAvailabilityTarget: 0.999,
	/** Edit to collaborator diff, p95, above this for ten minutes. */
	editToDiffP95Ms: 300,
	editToDiffTargetMs: 150,
	/** Reconnects in the last hour above this multiple of the weekly hourly baseline. */
	reconnectFactor: 5,
	reconnectMinCount: 20,
	reconnectTargetShare: 0.01,
	/** Indexing queue lag above five minutes (target: under 60 s). */
	queueLagMs: 5 * 60_000,
	queueLagTargetMs: 60_000,
	/** Workspace DO storage above 5 GB. */
	storageBytes: 5 * 1024 ** 3,
	/** Page document size above 80% of its quota. */
	docRatio: 0.8
} as const;

export type Row = Record<string, unknown>;
export type RunSql = (sql: string) => Promise<Row[]>;

export interface SloEnv {
	ANALYTICS_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	METRICS_DATASET?: string;
}

const SQL_ENDPOINT = (account: string) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/analytics_engine/sql`;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What the dashboard says when the SQL API cannot be reached: the exact names the orchestrator must set. */
export const UNCONFIGURED =
	'The Analytics Engine SQL API is not configured. Set the Worker secret ANALYTICS_API_TOKEN (an API token with "Account Analytics: Read") and the vars CF_ACCOUNT_ID and METRICS_DATASET (docs/ops/alerts.md).';

/** A runner over the SQL API, or null when the token, account or dataset is missing. */
export function analyticsRunner(env: SloEnv, fetchImpl: typeof fetch = fetch): RunSql | null {
	if (!env.ANALYTICS_API_TOKEN || !env.CF_ACCOUNT_ID || !env.METRICS_DATASET || !IDENTIFIER.test(env.METRICS_DATASET)) return null;
	const url = SQL_ENDPOINT(env.CF_ACCOUNT_ID);
	const token = env.ANALYTICS_API_TOKEN;
	return async (sql) => {
		const response = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: sql });
		if (!response.ok) throw new Error(`Analytics Engine SQL API answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
		const body = (await response.json()) as { data?: Row[] };
		return body.data ?? [];
	};
}

const num = (value: unknown): number => {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
};

// ───────────────────────────── queries ─────────────────────────────

const within = (interval: string) => `timestamp > NOW() - INTERVAL ${interval}`;
const HOURLY = 'intDiv(toUInt32(timestamp), 3600) * 3600';

/** The SQL of each signal, by dataset (exported for tests and docs). */
export const queries = (dataset: string) => ({
	rpcWindow: `SELECT blob2 AS class, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1 = 'rpc' AND ${within("'5' MINUTE")} GROUP BY class`,
	rpcMonth: `SELECT blob2 AS class, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1 = 'rpc' AND ${within("'30' DAY")} GROUP BY class`,
	rpcSeries: `SELECT ${HOURLY} AS t, blob2 AS class, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1 = 'rpc' AND ${within("'24' HOUR")} GROUP BY t, class ORDER BY t`,
	diffWindow: `SELECT quantileWeighted(0.95)(double1, _sample_interval) AS p95, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1 = 'mutation' AND ${within("'10' MINUTE")}`,
	diffSeries: `SELECT ${HOURLY} AS t, quantileWeighted(0.95)(double1, _sample_interval) AS p95 FROM ${dataset} WHERE index1 = 'mutation' AND ${within("'24' HOUR")} GROUP BY t ORDER BY t`,
	reconnectHour: `SELECT blob1 AS kind, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1 = 'reconnect' AND ${within("'1' HOUR")} GROUP BY kind`,
	reconnectWeek: `SELECT blob1 AS kind, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1 = 'reconnect' AND ${within("'7' DAY")} GROUP BY kind`,
	reconnectSeries: `SELECT ${HOURLY} AS t, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1 = 'reconnect' AND blob1 = 'resume' AND ${within("'24' HOUR")} GROUP BY t ORDER BY t`,
	lagWindow: `SELECT quantileWeighted(0.95)(double1, _sample_interval) AS p95, MAX(double1) AS max, SUM(_sample_interval) AS n FROM ${dataset} WHERE index1 = 'queue_lag' AND ${within("'10' MINUTE")}`,
	lagSeries: `SELECT ${HOURLY} AS t, quantileWeighted(0.95)(double1, _sample_interval) AS p95 FROM ${dataset} WHERE index1 = 'queue_lag' AND ${within("'24' HOUR")} GROUP BY t ORDER BY t`,
	storage: `SELECT blob1 AS workspace, MAX(double1) AS bytes FROM ${dataset} WHERE index1 = 'storage' AND ${within("'2' DAY")} GROUP BY workspace ORDER BY bytes DESC LIMIT 5`,
	storageSeries: `SELECT ${HOURLY} AS t, MAX(double1) AS bytes FROM ${dataset} WHERE index1 = 'storage' AND ${within("'24' HOUR")} GROUP BY t ORDER BY t`,
	docs: `SELECT blob1 AS workspace, blob2 AS page, MAX(double1) AS ratio FROM ${dataset} WHERE index1 = 'doc_size' AND ${within("'1' DAY")} GROUP BY workspace, page ORDER BY ratio DESC LIMIT 5`,
	docSeries: `SELECT ${HOURLY} AS t, MAX(double1) AS ratio FROM ${dataset} WHERE index1 = 'doc_size' AND ${within("'24' HOUR")} GROUP BY t ORDER BY t`
});

// ───────────────────────────── formatting ─────────────────────────────

export const formatBytes = (bytes: number): string => {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${Math.round(bytes)} B`;
};
export const formatMs = (ms: number): string => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const formatPercent = (ratio: number, digits = 2): string => `${(ratio * 100).toFixed(digits)}%`;

// ───────────────────────────── signals ─────────────────────────────

/** 5xx share of `/rpc` rows (`class`, `n`), and the request count. */
export function errorShare(rows: Row[]): { errors: number; total: number; rate: number } {
	let errors = 0;
	let total = 0;
	for (const row of rows) {
		const n = num(row.n);
		total += n;
		if (row.class === '5xx') errors += n;
	}
	return { errors, total, rate: total > 0 ? errors / total : 0 };
}

const series = (rows: Row[], pick: (row: Row) => number): SloSignal['series'] => rows.map((row) => ({ t: num(row.t), v: pick(row) }));

function rpcSeries(rows: Row[]): SloSignal['series'] {
	const byHour = new Map<number, Row[]>();
	for (const row of rows) byHour.set(num(row.t), [...(byHour.get(num(row.t)) ?? []), row]);
	return [...byHour].map(([t, hour]) => ({ t, v: errorShare(hour).rate * 100 })).sort((a, b) => a.t - b.t);
}

type Base = Pick<SloSignal, 'id' | 'label' | 'target' | 'alertWhen' | 'unit'>;

const signal = (s: Omit<SloSignal, 'series'> & { series?: SloSignal['series'] }): SloSignal => ({ series: [], ...s });

async function safe(base: Base, build: () => Promise<SloSignal>): Promise<SloSignal> {
	try {
		return await build();
	} catch (error) {
		return signal({ ...base, display: 'No data', value: null, status: 'nodata', detail: error instanceof Error ? error.message : String(error) });
	}
}

export async function computeSignals(run: RunSql, dataset: string): Promise<SloSignal[]> {
	const q = queries(dataset);
	const T = THRESHOLDS;

	const rpc: Base = { id: 'rpc_availability', label: '/rpc availability', target: '99.9% per month', alertWhen: 'Error rate above 1% for 5 minutes', unit: 'percent' };
	const diff: Base = { id: 'edit_to_diff', label: 'Edit to collaborator diff, p95', target: '150 ms, same region', alertWhen: 'Above 300 ms for 10 minutes', unit: 'ms' };
	const reconnects: Base = { id: 'reconnects', label: 'Workspace socket reconnects', target: 'Below 1% of sockets per hour', alertWhen: 'Five times the weekly baseline', unit: 'count' };
	const lag: Base = { id: 'queue_lag', label: 'Indexing queue lag, p95', target: 'Under 60 s', alertWhen: 'Over 5 minutes', unit: 'ms' };
	const storage: Base = { id: 'do_storage', label: 'Workspace DO storage, largest', target: 'Under 5 GB', alertWhen: 'Over 5 GB', unit: 'bytes' };
	const pages: Base = { id: 'page_size', label: 'Page document size, largest', target: 'Under 80% of quota', alertWhen: 'Over 80%', unit: 'ratio' };

	return Promise.all([
		safe(rpc, async () => {
			const [window, month, hourly] = await Promise.all([run(q.rpcWindow), run(q.rpcMonth), run(q.rpcSeries)]);
			const now = errorShare(window);
			const long = errorShare(month);
			const breach = now.total >= T.rpcMinRequests && now.rate > T.rpcErrorRate;
			const availability = long.total > 0 ? 1 - long.rate : null;
			return signal({
				...rpc,
				value: availability === null ? null : availability * 100,
				display: availability === null ? 'No data' : `${formatPercent(availability, 3)} over 30 days`,
				status: now.total === 0 && long.total === 0 ? 'nodata' : breach ? 'breach' : 'ok',
				detail: `Last 5 minutes: ${formatPercent(now.rate)} errors of ${Math.round(now.total)} requests${availability !== null && availability < T.rpcAvailabilityTarget ? ' · below the monthly target' : ''}`,
				series: rpcSeries(hourly)
			});
		}),
		safe(diff, async () => {
			const [[window], hourly] = await Promise.all([run(q.diffWindow), run(q.diffSeries)]);
			const n = num(window?.n);
			const p95 = num(window?.p95);
			return signal({
				...diff,
				value: n > 0 ? p95 : null,
				display: n > 0 ? formatMs(p95) : 'No data',
				status: n === 0 ? 'nodata' : p95 > T.editToDiffP95Ms ? 'breach' : 'ok',
				detail: n > 0 ? `10-minute window, ${Math.round(n)} commits` : undefined,
				series: series(hourly, (row) => num(row.p95))
			});
		}),
		safe(reconnects, async () => {
			const [hour, week, hourly] = await Promise.all([run(q.reconnectHour), run(q.reconnectWeek), run(q.reconnectSeries)]);
			const count = (rows: Row[], kind: string) => num(rows.find((r) => r.kind === kind)?.n);
			const resumedHour = count(hour, 'resume');
			const sessionsHour = resumedHour + count(hour, 'fresh');
			const baseline = count(week, 'resume') / (7 * 24);
			const breach = resumedHour >= T.reconnectMinCount && resumedHour > T.reconnectFactor * Math.max(baseline, 1);
			return signal({
				...reconnects,
				value: sessionsHour > 0 ? resumedHour / sessionsHour : null,
				display: sessionsHour > 0 ? `${Math.round(resumedHour)} in the last hour (${formatPercent(resumedHour / sessionsHour, 1)} of connections)` : 'No data',
				status: sessionsHour === 0 ? 'nodata' : breach ? 'breach' : 'ok',
				detail: `Weekly baseline ${baseline.toFixed(1)} an hour`,
				series: series(hourly, (row) => num(row.n))
			});
		}),
		safe(lag, async () => {
			const [[window], hourly] = await Promise.all([run(q.lagWindow), run(q.lagSeries)]);
			const n = num(window?.n);
			const max = num(window?.max);
			return signal({
				...lag,
				value: n > 0 ? num(window?.p95) : null,
				display: n > 0 ? formatMs(num(window?.p95)) : 'No data',
				status: n === 0 ? 'nodata' : max > T.queueLagMs ? 'breach' : 'ok',
				detail: n > 0 ? `Slowest page in the last 10 minutes: ${formatMs(max)}` : undefined,
				series: series(hourly, (row) => num(row.p95))
			});
		}),
		safe(storage, async () => {
			const [top, hourly] = await Promise.all([run(q.storage), run(q.storageSeries)]);
			const worst = top[0];
			const bytes = num(worst?.bytes);
			return signal({
				...storage,
				value: worst ? bytes : null,
				display: worst ? formatBytes(bytes) : 'No data',
				status: !worst ? 'nodata' : bytes > T.storageBytes ? 'breach' : 'ok',
				detail: worst ? `Workspace ${String(worst.workspace)} · largest five: ${top.map((r) => formatBytes(num(r.bytes))).join(', ')}` : undefined,
				series: series(hourly, (row) => num(row.bytes))
			});
		}),
		safe(pages, async () => {
			const [top, hourly] = await Promise.all([run(q.docs), run(q.docSeries)]);
			const worst = top[0];
			const ratio = num(worst?.ratio);
			return signal({
				...pages,
				value: worst ? ratio : null,
				display: worst ? formatPercent(ratio, 1) : 'No data',
				status: !worst ? 'nodata' : ratio > T.docRatio ? 'breach' : 'ok',
				detail: worst ? `Page ${String(worst.page)} in workspace ${String(worst.workspace)}` : undefined,
				series: series(hourly, (row) => num(row.ratio) * 100)
			});
		})
	]);
}

export async function sloReport(env: SloEnv, deps: { run?: RunSql | null; now?: Date } = {}): Promise<SloReport> {
	const run = deps.run === undefined ? analyticsRunner(env) : deps.run;
	const generatedAt = (deps.now ?? new Date()).toISOString();
	if (!run) return { available: false, message: UNCONFIGURED, generatedAt, signals: [] };
	return { available: true, generatedAt, signals: await computeSignals(run, env.METRICS_DATASET ?? 'metrics') };
}
