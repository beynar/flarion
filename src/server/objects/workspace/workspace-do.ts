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
 * Writes go through `#writeDb(actor)`, the one seam P2 switches to `db.$as(actor)`; the visibility set is
 * "every live page" until then (`actor.ts`).
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
import { createWorkspaceClient, type WorkspaceClient } from '../../db/workspace.client';
import type { PageIndexItem } from '../../queues/types';
import { stubAccess, type WorkspaceSocketActor } from './actor';
import { pruneLog, LOG_RETENTION_MS, type PruneResult } from './changelog';
import { runCommit, type CommitResult } from './commit';
import {
	applyEavOp,
	invalidateRegistry,
	isEavOp,
	isEavError,
	loadRegistry,
	ensureEavLayout,
	readCollection,
	readProperties,
	readViews,
	type ChangeRecord
} from './eav';
import { notFound, WorkspaceError } from './errors';
import { ingestInTransaction, type IngestResult } from './ingest';
import { LiveHub, unitEvaluations, type CommitInfo } from './live';
import { migrateWorkspace } from './migrations';
import { applyPageOp, isPageOp } from './page-ops';
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
	assertNotGuest,
	insertTeamspace,
	listTeamspaceMembers,
	listTeamspaces,
	readTeamspace,
	removeTeamspaceMemberRecords,
	setTeamspaceMemberRoleRecords,
	updateTeamspaceRecords,
	type TeamspaceInput
} from './teamspaces';
import { checkVersions } from './versions';
import { APP_VERSION_HEADER, APP_VERSION_PARAM } from '../../../lib/shared/protocol';

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
		this.#db = createWorkspaceClient(ctx.storage);
		// Raw steps, the viborm estate and the EAV layout, before any request or socket message is served.
		void ctx.blockConcurrencyWhile(async () => {
			await migrateWorkspace(ctx, this.#db);
			ensureEavLayout(ctx.storage);
		});
		this.#hub = new LiveHub({
			sql: ctx.storage.sql,
			send: (socketId, message) => this.#send(socketId, message),
			actorOf: (socketId) => this.#socket(socketId)?.actor ?? null
		});
		this.#api = new WorkspaceSocketApi({
			env,
			hub: this.#hub,
			presence: this.#presence,
			send: (socketId, message) => this.#send(socketId, message),
			streams: () => this.#hub.streamSockets(),
			now: () => Date.now()
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
		if (typeof message === 'string' && PROTOCOL_FRAME.test(message)) return this.#protocolFrame(ws, message);
		return this.#transport.message(ws, message);
	}

	#protocolFrame(ws: WebSocket, text: string): void {
		const socket = this.#transport.handle(ws);
		if (!socket) return ws.close(1011, 'missing attachment');
		const decoded = decodeClientMessage(text);
		if (!decoded.ok) return ws.close(CLOSE.BAD_MESSAGE, decoded.message.slice(0, 120));
		const message: ClientMessage = decoded.value;
		try {
			switch (message.t) {
				case 'hello':
					return this.#api.hello(socket, RAW_STREAM, message);
				case 'subscribe':
					return this.#api.subscribe(socket, { id: message.id, sub: message.sub });
				case 'unsubscribe':
					return this.#api.unsubscribe(socket, message.id);
				case 'window':
					return this.#api.window(socket, message);
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
	 * The one seam for permissions. P2 returns `this.#db.$as(actor)`; until then the base client is used and
	 * the only rule is that guests do not write.
	 */
	#writeDb(actor: Actor): WorkspaceClient {
		assertNotGuest(actor, 'edit this workspace');
		return this.#db;
	}

	#serialize<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#serial.then(work, work);
		this.#serial = run.catch(() => undefined);
		return run;
	}

	/** A commit and its fan-out, as one unit in the serial queue. */
	async #commit(
		db: WorkspaceClient,
		actorId: string,
		body: Parameters<typeof runCommit>[1]['body'],
		options: { mid?: string; backlinkTargets?: () => readonly string[]; definition?: boolean } = {}
	): Promise<CommitResult> {
		const result = await this.#serialize(async () => {
			const commit = await runCommit(db, { actorId, now: Date.now(), mid: options.mid, body });
			if (!commit.replayed) {
				if (options.definition) invalidateRegistry();
				const info: CommitInfo = {
					seq: commit.seq,
					rows: commit.rows,
					hasChildrenFlips: commit.hasChildrenFlips,
					backlinkTargets: options.backlinkTargets?.()
				};
				try {
					this.#hub.fanOut(info);
				} catch (error) {
					// The commit stands; the live state may not. Drop the registry and ask every socket to
					// reconnect: `hello` with its last seq replays or resnapshots.
					this.#resync(error);
				}
			}
			return commit;
		});
		void this.#armAlarm();
		return result;
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

	/** Prunes the change log (7 days plus a size cap); re-arms itself while the log holds anything. */
	override async alarm(): Promise<void> {
		const result = await this.pruneLog();
		this.#alarmChecked = false;
		if (result.remaining > 0) await this.#armAlarm();
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

	/** Mirrors a D1 membership into `member`: upserts the role and name, or marks the user removed. */
	async syncMember(args: SyncMemberArgs): Promise<void> {
		const removed = args.removed === true || args.role === null;
		const existing = await this.#db.member.findUnique({ where: { userId: args.userId } });
		const role = args.role ?? existing?.role ?? 'guest';
		const name = args.name ?? existing?.name ?? '';
		const removedAt = removed ? new Date() : null;
		await this.#db.member.upsert({
			where: { userId: args.userId },
			create: { userId: args.userId, role, name, removedAt },
			update: { role, name, removedAt }
		});
		for (const socket of this.#transport.sockets()) {
			if (socket.actor.userId !== args.userId) continue;
			if (removed) {
				// The user lost access: close their sockets with FORBIDDEN so they do not reconnect.
				socket.ws.close(CLOSE.FORBIDDEN, 'removed from the workspace');
				continue;
			}
			// The attachment carries the role: refresh it so the open socket sees the change.
			socket.ws.serializeAttachment({ socketId: socket.socketId, actor: { ...socket.actor, role, name } });
		}
		this.#socketCache = null;
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
						records.push(...(await this.#applyOp(tx, op, env)));
					} catch (error) {
						throw withOpPath(error, index);
					}
				}
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

	/** `page.create`: a `create` op with a title. Returns the new page's id, dense number and the commit's seq. */
	async createPage(
		actor: Actor,
		input: PageCreate & { appVersion: string; mid?: string }
	): Promise<{ id: string; num: number; seq: number }> {
		const id = input.id ?? crypto.randomUUID();
		const rank = input.rank ?? rankAfter(this.#lastRank(input.parentId));
		const { seq } = await this.apply(actor, {
			mid: input.mid ?? `create:${id}`,
			appVersion: input.appVersion,
			ops: [
				{
					op: 'create',
					id,
					parentId: input.parentId,
					rank,
					...(input.teamspaceId !== undefined ? { teamspaceId: input.teamspaceId } : {}),
					...(input.icon !== undefined ? { icon: input.icon } : {}),
					...(input.cover !== undefined ? { cover: input.cover } : {}),
					...(input.isDatabase !== undefined ? { isDatabase: input.isDatabase } : {}),
					...(input.values ? { values: input.values } : {})
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
		const row = this.#hub.reader.pageRows([id], stubAccess(actor.role)).get(id);
		if (!row) throw notFound(`Page "${id}"`);
		return row;
	}

	/** Trash roots, newest first, with the number of pages each took along. */
	async listTrash(_actor: Actor, input: TrashListInput) {
		const limit = input.limit ?? 50;
		const offset = input.cursor ? Number(input.cursor) || 0 : 0;
		const order =
			input.sort === 'deleted_asc' ? 'deleted_at ASC' : input.sort === 'title' ? 'title COLLATE NOCASE ASC' : 'deleted_at DESC';
		const like = input.q ? `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
		const rows = this.ctx.storage.sql
			.exec<{
				id: string;
				title: string;
				icon: string | null;
				deleted_at: string;
				deleted_by: string | null;
				parent_id: string | null;
				page_count: number;
			}>(
				`SELECT p.id, p.title, p.icon, p.deleted_at, p.deleted_by, p.parent_id,
				        (SELECT COUNT(*) FROM page c WHERE c.trash_root = p.id) AS page_count
				 FROM page p
				 WHERE p.deleted_at IS NOT NULL AND p.trash_root = p.id
				   ${like ? "AND p.title LIKE ? ESCAPE '\\'" : ''}
				 ORDER BY ${order}, p.id LIMIT ? OFFSET ?`,
				...(like ? [like] : []),
				limit + 1,
				offset
			)
			.toArray();
		const page = rows.slice(0, limit);
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
			nextCursor: rows.length > limit ? String(offset + limit) : null
		};
	}

	/** The workspace's live properties (Databases' `property.list`). */
	async readProperties(_actor: Actor) {
		return readProperties(this.#db);
	}

	/** A collection and its views, or null (Databases' `collection.get`). */
	async readCollection(_actor: Actor, id: string) {
		return readCollection(this.#db, id);
	}

	/** The views of a collection (Databases' `view.list`). */
	async readViews(_actor: Actor, collectionId: string) {
		return readViews(this.#db, collectionId);
	}

	// ───────────────────────── teamspaces ─────────────────────────

	async teamspaces(actor: Actor): Promise<Teamspace[]> {
		return listTeamspaces(this.#db, actor);
	}

	async createTeamspace(actor: Actor, input: TeamspaceInput): Promise<Teamspace> {
		const db = this.#writeDb(actor);
		let id = '';
		await this.#commit(db, actor.userId, async (tx) => {
			const out = await insertTeamspace(tx, actor.userId, input);
			id = out.id;
			return out.records;
		});
		return readTeamspace(this.#db, actor, id);
	}

	async updateTeamspace(actor: Actor, patch: Partial<TeamspaceInput> & { id: string }): Promise<Teamspace> {
		const db = this.#writeDb(actor);
		await this.#commit(db, actor.userId, (tx) => updateTeamspaceRecords(tx, patch));
		return readTeamspace(this.#db, actor, patch.id);
	}

	/** Tombstones the teamspace and all its pages with one shared timestamp. */
	async archiveTeamspace(actor: Actor, id: string): Promise<{ seq: number }> {
		const db = this.#writeDb(actor);
		const { seq } = await this.#commit(db, actor.userId, (tx, env) => archiveTeamspaceRecords(tx, id, env.actorId, env.now));
		return { seq };
	}

	async teamspaceMembers(actor: Actor, teamspaceId: string): Promise<TeamspaceMember[]> {
		return listTeamspaceMembers(this.#db, actor, teamspaceId);
	}

	async addTeamspaceMember(
		actor: Actor,
		input: { teamspaceId: string; userId: string; role?: 'owner' | 'member' }
	): Promise<TeamspaceMember> {
		const db = this.#writeDb(actor);
		let member: TeamspaceMember | undefined;
		await this.#commit(db, actor.userId, async (tx) => {
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
		const db = this.#writeDb(actor);
		let member: TeamspaceMember | undefined;
		await this.#commit(db, actor.userId, async (tx) => {
			const out = await setTeamspaceMemberRoleRecords(tx, input);
			member = out.member;
			return out.records;
		});
		return member as TeamspaceMember;
	}

	async removeTeamspaceMember(actor: Actor, input: { teamspaceId: string; userId: string }): Promise<void> {
		const db = this.#writeDb(actor);
		await this.#commit(db, actor.userId, (tx) => removeTeamspaceMemberRecords(tx, input));
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
				return result.records;
			},
			{ backlinkTargets: () => result?.backlinkTargets ?? [] }
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

	// ───────────────────────── diagnostics ─────────────────────────

	/** Live-loop counters, for tests and operators: shared units, evaluations, sockets with a stream. */
	async liveStats(): Promise<{ units: number; evaluations: number; isolateEvaluations: number; streams: number; head: number; stale: string[] }> {
		return {
			units: this.#hub.unitCount(),
			evaluations: this.#hub.evaluations,
			isolateEvaluations: unitEvaluations(),
			streams: this.#hub.streamSockets().length,
			head: this.#hub.headSeq(),
			stale: this.#hub.staleUnits()
		};
	}
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
