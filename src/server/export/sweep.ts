/**
 * The weekly export sweep (the same cron as the upload sweep, `0 4 * * SUN`): finished export archives
 * (`exports/<workspaceId>/<jobId>.zip`) and the scratch objects of failed runs (`exports/<workspaceId>/<jobId>/tmp/...`)
 * are deleted once they are older than {@link JOB_TTL_SECONDS} (7 days), the same time the job record keeps in KV, so
 * a download link never outlives its record and R2 does not fill with archives nobody will fetch again.
 */
import { EXPORT_PREFIX, JOB_TTL_SECONDS } from './jobs';

export interface ExportSweepSummary {
	/** Objects looked at. */
	scanned: number;
	/** Objects deleted (archives and leftovers older than the retention). */
	removed: number;
	bytes: number;
}

/** R2 deletes up to 1,000 keys per call. */
const BATCH = 1000;

export async function sweepExports(env: Pick<Env, 'FILES'>, options: { now?: number; maxAgeMs?: number } = {}): Promise<ExportSweepSummary> {
	const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? JOB_TTL_SECONDS * 1000);
	const summary: ExportSweepSummary = { scanned: 0, removed: 0, bytes: 0 };
	let cursor: string | undefined;
	do {
		const page = await env.FILES.list({ prefix: EXPORT_PREFIX, cursor, limit: BATCH });
		summary.scanned += page.objects.length;
		const old = page.objects.filter((object) => object.uploaded.getTime() < cutoff);
		if (old.length > 0) {
			await env.FILES.delete(old.map((object) => object.key));
			summary.removed += old.length;
			summary.bytes += old.reduce((sum, object) => sum + object.size, 0);
		}
		// Deleting while listing is safe: the cursor names a position, not a page number.
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return summary;
}
