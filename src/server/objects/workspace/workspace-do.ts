/**
 * The Workspace Durable Object: one per workspace. It owns the page tree, properties, views, teamspaces,
 * the change log and the live subscriptions (docs/PLAN.md "Data model", "Real-time sync").
 *
 * RPC surface (called from `src/worker.ts`-side code, never from SvelteKit server code):
 *   Lifecycle   init, syncMember, rename, getMemberRole
 *   Writes      apply, createPage, create/update/archive teamspaces and their members
 *   Reads       getPage, nextRank, listTrash, teamspaces, teamspace members
 *   Index       ingestPages, openRoom, closeRoom
 *   Sockets     fetch (upgrade) + the hibernatable handlers
 *
 * Every call runs on `db.$as(actor)` (`#writeDb`, `AccessService.governed`): the base client is reserved for
 * migrations, init, member sync, the indexing queue and other system work. Reads of pages and views are
 * ANDed with the actor's visibility set (`access.ts`); access changes reach open rooms (`room-sync.ts`).
 *   Access      pageAccess, can, listGrants, setGrant, revokeGrant, grantByToken, visibleNums
 */
import { DurableObject } from 'cloudflare:workers';
import {
	CLOSE,
	decodeClientMessage,
	encodeServerMessage,
	type ClientMessage,
	type ServerMessage
} from '../../../lib/shared/protocol';
import { TITLE_PROP_ID } from '../../../lib/shared/property-types';
import { isDefinitionOp, validateBatch, type MutationBatch, type Op } from '../../../lib/shared/ops';
import type { PageRow } from '../../../lib/shared/protocol';
import type {
	PageCreate,
	Teamspace,
	TeamspaceMember,
	trashListInputSchema
} from '../../../lib/shared/schemas';
import { rankAfter } from '../../../lib/shared/sort-keys';
import type * as v from 'valibot';
import type { Actor, WorkspaceRole } from '../../auth/session';
import { createWorkspaceClient, type WorkspaceClient, type WorkspaceDb, type WorkspaceTx } from '../../db/workspace.client';
import type { PageIndexItem } from '../../queues/types';
import type { WorkspaceSocketActor } from './actor';
import { pruneLog, LOG_RETENTION_MS, type PruneResult } from './changelog';
import { runCommit, type CommitResult } from './commit';
import {
	afterWrite,
	applyEavOp,
	defaultsForView,
	invalidateRegistry,
	isEavOp,
	isEavError,
	loadRegistry,
	recomputeNowFormulas,
	usesNow,
	ensureEavLayout,
	readCollection,
	readProperties,
	readViews,
	type ChangeRecord
} from './eav';
import { validateFilter } from '../../../lib/shared/filter-ast';
import { invalid, notFound, WorkspaceError } from './errors';
import { ingestInTransaction, type IngestResult } from './ingest';
import { LiveHub, unitEvaluations, type CommitInfo } from './live';
import { migrateWorkspace } from './migrations';
import { applyPageOp, isPageOp } from './page-ops';
import { processMentions } from './mentions';
import { Presence } from './presence';
import {
	ACTOR_HEADER,
	AttachmentTooLargeError,
	decodeActorHeader,
	HibernatableSocketTransport,
	type SocketHandle
} from './socket';
import { RAW_STREAM, WorkspaceSocketApi } from './socket-api';
import { socketRouter, type SocketContext } from './socket-router';
import {
	addTeamspaceMemberRecords,
	archiveTeamspaceRecords,
	listArchivedTeamspaces,
	restoreTeamspaceRecords,
	type ArchivedTeamspace,
	assertNotGuest,
	insertTeamspace,
	listTeamspaceMembers,
	nextMemberRank,
	listTeamspaces,
	readTeamspace,
	removeTeamspaceMemberRecords,
	setTeamspaceMemberRoleRecords,
	updateTeamspaceRecords,
	type TeamspaceInput
} from './teamspaces';
import { checkVersions } from './versions';
import { indexBodies, indexChanges, removeFromIndex } from '../../search/index-writes';
import { ForbiddenError } from 'viborm';
import {
	AccessService,
	actorKey,
	type CommitAccess,
	type AccessActor,
	type AccessLevel,
	type GovernedTx
} from './access';
import { createAuthorizer } from './authorize';
import { queryViewRows, type QueryViewInput, type QueryViewResult } from '../../engine/view';
import { revokeGrantRecords, setGrantRecords, toGrant, type GrantInput } from './grants';
import { syncRooms, type RoomStub } from './room-sync';
import { chunks } from './util';
import { planPurge, purgePageRows, purgeTeamspaceRows, purgeableTeamspaces, TRASH_RETENTION_MS, type PurgedPage } from './purge';
import type { Grant } from '../../../lib/shared/schemas';
import {
	abortUpload,
	beginUpload,
	completeUpload,
	ensureFilesTable,
	filesUsage,
	getFile,
	normalizeLevel,
	pendingUpload,
	purgeFilesOfPages,
	readableFile,
	recordUploadId,
	setStorageQuota,
	sweepUncommitted,
	type BeginInput,
	type FilesContext,
	type PageLevel
} from './files';
import { APP_VERSION_HEADER, APP_VERSION_PARAM, registryScopesOf } from '../../../lib/shared/protocol';
import { reindexAll as reindexSearch } from '../../search/index-writes';
import { applyChunks, chunkIdsOf, diffChunks, forgetChunks, type EmbedPlan, type PageChunks } from '../../search/embed-store';
import { embedPages, type EmbedResult } from '../../search/embed';
import { quickFind, recordVisit, searchPages, type QuickFindInput, type QuickFindResult, type SearchInput, type SearchResult } from '../../search/query';
import { ensureSearchTables } from '../../search/tables';
import { vectorSearchOf } from '../../search/vectors';

type TrashListInput = v.InferOutput<typeof trashListInputSchema>;

export interface InitArgs {
	workspaceId: string;
	name: string;
	ownerId: string;
	ownerName: string;
}

export interface SyncMemberArgs {
	userId: string;
	/** `null` removes the member, like `removed: true` (the Accounts track sends either). */
	role: WorkspaceRole | null;
	name?: string;
	removed?: boolean;
}

/** Alarm cadence: prune the change log hourly while it holds anything. */
const ALARM_INTERVAL_MS = 60 * 60 * 1000;
const SYSTEM_ACTOR = 'system';

/** Close code and reason of a Page DO socket whose page was moved to the trash. */
const TRASH_CLOSE_CODE = 4403;
const TRASH_CLOSE_REASON = 'moved to Trash';
/** Rooms called at once. */
const ROOM_BATCH = 16;

