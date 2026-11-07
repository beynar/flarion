/**
 * PageDO: one Durable Object per page, hosting that page's edytor room through `attachRoom`.
 *
 * - Named `workspaceId:pageId` (see src/server/rooms/names.ts); reached only through
 *   `routeDocumentSocket` in src/server/http/room-route.ts, which verifies the room token first.
 * - edytor owns the `edytor_*` tables; the one app table is `page_meta(page_id, workspace_id)`.
 * - `onSave` writes the CRDT update and replica owners to R2 and enqueues a deduplicated indexing job;
 *   `onLoad` restores from R2 for a room that stores nothing (a page survives the loss of its object).
 * - P1 adds the bundled plugin kinds (`semantics`), history (`r2History`), locks and the page header.
 */
import { DurableObject } from 'cloudflare:workers';
import {
	SOCKET_TAG,
	attachRoom,
	type AttachedDocument,
	type DocumentAccessLevel,
	type LoadedDocument,
	type SavedDocument
} from 'edytor/cloudflare';
import { enqueueIndexJob, type IndexJob } from './index-job';
import { ensurePageMetaTable, resolvePageIdentity, type PageIdentity } from './page-meta';
import { loadSnapshot, saveSnapshot } from './snapshot-store';
import { createFrameValidator, recordUserAccess } from './validate';

/** edytor's default document quota is 2 MiB; long pages need more (docs/PLAN.md "Pages and blocks"). */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
/** Days after which deleted content is purged from the room and every replica. */
export const PURGE_AFTER_DAYS = 30;

export class PageDO extends DurableObject<Env> {
	readonly document: AttachedDocument;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ensurePageMetaTable(ctx.storage.sql);
		this.document = attachRoom(this, {
			maxDocumentBytes: MAX_DOCUMENT_BYTES,
			purgeAfterDays: PURGE_AFTER_DAYS,
			onLoad: () => this.restore(),
			onSave: (saved) => this.persist(saved),
			validate: createFrameValidator(ctx.storage.kv)
		});
	}

	/** This object's page, from its name (recorded in `page_meta` on first use). */
	identity(): PageIdentity {
		return resolvePageIdentity(this.ctx.storage.sql, this.ctx.id.name);
	}

	private restore(): Promise<LoadedDocument | undefined> {
		return loadSnapshot(this.env.FILES, this.identity());
	}

	private async persist(saved: SavedDocument): Promise<void> {
		const identity = this.identity();
		await saveSnapshot(this.env.FILES, identity, saved);
		const version = this.document.lastUpdated() ?? Date.now();
		await enqueueIndexJob(this.env.JOBS as Queue<IndexJob>, this.ctx.storage.kv, identity, version);
	}

	// Durable Object RPC reaches only this class's own methods, so the room methods the Workspace DO,
	// the queue consumer and tests call are forwarded here.

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
