import type { WorkerScheduled } from 'sveltekit-cloudflare-worker';
import { drainOutbox, pruneOutbox, reconcileMemberships } from './auth/outbox';
import { SWEEP_CRON, sweepUncommittedUploads } from './files/sweep';
import { reconcileGuests } from './share/guests';
import { reconcilePublicShares } from './share/public-links';
import { startPurgeWorkflows } from './workflows/purge';

/** "0 3 * * *": daily purge + nightly reconcile/backups. "0 4 * * SUN": weekly upload sweep. */
export const NIGHTLY_CRON = '0 3 * * *';

type Env = App.Platform['env'];

/**
 * Nightly identity maintenance (docs/PLAN.md "Two copies of membership", "Share links in two stores"): retry
 * what the outbox could not deliver, re-push every D1 membership to its Workspace DO, make public-link routes
 * and guest grants agree with the DO, and prune delivered outbox rows. Each step is
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
	// "Share links in two stores": D1 routes against DO grants, then guest grants against memberships.
	await step('public share reconcile', () => reconcilePublicShares(env));
	await step('guest grants reconcile', () => reconcileGuests(env));
	await step('outbox prune', () => pruneOutbox(env));
}

export const scheduled: WorkerScheduled<Env> = async (controller, env, ctx) => {
	if (controller.cron === NIGHTLY_CRON) {
		ctx.waitUntil(runNightlyIdentityJobs(env));
		// Trash older than 30 days, and workspaces deleted more than 30 days ago: the PURGE Workflow per workspace.
		ctx.waitUntil(
			startPurgeWorkflows(env)
				.then((r) => console.log('[cron] purge:', JSON.stringify(r)))
				.catch((error) => console.error('[cron] purge failed:', error instanceof Error ? (error.stack ?? error.message) : error))
		);
	}
	if (controller.cron === SWEEP_CRON) ctx.waitUntil(sweepUncommittedUploads(env).then((r) => console.log('[cron] upload sweep:', JSON.stringify(r))));
};