/** Protocol frames start with a string `t`; oRPC's have a numeric one. */
const PROTOCOL_FRAME = /^\s*\{\s*"t"\s*:\s*"/;

const META_INITIALIZED = 'initialized';
const META_WORKSPACE = 'workspace';

export class WorkspaceDO extends DurableObject<Env> {
	/** Number of instances constructed in this isolate: tests use it to prove a re-create after eviction. */
	static constructed = 0;
	/** Per-instance, in memory only: changes whenever the object is evicted and woken again. */
	readonly instanceId = crypto.randomUUID();

	readonly #db: WorkspaceClient;
	readonly #access: AccessService;
	readonly #hub: LiveHub;
	readonly #presence = new Presence();
	readonly #api: WorkspaceSocketApi;
	readonly #transport: HibernatableSocketTransport<SocketContext, WorkspaceSocketActor>;
	/** Commits (and their fan-out) run one at a time, so `seq` order is also delivery order. */
	#serial: Promise<unknown> = Promise.resolve();
	#alarmChecked = false;
	#socketCache: Map<string, SocketHandle<WorkspaceSocketActor>> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		WorkspaceDO.constructed++;
		ensureFilesTable(ctx.storage.sql);
		ensureSearchTables(ctx.storage.sql);
		this.#db = createWorkspaceClient(ctx.storage);
		this.#access = new AccessService({ db: this.#db, sql: ctx.storage.sql });
		// Raw steps, the viborm estate and the EAV layout, before any request or socket message is served.
		void ctx.blockConcurrencyWhile(async () => {
			await migrateWorkspace(ctx, this.#db);
			ensureEavLayout(ctx.storage);
		});
		this.#hub = new LiveHub({
			sql: ctx.storage.sql,
			db: this.#db,
			now: () => Date.now(),
			send: (socketId, message) => this.#send(socketId, message),
			actorOf: (socketId) => this.#socket(socketId)?.actor ?? null,
			view: (actor) => this.#access.view(actor)
		});
		this.#api = new WorkspaceSocketApi({
			env,
			hub: this.#hub,
			presence: this.#presence,
			send: (socketId, message) => this.#send(socketId, message),
			streams: () => this.#hub.streamSockets(),
			now: () => Date.now(),
			checkView: (sub) => this.#checkView(sub),
			serialize: (work) => this.#serialize(work)
		});
		this.#transport = new HibernatableSocketTransport<SocketContext, WorkspaceSocketActor>(ctx, socketRouter, {
			createContext: (socket) => ({ socket, api: this.#api, instanceId: this.instanceId }),
			onClose: (socket) => this.#api.closed(socket),
			// The client cancelled its `hello` stream: the session is over.
			onIteratorAbort: (socket, requestId) => {
				if (requestId !== RAW_STREAM && this.#hub.streamOf(socket.socketId) === requestId) this.#api.closed(socket);
			}
		});
	}

	// ───────────────────────── sockets ─────────────────────────

	/** Live sockets by id, cached for the current turn (a fan-out looks up every socket). */
	#socket(socketId: string): SocketHandle<WorkspaceSocketActor> | null {
		if (!this.#socketCache) {
			this.#socketCache = new Map(this.#transport.sockets().map((s) => [s.socketId, s]));
			queueMicrotask(() => (this.#socketCache = null));
		}
		return this.#socketCache.get(socketId) ?? null;
	}

	/** Pushes a message on the socket's stream: a raw JSON frame, or an event of its oRPC `hello` iterator. */
	#send(socketId: string, message: ServerMessage): boolean {
		const socket = this.#socket(socketId);
		const requestId = this.#hub.streamOf(socketId);
		if (!socket || requestId === null) return false;
		if (requestId === RAW_STREAM) {
			try {
				socket.ws.send(encodeServerMessage(message));
				return true;
			} catch {
				return false;
			}
		}
		return this.#transport.send(socket.ws, requestId, message);
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		}
		const actor = decodeActorHeader<WorkspaceSocketActor>(request.headers.get(ACTOR_HEADER));
		if (!actor) return new Response('Missing actor', { status: 401 });
		const appVersion = request.headers.get(APP_VERSION_HEADER) ?? new URL(request.url).searchParams.get(APP_VERSION_PARAM);
		if (checkVersions(this.env, appVersion) === 'reload') {
			// Accept, then close with the "reload" code: a browser only sees a close code on an open socket.
			const pair = new WebSocketPair();
			pair[1].accept();
			pair[1].close(CLOSE.RELOAD_REQUIRED, 'reload');
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		try {
			// The actor's visibility set is built before the socket is served, so every handler can read it synchronously.
			await this.#access.ensure(actor);
			return this.#transport.accept(actor);
		} catch (error) {
			if (error instanceof AttachmentTooLargeError) return new Response(error.message, { status: 413 });
			throw error;
		}
	}

	/**
	 * Two kinds of frames share the socket. The protocol of `src/lib/shared/protocol.ts` is JSON text with a
	 * string `t` (`{"t":"hello",...}`): handled here. Everything else (oRPC frames, whose `t` is a number)
	 * goes to the oRPC transport, so the same connection also serves the oRPC `hello` stream and `ping`.
	 */
	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// After hibernation the in-memory visibility sets are gone: rebuild the sender's before serving it.
		const sender = this.#transport.handle(ws);
		if (sender) await this.#access.ensure(sender.actor);
		// In the commits' queue: a view is evaluated through the engine (asynchronously), and a socket message
		// must never observe a commit that is half fanned out.
		if (typeof message === 'string' && PROTOCOL_FRAME.test(message)) return this.#serialize(() => this.#protocolFrame(ws, message));
		return this.#serialize(() => this.#transport.message(ws, message));
	}

	async #protocolFrame(ws: WebSocket, text: string): Promise<void> {
		const socket = this.#transport.handle(ws);
		if (!socket) return ws.close(1011, 'missing attachment');
		const decoded = decodeClientMessage(text);
		if (!decoded.ok) return ws.close(CLOSE.BAD_MESSAGE, decoded.message.slice(0, 120));
		const message: ClientMessage = decoded.value;
		try {
			switch (message.t) {
				case 'hello':
					return await this.#api.hello(socket, RAW_STREAM, message);
				case 'subscribe':
					return await this.#api.subscribe(socket, { id: message.id, sub: message.sub });
				case 'unsubscribe':
					return this.#api.unsubscribe(socket, message.id);
				case 'window':
					return await this.#api.window(socket, message);
				case 'presence':
					return this.#api.presence(socket, message.pageId);
				case 'notifications.read':
					return this.#api.notificationsRead(socket, message.ids);
				case 'ping':
					ws.send(encodeServerMessage({ t: 'pong' }));
			}
		} catch (error) {
			// `subscribe` before `hello`, mostly: an `error` frame, the socket stays open.
			ws.send(encodeServerMessage({ t: 'error', code: 'bad_subscription', message: error instanceof Error ? error.message : 'bad request' }));
		}
	}

	override webSocketClose(ws: WebSocket, code: number, reason: string): void {
		this.#transport.close(ws, code, reason);
	}

	override webSocketError(ws: WebSocket): void {
		this.#transport.close(ws, 1011, 'socket error');
	}

	// ───────────────────────── plumbing ─────────────────────────

	async ping() {
		return 'workspace';
	}

	/**
	 * The one seam for permissions: the client every call of `actor` runs on, `db.$as(actor)` (viborm
	 * policy with the actor's facts). A user the workspace has no membership for holds nothing.
	 */
	#writeDb(actor: Actor): WorkspaceClient {
		const governed = this.#access.governed(actor);
		if (!governed) throw new WorkspaceError('FORBIDDEN', 'You are not a member of this workspace');
		return governed as unknown as WorkspaceClient;
	}

	#serialize<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#serial.then(work, work);
		this.#serial = run.catch(() => undefined);
		return run;
	}

	/**
	 * A commit and its fan-out, as one unit in the serial queue. Between the two, the actors' visibility sets
	 * are brought up to date (`noteCommit` marks what the commit invalidates, `settle` recomputes it for the
	 * connected sockets' actors), so the fan-out ANDs every window with the sets as they are after the commit
	 * and knows the pages that entered or left each of them. Access changes then reach the open rooms.
	 */
	async #commit(
		db: WorkspaceClient,
		actorId: string,
		body: Parameters<typeof runCommit>[1]['body'],
		options: { mid?: string; backlinkTargets?: () => readonly string[]; definition?: boolean } = {}
	): Promise<CommitResult> {
		const roomWork: { value: { scope: CommitAccess; changes: ReturnType<AccessService['changedActors']> } | null } = { value: null };
		let closeTrashedRooms = false;
		const result = await this.#serialize(async () => {
			let commit: CommitResult;
			try {
				commit = await runCommit(db, { actorId, now: Date.now(), mid: options.mid, body });
			} catch (error) {
				throw mapPolicyError(error);
			}
			if (!commit.replayed) {
				if (options.definition) invalidateRegistry();
				const access = this.#access.noteCommit(commit.rows);
				try {
					const sockets = this.#transport.sockets();
					const { cold } = await this.#access.settle(sockets.map((s) => s.actor));
					if (access.affecting && cold.size > 0) {
						// A socket whose visibility set was lost (the object slept) cannot be diffed: it reconnects.
						for (const socket of sockets) {
							if (!cold.has(actorKey(socket.actor))) continue;
							this.#hub.dropSocket(socket.socketId);
							socket.ws.close(CLOSE.TRY_AGAIN, 'resync');
						}
					}
				} catch (error) {
					this.#resync(error);
				}
				const info: CommitInfo = {
					seq: commit.seq,
					rows: commit.rows,
					hasChildrenFlips: commit.hasChildrenFlips,
					backlinkTargets: options.backlinkTargets?.()
				};
				try {
					await this.#hub.fanOut(info);
				} catch (error) {
					// The commit stands; the live state may not. Drop the registry and ask every socket to
					// reconnect: `hello` with its last seq replays or resnapshots.
					this.#resync(error);
				}
				// Definitions held outside any subscription (property registry, teamspace and member directory).
				this.#api.broadcastRegistry(registryScopesOf(commit.rows.map((row) => row.kind)), commit.seq);
				if (commit.rows.some((row) => row.kind === 'trash' || row.kind === 'archiveTeamspace')) closeTrashedRooms = true;
				if (access.affecting) roomWork.value = { scope: access, changes: this.#access.changedActors() };
				this.#access.clearDeltas();
			}
			return commit;
		});
		// Trashing a page closes its room: open tabs show "This page was moved to Trash" (docs/PLAN.md).
		if (closeTrashedRooms) await this.#closeTrashedRooms();
		if (roomWork.value) await this.#syncRooms(roomWork.value.scope, roomWork.value.changes);
		void this.#armAlarm();
		return result;
	}

	/** Closes every open room whose page is in the trash, with the reason the tabs show. Best effort. */
	async #closeTrashedRooms(): Promise<void> {
		const workspaceId = this.ctx.id.name ?? '';
		const open = this.ctx.storage.sql
			.exec<{ page_id: string }>('SELECT o.page_id AS page_id FROM open_room o JOIN page p ON p.id = o.page_id WHERE p.deleted_at IS NOT NULL')
			.toArray()
			.map((r) => r.page_id);
		for (const part of chunks(open, ROOM_BATCH)) {
			await Promise.all(
				part.map(async (pageId) => {
					try {
						const room = this.env.PAGE.getByName(`${workspaceId}:${pageId}`) as unknown as { closeAll(code?: number, reason?: string): Promise<unknown> };
						await room.closeAll(TRASH_CLOSE_CODE, TRASH_CLOSE_REASON);
					} catch (error) {
						console.warn(`[workspace] closing the room of trashed page ${pageId} failed:`, error instanceof Error ? error.message : error);
					}
				})
			);
		}
	}

	/** The reason a view subscription is refused, if any (a primary sort that changes with the clock). */
	async #checkView(sub: { sorts?: readonly { prop: string }[] }): Promise<string | null> {
		const first = sub.sorts?.[0];
		if (first && (await usesNow(this.#db, first.prop))) return 'A formula that reads now() cannot be the primary sort of a view';
		return null;
	}

	/** Pushes access changes into the open rooms (best effort: a room that fails keeps its 10-minute token). */
	async #syncRooms(scope: CommitAccess, changes: ReturnType<AccessService['changedActors']>): Promise<void> {
		const workspaceId = this.ctx.id.name ?? '';
		try {
			await syncRooms(
				{
					sql: this.ctx.storage.sql,
					workspaceId,
					access: this.#access,
					changes,
					room: (pageId) => this.env.PAGE.getByName(`${workspaceId}:${pageId}`) as unknown as RoomStub
				},
				scope
			);
		} catch (error) {
			console.warn('[workspace] room access sync failed:', error instanceof Error ? error.message : error);
		}
	}

	#resync(error: unknown): void {
		console.error('[workspace] fan-out failed, resyncing sockets:', error instanceof Error ? (error.stack ?? error.message) : error);
		const streaming = new Set(this.#hub.streamSockets());
		this.#hub.clearRegistry();
		for (const socket of this.#transport.sockets()) {
			if (streaming.has(socket.socketId)) socket.ws.close(CLOSE.TRY_AGAIN, 'resync');
		}
	}

	async #armAlarm(): Promise<void> {
		if (this.#alarmChecked) return;
		this.#alarmChecked = true;
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
	}

	/**
	 * Hourly: prunes the change log (7 days plus a size cap) and recomputes what depends on the clock (formulas
	 * that read `now()`, views with relative dates), publishing the results through the live loop. Re-arms itself
	 * while the log holds anything or something reads the clock.
	 */
	override async alarm(): Promise<void> {
		const result = await this.pruneLog();
		try {
			await this.hourly();
		} catch (error) {
			console.error('[workspace] hourly recompute failed:', error instanceof Error ? (error.stack ?? error.message) : error);
		}
		this.#alarmChecked = false;
		if (result.remaining > 0 || this.#readsClock()) await this.#armAlarm();
	}

	/** Whether any formula reads the clock (the alarm then keeps ticking). */
	#readsClock(): boolean {
		const sql = this.ctx.storage.sql;
		const formula = sql
			.exec("SELECT 1 FROM property WHERE type = 'formula' AND deleted_at IS NULL AND (config_json LIKE '%now(%' OR config_json LIKE '%today(%') LIMIT 1")
			.toArray();
		return formula.length > 0 || this.#hub.hasClockUnits();
	}

	/**
	 * The hourly job, also callable by tests and operators: recomputes the `now()` formulas (and what depends on
	 * them) on the live pages and, when a view's filter has relative dates, makes the live loop evaluate it
	 * again. What changed is committed as one system commit, so it reaches collaborators like any write.
	 */
	async hourly(): Promise<{ recomputed: number; seq: number | null }> {
		const now = Date.now();
		const records = await this.#serialize(() => recomputeNowFormulas(this.#db, { actorId: SYSTEM_ACTOR, now }));
		const clock = this.#hub.hasClockUnits();
		if (records.length === 0 && !clock) return { recomputed: 0, seq: null };
		const all: ChangeRecord[] = [...records];
		if (clock) all.push({ kind: 'clock', page: null, prop: null, old: null, new: { at: now } });
		const { seq } = await this.#commit(this.#db, SYSTEM_ACTOR, async (_tx, env) => {
			for (const r of records) if (r.page) env.unstamped.add(r.page);
			return all;
		});
		return { recomputed: records.length, seq };
	}

	/** Also callable from tests and operators: prune now (or as of `now`). */
	async pruneLog(now: number = Date.now(), options?: { retentionMs?: number; maxRows?: number }): Promise<PruneResult> {
		return this.#serialize(() => pruneLog(this.#db, now, { retentionMs: LOG_RETENTION_MS, ...options }));
	}

	// ───────────────────────── lifecycle ─────────────────────────

	/**
	 * Creates the workspace's own state: the owner's member row, the default open teamspace "General" with
	 * the owner as its owner, and a "Getting started" page in it. Idempotent: a second call changes nothing.
	 */
	async init(args: InitArgs): Promise<{ created: boolean; teamspaceId: string | null }> {
		const done = await this.#db.meta.findUnique({ where: { key: META_INITIALIZED } });
		if (done) return { created: false, teamspaceId: typeof done.value === 'string' ? done.value : null };
		let teamspaceId = '';
		let created = false;
		await this.#commit(this.#db, args.ownerId, async (tx, env) => {
			const exists = await tx.meta.findUnique({ where: { key: META_INITIALIZED } });
			if (exists) {
				// A concurrent first call got here first.
				teamspaceId = typeof exists.value === 'string' ? exists.value : '';
				return [];
			}
			created = true;
			await tx.member.upsert({
				where: { userId: args.ownerId },
				create: { userId: args.ownerId, role: 'owner', name: args.ownerName },
				update: { role: 'owner', name: args.ownerName, removedAt: null }
			});
			const general = await insertTeamspace(tx, args.ownerId, {
				name: 'General',
				icon: null,
				description: 'The whole team',
				privacy: 'open',
				defaultLevel: 'update'
			});
			teamspaceId = general.id;
			const records: ChangeRecord[] = [...general.records];
			const pageId = crypto.randomUUID();
			records.push(
				...(await applyPageOp(
					tx,
					{
						op: 'create',
						id: pageId,
						parentId: null,
						rank: rankAfter(null),
						teamspaceId: general.id,
						icon: '👋',
						values: { [TITLE_PROP_ID]: 'Getting started' }
					},
					env
				))
			);
			await tx.meta.create({ data: { key: META_WORKSPACE, value: { id: args.workspaceId, name: args.name } } });
			await tx.meta.create({ data: { key: META_INITIALIZED, value: general.id } });
			return records;
		});
		return { created, teamspaceId };
	}

	/**
	 * Mirrors a D1 membership into `member`: upserts the role and name, or marks the user removed.
	 *
	 * A change of who may do what (a new member, a role change, a removal) is a commit (`member.sync`), so the
	 * visibility sets are rebuilt and open rooms re-checked. A new non-guest member joins the workspace's
	 * default open teamspace ("General") as a member, as in Notion; a removed or demoted-to-guest one leaves
	 * every teamspace.
	 * A role change reconnects the member's sockets (their actor key changes); a removal closes them.
	 */
	async syncMember(args: SyncMemberArgs): Promise<void> {
		const removed = args.removed === true || args.role === null;
		const existing = await this.#db.member.findUnique({ where: { userId: args.userId } });
		const role = args.role ?? existing?.role ?? 'guest';
		const name = args.name ?? existing?.name ?? '';
		const wasActive = !!existing && !existing.removedAt;
		const changed = removed ? wasActive : !wasActive || existing?.role !== role;
		const removedAt = removed ? new Date() : null;
		const upsert = (db: WorkspaceDb) =>
			db.member.upsert({
				where: { userId: args.userId },
				create: { userId: args.userId, role, name, removedAt },
				update: { role, name, removedAt }
			});
		if (removed) {
			// The user lost access: close their sockets with FORBIDDEN so they do not reconnect.
			for (const socket of this.#transport.sockets()) {
				if (socket.actor.userId === args.userId) socket.ws.close(CLOSE.FORBIDDEN, 'removed from the workspace');
			}
		}
		if (changed) {
			await this.#commit(this.#db, SYSTEM_ACTOR, async (tx) => {
				await upsert(tx);
				if (removed || (role === 'guest' && wasActive && existing?.role !== 'guest')) {
					// Guests hold no teamspace: a demoted member leaves them all, like a removed one.
					await tx.teamspaceMember.deleteMany({ where: { userId: args.userId } });
				} else if (role !== 'guest' && (!wasActive || existing?.role === 'guest')) {
					await this.#joinDefaultTeamspace(tx, args.userId);
				}
				return [
					{
						kind: 'member.sync',
						page: null,
						prop: args.userId,
						old: existing ? { role: existing.role, removed: !!existing.removedAt } : null,
						new: { role, removed }
					}
				];
			});
		} else {
			await upsert(this.#db);
		}
		for (const socket of this.#transport.sockets()) {
			if (socket.actor.userId !== args.userId) continue;
			if (removed) {
				continue;
			} else if (socket.actor.role !== role) {
				// Their visibility is another actor's now: a fresh session (hello) builds it.
				this.#hub.dropSocket(socket.socketId);
				socket.ws.close(CLOSE.TRY_AGAIN, 'role changed');
			} else if (socket.actor.name !== name) {
				socket.ws.serializeAttachment({ socketId: socket.socketId, actor: { ...socket.actor, name } });
			}
		}
		this.#socketCache = null;
	}

	/** Puts a user in the default teamspace the workspace was created with (`init`), when it is still live. */
	async #joinDefaultTeamspace(tx: WorkspaceTx, userId: string): Promise<void> {
		const row = await tx.meta.findUnique({ where: { key: META_INITIALIZED } });
		const teamspaceId = typeof row?.value === 'string' ? row.value : null;
		if (!teamspaceId) return;
		const ts = await tx.teamspace.findUnique({ where: { id: teamspaceId } });
		if (!ts || ts.deletedAt || ts.privacy !== 'open') return;
		const key = { teamspaceId_userId: { teamspaceId, userId } };
		if (await tx.teamspaceMember.findUnique({ where: key })) return;
		await tx.teamspaceMember.create({ data: { teamspaceId, userId, role: 'member', rank: await nextMemberRank(tx, userId) } });
	}

	/** The workspace was renamed in D1 (`workspace.settings`): keeps the display name in `meta`. Idempotent. */
	async rename(args: { name: string }): Promise<void> {
		const current = await this.#db.meta.findUnique({ where: { key: META_WORKSPACE } });
		const value = (current?.value && typeof current.value === 'object' ? current.value : {}) as { id?: string; name?: string };
		await this.#db.meta.upsert({
			where: { key: META_WORKSPACE },
			create: { key: META_WORKSPACE, value: { id: this.ctx.id.name ?? '', name: args.name } },
			update: { value: { ...value, name: args.name } }
		});
	}

	/** The member's role, or null for an unknown or removed user. Accounts uses it as the membership cache. */
	async getMemberRole(userId: string): Promise<WorkspaceRole | null> {
		const row = await this.#db.member.findUnique({ where: { userId } });
		return row && !row.removedAt ? (row.role as WorkspaceRole) : null;
	}

	// ───────────────────────── the mutation path ─────────────────────────

	/**
	 * `apply(actor, { mid, ops, appVersion })`: validates the batch against the property registry, runs every
	 * op in one transaction, appends the `change` rows and returns the commit's `seq`. A retry of the same
	 * `mid` returns its first answer. Throws `WorkspaceError` (`APP_OUTDATED`, `VALIDATION_FAILED`...).
	 */
	async apply(actor: Actor, batch: MutationBatch): Promise<{ seq: number }> {
		if (checkVersions(this.env, batch.appVersion) === 'reload') {
			throw new WorkspaceError('APP_OUTDATED', 'This version of the app is outdated. Reload to continue.');
		}
		const db = this.#writeDb(actor);
		const resolved = this.#access.resolve(actor);
		if (!resolved) throw new WorkspaceError('FORBIDDEN', 'You are not a member of this workspace');
		const authorizer = createAuthorizer({
			role: resolved.role,
			userId: actor.userId,
			updatableTeamspaces: this.#access.facts(resolved).teamspaces.update
		});
		const registry = await loadRegistry(db);
		const checked = validateBatch(batch, registry);
		if (!checked.ok) throw new WorkspaceError('VALIDATION_FAILED', 'Validation failed', checked.issues);
		const { ops } = checked.value;

		const result = await this.#commit(
			db,
			actor.userId,
			async (tx, env) => {
				const records: ChangeRecord[] = [];
				for (const [index, op] of ops.entries()) {
					try {
						await authorizer.check(tx as unknown as GovernedTx, op);
						records.push(...(await this.#applyOp(tx, op, env)));
					} catch (error) {
						throw withOpPath(error, index);
					}
				}
				// Rollups and formulas that depend on what the batch wrote (one pass for the whole batch), then
				// the search index, all in this transaction: their records flow through the same live loop.
				const written = new Set(records.flatMap((r) => (r.page ? [r.page] : [])));
				const computed = await afterWrite(tx, records, { actorId: env.actorId, now: env.now });
				for (const r of computed) if (r.page && !written.has(r.page)) env.unstamped.add(r.page);
				records.push(...computed);
				await indexChanges(tx, records);
				return records;
			},
			{ mid: batch.mid, definition: ops.some(isDefinitionOp) }
		);
		return { seq: result.seq };
	}

	#applyOp(tx: Parameters<typeof applyPageOp>[0], op: Op, env: Parameters<typeof applyPageOp>[2]): Promise<ChangeRecord[]> {
		if (isPageOp(op)) return applyPageOp(tx, op, env);
		if (isEavOp(op)) return applyEavOp(tx, op, { actorId: env.actorId, now: env.now });
		throw new WorkspaceError('BAD_REQUEST', `Unknown op "${(op as { op: string }).op}"`);
	}

	/**
	 * `page.create`: a `create` op with a title. Returns the new page's id, dense number and the commit's seq. With a
	 * `viewId` the row starts with the values that satisfy the view (`defaultsForView`: the collection's defaults,
	 * its filter, the view's and `localFilter`), and sits under the view's default parent unless `parentId` is given.
	 * The op that is authorized and applied is a plain `create`: placement is checked on the resolved parent.
	 */
	async createPage(
		actor: Actor,
		input: PageCreate & { appVersion: string; mid?: string }
	): Promise<{ id: string; num: number; seq: number }> {
		const id = input.id ?? crypto.randomUUID();
		let parentId = input.parentId;
		let teamspaceId = input.teamspaceId;
		let values = input.values;
		if (input.viewId) {
			if (input.localFilter) {
				const checked = validateFilter(input.localFilter, await loadRegistry(this.#db));
				if (!checked.ok) throw new WorkspaceError('VALIDATION_FAILED', 'Validation failed', checked.issues.map((i) => ({ ...i, path: `/localFilter${i.path}` })));
			}
			const defaults = await defaultsForView(this.#db, input.viewId, {
				meId: actor.userId,
				now: Date.now(),
				localFilter: input.localFilter ?? null
			});
			// A database the caller cannot read does not exist for them, and neither does its view.
			if (!defaults || !(await this.#access.pageAccess(actor, defaults.collectionPageId as string))) throw notFound(`View "${input.viewId}"`);
			if (parentId === undefined) {
				parentId = defaults.parentId;
				if (parentId === null && teamspaceId === undefined && defaults.teamspaceId !== undefined) teamspaceId = defaults.teamspaceId;
			}
			values = { ...defaults.values, ...(input.values ?? {}) };
		}
		if (parentId === undefined) throw invalid('/parentId', 'required', 'A page needs a parent (null for the root level) unless it is created from a view');
		const rank = input.rank ?? rankAfter(this.#lastRank(parentId));
		const { seq } = await this.apply(actor, {
			mid: input.mid ?? `create:${id}`,
			appVersion: input.appVersion,
			ops: [
				{
					op: 'create',
					id,
					parentId,
					rank,
					...(teamspaceId !== undefined ? { teamspaceId } : {}),
					...(input.icon !== undefined ? { icon: input.icon } : {}),
					...(input.cover !== undefined ? { cover: input.cover } : {}),
					...(input.isDatabase !== undefined ? { isDatabase: input.isDatabase } : {}),
					...(values ? { values } : {})
				}
			]
		});
		const row = await this.#db.page.findUnique({ where: { id }, select: { num: true } });
		return { id, num: row?.num ?? 0, seq };
	}

	#lastRank(parentId: string | null): string | null {
		const sql = this.ctx.storage.sql;
		const row =
			parentId === null
				? sql.exec<{ rank: string }>('SELECT MAX(rank) AS rank FROM page WHERE parent_id IS NULL AND deleted_at IS NULL').toArray()[0]
				: sql.exec<{ rank: string }>('SELECT MAX(rank) AS rank FROM page WHERE parent_id = ? AND deleted_at IS NULL', parentId).toArray()[0];
		return row?.rank ?? null;
	}

	/** A rank after the last live child of `parentId` (null: the root level). */
	async nextRank(parentId: string | null): Promise<string> {
		return rankAfter(this.#lastRank(parentId));
	}

	// ───────────────────────── reads ─────────────────────────

	/** One-shot read of a page's header and properties. */
	async getPage(actor: Actor, id: string): Promise<PageRow> {
		const level = await this.#access.pageAccess(actor, id);
		// A page the caller cannot see does not exist for them.
		const row = level ? (await this.#hub.reader.pageRows([id], () => level)).get(id) : undefined;
		if (!row) throw notFound(`Page "${id}"`);
		return row;
	}

	/** Trash roots the caller may read, newest first, with the number of pages each took along. */
	async listTrash(actor: Actor, input: TrashListInput) {
		const limit = input.limit ?? 50;
		const offset = input.cursor ? Number(input.cursor) || 0 : 0;
		const order =
			input.sort === 'deleted_asc' ? 'deleted_at ASC' : input.sort === 'title' ? 'title COLLATE NOCASE ASC' : 'deleted_at DESC';
		const like = input.q ? `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
		const gov = this.#writeDb(actor);
		type Row = {
			id: string;
			title: string;
			icon: string | null;
			deleted_at: string;
			deleted_by: string | null;
			parent_id: string | null;
			page_count: number;
		};
		// Candidates are read in windows and ANDed with what the caller may read (a trashed page keeps its grants).
		const visible: Row[] = [];
		let exhausted = false;
		let next = offset;
		while (visible.length <= limit && !exhausted) {
			const rows = this.ctx.storage.sql
				.exec<Row>(
					`SELECT p.id, p.title, p.icon, p.deleted_at, p.deleted_by, p.parent_id,
					        (SELECT COUNT(*) FROM page c WHERE c.trash_root = p.id) AS page_count
					 FROM page p
					 WHERE p.deleted_at IS NOT NULL AND p.trash_root = p.id
					   ${like ? "AND p.title LIKE ? ESCAPE '\\'" : ''}
					 ORDER BY ${order}, p.id LIMIT ? OFFSET ?`,
					...(like ? [like] : []),
					limit + 1,
					next
				)
				.toArray();
			exhausted = rows.length < limit + 1;
			const ids = rows.map((r) => r.id);
			const allowed = new Set(
				ids.length === 0
					? []
					: ((await gov.page.findMany({ where: { id: { in: ids } }, select: { id: true } })) as { id: string }[]).map((r) => r.id)
			);
			for (const r of rows) {
				next++;
				if (allowed.has(r.id)) visible.push(r);
				if (visible.length > limit) break;
			}
		}
		const page = visible.slice(0, limit);
		return {
			items: page.map((r) => ({
				id: r.id,
				title: r.title,
				icon: r.icon,
				deletedAt: r.deleted_at,
				deletedBy: r.deleted_by,
				pageCount: r.page_count,
				parentId: r.parent_id
			})),
			// `next` stopped right after the first row beyond the page, so the page's own last row is one before.
			nextCursor: visible.length > limit ? String(next - 1) : null
		};
	}

	/** The workspace's live properties (Databases' `property.list`): the registry holds names and types, for any member. */
	async readProperties(actor: Actor) {
		this.#writeDb(actor); // a user without a membership holds nothing
		return readProperties(this.#db);
	}

	/** A collection and its views, or null (Databases' `collection.get`): only for a caller who can read its page. */
	async readCollection(actor: Actor, id: string) {
		const found = await readCollection(this.#db, id);
		if (!found) return null;
		return (await this.#access.pageAccess(actor, found.collection.pageId)) ? found : null;
	}

	/** The views of a collection (Databases' `view.list`), for a caller who can read its database page. */
	async readViews(actor: Actor, collectionId: string) {
		const row = this.ctx.storage.sql.exec<{ page_id: string }>('SELECT page_id FROM collection WHERE id = ? AND deleted_at IS NULL', collectionId).toArray()[0];
		if (!row || !(await this.#access.pageAccess(actor, row.page_id))) return [];
		return readViews(this.#db, collectionId);
	}

	/**
	 * One-shot read of a collection's view (Databases' query engine, `collection.query`): the window, total,
	 * groups (a grouped view) and referenced properties. Every result is intersected with the actor's
	 * visibility set (`visibleNums`), the collection's membership and the live pages: the engine runs raw SQL,
	 * which the viborm policy does not govern. Throws `NOT_FOUND` for a collection or view the actor cannot read.
	 */
	async queryView(actor: Actor, input: QueryViewInput): Promise<QueryViewResult> {
		const row = this.ctx.storage.sql.exec<{ page_id: string }>('SELECT page_id FROM collection WHERE id = ? AND deleted_at IS NULL', input.collectionId).toArray()[0];
		if (!row || !(await this.#access.pageAccess(actor, row.page_id))) throw notFound(`Collection "${input.collectionId}"`);
		const visible = await this.visibleNums(actor);
		const levels = await this.#access.levelsOf(actor);
		return queryViewRows(this.#db, input, {
			userId: actor.userId,
			visible,
			levels,
			seq: this.#hub.headSeq(),
			now: Date.now()
		});
	}

	// ───────────────────────── teamspaces ─────────────────────────

	async teamspaces(actor: Actor): Promise<Teamspace[]> {
		return listTeamspaces(this.#writeDb(actor), actor);
	}

	/** Creating a teamspace needs a non-guest; its first owner row is then a system write (policy: `create`). */
	async createTeamspace(actor: Actor, input: TeamspaceInput): Promise<Teamspace> {
		this.#writeDb(actor);
		assertNotGuest(actor, 'create teamspaces');
		let id = '';
		await this.#commit(this.#db, actor.userId, async (tx) => {
			const out = await insertTeamspace(tx, actor.userId, input);
			id = out.id;
			return out.records;
		});
		return readTeamspace(this.#writeDb(actor), actor, id);
	}

	async updateTeamspace(actor: Actor, patch: Partial<TeamspaceInput> & { id: string }): Promise<Teamspace> {
		await this.#commit(this.#writeDb(actor), actor.userId, (tx) => updateTeamspaceRecords(tx, patch));
		return readTeamspace(this.#writeDb(actor), actor, patch.id);
	}

	/** Tombstones the teamspace and all its pages with one shared timestamp. */
	async archiveTeamspace(actor: Actor, id: string): Promise<{ seq: number }> {
		const { seq } = await this.#commit(this.#writeDb(actor), actor.userId, async (tx, env) => {
			const records = await archiveTeamspaceRecords(tx, id, env.actorId, env.now);
			// Rollups and formulas elsewhere that read the archived pages through a relation drop them.
			return [...records, ...(await this.#computedAfter(tx, records, env))];
		});
		return { seq };
	}

	/** Archived teamspaces the caller owns (Settings lists them with a restore button). */
	async archivedTeamspaces(actor: Actor): Promise<ArchivedTeamspace[]> {
		return listArchivedTeamspaces(this.#writeDb(actor), this.ctx.storage.sql);
	}

	/** Brings an archived teamspace and the pages its archive took back (owners only). */
	async restoreTeamspace(actor: Actor, id: string): Promise<{ seq: number }> {
		const { seq } = await this.#commit(this.#writeDb(actor), actor.userId, async (tx, env) => {
			const records = await restoreTeamspaceRecords(tx, id);
			return [...records, ...(await this.#computedAfter(tx, records, env))];
		});
		return { seq };
	}

	/** The rollup and formula records `afterWrite` derives from `records`; their pages are not "edited" by it. */
	async #computedAfter(tx: WorkspaceTx, records: ChangeRecord[], env: { actorId: string; now: number; unstamped: Set<string> }): Promise<ChangeRecord[]> {
		const computed = await afterWrite(tx, records, { actorId: env.actorId, now: env.now });
		for (const r of computed) if (r.page) env.unstamped.add(r.page);
		return computed;
	}

	async teamspaceMembers(actor: Actor, teamspaceId: string): Promise<TeamspaceMember[]> {
		return listTeamspaceMembers(this.#writeDb(actor), actor, teamspaceId);
	}

	async addTeamspaceMember(
		actor: Actor,
		input: { teamspaceId: string; userId: string; role?: 'owner' | 'member' }
	): Promise<TeamspaceMember> {
		let member: TeamspaceMember | undefined;
		await this.#commit(this.#writeDb(actor), actor.userId, async (tx) => {
			const out = await addTeamspaceMemberRecords(tx, input);
			member = out.member;
			return out.records;
		});
		return member as TeamspaceMember;
	}

	async setTeamspaceMemberRole(
		actor: Actor,
		input: { teamspaceId: string; userId: string; role: 'owner' | 'member' }
	): Promise<TeamspaceMember> {
		let member: TeamspaceMember | undefined;
		await this.#commit(this.#writeDb(actor), actor.userId, async (tx) => {
			const out = await setTeamspaceMemberRoleRecords(tx, input);
			member = out.member;
			return out.records;
		});
		return member as TeamspaceMember;
	}

	async removeTeamspaceMember(actor: Actor, input: { teamspaceId: string; userId: string }): Promise<void> {
		await this.#commit(this.#writeDb(actor), actor.userId, (tx) => removeTeamspaceMemberRecords(tx, input));
	}

	// ───────────────────────── access: pages, grants, visibility ─────────────────────────

	/**
	 * The highest level `actor` holds on a live page, or null (no access, trashed, unknown). Rooms and files
	 * ask this. `actor.role` may be left out (a user id alone): the `member` mirror then decides, and a user
	 * who is not a current member holds nothing.
	 */
	async pageAccess(actor: AccessActor, pageId: string): Promise<AccessLevel | null> {
		return this.#access.pageAccess(actor, pageId);
	}

	/**
	 * Pushes a page's new lock state to every connected tab that can read the page (the `lock` message). The lock
	 * itself lives in the page's room; the `page.lock.set` handler calls this once the room has changed.
	 */
	async pageLockChanged(pageId: string, state: { locked: boolean; lockedBy: string | null; lockedAt: number | null }): Promise<void> {
		const message: ServerMessage = { t: 'lock', pageId, locked: state.locked, lockedBy: state.lockedBy, lockedAt: state.lockedAt };
		await Promise.all(
			this.#hub.streamSockets().map(async (socketId) => {
				const socket = this.#socket(socketId);
				if (socket && (await this.#access.pageAccess(socket.actor, pageId))) this.#send(socketId, message);
			})
		);
	}

	/** Whether `actor` holds `level` on each of the pages: `{ [pageId]: boolean }`. */
	async can(actor: AccessActor, pageIds: string[], level: AccessLevel): Promise<Record<string, boolean>> {
		return this.#access.can(actor, pageIds, level);
	}

	/** The live grants of a page (the policy's `grant` read: whoever can read the page). Tokens only for `full`. */
	async listGrants(actor: Actor, pageId: string): Promise<Grant[]> {
		const level = await this.#access.pageAccess(actor, pageId);
		if (!level) throw notFound(`Page "${pageId}"`);
		const rows = (await this.#writeDb(actor).grant.findMany({
			where: { pageId, deletedAt: null },
			orderBy: { id: 'asc' }
		})) as Parameters<typeof toGrant>[0][];
		return rows.map((r) => toGrant(r, level === 'full'));
	}

	/**
	 * Shares a page with a user, a teamspace, the workspace or the world (`public` mints a random link token).
	 * Needs `full` on the page. Setting a grant that exists changes its level; a page has one public link.
	 */
	async setGrant(actor: Actor, input: GrantInput): Promise<Grant> {
		let grant: Grant | undefined;
		await this.#commit(this.#writeDb(actor), actor.userId, async (tx) => {
			const out = await setGrantRecords(tx as unknown as GovernedTx, actor.userId, input);
			grant = out.grant;
			return out.records;
		});
		return grant as Grant;
	}

	/** Revokes a grant (tombstones it). Needs `full` on its page. Returns the commit's `seq`. */
	async revokeGrant(actor: Actor, grantId: string): Promise<{ seq: number }> {
		const { seq } = await this.#commit(this.#writeDb(actor), actor.userId, (tx, env) =>
			revokeGrantRecords(tx as unknown as GovernedTx, grantId, env.now)
		);
		return { seq };
	}

	/**
	 * The page a public share token opens and the level it gives, or null (unknown or revoked token,
	 * trashed page). The token IS the credential: this is the one lookup that runs before an actor exists,
	 * and what it returns is confirmed by the policy for an anonymous visitor holding that token.
	 */
	async grantByToken(token: string): Promise<{ pageId: string; level: AccessLevel } | null> {
		if (typeof token !== 'string' || token.length < 16) return null;
		const grant = await this.#db.grant.findFirst({ where: { subjectKind: 'public', token, deletedAt: null } });
		if (!grant) return null;
		const level = await this.#access.pageAccess({ role: 'anonymous', shareToken: token }, grant.pageId);
		return level ? { pageId: grant.pageId, level } : null;
	}

	/**
	 * The `num` of every live page `actor` can read: the visibility set the query engine ANDs into
	 * `queryView` (and search and AI use). Cached per actor, recomputed lazily when a grant, a move, a
	 * teamspace membership or a workspace membership changes. Empty for a user without a membership.
	 */
	async visibleNums(actor: AccessActor): Promise<Set<number>> {
		return (await this.#access.visibleNums(actor)) ?? new Set();
	}

	/** Test and diagnostics hook: whether the actor's visibility set is held in memory right now. */
	async visibilityCached(actor: AccessActor): Promise<boolean> {
		return this.#access.cached(actor);
	}

	// ───────────────────────── index ingestion and rooms ─────────────────────────

	/**
	 * Fed by the queue consumer in batches of up to 100 pages: body text, links and last-edited stamps.
	 * Updates `link` rows and the backlinks subscriptions. FTS5 is built in P3.
	 */
	async ingestPages(items: PageIndexItem[]): Promise<{ indexed: number; skipped: number }> {
		if (items.length === 0) return { indexed: 0, skipped: 0 };
		let result: IngestResult | undefined;
		await this.#commit(
			this.#db,
			SYSTEM_ACTOR,
			async (tx) => {
				result = await ingestInTransaction(tx, items);
				await indexBodies(tx, items);
				return result.records;
			},
			{ backlinkTargets: () => result?.backlinkTargets ?? [] }
		);
		// Mention emails: new @mentions become `email` jobs (never fails the index batch).
		await processMentions({ db: this.#db, env: this.env, host: this, workspaceId: this.ctx.id.name ?? '' }, items).catch((error) =>
			console.warn('[mentions] failed:', String(error))
		);
		return { indexed: result?.indexed ?? 0, skipped: result?.skipped ?? 0 };
	}

	/** The Page DO has a live socket for `pageId`: kept so access changes can reach open rooms (P2). */
	async openRoom(pageId: string): Promise<void> {
		await this.#db.openRoom.upsert({
			where: { pageId },
			create: { pageId },
			update: {}
		});
	}

	async closeRoom(pageId: string): Promise<void> {
		await this.#db.openRoom.deleteMany({ where: { pageId } });
	}

	// ───────────────────────── files (Editor and files track, see ./files.ts) ─────────────────────────

	/** The level `actor` holds on a page for the files, comments and lock features: `pageAccess`, as a {@link PageLevel}. */
	async editorPageLevel(actor: Actor, pageId: string): Promise<PageLevel | null> {
		return normalizeLevel(await this.pageAccess(actor, pageId));
	}

	/** `editorPageLevel` for a user known only by id (the room route, at a dial): the member mirror decides the role. */
	async editorUserLevel(userId: string, pageId: string): Promise<PageLevel | null> {
		return normalizeLevel(await this.pageAccess({ userId }, pageId));
	}

	#filesContext(actor: Actor): FilesContext {
		return {
			sql: this.ctx.storage.sql,
			env: this.env,
			workspaceId: actor.workspaceId,
			level: (pageId) => this.editorPageLevel(actor, pageId)
		};
	}

	/** `files.begin`: `update` on the page and room in the quota, then the upload's id and where to send it. */
	filesBegin(actor: Actor, input: BeginInput) {
		return beginUpload(this.#filesContext(actor), actor, input);
	}

	/** The caller's pending upload (`PUT /files/:fileId`, the parts endpoints), checked again for access. */
	filesPending(actor: Actor, fileId: string) {
		return pendingUpload(this.#filesContext(actor), actor, fileId);
	}

	async filesRecordUploadId(actor: Actor, fileId: string, uploadId: string): Promise<void> {
		const ctx = this.#filesContext(actor);
		await pendingUpload(ctx, actor, fileId);
		recordUploadId(ctx, fileId, uploadId);
	}

	/** `files.complete`: assembles a multipart upload, checks the bytes, commits the row. */
	filesComplete(actor: Actor, fileId: string, parts?: { partNumber: number; etag: string }[]) {
		return completeUpload(this.#filesContext(actor), actor, fileId, parts);
	}

	filesAbort(actor: Actor, fileId: string) {
		return abortUpload(this.#filesContext(actor), actor, fileId);
	}

	/** A committed file's metadata when `actor` may read its page (`files.get`, and the download route). */
	filesGet(actor: Actor, fileId: string) {
		return getFile(this.#filesContext(actor), fileId);
	}

	/** Like `filesGet` with the R2 key, or `null` (the download route turns that into a 404). */
	filesResolve(actor: Actor, fileId: string) {
		return readableFile(this.#filesContext(actor), fileId);
	}

	/** The weekly sweep for this workspace: uploads never committed are removed. */
	filesSweep(options: { now?: number; maxAgeMs?: number } = {}) {
		return sweepUncommitted(this.ctx.storage.sql, this.env, this.ctx.id.name ?? '', options);
	}

	/** Purge: the files of these pages lose their rows and bytes. */
	filesPurgePages(pageIds: string[]) {
		return purgeFilesOfPages(this.ctx.storage.sql, this.env, this.ctx.id.name ?? '', pageIds);
	}

	/** Storage used and the quota; `setQuota` (bytes, or `null` for the default) changes it. */
	filesStorage(setQuota?: number | null) {
		if (setQuota !== undefined) setStorageQuota(this.ctx.storage.sql, setQuota);
		return filesUsage(this.ctx.storage.sql);
	}

	// ───────────────────────── search (Accounts, AI, API: src/server/search) ─────────────────────────

	/** What a search of `actor` runs on: raw reads, ANDed with the actor's visibility set (FORBIDDEN for non-members). */
	async #searchContext(actor: Actor, semantic: boolean) {
		this.#writeDb(actor);
		const visible = await this.visibleNums({ userId: actor.userId, role: actor.role });
		return { db: this.#db, visible, vector: semantic ? vectorSearchOf(this.env, actor.workspaceId) : null };
	}

	/** The search page: full text (plus Vectorize for questions), filters, snippets. Only pages the actor can read. */
	async searchQuery(actor: Actor, input: SearchInput): Promise<SearchResult> {
		return searchPages(await this.#searchContext(actor, true), input);
	}

	/** Quick find (`⌘K`): title prefixes, recently visited pages, then full-text hits. */
	async searchQuick(actor: Actor, input: QuickFindInput): Promise<QuickFindResult> {
		return quickFind(await this.#searchContext(actor, false), actor.userId, input);
	}

	/** Records that `actor` opened a page they can read (feeds quick find's "recent"). Anything else is ignored. */
	async searchVisit(actor: Actor, pageId: string): Promise<void> {
		const context = await this.#searchContext(actor, false);
		const row = await this.#db.page.findUnique({ where: { id: pageId }, select: { num: true, deletedAt: true } });
		if (row && !row.deletedAt && context.visible.has(row.num)) await recordVisit(this.#db, actor.userId, row.num);
	}

	/** Backfill for workspaces that existed before search: rebuilds the whole FTS5 index. Idempotent. */
	async reindexAll(): Promise<{ pages: number }> {
		return reindexSearch(this.#db);
	}

	/** Backfill for Vectorize: embeds the chunks of every live page whose hash is new. Idempotent; a no-op without AI/Vectorize. */
	async embedAll(): Promise<EmbedResult[]> {
		const results: EmbedResult[] = [];
		const store = {
			diff: async (model: string, pages: PageChunks[]) => diffChunks(this.#db, model, pages),
			apply: (model: string, pages: PageChunks[]) => applyChunks(this.#db, model, pages),
			chunkIds: (pageIds: string[]) => chunkIdsOf(this.#db, pageIds),
			forget: (pageIds: string[]) => forgetChunks(this.#db, pageIds)
		};
		let after = 0;
		for (;;) {
			const rows = await this.#db.$queryRawUnsafe<{ id: string; num: number; version: number; text: string; outline_json: string; edited_at: number | null; edited_by: string | null }>(
				`SELECT p.id AS id, p.num AS num, t.version AS version, t.text AS text, t.outline_json AS outline_json, t.edited_at AS edited_at, t.edited_by AS edited_by
				 FROM page p JOIN page_text t ON t.page_num = p.num WHERE p.deleted_at IS NULL AND p.num > ? ORDER BY p.num LIMIT 50`,
				after
			);
			if (rows.length === 0) break;
			const items: PageIndexItem[] = rows.map((r) => ({
				pageId: r.id,
				version: r.version,
				text: r.text,
				outline: JSON.parse(r.outline_json || '[]'),
				links: [],
				mentions: [],
				editedAt: r.edited_at ?? 0,
				editedBy: r.edited_by
			}));
			const result = await embedPages(this.env, this.ctx.id.name ?? '', items, { store });
			results.push(result);
			if (result.unavailable) break;
			after = rows[rows.length - 1]!.num;
		}
		return results;
	}

	/** Embedding bookkeeping, called over RPC by `embedPages` and `deletePageVectors` (src/server/search). */
	async embedDiff(model: string, pages: PageChunks[]): Promise<EmbedPlan[]> {
		return diffChunks(this.#db, model, pages);
	}

	async embedApply(model: string, pages: PageChunks[]): Promise<void> {
		await applyChunks(this.#db, model, pages);
	}

	async embedChunkIds(pageIds: string[]): Promise<string[]> {
		return chunkIdsOf(this.#db, pageIds);
	}

	async embedForget(pageIds: string[]): Promise<void> {
		await forgetChunks(this.#db, pageIds);
	}

	// ───────────────────────── trash and purge ─────────────────────────

	/**
	 * What the Purge workflow deletes next: tombstones older than the cutoff (30 days by default), deepest first,
	 * at most `limit`, and the archived teamspaces that have no page left. Read only.
	 */
	async purgePlan(cutoffMs: number = Date.now() - TRASH_RETENTION_MS, limit = 500): Promise<{ pages: PurgedPage[]; teamspaces: string[] }> {
		return { pages: await planPurge(this.#db, cutoffMs, limit), teamspaces: await purgeableTeamspaces(this.#db, cutoffMs) };
	}

	/**
	 * Deletes tombstoned pages and everything in this object that hangs off them (EAV rows, relation cells of
	 * other pages, grants, links, collection members, indexed text). Idempotent, and safe to retry after a
	 * partial failure: pages that are live or still hold a child outside the set are skipped, and the answer is
	 * the pages of `pages` that are gone from the database afterwards (this call's or an earlier one's), which
	 * is what the next steps (search rows, rooms, files, vectors) act on. The caller (the workflow, or
	 * `purgeTrash` after its own checks) is trusted: the base client is the only one that can hard-delete.
	 */
	async purgePages(pages: PurgedPage[]): Promise<PurgedPage[]> {
		return this.#purge(SYSTEM_ACTOR, pages);
	}

	async #purge(actorId: string, pages: readonly PurgedPage[]): Promise<PurgedPage[]> {
		await this.#commit(this.#db, actorId, async (tx, env) => {
			const out = await purgePageRows(tx, pages.map((p) => p.id), { actorId, now: env.now });
			for (const r of out.records) if (r.page) env.unstamped.add(r.page);
			// Pages that lost a relation target (their cell is rewritten) get their rollups and formulas recomputed too.
			return [...out.records, ...(await this.#computedAfter(tx, out.records, env))];
		});
		const left = new Set<string>();
		for (const part of chunks(pages, 90)) {
			for (const r of this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM page WHERE id IN (${part.map(() => '?').join(',')})`, ...part.map((p) => p.id)).toArray()) left.add(r.id);
		}
		return pages.filter((p) => !left.has(p.id));
	}

	/** Removes the search rows (and visits) of purged pages by number; idempotent. */
	async removeIndexRows(nums: number[]): Promise<void> {
		await removeFromIndex(this.#db, nums);
	}

	/** Deletes archived teamspaces past the cutoff once their pages are purged. Returns the ids removed. */
	async purgeTeamspaces(cutoffMs: number = Date.now() - TRASH_RETENTION_MS): Promise<string[]> {
		const ids = await purgeableTeamspaces(this.#db, cutoffMs);
		let done: string[] = [];
		if (ids.length > 0) {
			await this.#commit(this.#db, SYSTEM_ACTOR, async (tx) => {
				done = await purgeTeamspaceRows(tx, ids);
				return done.map((id) => ({ kind: 'teamspace.purge', page: null, prop: id, old: null, new: null }));
			});
		}
		return done;
	}

	/**
	 * `page.purge`: deletes a trashed page and everything under it for good, ahead of the 30 days. Needs `full`
	 * on the page (the policy keeps a trashed page's grants, so the person who could delete it can purge it)
	 * and the page must be the root of its trash entry. Returns the pages that went; the caller finishes the job
	 * (rooms, files, vectors) through the Purge workflow.
	 */
	async purgeTrash(actor: Actor, pageId: string): Promise<{ pages: PurgedPage[] }> {
		const gov = this.#writeDb(actor);
		const row = this.ctx.storage.sql
			.exec<{ deleted_at: string | null; trash_root: string | null }>('SELECT deleted_at, trash_root FROM page WHERE id = ?', pageId)
			.toArray()[0];
		const can = row ? await (gov.page as unknown as { can(level: 'read' | 'full', where: { id: string }): Promise<boolean> }).can('read', { id: pageId }) : false;
		if (!row || !can) throw notFound(`Page "${pageId}"`);
		if (!row.deleted_at || row.trash_root !== pageId) throw invalid('/id', 'not_in_trash', 'Only a page that was moved to the trash can be deleted forever');
		if (!(await (gov.page as unknown as { can(level: 'full', where: { id: string }): Promise<boolean> }).can('full', { id: pageId }))) {
			throw new WorkspaceError('FORBIDDEN', 'You do not have access to delete this page');
		}
		// Everything below it goes, whichever entry of the trash it was in.
		const ids = this.#hub.reader.subtree([pageId]);
		const nums = this.#hub.reader.nums(ids);
		const gone = await this.#purge(actor.userId, ids.flatMap((id) => (nums.has(id) ? [{ id, num: nums.get(id) as number }] : [])));
		await removeFromIndex(this.#db, gone.map((p) => p.num));
		return { pages: gone };
	}

	/** Every page of the workspace, tombstones included, after `num`: how workspace deletion walks the Page DOs. */
	async pagesAfter(num: number, limit = 500): Promise<PurgedPage[]> {
		return this.ctx.storage.sql.exec<{ id: string; num: number }>('SELECT id, num FROM page WHERE num > ? ORDER BY num LIMIT ?', num, limit).toArray();
	}

	/**
	 * Deletes everything this object stores (workspace deletion, after 30 days): closes the sockets, cancels the
	 * alarm and wipes the storage. The Purge workflow has already taken the rooms, the R2 prefix and the vectors.
	 */
	async destroy(): Promise<void> {
		for (const socket of this.#transport.sockets()) {
			try {
				socket.ws.close(CLOSE.WORKSPACE_GONE, 'workspace deleted');
			} catch {
				// already closed
			}
		}
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	// ───────────────────────── diagnostics ─────────────────────────

	/** Live-loop counters, for tests and operators: shared units, evaluations, sockets with a stream. */
	async liveStats(): Promise<{ units: number; evaluations: number; isolateEvaluations: number; streams: number; head: number; stale: string[] }> {
		return {
			units: this.#hub.unitCount(),
			evaluations: this.#hub.evaluations,
			isolateEvaluations: unitEvaluations(),
			streams: this.#hub.streamSockets().length,
			head: this.#hub.headSeq(),
			stale: await this.#hub.staleUnits()
		};
	}
}

/** The policy's refusal as the workspace error the `/rpc` layer maps to 403. */
function mapPolicyError(error: unknown): unknown {
	if (error instanceof ForbiddenError || (error instanceof Error && error.name === 'ForbiddenError')) {
		return new WorkspaceError('FORBIDDEN', 'You do not have permission to do that');
	}
	return error;
}

/** Prefixes the issues of a failed op with `/ops/<index>` and maps Databases' `EavError` to `VALIDATION_FAILED`. */
function withOpPath(error: unknown, index: number): unknown {
	const prefix = `/ops/${index}`;
	if (isEavError(error)) {
		return new WorkspaceError(
			'VALIDATION_FAILED',
			error.message,
			error.issues.map((i) => ({ ...i, path: prefix + i.path }))
		);
	}
	if (error instanceof WorkspaceError && error.code === 'VALIDATION_FAILED') {
		return new WorkspaceError(
			'VALIDATION_FAILED',
			error.detail,
			error.issues.map((i) => ({ ...i, path: prefix + i.path }))
		);
	}
	return error;
}
