/**
 * Version history of a page in R2 (docs/PLAN.md "Pages and blocks": "History: edytor history kept in R2 through
 * `r2History`"). edytor writes one object per half-day slot that changed, `history/<room>/<YYYY-MM-DD>-am|pm`, with the
 * version's metadata (`blocks`, `editors`, `at`) and its expiry in R2 custom metadata. Here every key is moved under the
 * page's own R2 prefix:
 *
 *   ws/{workspaceId}/pages/{pageId}/history/{room}/{YYYY-MM-DD}-am|pm
 *
 * so one prefix holds everything a page keeps (`state.bin`, `replicas.json`, the versions) and `PageDO.purge()` deletes
 * the page's R2 footprint with one listing. The page's identity is only known once the object is addressed
 * (`PageDO.identity()`), so the prefix is resolved at each call, not when the room is built.
 */
import { r2History, type HistoryStore, type R2BucketLike } from 'edytor/cloudflare';
import type { PageIdentity } from './page-meta';
import { pageKeyPrefix } from './snapshot-store';

/** The prefix of a page's versions in R2 (inside {@link pageKeyPrefix}). */
export const pageHistoryPrefix = (identity: PageIdentity) => `${pageKeyPrefix(identity)}history/`;

/** `bucket` seen under `prefix()`: keys go in and come out relative to it (the room never sees the page's prefix). */
export function prefixedBucket(bucket: R2Bucket, prefix: () => string): R2BucketLike {
	return {
		put: (key, value, options) => bucket.put(prefix() + key, value, options),
		get: (key) => bucket.get(prefix() + key),
		async list(options) {
			const base = prefix();
			const listed = await bucket.list({
				...options,
				...(options?.prefix !== undefined ? { prefix: base + options.prefix } : { prefix: base })
			});
			return {
				objects: listed.objects.map((object) => ({ key: object.key.slice(base.length), customMetadata: object.customMetadata })),
				truncated: listed.truncated,
				...(listed.truncated ? { cursor: listed.cursor } : {})
			};
		},
		delete: (keys) => bucket.delete(Array.isArray(keys) ? keys.map((key) => prefix() + key) : prefix() + keys)
	};
}

/** The history store of a page: edytor's `r2History` over {@link prefixedBucket}. */
export function pageHistoryStore(bucket: R2Bucket, identity: () => PageIdentity): HistoryStore {
	return r2History(prefixedBucket(bucket, () => pageKeyPrefix(identity())));
}

/**
 * Deletes every R2 object under `prefix` (a page's snapshot, replicas and versions). Pages through the listing, so a
 * long history never stops it; returns how many objects went. Safe to repeat: an empty prefix deletes nothing.
 */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
	let deleted = 0;
	let cursor: string | undefined;
	do {
		const listed: R2Objects = await bucket.list({ prefix, cursor, limit: 1000 });
		if (listed.objects.length > 0) {
			await bucket.delete(listed.objects.map((object) => object.key));
			deleted += listed.objects.length;
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return deleted;
}
