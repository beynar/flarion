import type { WorkerScheduled } from 'sveltekit-cloudflare-worker';

/** "0 3 * * *": daily purge + nightly reconcile/backups. "0 4 * * 0": weekly upload sweep. */
export const scheduled: WorkerScheduled<App.Platform['env']> = async () => {};
