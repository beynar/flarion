/**
 * The weekly upload sweep (cron `0 4 * * SUN`, docs/PLAN.md "Files and media"): in every workspace, uploads
 * begun more than a day ago and never committed lose their row, their multipart upload and their bytes.
 */
import type { WorkspaceDO } from '../objects/workspace/workspace-do';

export const SWEEP_CRON = '0 4 * * SUN';

export interface SweepSummary {
	workspaces: number;
	removed: number;
	failed: number;
}

export async function sweepUncommittedUploads(
	env: Pick<Env, 'DB' | 'WORKSPACE'>,
	options: { now?: number; maxAgeMs?: number } = {}
): Promise<SweepSummary> {
	const { results } = await env.DB.prepare('SELECT id FROM workspace').all<{ id: string }>();
	const summary: SweepSummary = { workspaces: results.length, removed: 0, failed: 0 };
	for (const { id } of results) {
		try {
			const stub = env.WORKSPACE.getByName(id) as unknown as DurableObjectStub<WorkspaceDO>;
			summary.removed += await stub.filesSweep(options);
		} catch (error) {
			summary.failed++;
			console.error(`[sweep] workspace ${id} failed:`, error instanceof Error ? error.message : error);
		}
	}
	return summary;
}
