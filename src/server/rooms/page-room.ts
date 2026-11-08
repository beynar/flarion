/**
 * A typed handle on a page's room (its Page Durable Object) for the RPC layer. Durable Object RPC reaches only
 * `PageDO`'s own methods, and edytor's generated RPC types are too deep for tsc, so the surface the Worker uses is
 * written down here once.
 */
import type { JSONBlock, JSONDoc } from 'edytor/crdt/edytor';
import type { CommentActor, CommentOutcome, CommentRequest, CommentSnapshot, CommitResult, ExportedBlocks, HistoryEntry, ImportReceipt, ImportRequest, RestoreResult } from 'edytor/cloudflare';
import type { PageLockState } from '../objects/page/page-do';
import { roomName } from './names';

export interface PageRoomApi {
	read(): Promise<JSONDoc>;
	/** The body with its version (published pages): the room's `read()` and `String(lastUpdated() ?? 0)`. */
	readPublished(): Promise<{ doc: JSONDoc; version: string }>;
	seedFrom(json: JSONDoc): Promise<{ seeded: boolean }>;
	lockState(userId?: string): Promise<PageLockState>;
	listHistory(): Promise<HistoryEntry[]>;
	readHistory(key: string): Promise<JSONDoc | null>;
	restoreHistory(key: string, user?: string): Promise<RestoreResult>;
	undoRestore(user?: string): Promise<{ status: 'applied' | 'noop' }>;
	historyWritten(): Promise<void>;
	closeHistorySlot(): Promise<void>;
	exportBlocks(ids: string[]): Promise<ExportedBlocks>;
	importBlocks(request: ImportRequest): Promise<ImportReceipt>;
	commitMove(moveId: string, receipt: { to: string; ids: Record<string, string> }): Promise<CommitResult>;
	abortMove(moveId: string): Promise<{ moveId: string; status: 'applied' | 'noop' }>;
	purge(): Promise<{ r2Deleted: number; sockets: number }>;
	/** Public API (`/v1`): see `PageDO.appendBlocks`. */
	appendBlocks(input: {
		parentId: string | null;
		blocks: JSONBlock[];
		afterId?: string;
		userId: string;
		bypassLock: boolean;
	}): Promise<{ ok: true; blocks: JSONBlock[] } | { ok: false; reason: 'locked' | 'not_found' | 'invalid'; message: string }>;
	listCommentThreads(): Promise<CommentSnapshot>;
	applyComment(request: CommentRequest, actor: CommentActor): Promise<CommentOutcome>;
}

/**
 * The room of `workspaceId`/`pageId`. The stub comes back inside an object, never as the awaited value itself: a stub is
 * thenable over RPC, so returning it from an async function would try to resolve it.
 */
export async function openPageRoom(env: Pick<Env, 'PAGE'>, workspaceId: string, pageId: string): Promise<{ room: PageRoomApi }> {
	const room = env.PAGE.getByName(roomName(workspaceId, pageId)) as unknown as PageRoomApi;
	return { room };
}
