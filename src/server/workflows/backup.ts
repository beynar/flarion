/**
 * The `BACKUP` Workflow: one instance per workspace per day (`backup-<workspace>-<YYYY-MM-DD>`), started by the daily
 * cron. A Workflow outlives the cron's request: the export runs as a retried step (the DO is paged ~1 MiB at a
 * time and streamed into R2), retention as another. Without the binding (local dev) `runBackupsInline` does the same
 * work in the cron's `waitUntil`.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { dayOf, pruneBackups, pruneOrphanBackups, runBackup, type BackupResult } from '../backup/backup';

export interface BackupParams {
	workspaceId: string;
	/** Epoch ms the run is for (the instance id carries its day). */
	now?: number;
}

const RETRY = { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '30 minutes' } as const;

export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
	async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep): Promise<Omit<BackupResult, 'tables'>> {
		const { workspaceId } = event.payload;
		const now = event.payload.now ?? event.timestamp.getTime();
		const result = await step.do('export', RETRY, async () => {
			const { tables: _tables, ...rest } = await runBackup(this.env, workspaceId, { now });
			return rest;
		});
		await step.do('retention', { retries: { limit: 3, delay: '10 seconds' }, timeout: '5 minutes' }, () => pruneBackups(this.env, workspaceId, now));
		return result;
	}
}

// ───────────────────────────── starting runs ─────────────────────────────

export interface BackupSweep {
	checked: number;
	started: string[];
	failed: string[];
	orphans: { workspaces: number; deleted: number };
}

async function liveWorkspaceIds(env: Pick<Env, 'DB'>): Promise<string[]> {
	const live = await env.DB.prepare('SELECT "id" FROM "workspace" WHERE "deletedAt" IS NULL').all<{ id: string }>();
	return (live.results ?? []).map((r) => r.id);
}

/** Starts a run; an instance that already exists (the cron ran twice) is not an error. */
async function create(env: Env, id: string, params: BackupParams): Promise<boolean> {
	try {
		await env.BACKUP.create({ id, params });
		return true;
	} catch (error) {
		if (/already|exists|duplicate/i.test(error instanceof Error ? error.message : String(error))) return false;
		throw error;
	}
}

/**
 * The nightly entry: a backup run for every live workspace, then retention for the ones that are gone. `start` is the
 * seam tests use. Without the `BACKUP` binding the runs execute inline, four at a time.
 */
export async function startBackupWorkflows(
	env: Env,
	now = Date.now(),
	start: (id: string, params: BackupParams) => Promise<unknown> = async (id, params) => {
		if (env.BACKUP) return create(env, id, params);
		await runBackup(env, params.workspaceId, { now: params.now });
	}
): Promise<BackupSweep> {
	const ids = await liveWorkspaceIds(env);
	const sweep: BackupSweep = { checked: ids.length, started: [], failed: [], orphans: { workspaces: 0, deleted: 0 } };
	const day = dayOf(now);
	const queue = [...ids];
	const worker = async () => {
		for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
			try {
				await start(`backup-${id}-${day}`, { workspaceId: id, now });
				sweep.started.push(id);
			} catch (error) {
				sweep.failed.push(id);
				console.error(`[backup] ${id} not started:`, error instanceof Error ? error.message : error);
			}
		}
	};
	await Promise.all(Array.from({ length: env.BACKUP ? 8 : 4 }, worker));
	sweep.orphans = await pruneOrphanBackups(env, new Set(ids), now);
	return sweep;
}
