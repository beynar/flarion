/**
 * The tail Worker (docs/PLAN.md "Observability": "Workers Logs and a Tail Worker for errors"). The main Worker lists
 * it in `tail_consumers` (staging and production, see `wrangler.jsonc`), and Cloudflare hands it a batch of trace events
 * after each invocation. It keeps the failed ones: an `error` data point in the app's Analytics Engine dataset (so the
 * dashboard and `docs/ops/alerts.md` can count them) and one structured log line (Workers Logs keeps it searchable).
 *
 * Deployed on its own: `wrangler deploy --env staging|production -c workers/tail/wrangler.jsonc`, before the main Worker
 * (a `tail_consumers` entry names a Worker that must exist).
 */
import { errorPoint, type TailEvent } from './errors';

interface TailEnv {
	METRICS?: AnalyticsEngineDataset;
}

export default {
	async tail(events: TailEvent[], env: TailEnv): Promise<void> {
		for (const event of events) {
			const point = errorPoint(event);
			if (!point) continue;
			try {
				env.METRICS?.writeDataPoint(point);
			} catch {
				// Metrics are best effort.
			}
			console.error(JSON.stringify({ tail: 'error', script: event.scriptName, outcome: event.outcome, path: point.blobs[2], message: point.blobs[1], at: event.eventTimestamp }));
		}
	}
} satisfies ExportedHandler<TailEnv>;
