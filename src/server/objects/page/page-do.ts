/**
 * PageDO: one Durable Object per page, hosting that page's edytor room through `attachRoom`.
 *
 * - Named `workspaceId:pageId` (see src/server/rooms/names.ts); reached only through
 *   `routeDocumentSocket` in src/server/http/room-route.ts, which verifies the room token first.
 * - edytor owns the `edytor_*` tables; the one app table is `page_meta(page_id, workspace_id)`.
 * - `onSave` writes the CRDT update and replica owners to R2 and enqueues a deduplicated indexing job;
 *   `onLoad` restores from R2 for a room that stores nothing (a page survives the loss of its object).
 * - `semantics` is edytor's defaults plus the custom kinds of `src/lib/shared/blocks/kinds.ts` (the same
 *   rows the client plugin spreads), so every replica and this room read the same block roles. The
 *   route refuses a client whose `KINDS_VERSION` is behind (close 4426, reload).
 * - The first socket tells the Workspace DO (`openRoom`), the last closing one too (`closeRoom`).
 * - `seedFrom(json)` seeds a brand-new room (duplicate, template); `onLoad` restores from R2, else
 *   returns the pending seed, else nothing.
 * - Page lock: `setLocked` / `lockState` keep the lock in the room's KV, `validate` denies edits of a locked page
 *   unless the sender has full access (`noteBypass`, called by the route at each dial); see `validate.ts`.
 * - History (P3): `history: { store: r2History over the page's R2 prefix, retentionDays: 30 }` (`history-store.ts`): one
 *   version per half-day slot that changed, `ws/{ws}/pages/{page}/history/...`. `listHistory`, `readHistory`,
 *   `restoreHistory` (a forward edit, collaborative) and `undoRestore` are forwarded for the RPC layer.
 * - Cross-document moves (`exportBlocks`, `importBlocks`, `commitMove`, ...) are forwarded too; `rooms` names the PAGE
 *   namespace, so the room forwards a moved block's late edits to its new page by itself.
 * - `purge()` wipes the room for good (trash purge): sockets, R2 snapshot and versions, then all its storage.
 */
import { QUOTA_WARN_RATIO } from '../../limits';
import { DurableObject } from 'cloudflare:workers';
import type { JSONBlock, JSONDoc } from 'edytor/crdt/edytor';
import {
	SOCKET_TAG,
	attachRoom,
	type AttachedDocument,
	type CommentActor,
	type CommentOutcome,
	type CommentRequest,
	type CommentSnapshot,
	type CommitResult,
	type DocumentAccessLevel,
	type ExportedBlocks,
	type HistoryEntry,
	type ImportReceipt,
	type ImportRequest,
	type LateEditBatch,
	type LoadedDocument,
	type MoveNamespace,
	type RestoreResult,
	type SavedDocument
} from 'edytor/cloudflare';
import { roomSemantics } from '../../../lib/shared/blocks/kinds.js';
import type { IndexPageJob } from '../../queues/types';
import { deletePrefix, pageHistoryStore } from './history-store';
import { enqueueIndexJob } from './index-job';
import { bumpPageVersion } from '../../share/cache';
import { metric } from '../../metrics';
import { ensurePageMetaTable, resolvePageIdentity, type PageIdentity } from './page-meta';
import { loadSnapshot, pageKeyPrefix, saveSnapshot } from './snapshot-store';
import {
	canBypassLock,
	createFrameValidator,
	lastEditor,
	readPageLock,
	recordBypass,
	recordLastEditor,
	recordUserAccess,
	writePageLock
} from './validate';

/** edytor's default document quota is 2 MiB; long pages need more (docs/PLAN.md "Pages and blocks"). */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
/** Days after which deleted content is purged from the room and every replica. */
export const PURGE_AFTER_DAYS = 30;

const SEED_KEY = 'seed:json';
/** The share of the quota last reported to the Workspace DO (absent: nothing reported, the page is under the warning). */
const QUOTA_REPORTED_KEY = 'quota:reported';

