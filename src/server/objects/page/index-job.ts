/**
 * Indexing jobs: after each save the Page DO tells the queue that `(workspaceId, pageId)` changed at
 * `version`. The queue consumer batches up to 100 pages into one Workspace DO call, at most once per
 * page every 30 seconds (docs/PLAN.md "Between Durable Objects"), and reads the page text from the
 * Page DO then; the job carries no content.
 */
import type { PageIdentity } from './page-meta';

export interface IndexJob {
	workspaceId: string;
	pageId: string;
	/** Milliseconds timestamp of the room's last stored change; the consumer's dedup key with the page. */
	version: number;
}

const LAST_ENQUEUED = 'index_job:version';

/**
 * Enqueue at most one job per `(page, version)`. A save that is retried after the queue send already
 * succeeded (or a second alarm for the same state) does not enqueue twice.
 */
export async function enqueueIndexJob(
	queue: Queue<IndexJob>,
	kv: SyncKvStorage,
	identity: PageIdentity,
	version: number
): Promise<boolean> {
	if (kv.get<number>(LAST_ENQUEUED) === version) return false;
	await queue.send({ workspaceId: identity.workspaceId, pageId: identity.pageId, version }, { contentType: 'json' });
	kv.put(LAST_ENQUEUED, version);
	return true;
}
