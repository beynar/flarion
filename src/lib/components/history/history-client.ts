/**
 * edytor's `HistoryClient` over the app's `/rpc` (`page.history.*`), so the version list, the preview, Restore and
 * Undo restore go through the same permission checks as every other call (`read` to look, `update` to restore).
 */
import type { HistoryClient, HistoryVersion } from 'edytor';
import type { JSONDoc } from 'edytor/crdt/edytor';
import type { Rpc } from '#lib/client/rpc.ts';
import type { HistoryEntry } from '#lib/shared/schemas.ts';

type HistoryRpc = Pick<Rpc['page']['history'], 'list' | 'read' | 'restore' | 'undo'>;

/** A listed entry as edytor's panel reads it. `key` is our version id (`YYYY-MM-DD-am|pm`). */
export function toVersion(entry: HistoryEntry): HistoryVersion {
	const at = Date.parse(entry.createdAt);
	const [date = '', slot = 'am'] = entry.date && entry.slot ? [entry.date, entry.slot] : entry.id.split(/-(?=am$|pm$)/);
	return {
		key: entry.id,
		date,
		slot: slot === 'pm' ? 'pm' : 'am',
		bytes: entry.size,
		blocks: entry.blocks ?? 0,
		editors: entry.authorIds,
		more: entry.moreAuthors ?? 0,
		at,
		expiresAt: Number.isFinite(at) ? at + 30 * 24 * 3600 * 1000 : null
	};
}

const isNotFound = (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'NOT_FOUND';

export function rpcHistoryClient(history: HistoryRpc, pageId: string): HistoryClient {
	return {
		async list() {
			const versions: HistoryVersion[] = [];
			let cursor: string | undefined;
			do {
				const page = await history.list({ pageId, limit: 100, ...(cursor ? { cursor } : {}) });
				versions.push(...page.items.map(toVersion));
				cursor = page.nextCursor ?? undefined;
			} while (cursor);
			return versions;
		},
		async read(key) {
			try {
				return (await history.read({ pageId, versionId: key })).doc as unknown as JSONDoc;
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},
		async restore(key) {
			try {
				await history.restore({ pageId, versionId: key });
				return { status: 'applied', key };
			} catch (error) {
				if (isNotFound(error)) return { status: 'refused', key };
				throw error;
			}
		},
		undo: () => history.undo({ id: pageId })
	};
}
