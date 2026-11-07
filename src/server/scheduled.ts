import type { WorkerScheduled } from 'sveltekit-cloudflare-worker';
import { drainOutbox, pruneOutbox, reconcileMemberships } from './auth/outbox';

/** "0 3 * * *": daily purge + nightly reconcile/backups. "0 4 * * 0": weekly upload sweep. */
export const NIGHTLY_CRON = '0 3 * * *';

type Env = App.Platform['env'];

/**
 * Nightly identity maintenance (docs/PLAN.md "Two copies of membership"): retry what the outbox could not
 * deliver, re-push every D1 membership to its Workspace DO, and prune delivered outbox rows. Each step is
 * isolated so one failure does not skip the others.
 */
export async function runNightlyIdentityJobs(env: Env): Promise<void> {
	const step = async (name: string, job: () => Promise<unknown>) => {
		try {
			console.log(`[cron] ${name}:`, JSON.stringify(await job()));
		} catch (error) {
			console.error(`[cron] ${name} failed:`, error instanceof Error ? (error.stack ?? error.message) : error);
		}
	};
	await step('outbox drain', () => drainOutbox(env, 500));
	await step('membership reconcile', () => reconcileMemberships(env));
	await step('outbox prune', () => pruneOutbox(env));
}

export const scheduled: WorkerScheduled<Env> = async (controller, env, ctx) => {
	if (controller.cron === NIGHTLY_CRON) ctx.waitUntil(runNightlyIdentityJobs(env));
};
