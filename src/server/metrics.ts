/**
 * Metrics, written to Analytics Engine (`env.METRICS`; docs/PLAN.md "Observability"). One data point layout for
 * every metric, so one dataset and one SQL shape serve the SLO dashboard and the alert cron (`admin/slo.ts`):
 *
 *   index1   the metric name ({@link MetricName})
 *   blob1..  labels, in the order the metric lists below
 *   double1  the value (milliseconds, a count, bytes or a ratio, see the table)
 *   double2.. extra numbers, in the order listed below
 *
 * | name        | blobs                              | doubles                                   | written by |
 * | `rpc`       | procedure (`page.create`), class   | latency ms, HTTP status                   | `/rpc` route |
 * | `mutation`  | outcome (`ok`), -                  | commit + fan-out ms (edit to diff), ops   | Workspace DO commit |
 * | `fanout`    | -                                  | sockets reached, fan-out ms, rows         | Workspace DO commit |
 * | `subs`      | workspace id                       | subscriptions, shared units, sockets      | Workspace DO alarm |
 * | `storage`   | workspace id                       | SQLite bytes                              | Workspace DO alarm |
 * | `queue_lag` | queue                              | ms between enqueue and consumption, batch | queue consumer |
 * | `reconnect` | `fresh` or `resume`                | 1                                         | workspace socket `hello` |
 * | `doc_size`  | workspace id, page id              | bytes / limit (0..1), bytes               | Page DO save |
 * | `api`       | token id, `METHOD /path`, class    | latency ms, HTTP status                   | public API |
 * | `error`     | where, message                     | 1                                         | anywhere |
 *
 * Writing never throws and never awaits: a metrics outage must not touch a request. The binding is optional (local
 * dev has no Analytics Engine), and without it a write does nothing.
 */
export const METRIC_NAMES = [
	'rpc',
	'mutation',
	'fanout',
	'subs',
	'storage',
	'queue_lag',
	'reconnect',
	'doc_size',
	'api',
	'error'
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export interface MetricsEnv {
	METRICS?: AnalyticsEngineDataset;
	ENVIRONMENT?: string;
}

declare global {
	/** Tests only: sees every data point written in an isolate whose `ENVIRONMENT` is `test` (the local binding keeps nothing to read). */
	// eslint-disable-next-line no-var
	var __flarionMetricsTap: ((point: AnalyticsEngineDataPoint) => void) | undefined;
}

export interface MetricPoint {
	/** Labels (Analytics Engine keeps up to 20 blobs of 5,120 bytes in all; each is cut at 256 characters here). */
	labels?: readonly string[];
	/** `double1`. */
	value?: number;
	/** `double2` onward. */
	extra?: readonly number[];
}

const MAX_LABEL = 256;
/** Analytics Engine's own cap per data point. */
const MAX_FIELDS = 20;

/** The data point of a metric: pure, so tests (and the SQL in `admin/slo.ts`) agree on one layout. */
export function dataPoint(name: MetricName, point: MetricPoint = {}): AnalyticsEngineDataPoint {
	return {
		indexes: [name],
		blobs: (point.labels ?? []).slice(0, MAX_FIELDS).map((label) => String(label).slice(0, MAX_LABEL)),
		doubles: [point.value ?? 0, ...(point.extra ?? [])].slice(0, MAX_FIELDS).map((n) => (Number.isFinite(n) ? n : 0))
	};
}

/** Writes one metric. Safe to call anywhere: it returns at once and swallows every failure. */
export function metric(env: MetricsEnv | undefined, name: MetricName, point: MetricPoint = {}): void {
	if (env?.ENVIRONMENT === 'test' && globalThis.__flarionMetricsTap) {
		try {
			globalThis.__flarionMetricsTap(dataPoint(name, point));
		} catch {
			// A broken tap must not matter either.
		}
	}
	const dataset = env?.METRICS;
	if (!dataset) return;
	try {
		dataset.writeDataPoint(dataPoint(name, point));
	} catch {
		// Metrics are best effort.
	}
}

/** `4xx`, `5xx`...: the status class a latency is grouped by. */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/** Milliseconds since `start` (a `performance.now()` or `Date.now()` reading), never negative. */
export const since = (start: number, now: number = Date.now()): number => Math.max(0, now - start);

/** The dotted procedure name of an `/rpc/...` path: `/rpc/page/create` is `page.create`, anything else `unknown`. */
export function rpcProcedure(pathname: string): string {
	const rest = pathname.replace(/^\/rpc\/?/, '').replace(/\/+$/, '');
	return /^[A-Za-z0-9_/-]{1,80}$/.test(rest) && rest ? rest.split('/').join('.') : 'unknown';
}

/** Reports an error that is about to be swallowed (and logged), so the alert cron can count them. */
export function reportError(env: MetricsEnv | undefined, where: string, error: unknown): void {
	metric(env, 'error', { labels: [where, error instanceof Error ? error.message : String(error)], value: 1 });
}