/** Hours the room's clock jumps in `closeHistorySlot`: past the next local noon or midnight, whichever is first. */
const SLOT_JUMP_MS = 13 * 60 * 60 * 1000;

const isMovableClock = (env: Env) => (env.ENVIRONMENT as string) === 'development' || (env.ENVIRONMENT as string) === 'test';

/** What `purge()` removed. */
export interface PurgeReport {
	/** R2 objects deleted (the snapshot, the replica owners and every version). */
	r2Deleted: number;
	/** Sockets closed. */
	sockets: number;
}

/**
 * What a page object asks of its Workspace DO. The Sync core implements both on `WorkspaceDO`; they
 * are called best-effort (a failure never breaks the room) so the page keeps working while that
 * side is unavailable.
 */
export interface WorkspaceRoomApi {
	openRoom(pageId: string): unknown;
	closeRoom(pageId: string): unknown;
}

/** What the indexing consumer reads from a page in one call. */
export interface PageIndexSource {
	doc: JSONDoc;
	/** Milliseconds timestamp of the last stored change (`null`: never changed). */
	editedAt: number | null;
	editedBy: string | null;
}

/** A page's lock as its room reports it. */
export interface PageLockState {
	locked: boolean;
	lockedBy: string | null;
	lockedAt: number | null;
	bypass: boolean;
}

