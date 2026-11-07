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
 * - History (`r2History`) and locks arrive in P3.
 */
import { DurableObject } from 'cloudflare:workers';
import type { JSONDoc } from 'edytor/crdt/edytor';
import {
	SOCKET_TAG,
	attachRoom,
	type AttachedDocument,
	type DocumentAccessLevel,
	type LoadedDocument,
	type SavedDocument
} from 'edytor/cloudflare';
import { roomSemantics } from '../../../lib/shared/blocks/kinds.js';
import type { IndexPageJob } from '../../queues/types';
import { enqueueIndexJob } from './index-job';
import { ensurePageMetaTable, resolvePageIdentity, type PageIdentity } from './page-meta';
import { loadSnapshot, saveSnapshot } from './snapshot-store';
import { createFrameValidator, lastEditor, recordUserAccess } from './validate';

/** edytor's default document quota is 2 MiB; long pages need more (docs/PLAN.md "Pages and blocks"). */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
/** Days after which deleted content is purged from the room and every replica. */
export const PURGE_AFTER_DAYS = 30;

const SEED_KEY = 'seed:json';

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

export class PageDO extends DurableObject<Env> {
	readonly document: AttachedDocument;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ensurePageMetaTable(ctx.storage.sql);
		this.document = attachRoom(this, {
			maxDocumentBytes: MAX_DOCUMENT_BYTES,
			purgeAfterDays: PURGE_AFTER_DAYS,
			semantics: roomSemantics,
			onLoad: () => this.restore(),
			onSave: (saved) => this.persist(saved),
			validate: createFrameValidator(ctx.storage.kv)
		});
	}

	/** This object's page, from its name (recorded in `page_meta` on first use). */
	identity(): PageIdentity {
		return resolvePageIdentity(this.ctx.storage.sql, this.ctx.id.name);
	}

	/** R2 first (a page survives the loss of its object), else a seed `seedFrom` left, else an empty room. */
	private async restore(): Promise<LoadedDocument | undefined> {
		const stored = await loadSnapshot(this.env.FILES, this.identity());
		if (stored) return stored;
		const seed = this.ctx.storage.kv.get<string>(SEED_KEY);
		return seed ? (JSON.parse(seed) as JSONDoc) : undefined;
	}

	private async persist(saved: SavedDocument): Promise<void> {
		const identity = this.identity();
		await saveSnapshot(this.env.FILES, identity, saved);
		const version = this.document.lastUpdated() ?? Date.now();
		await enqueueIndexJob(this.env.JOBS as Queue<IndexPageJob>, this.ctx.storage.kv, identity, version);
	}

	// ───────────── sockets: tell the Workspace DO when the room opens and empties ─────────────
	// edytor installs these handlers itself when the class defines none; defining them here is how the
	// object watches its sockets, and each one delegates to the room.

	override async fetch(request: Request): Promise<Response> {
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
		return this.document.setAccess(userId, access);
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
