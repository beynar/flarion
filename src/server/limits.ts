/** The limits the plan names and where they are watched (docs/PLAN.md "Performance, limits and scaling", "Operating targets"). */

/** Workspace DO SQLite storage at which an alert fires (the platform limit is 10 GB: shard by type past 5). */
export const STORAGE_ALERT_BYTES = 5 * 1024 ** 3;
/** From this size an object keeps its hourly gauge alarm even when nothing else needs the alarm. */
export const STORAGE_WATCH_BYTES = 1024 ** 3;
/** A page whose document passes this share of its quota is reported to the people who can read it. */
export const QUOTA_WARN_RATIO = 0.8;

/** `alert` from 5 GB (the metrics hook and a console error say so), `watch` from 1 GB (the hourly gauge keeps running while idle). */
export function storageLevel(bytes: number): 'ok' | 'watch' | 'alert' {
	return bytes >= STORAGE_ALERT_BYTES ? 'alert' : bytes >= STORAGE_WATCH_BYTES ? 'watch' : 'ok';
}
