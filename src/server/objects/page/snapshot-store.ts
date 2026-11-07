/**
 * The durable copy of a room in R2, under `ws/{workspaceId}/pages/{pageId}/`:
 *
 *   state.bin      the full CRDT update (what `onLoad` restores from)
 *   replicas.json  who owns each client id
 *
 * `replicas.json` is written first: if only one write lands, a newer `state.bin` with older owners
 * restores content and lets clients re-claim ids, while the reverse would orphan nothing either.
 */
import type { LoadedDocument, ReplicaOwner, SavedDocument } from 'edytor/cloudflare';
import type { PageIdentity } from './page-meta';

export const pageKeyPrefix = ({ workspaceId, pageId }: PageIdentity) => `ws/${workspaceId}/pages/${pageId}/`;
export const stateKey = (identity: PageIdentity) => `${pageKeyPrefix(identity)}state.bin`;
export const replicasKey = (identity: PageIdentity) => `${pageKeyPrefix(identity)}replicas.json`;

export async function saveSnapshot(bucket: R2Bucket, identity: PageIdentity, saved: Pick<SavedDocument, 'update' | 'replicas'>) {
	await bucket.put(replicasKey(identity), JSON.stringify(saved.replicas), {
		httpMetadata: { contentType: 'application/json' }
	});
	await bucket.put(stateKey(identity), saved.update, {
		httpMetadata: { contentType: 'application/octet-stream' }
	});
}

/** The saved room, or `undefined` when R2 holds none (a brand-new page). */
export async function loadSnapshot(bucket: R2Bucket, identity: PageIdentity): Promise<LoadedDocument | undefined> {
	const [state, owners] = await Promise.all([bucket.get(stateKey(identity)), bucket.get(replicasKey(identity))]);
	if (!state) return undefined;
	const update = new Uint8Array(await state.arrayBuffer());
	return owners ? { update, replicas: await owners.json<ReplicaOwner[]>() } : update;
}