export class PageDO extends DurableObject<Env> {
	readonly document: AttachedDocument;
	/** `purge()` ran: nothing this instance holds may be written again. */
	private purged = false;
	private identityCache: PageIdentity | undefined;
	private clockOffset = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ensurePageMetaTable(ctx.storage.sql);
		this.document = attachRoom(this, {
			maxDocumentBytes: MAX_DOCUMENT_BYTES,
			purgeAfterDays: PURGE_AFTER_DAYS,
			history: { store: pageHistoryStore(env.FILES, () => this.identity()), retentionDays: PURGE_AFTER_DAYS },
			rooms: () => env.PAGE as unknown as MoveNamespace,
			now: () => Date.now() + this.clockOffset,
			semantics: roomSemantics,
			onLoad: () => this.restore(),
			onSave: (saved) => this.persist(saved),
			validate: createFrameValidator(ctx.storage.kv),
			// Per-block locks (a block whose data names a user under `lockedBy`) hold their subtree; full access bypasses.
			locks: { key: 'lockedBy', subtree: true, bypass: (user) => canBypassLock(ctx.storage.kv, user) }
		});
	}

	/** This object's page, from its name (recorded in `page_meta` on first use). */
	identity(): PageIdentity {
		return (this.identityCache ??= resolvePageIdentity(this.ctx.storage.sql, this.ctx.id.name));
	}

	/** R2 first (a page survives the loss of its object), else a seed `seedFrom` left, else an empty room. */
	private async restore(): Promise<LoadedDocument | undefined> {
		const stored = await loadSnapshot(this.env.FILES, this.identity());
		if (stored) return stored;
		const seed = this.ctx.storage.kv.get<string>(SEED_KEY);
		return seed ? (JSON.parse(seed) as JSONDoc) : undefined;
	}

	private async persist(saved: SavedDocument): Promise<void> {
		// A purged room must not write its snapshot back to R2 (an alarm or a save already in flight).
		if (this.purged) return;
		const identity = this.identity();
		await saveSnapshot(this.env.FILES, identity, saved);
		// "Page document size" target: the share of the quota this page holds (the app warns at 80%).
		const { documentBytes, documentLimit } = this.document.metrics();
		metric(this.env, 'doc_size', {
			labels: [identity.workspaceId, identity.pageId],
			value: documentLimit > 0 ? documentBytes / documentLimit : 0,
			extra: [documentBytes]
		});
		this.reportQuota(identity, documentBytes, documentLimit);
		const version = this.document.lastUpdated() ?? Date.now();
		// Published pages cache their body by version (src/server/share/cache.ts): a save is a new version.
		await bumpPageVersion(this.env.CACHE, identity.workspaceId, identity.pageId, version);
		await enqueueIndexJob(this.env.JOBS as Queue<IndexPageJob>, this.ctx.storage.kv, identity, version);
	}

	/**
	 * "Page document size: warn at 80% of the quota, also shown to the user" (docs/PLAN.md "Operating targets"): when a save
	 * moves this page's share of its quota across 80% or by five points past it, the Workspace DO is told, and it pushes a
	 * `quota` message to the tabs that can read the page (and keeps it for tabs that connect later). Best effort.
	 */
	private reportQuota(identity: PageIdentity, bytes: number, limit: number): void {
		if (limit <= 0) return;
		const ratio = bytes / limit;
		const kv = this.ctx.storage.kv;
		const last = kv.get<number>(QUOTA_REPORTED_KEY);
		const over = ratio >= QUOTA_WARN_RATIO;
		if (over ? last !== undefined && ratio - last < 0.05 : last === undefined) return;
		if (over) kv.put(QUOTA_REPORTED_KEY, ratio);
		else kv.delete(QUOTA_REPORTED_KEY);
		const workspace = this.env.WORKSPACE.getByName(identity.workspaceId) as unknown as { pageQuota(pageId: string, bytes: number, limit: number): Promise<void> };
		this.ctx.waitUntil(
			Promise.resolve()
				.then(() => workspace.pageQuota(identity.pageId, over ? bytes : 0, limit))
				.catch((error) => console.warn(`page ${identity.pageId}: reporting the size quota failed`, String(error)))
		);
	}

	// ───────────── sockets: tell the Workspace DO when the room opens and empties ─────────────
	// edytor installs these handlers itself when the class defines none; defining them here is how the
	// object watches its sockets, and each one delegates to the room.

	override async fetch(request: Request): Promise<Response> {
		if (this.purged) return new Response('This page was deleted', { status: 410 });
		const response = await this.document.fetch(request);
		if (response.status === 101 && this.ctx.getWebSockets(SOCKET_TAG).length === 1) this.announce('openRoom');
		return response;
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		this.document.webSocketMessage(ws, message);
	}

	webSocketClose(ws: WebSocket, code: number, reason: string) {
		this.document.webSocketClose(ws, code, reason);
		this.announceIfEmpty(ws);
	}

	webSocketError(ws: WebSocket) {
		this.document.webSocketError(ws);
		this.announceIfEmpty(ws);
	}

	private announceIfEmpty(closing: WebSocket) {
		const open = this.ctx.getWebSockets(SOCKET_TAG).filter((ws) => ws !== closing && ws.readyState === WebSocket.OPEN);
		if (open.length === 0) this.announce('closeRoom');
	}

	private announce(method: keyof WorkspaceRoomApi) {
		let identity: PageIdentity;
		try {
			identity = this.identity();
		} catch {
			return;
		}
		const workspace = this.env.WORKSPACE.getByName(identity.workspaceId) as unknown as WorkspaceRoomApi;
		this.ctx.waitUntil(
			Promise.resolve()
				.then(() => workspace[method](identity.pageId))
				.catch((error) => console.warn(`page ${identity.pageId}: ${method} failed`, String(error)))
		);
	}

	// ───────────── creation ─────────────

	/**
	 * Seed a page that has never been written with `json` (a duplicate's source, a template). Safe
	 * because a fresh document has no shared history. Returns `{ seeded: false }` for a page that
	 * already holds content: a seed never overwrites. The JSON is also kept for `onLoad`, so a room
	 * that restarts before anyone writes still starts from it.
	 */
	seedFrom(json: JSONDoc): { seeded: boolean } {
		if (this.purged) return { seeded: false };
		if (this.document.lastUpdated() !== null) return { seeded: false };
		this.ctx.storage.kv.put(SEED_KEY, JSON.stringify(json));
		const blocks = json.children ?? [];
		if (blocks.length === 0) return { seeded: true };
		// `transact` first seeds an empty room with one empty block; replace that with the source.
		this.document.transact((doc) => {
			const stale = doc.childrenIds(null);
			doc.insertBlocks({ parent: null, index: stale.length }, blocks);
			if (stale.length > 0) doc.deleteBlocks(stale);
		});
		return { seeded: true };
	}

	// Durable Object RPC reaches only this class's own methods, so the room methods the Workspace DO,
	// the queue consumer and tests call are forwarded here.

	/**
	 * The body and version of this page for a published page or an export (src/server/share, src/server/export): the
	 * room's `read()` and the time of its last change, the same string `persist` records for the cache.
	 */
	readPublished(): { doc: JSONDoc; version: string } {
		return { doc: this.document.read(), version: String(this.document.lastUpdated() ?? 0) };
	}

	/** What the indexing consumer needs from this page, in one call. */
	readForIndex(): PageIndexSource {
		return {
			doc: this.document.read(),
			editedAt: this.document.lastUpdated(),
			editedBy: lastEditor(this.ctx.storage.kv)
		};
	}

	/** The page body as JSON (the queue consumer extracts text and links from it). */
	read() {
		return this.document.read();
	}

	/** Room counters, including `documentBytes` against `documentLimit` (warn the user at 80%). */
	metrics() {
		return this.document.metrics();
	}

	lastUpdated() {
		return this.document.lastUpdated();
	}

	/**
	 * Change what a user may do in this room. Records the level for `validate` and applies it to the
	 * user's open sockets: `read` downgrades in place, `none` closes them for good, any other level
	 * closes them with 1012 so they redial and `authorize` grants the new level.
	 */
	setAccess(userId: string, access: DocumentAccessLevel | 'none') {
		recordUserAccess(this.ctx.storage.kv, userId, access);
		// Full access is re-noted at the user's next dial.
		recordBypass(this.ctx.storage.kv, userId, false);
		return this.document.setAccess(userId, access);
	}

	/** The user ids with an open socket in this room (the Workspace DO's access sync asks before it re-checks them). */
	roomUsers(): string[] {
		const users = new Set<string>();
		for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const user = (ws.deserializeAttachment() as { user?: unknown } | null)?.user;
			if (typeof user === 'string') users.add(user);
		}
		return [...users];
	}

	// ───────────── public API (`/v1`): blocks and comments ─────────────

	/**
	 * `PATCH /blocks/{id}/children`: appends `blocks` (edytor JSON, nested) under `parentId` (`null`: the page itself),
	 * after `afterId` when given, as one room transaction every collaborator receives. A locked page refuses unless
	 * `bypassLock` (the caller holds full access). Refusals are values (`ok: false`), not throws, so they cross the
	 * Durable Object RPC boundary cleanly. Answers the new blocks (ids included), without their children.
	 */
	appendBlocks(
		input: { parentId: string | null; blocks: JSONBlock[]; afterId?: string; userId: string; bypassLock: boolean }
	): { ok: true; blocks: JSONBlock[] } | { ok: false; reason: 'locked' | 'not_found' | 'invalid'; message: string } {
		if (this.purged) return { ok: false, reason: 'not_found', message: 'This page was deleted' };
		if (readPageLock(this.ctx.storage.kv) && !input.bypassLock) return { ok: false, reason: 'locked', message: 'This page is locked' };
		const idsOf = (parentId: string | null): string[] | null => {
			const doc = this.document.read();
			if (parentId === null) return (doc.children ?? []).map((b) => b.id ?? '');
			const found = findBlock(doc.children ?? [], parentId);
			return found ? (found.children ?? []).map((b) => b.id ?? '') : null;
		};
		const before = idsOf(input.parentId);
		if (before === null) return { ok: false, reason: 'not_found', message: `Block "${input.parentId}" not found` };
		if (input.afterId && !before.includes(input.afterId)) return { ok: false, reason: 'not_found', message: `Block "${input.afterId}" is not a child of this block` };
		try {
			// A page nobody has written yet starts from its first blocks (no leading empty paragraph).
			const seeded = input.parentId === null && !input.afterId && this.document.lastUpdated() === null && this.seedFrom({ children: input.blocks }).seeded;
			if (!seeded) {
				this.document.transact((doc) => {
					const siblings = doc.childrenIds(input.parentId);
					const at = input.afterId ? siblings.indexOf(input.afterId) + 1 : siblings.length;
					doc.insertBlocks({ parent: input.parentId, index: at }, input.blocks);
				});
			}
		} catch (error) {
			return { ok: false, reason: 'invalid', message: error instanceof Error ? error.message : 'The blocks were refused' };
		}
		recordLastEditor(this.ctx.storage.kv, input.userId);
		const known = new Set(before);
		const after = this.document.read();
		const siblings = input.parentId === null ? (after.children ?? []) : (findBlock(after.children ?? [], input.parentId)?.children ?? []);
		return { ok: true, blocks: siblings.filter((b) => !known.has(b.id ?? '')) };
	}

	/** The comment threads of this page, oldest first (public API `GET /comments`). */
	listCommentThreads(): CommentSnapshot {
		return this.document.listComments();
	}

	/** One comments request (add a thread, reply...) by `actor`, under edytor's rules (public API `POST /comments`). */
	applyComment(request: CommentRequest, actor: CommentActor): Promise<CommentOutcome> {
		return this.document.comment(request, actor);
	}

	// ───────────── page lock ─────────────

	/** The page's lock, and whether `userId` edits despite it. */
	lockState(userId?: string): PageLockState {
		const lock = readPageLock(this.ctx.storage.kv);
		return {
			locked: lock !== null,
			lockedBy: lock?.by ?? null,
			lockedAt: lock?.at ?? null,
			bypass: userId ? canBypassLock(this.ctx.storage.kv, userId) : false
		};
	}

	/**
	 * Lock or unlock the page for `userId`. Anyone who may lock can; only the locker or a user with full access
	 * (`full`) unlocks: otherwise `refused` is set and the lock stands (the RPC maps it to FORBIDDEN). A refusal is
	 * a value, not a throw, so it crosses the Durable Object RPC boundary cleanly.
	 */
	setLocked(userId: string, locked: boolean, full: boolean): PageLockState & { refused?: true } {
		const kv = this.ctx.storage.kv;
		const current = readPageLock(kv);
		let refused = false;
		if (locked) {
			if (!current) writePageLock(kv, { by: userId, at: Date.now() });
		} else if (current) {
			if (current.by !== userId && !full) refused = true;
			else writePageLock(kv, null);
		}
		recordBypass(kv, userId, full);
		return { ...this.lockState(userId), ...(refused ? { refused: true as const } : {}) };
	}

	/** The route tells the room, at each dial, whether the dialing user has full access (they edit through a lock). */
	noteBypass(userId: string, bypass: boolean): void {
		recordBypass(this.ctx.storage.kv, userId, bypass);
	}

	// ───────────── version history (docs/PLAN.md "Pages and blocks": History) ─────────────

	/** The page's versions, newest first: one per half-day slot that changed, for 30 days. */
	listHistory(): Promise<HistoryEntry[]> {
		return this.document.listHistory();
	}

	/** One version as JSON (the preview), or `null` when this room holds no such version. */
	readHistory(key: string): Promise<JSONDoc | null> {
		return this.document.readHistory(key);
	}

	/**
	 * Restore a version as one forward edit: relayed to every socket (so collaborators see it at once) and undone by
	 * `undoRestore`. `user` is recorded as the editor of the slot. `refused`: no such version.
	 */
	restoreHistory(key: string, user?: string): Promise<RestoreResult> {
		return this.document.restoreHistory(key, user ? { user } : undefined);
	}

	/** Undo the last restore (one level, edits made since stay). */
	undoRestore(user?: string): Promise<{ status: 'applied' | 'noop' }> {
		return this.document.undoRestore(user ? { user } : undefined);
	}

	/** Resolves once the version writes in flight are stored. */
	historyWritten(): Promise<void> {
		return this.document.historyWritten();
	}

	/**
	 * Development and tests only: ends the open half-day history slot now. Real versions appear at local noon and
	 * midnight; this moves the room's clock past the slot's end, lets the room's own alarm close it into a version,
	 * waits for the write, and puts the clock back. Sockets whose credentials the jump outlives are closed (4401) by
	 * the room, as they would be at that time of day, and redial. Refused in production.
	 */
	async closeHistorySlot(): Promise<void> {
		if (!isMovableClock(this.env)) throw new Error('closeHistorySlot is for development and tests');
		this.clockOffset += SLOT_JUMP_MS;
		try {
			await (this as unknown as { alarm(): Promise<void> }).alarm();
			await this.document.historyWritten();
		} finally {
			this.clockOffset -= SLOT_JUMP_MS;
		}
	}

	// ───────────── moving blocks between pages (edytor's room.move) ─────────────
	// Run by `moveBlocksBetweenRooms(PAGE, { from, to, ... })` from the Worker; each step is a room transaction.

	exportBlocks(ids: string[]): ExportedBlocks {
		return this.document.exportBlocks(ids);
	}

	importBlocks(request: ImportRequest): ImportReceipt {
		return this.document.importBlocks(request);
	}

	commitMove(moveId: string, receipt: { to: string; ids: Record<string, string> }): CommitResult {
		return this.document.commitMove(moveId, receipt);
	}

	abortMove(moveId: string) {
		return this.document.abortMove(moveId);
	}

	applyLateEdits(batch: LateEditBatch) {
		return this.document.applyLateEdits(batch);
	}

	lateEdits(): LateEditBatch[] {
		return this.document.lateEdits();
	}

	ackLateEdits(moveId: string, seq: number): void {
		this.document.ackLateEdits(moveId, seq);
	}

	// ───────────── purge ─────────────

	/**
	 * Wipe this room completely (docs/PLAN.md "Soft delete and trash": the purge Workflow calls it for a page whose 30
	 * days are over): sockets closed, every R2 object under the page's prefix deleted (the snapshot, the replica owners
	 * and every history version), then all the object's storage and its alarm.
	 *
	 * Idempotent, and safe to retry: R2 goes first, while the page's identity is still known, so a failure leaves the
	 * storage in place for the retry; a second call finds nothing to delete. Afterwards the instance refuses sockets
	 * (410) and never writes its snapshot again.
	 */
	async purge(): Promise<PurgeReport> {
		this.purged = true;
		let sockets = 0;
		for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
			try {
				ws.close(4403, 'page purged');
			} catch {
				// Already closing.
			}
			sockets++;
		}
		// No save may land between the listing below and the wipe.
		await this.ctx.storage.deleteAlarm();
		let identity: PageIdentity | undefined;
		try {
			identity = this.identity();
		} catch {
			// Never addressed, or already wiped: there is no prefix to delete.
		}
		const r2Deleted = identity ? await deletePrefix(this.env.FILES, pageKeyPrefix(identity)) : 0;
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
		return { r2Deleted, sockets };
	}

	/** Close every socket of a user; 4401 makes the provider refresh its token and redial. */
	closeUser(userId: string, code?: number, reason?: string) {
		return this.document.closeUser(userId, code, reason);
	}

	/** Close every socket of the page (trashing a page). */
	closeAll(code = 4403, reason = 'page closed') {
		let sockets = 0;
		for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
			ws.close(code, reason);
			sockets++;
		}
		return { sockets };
	}
}

/** A block of a nested document by id (depth first). */
function findBlock(blocks: readonly JSONBlock[], id: string): JSONBlock | null {
	for (const block of blocks) {
		if (block.id === id) return block;
		const inner = block.children ? findBlock(block.children, id) : null;
		if (inner) return inner;
	}
	return null;
}
