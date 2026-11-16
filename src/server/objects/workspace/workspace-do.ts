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
import { pruneLog, headSeq, LOG_RETENTION_MS, type PruneResult } from './changelog';
import { cancelJob, createJob, getJob, toStatus, updateJob, type Progress } from '../../import/store';
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
	readValues,
	writeComputedValue,
	type ChangeRecord
} from './eav';
import { aiDone, aiFailed, flushAi, markAiPages, prepareAi, readAiMarkers, type AiMarker, type AiPrepare } from './eav/ai';
import { validateFilter, type FilterGroup } from '../../../lib/shared/filter-ast';
import { invalid, notFound, WorkspaceError } from './errors';
import { accessTo } from './governed';
import type { IngestResult } from './ingest';
import { LiveHub, fanOutPerf, resetFanOutPerf, unitEvaluations, type CommitInfo } from './live';
import { OptionIndex, type Drift } from '../../bitmaps/option-index';
import { ensureRoaring, setRoaringEnabled } from '../../bitmaps/roaring';
import { syncOptionIndex } from './option-sync';
import { COALESCABLE_KINDS, LoadGovernor, mergeCommits } from './governor';
import { QUOTA_WARN_RATIO, storageLevel } from '../../limits';
import { applyRawSteps, migrateWorkspace, migrationFlags } from './migrations';
import { applyPageOp, isPageOp } from './page-ops';
import { Presence } from './presence';
import {
	ACTOR_HEADER,
	AttachmentTooLargeError,
	assertAttachmentSize,
	decodeActorHeader,
	HibernatableSocketTransport,
	type SocketHandle
} from './socket';
import { RemoteSocket, ShardRouter, type ShardStub } from './shard-router';
import { coloOf, SHARD_ATTACHMENT_HEADER, shardName, type ShardAttachment } from './socket-shard';
import { RAW_STREAM, WorkspaceSocketApi } from './socket-api';
import { SocketDirectory } from './socket-directory';
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
import type { ExportReadDeps } from './export-read';
import type { SsrRead, SsrRequest } from './ssr-read';
import type { SeedWindow } from '../../../lib/shared/seed';
import { queryViewRows, type QueryViewInput, type QueryViewResult } from '../../engine/view';
import { revokeGrantRecords, setGrantRecords, toGrant, type GrantInput } from './grants';
import { syncRooms, type RoomStub } from './room-sync';
import { chunks } from './util';
import { planPurge, purgePageRows, purgeTeamspaceRows, purgeableTeamspaces, TRASH_RETENTION_MS, type PurgedPage } from './purge';
import type { Grant } from '../../../lib/shared/schemas';
import { ensureFilesTable, normalizeLevel, type PageLevel } from './files-base';
import type { BeginInput, FilesContext } from './files';
import { APP_VERSION_HEADER, APP_VERSION_PARAM, registryScopesOf, type Notification } from '../../../lib/shared/protocol';
import { reindexAll as reindexSearch } from '../../search/index-writes';
import type { EmbedPlan, PageChunks } from '../../search/embed-store';
import type { EmbedResult } from '../../search/embed';
import type { QuickFindInput, QuickFindResult, SearchInput, SearchResult } from '../../search/query';
import { ensureSearchTables } from '../../search/tables';
import type { Passage } from '../../ai/ask';
import { abandonIdempotent, beginIdempotent, ensureIdempotencyTable, finishIdempotent, type IdempotencyBegin } from './idempotency';
import { metric, since } from '../../metrics';
import type { BackupHeader, ExportBatch, ExportCursor, PitrStorage } from './backup';

// Rarely used parts are imported by the first call that needs them, not by every wake (docs/ops/load-test.md "Start-up": a cold wake
// pays about 75 ms per MB it evaluates): files, backup and import, export, ingestion and mentions, search, embeddings and Ask AI.
const filesLib = () => import('./files');
const backupLib = () => import('./backup');

type TrashListInput = v.InferOutput<typeof trashListInputSchema>;

export interface InitArgs {
	workspaceId: string;
	name: string;
	ownerId: string;
	ownerName: string;
	/** Where the object was asked to be created (`location.ts`): kept so the shards of its sockets are placed in the same region. */
	locationHint?: string;
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

/** Sockets the Workspace DO holds itself before it hands new ones to shards (`SOCKET_SHARDS`): small workspaces never leave it. */
const DEFAULT_LOCAL_SOCKETS = 48;
const MAX_SHARDS = 16;
/** Value-only commits queued behind each other that one transaction and one fan-out take (see `WorkspaceDO.#drainCommits`). */
const MAX_COMMIT_GROUP = 32;
/** Commits closer together than this (ms) are a stream: the drain then yields once so that commits waiting at the object's door join its group. */
const STREAM_GAP_MS = 100;

interface QueuedCommit {
	db: WorkspaceClient;
	actorId: string;
	body: Parameters<typeof runCommit>[1]['body'];
	options: { mid?: string; backlinkTargets?: () => readonly string[]; definition?: boolean; groupable?: boolean };
	startedAt: number;
	resolve(commit: CommitResult): void;
	reject(error: unknown): void;
	roomWork: { scope: CommitAccess; changes: ReturnType<AccessService['changedActors']> } | null;
	closeTrashedRooms: boolean;
}
const SHARD_SETTING = 'socket_shards';

/** Protocol frames start with a string `t`; oRPC's have a numeric one. */
const PROTOCOL_FRAME = /^\s*\{\s*"t"\s*:\s*"/;
/** Protocol frames that read no live unit: they run in the queue but do not make it send held fan-outs first. */
const QUIET_FRAME = /^\s*\{\s*"t"\s*:\s*"(?:ping|presence|unsubscribe|notifications\.read)"/;



const META_INITIALIZED = 'initialized';
const META_WORKSPACE = 'workspace';
const META_LOCATION_HINT = 'location_hint';

export class WorkspaceDO extends DurableObject<Env> {
	/** Number of instances constructed in this isolate: tests use it to prove a re-create after eviction. */
	static constructed = 0;
	/** Per-instance, in memory only: changes whenever the object is evicted and woken again. */
	readonly instanceId = crypto.randomUUID();

	readonly #db: WorkspaceClient;
	readonly #access: AccessService;
	readonly #hub: LiveHub;
	readonly #presence = new Presence();
	/** Roaring bitmaps per (select, status, multi-select, person property) option: filters read them (docs/spikes/p4-scale.md). */
	readonly #options = new OptionIndex();
	readonly #api: WorkspaceSocketApi;
	readonly #transport: HibernatableSocketTransport<SocketContext, WorkspaceSocketActor>;
	/** Decides when the object counts as overloaded, and what that changes (docs/PLAN.md runbook "Workspace DO overloaded"). */
	readonly #governor = new LoadGovernor();
	/** Tabs that said they are hidden, those the fan-out skipped since (they get snapshots when visible), and those seen this wake. */
	readonly #hidden = new Set<string>();
	readonly #stale = new Set<string>();
	readonly #known = new Set<string>();
	/** Value-only commits whose fan-out waits to be merged with the next (overload only), and how many were merged since the wake. */
	#pendingFanOut: CommitInfo[] = [];
	#merged = 0;
	/** `destroy()` ran: the storage is empty and the sockets are closing. */
	#destroyed = false;
	/** Tasks in the serial queue, the running one included. */
	#queued = 0;
	/** Commits (and their fan-out) run one at a time, so `seq` order is also delivery order. */
	#serial: Promise<unknown> = Promise.resolve();
	#alarmChecked = false;
	/** Lifts the commit-queue hold of a running backup (null when none is running). */
	#backupRelease: (() => void) | null = null;
	/** Live sockets with their actors, read from the attachments once per wake (see `socket-directory.ts`). */
	#directory: SocketDirectory<WorkspaceSocketActor> | null = null;
	/** Sockets held by shards (`socket-shard.ts`), by socket id; the `shard_socket` table is their record across hibernation. */
	readonly #remotes = new Map<string, RemoteSocket>();
	#remotesLoaded = false;
	readonly #router: ShardRouter;
	/** Sockets per shard (for placing the next one). */
	readonly #shardCounts: number[] = [];
	#placement: { count: number; localMax: number } | null = null;
	#hint: DurableObjectLocationHint | null | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		WorkspaceDO.constructed++;
		ensureFilesTable(ctx.storage.sql);
		ensureIdempotencyTable(ctx.storage.sql);
		ensureSearchTables(ctx.storage.sql);
		this.#db = createWorkspaceClient(ctx.storage);
		this.#access = new AccessService({ db: this.#db, sql: ctx.storage.sql });
		// Raw steps, the viborm estate and the EAV layout, before any request or socket message is served.
		void ctx.blockConcurrencyWhile(async () => {
			await migrateWorkspace(ctx, this.#db, await migrationFlags(ctx.storage, env, ctx.id.name));
			ensureEavLayout(ctx.storage);
			// Bitmaps are an accelerator: without the WASM module (or with `BITMAPS=off`) the engine keeps its SQL paths.
			if (env.BITMAPS === 'off') setRoaringEnabled(false);
			await ensureRoaring();
		});
		this.#router = new ShardRouter({
			stubOf: (index) => this.#shardStub(index) as unknown as ShardStub,
			onDead: (_index, ids) => this.#remotesGone(ids),
			onFailure: (index, error) => this.#shardFailed(index, error)
		});
		this.#hub = new LiveHub({
			sql: ctx.storage.sql,
			db: this.#db,
			now: () => Date.now(),
			send: (socketId, message) => this.#send(socketId, message),
			actorOf: (socketId) => this.#socket(socketId)?.actor ?? null,
			view: (actor) => this.#access.view(actor),
			bitmaps: this.#options,
			memory: env.MEMBERSHIP_CACHE !== 'off',
			// A hidden tab of an overloaded object is not served; it is resynchronized when it shows again.
			paused: (socketId) => this.#governor.overloaded && this.#hidden.has(socketId),
			skipped: (socketId) => void this.#stale.add(socketId)
		});
		this.#api = new WorkspaceSocketApi({
			env,
			hub: this.#hub,
			presence: this.#presence,
			send: (socketId, message) => this.#send(socketId, message),
			streams: () => this.#hub.streamSockets(),
			now: () => Date.now(),
			checkView: (sub) => this.#checkView(sub),
			serialize: (work) => this.#serializeFlushed(work)
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

	#sockets(): SocketDirectory<WorkspaceSocketActor> {
		if (this.#directory) return this.#directory;
		this.#loadRemotes();
		const remote = [...this.#remotes.values()].map((r) => ({ ws: r as unknown as WebSocket, socketId: r.socketId, actor: r.deserializeAttachment().actor as unknown as WorkspaceSocketActor }));
		return (this.#directory = new SocketDirectory([...this.#transport.sockets(), ...remote]));
	}

	// ───────────────────────── socket shards ─────────────────────────

	/** Shard `index` of this workspace, created next to the object (the hint the workspace was created with) the first time it is reached. */
	#shardStub(index: number): DurableObjectStub<import('./socket-shard').SocketShardDO> {
		const name = shardName(this.ctx.id.name ?? '', index);
		this.#hint ??= this.#readHint();
		return this.#hint ? this.env.SOCKET_SHARD.getByName(name, { locationHint: this.#hint }) : this.env.SOCKET_SHARD.getByName(name);
	}

	#readHint(): DurableObjectLocationHint | null {
		const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', META_LOCATION_HINT).toArray()[0];
		try {
			return row ? (JSON.parse(row.value) as DurableObjectLocationHint) : null;
		} catch {
			return null;
		}
	}

	/** The remote sockets recorded before this wake (the table is created the first time it is needed). */
	#loadRemotes(): void {
		if (this.#remotesLoaded) return;
		this.#remotesLoaded = true;
		const sql = this.ctx.storage.sql;
		sql.exec('CREATE TABLE IF NOT EXISTS shard_socket (socket_id TEXT PRIMARY KEY, shard INTEGER NOT NULL, actor TEXT NOT NULL) WITHOUT ROWID');
		for (const row of sql.exec<{ socket_id: string; shard: number; actor: string }>('SELECT socket_id, shard, actor FROM shard_socket').toArray()) {
			if (this.#remotes.has(row.socket_id)) continue;
			try {
				this.#remotes.set(row.socket_id, this.#remoteSocket(row.shard, { socketId: row.socket_id, shard: row.shard, actor: JSON.parse(row.actor) }));
				this.#shardCounts[row.shard] = (this.#shardCounts[row.shard] ?? 0) + 1;
			} catch {
				sql.exec('DELETE FROM shard_socket WHERE socket_id = ?', row.socket_id);
			}
		}
	}

	#remoteSocket(shard: number, attachment: ShardAttachment): RemoteSocket {
		return new RemoteSocket(this.#router, shard, attachment, (value) => {
			this.ctx.storage.sql.exec('UPDATE shard_socket SET actor = ? WHERE socket_id = ?', JSON.stringify((value as ShardAttachment).actor), attachment.socketId);
		});
	}

	/** Where new sockets go: the shard count and how many sockets the object keeps for itself (the env vars, or a setting stored by `configureShards`). */
	#shardPlacement(): { count: number; localMax: number } {
		if (this.#placement) return this.#placement;
		const vars = this.env as { SOCKET_SHARDS?: string; SOCKET_LOCAL_MAX?: string };
		let count = Number(vars.SOCKET_SHARDS ?? 0);
		let localMax = Number(vars.SOCKET_LOCAL_MAX ?? DEFAULT_LOCAL_SOCKETS);
		if (this.env.SOCKET_SHARD) {
			const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', SHARD_SETTING).toArray()[0];
			if (row) {
				try {
					const setting = JSON.parse(row.value) as { count?: number; localMax?: number };
					if (typeof setting.count === 'number') count = setting.count;
					if (typeof setting.localMax === 'number') localMax = setting.localMax;
				} catch {
					// a malformed setting is ignored
				}
			}
		} else count = 0;
		return (this.#placement = { count: Number.isFinite(count) ? Math.max(0, Math.min(MAX_SHARDS, Math.floor(count))) : 0, localMax: Number.isFinite(localMax) ? Math.max(0, localMax) : DEFAULT_LOCAL_SOCKETS });
	}

	/** Diagnostics for the load tool: sends `{ t: 'head', seq }` to every tab with a stream, as a fan-out does (no commit, no derivation). */
	async diagEcho(seq: number): Promise<number> {
		const head: ServerMessage = { t: 'head', seq };
		let n = 0;
		for (const socketId of this.#hub.streamSockets()) if (this.#send(socketId, head)) n++;
		return n;
	}

	/** Calls of `diagTxn` running right now, and the most there were at once. */
	#diagInflight = 0;
	#diagPeak = 0;

	/**
	 * Diagnostics for the load tool (docs/ops/load-test.md "Fourth pass"): `n` writes to a scratch `meta` row, each in the given kind of
	 * transaction, and how long each took from this object's side (`async`: `storage.transaction`, what every commit does; `sync`:
	 * `transactionSync`; `sync+wait`: `transactionSync` then `storage.sync()`, i.e. until the write is durable), plus the most calls of
	 * this method that were inside the object at once. It shows whether a commit holds the object's input while its write is confirmed.
	 */
	async diagTxn(mode: 'async' | 'sync' | 'sync+wait', n: number): Promise<{ ms: number[]; peak: number }> {
		this.#diagInflight++;
		this.#diagPeak = Math.max(this.#diagPeak, this.#diagInflight);
		const sql = this.ctx.storage.sql;
		const write = (i: number) => sql.exec("INSERT INTO meta (key, value) VALUES ('diag', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(i));
		const ms: number[] = [];
		try {
			for (let i = 0; i < n; i++) {
				const t = Date.now();
				if (mode === 'async') await this.ctx.storage.transaction(async () => void write(i));
				else {
					this.ctx.storage.transactionSync(() => void write(i));
					if (mode === 'sync+wait') await this.ctx.storage.sync();
				}
				ms.push(Date.now() - t);
			}
			return { ms, peak: this.#diagPeak };
		} finally {
			this.#diagInflight--;
			if (this.#diagInflight === 0) this.#diagPeak = 0;
		}
	}

	/** Diagnostics: where the object and its shards run, and how many sockets and batches each holds. */
	async shardStats(): Promise<{ colo: string; hint: string | null; shards: { sockets: number; pushes: number; colo: string }[] }> {
		const count = Math.max(this.#shardCounts.length, this.#shardPlacement().count);
		const shards = await Promise.all(Array.from({ length: count }, (_, i) => this.#shardStub(i).stats()));
		this.#hint ??= this.#readHint();
		return { colo: await coloOf(), hint: this.#hint ?? null, shards };
	}

	/** Operators and tests: how many shards take new sockets and how many the object keeps (`null`: back to the environment's values). Applies to sockets opened after. */
	async configureShards(setting: { count: number; localMax?: number } | null): Promise<void> {
		const sql = this.ctx.storage.sql;
		if (setting === null) sql.exec('DELETE FROM meta WHERE key = ?', SHARD_SETTING);
		else sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SHARD_SETTING, JSON.stringify({ count: setting.count, localMax: setting.localMax ?? 0 }));
		this.#placement = null;
	}

	/** Hands an upgrade to the least loaded shard and keeps a record of the socket it accepts. */
	async #acceptRemote(actor: WorkspaceSocketActor, count: number): Promise<Response> {
		this.#sockets();
		let shard = 0;
		for (let i = 1; i < count; i++) if ((this.#shardCounts[i] ?? 0) < (this.#shardCounts[shard] ?? 0)) shard = i;
		const attachment: ShardAttachment = { socketId: crypto.randomUUID(), shard, actor: actor as unknown as ShardAttachment['actor'] };
		assertAttachmentSize(attachment);
		// The place is taken before the call: dials that arrive together must not all pick the same shard.
		this.#shardCounts[shard] = (this.#shardCounts[shard] ?? 0) + 1;
		let response: Response;
		try {
			response = await this.#shardStub(shard).fetch('https://shard.internal/', {
				headers: { Upgrade: 'websocket', [SHARD_ATTACHMENT_HEADER]: encodeURIComponent(JSON.stringify(attachment)) }
			});
		} catch (error) {
			this.#shardCounts[shard]--;
			throw error;
		}
		if (response.status !== 101) {
			this.#shardCounts[shard]--;
			return response;
		}
		const remote = this.#remoteSocket(shard, attachment);
		this.#remotes.set(attachment.socketId, remote);
		if (String(this.env.ENVIRONMENT) === 'development') console.debug(`[workspace] socket ${attachment.socketId.slice(0, 8)} is held by shard ${shard}`);
		this.ctx.storage.sql.exec('INSERT OR REPLACE INTO shard_socket (socket_id, shard, actor) VALUES (?, ?, ?)', attachment.socketId, shard, JSON.stringify(actor));
		this.#sockets().add({ ws: remote as unknown as WebSocket, socketId: attachment.socketId, actor });
		// Which shard holds the socket, for whoever looks at the 101 (the load tool groups its latencies by it).
		return new Response(null, { status: 101, webSocket: response.webSocket, headers: { 'x-flarion-shard': String(shard) } });
	}

	#dropRemote(socketId: string): void {
		const remote = this.#remotes.get(socketId);
		if (!remote) return;
		remote.gone = true;
		this.#remotes.delete(socketId);
		this.#shardCounts[remote.shard] = Math.max(0, (this.#shardCounts[remote.shard] ?? 1) - 1);
		this.ctx.storage.sql.exec('DELETE FROM shard_socket WHERE socket_id = ?', socketId);
	}

	/** A client frame, forwarded by the shard that holds the socket: handled as if the socket were this object's own. */
	async shardFrame(shard: number, attachment: ShardAttachment, data: string | ArrayBuffer): Promise<void> {
		if (this.#destroyed) return;
		this.#sockets();
		let remote = this.#remotes.get(attachment.socketId);
		if (!remote) {
			// The object lost its record (or never had it): the frame carries the identity.
			remote = this.#remoteSocket(shard, attachment);
			this.#remotes.set(attachment.socketId, remote);
			this.#shardCounts[shard] = (this.#shardCounts[shard] ?? 0) + 1;
			this.ctx.storage.sql.exec('INSERT OR REPLACE INTO shard_socket (socket_id, shard, actor) VALUES (?, ?, ?)', attachment.socketId, shard, JSON.stringify(attachment.actor));
			this.#sockets().add({ ws: remote as unknown as WebSocket, socketId: attachment.socketId, actor: attachment.actor as unknown as WorkspaceSocketActor });
		}
		return this.webSocketMessage(remote as unknown as WebSocket, data);
	}

	/** The shard says a socket closed. */
	async shardClosed(shard: number, attachment: ShardAttachment, code: number, reason: string): Promise<void> {
		this.#sockets();
		const remote = this.#remotes.get(attachment.socketId) ?? new RemoteSocket(this.#router, shard, attachment);
		remote.gone = true;
		this.webSocketClose(remote as unknown as WebSocket, code, reason);
		this.#dropRemote(attachment.socketId);
	}

	/** Sockets a shard could not reach: closed there. */
	#remotesGone(ids: readonly string[]): void {
		for (const id of ids) {
			const remote = this.#remotes.get(id);
			if (!remote) continue;
			remote.gone = true;
			this.webSocketClose(remote as unknown as WebSocket, 1006, 'gone');
			this.#dropRemote(id);
		}
	}

	/** A batch did not reach its shard: what the shard held cannot be served by this object any more, so its sockets are told to reconnect. */
	#shardFailed(index: number, error: unknown): void {
		console.error(`[workspace] shard ${index} failed, its sockets reconnect:`, error instanceof Error ? (error.stack ?? error.message) : error);
		this.#router.reset(index);
		const ids = [...this.#remotes.values()].filter((r) => r.shard === index).map((r) => r.socketId);
		void Promise.resolve((this.#shardStub(index) as unknown as ShardStub).closeAll?.(CLOSE.TRY_AGAIN, 'resync')).catch(() => undefined);
		this.#remotesGone(ids);
	}

	/** A live socket by id (a fan-out looks up every socket: no attachment is read for it). */
	#socket(socketId: string): SocketHandle<WorkspaceSocketActor> | null {
		return this.#sockets().get(socketId);
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
		let actor = decodeActorHeader<WorkspaceSocketActor>(request.headers.get(ACTOR_HEADER));
		if (!actor) return new Response('Missing actor', { status: 401 });
		if (!actor.role) {
			// The Worker leaves the role out: it is the member mirror's (a Durable Object call of its own less on every dial).
			const role = this.#access.memberRole(actor.userId);
			if (!role) return new Response('Not a member', { status: 403 });
			actor = { ...actor, role };
		}
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
			const placement = this.#shardPlacement();
			if (placement.count > 0 && this.#sockets().size - this.#remotes.size >= placement.localMax) return await this.#acceptRemote(actor, placement.count);
			const accepted = this.#transport.acceptSocket(actor);
			this.#sockets().add(accepted.handle);
			return accepted.response;
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
		// A frame that reads no live unit (a ping, presence, a hidden flag, an unsubscribe) does not need the held fan-outs sent first,
		// and 1,000 tabs pinging would otherwise cut every hold short.
		if (typeof message === 'string' && PROTOCOL_FRAME.test(message)) {
			const run = () => this.#protocolFrame(ws, message);
			return QUIET_FRAME.test(message) ? this.#serialize(run) : this.#serializeFlushed(run);
		}
		return this.#serializeFlushed(() => this.#transport.message(ws, message));
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
					await this.#api.hello(socket, RAW_STREAM, message);
					this.#known.add(socket.socketId);
					this.#stale.delete(socket.socketId);
					this.#hidden.delete(socket.socketId);
					return await this.#sendQuotas(socket);
				case 'visibility':
					return await this.#visibility(socket, message.hidden);
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
		// After `destroy()` the registry tables are gone with the rest of the storage: nothing is left to forget.
		if (this.#destroyed) return;
		this.#forgetSocket(ws);
		this.#transport.close(ws, code, reason);
	}

	override webSocketError(ws: WebSocket): void {
		if (this.#destroyed) return;
		this.#forgetSocket(ws);
		this.#transport.close(ws, 1011, 'socket error');
	}

	#forgetSocket(ws: WebSocket): void {
		const socket = this.#transport.handle(ws);
		if (!socket) return;
		this.#directory?.remove(socket.socketId);
		this.#dropRemote(socket.socketId);
		this.#hidden.delete(socket.socketId);
		this.#stale.delete(socket.socketId);
		this.#known.delete(socket.socketId);
	}

	/**
	 * A tab says it is hidden or visible again. Hidden tabs of an overloaded object are not served (the fan-out skips
	 * them and marks them stale); a tab that missed anything, or that this object woke up holding, gets `resumed` and a
	 * fresh snapshot of every subscription when it shows again.
	 */
	async #visibility(socket: SocketHandle<WorkspaceSocketActor>, hidden: boolean): Promise<void> {
		const id = socket.socketId;
		if (hidden) {
			this.#hidden.add(id);
			return;
		}
		this.#hidden.delete(id);
		if (this.#stale.delete(id) || !this.#known.has(id)) {
			this.#known.add(id);
			await this.#api.resync(socket);
		}
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
		this.#queued++;
		const counted = async (): Promise<T> => {
			try {
				return await work();
			} finally {
				this.#queued--;
				// The last task out sends the fan-out of the commits that were merged behind it.
				if (this.#queued === 0) await this.#flushFanOut();
			}
		};
		const run = this.#serial.then(counted, counted);
		this.#serial = run.catch(() => undefined);
		return run;
	}

	/**
	 * A socket message in the queue: the fan-outs held back for merging are sent first. A tab that says `hello` or `window` reads the
	 * live units, which a held-back commit has not reached yet: it would get a snapshot older than the `seq` it is told, and then
	 * the held-back diff as a "stale" frame.
	 */
	#serializeFlushed<T>(work: () => Promise<T>): Promise<T> {
		return this.#serialize(async () => {
			await this.#flushFanOut();
			return work();
		});
	}

	/** The merged fan-out of value-only commits that waited behind other work (see `LoadGovernor`). */
	async #flushFanOut(): Promise<void> {
		if (this.#pendingFanOut.length === 0) return;
		const merged = mergeCommits(this.#pendingFanOut);
		this.#pendingFanOut = [];
		try {
			await this.#hub.fanOut(merged);
		} catch (error) {
			this.#resync(error);
		}
	}

	/** Commits waiting for the serial queue, in arrival order (see `#drainCommits`). */
	readonly #commitQueue: QueuedCommit[] = [];
	#drainScheduled = false;
	#lastCommitAt = 0;
	#streaming = false;
	/** Group sizes since the wake (diagnostics): commits run, groups run, the largest group. */
	#groupStats = { commits: 0, groups: 0, largest: 0 };

	/**
	 * A commit and its fan-out, as one unit in the serial queue (several, when value-only commits are queued behind each other:
	 * `#drainCommits` runs them in one transaction, each with its own `seq`, `mid` and change rows, and one merged fan-out). Between
	 * the commit and the fan-out, the actors' visibility sets are brought up to date (`noteCommit` marks what the commit invalidates,
	 * `settle` recomputes it for the connected sockets' actors), so the fan-out ANDs every window with the sets as they are after the
	 * commit and knows the pages that entered or left each of them. Access changes then reach the open rooms.
	 */
	async #commit(
		db: WorkspaceClient,
		actorId: string,
		body: Parameters<typeof runCommit>[1]['body'],
		options: { mid?: string; backlinkTargets?: () => readonly string[]; definition?: boolean; groupable?: boolean } = {}
	): Promise<CommitResult> {
		const entry = { db, actorId, body, options, startedAt: Date.now(), roomWork: null, closeTrashedRooms: false } as unknown as QueuedCommit;
		const done = new Promise<CommitResult>((resolve, reject) => {
			entry.resolve = resolve;
			entry.reject = reject;
		});
		// Writes arriving less than 100 ms apart are a stream (a load, a script, several people): see the yield in `#drainCommits`.
		this.#streaming = entry.startedAt - this.#lastCommitAt < STREAM_GAP_MS;
		this.#lastCommitAt = entry.startedAt;
		this.#commitQueue.push(entry);
		this.#scheduleDrain();
		const result = await done;
		// Trashing a page closes its room: open tabs show "This page was moved to Trash" (docs/PLAN.md).
		if (entry.closeTrashedRooms) await this.#closeTrashedRooms();
		if (entry.roomWork) await this.#syncRooms(entry.roomWork.scope, entry.roomWork.changes);
		void this.#armAlarm();
		// AI properties the commit made due go to the queue (a no-op without any AI property).
		await this.#flushAi();
		return result;
	}

	#scheduleDrain(): void {
		if (this.#drainScheduled || this.#commitQueue.length === 0) return;
		this.#drainScheduled = true;
		// The answers go out once the task is over: when it was the last of the queue, `#serialize` has then sent the fan-outs held back.
		void this.#serialize(() => this.#drainCommits()).then((answers) => answers.forEach((answer) => answer()), () => undefined);
	}

	/**
	 * Runs the commit at the head of the queue, and the value-only commits queued right behind it, in one transaction: a savepoint
	 * per commit (one that fails is rolled back alone and answered with its error), so every mutation keeps its own `seq`, its
	 * `mid` row and an exact change log. What the group shares is the transaction's begin and end, the registry read, the option
	 * index, visibility and fan-out work: the commits' fan-outs are merged into one frame per socket (`mergeCommits`), tagged with
	 * the last `seq`, and the client drops its optimistic layer on its own `seq` (any frame at or past it stands for it).
	 */
	async #drainCommits(): Promise<(() => void)[]> {
		// A commit is one synchronous turn of this object, so a write never finds another waiting inside the object: the ones that arrived
		// while the thread was busy are still at its door, and they are delivered (and queue their commits here) only when this turn ends.
		// Yielding once, before the group is taken, lets them in: on a slow host that is what turns a backlog of single commits into a
		// group with one fan-out (docs/ops/load-test.md "Fourth pass"). A lone write (nothing within the last 100 ms) does not wait.
		if (this.#streaming) await new Promise<void>((resolve) => setTimeout(resolve, 0));
		this.#drainScheduled = false;
		const first = this.#commitQueue.shift();
		if (!first) return [];
		const answers: (() => void)[] = [];
		const group = [first];
		if (first.options.groupable) while (group.length < MAX_COMMIT_GROUP && this.#commitQueue[0]?.options.groupable) group.push(this.#commitQueue.shift()!);
		// Whatever is left runs in the next task.
		this.#scheduleDrain();
		const committed: { entry: QueuedCommit; commit: CommitResult }[] = [];
		const attempt = async (entry: QueuedCommit): Promise<void> => {
			try {
				committed.push({ entry, commit: await runCommit(entry.db, { actorId: entry.actorId, now: Date.now(), mid: entry.options.mid, body: entry.body }) });
			} catch (error) {
				entry.reject(mapPolicyError(error));
			}
		};
		try {
			if (group.length === 1) await attempt(first);
			else
				await this.ctx.storage.transaction(async () => {
					for (const [index, entry] of group.entries()) {
						await attempt(entry);
						// A commit that wrote more than property values, or nothing at all (a write that changed no value), is the last of its group: the
						// fan-outs of the commits before it are merged into its own, which must see the data as it stands right after it and
						// no later commit (a unit's order is maintained against the stored tuples of the pages it did not re-place).
						const last = committed[committed.length - 1];
						if (last?.entry === entry && !last.commit.replayed && !(last.commit.rows.length > 0 && last.commit.rows.every((r) => COALESCABLE_KINDS.has(r.kind)))) {
							const rest = group.splice(index + 1);
							this.#commitQueue.unshift(...rest);
							break;
						}
					}
				});
			this.#scheduleDrain();
		} catch (error) {
			// The shared transaction itself failed (not one commit): nothing of the group stands.
			for (const { entry } of committed) entry.reject(error);
			for (const entry of group) entry.reject(error);
			committed.length = 0;
		}
		if (group.length > 1) {
			this.#groupStats.groups++;
			this.#groupStats.largest = Math.max(this.#groupStats.largest, group.length);
		}
		this.#groupStats.commits += group.length;
		for (const [index, { entry, commit }] of committed.entries()) {
			if (commit.replayed) {
				answers.push(() => entry.resolve(commit));
				continue;
			}
			try {
				await this.#afterCommit(entry, commit, index < committed.length - 1);
				answers.push(() => entry.resolve(commit));
			} catch (error) {
				answers.push(() => entry.reject(error));
			}
		}
		return answers;
	}

	/** What follows a commit that stands: the option index, visibility, the fan-out (or its merge with the next), registry and room pushes. */
	async #afterCommit(entry: QueuedCommit, commit: CommitResult, moreInGroup: boolean): Promise<void> {
		const { options, actorId } = entry;
		if (options.definition) invalidateRegistry();
		try {
			await syncOptionIndex(this.#options, this.#db, commit.rows, this.#hub.reader);
		} catch (error) {
			// The index is an accelerator: whatever went wrong, it is rebuilt from `p_ref` when a filter next reads it.
			console.warn('[workspace] option index refresh failed, rebuilding on demand:', error instanceof Error ? error.message : error);
			this.#options.invalidateAll();
		}
		const access = this.#access.noteCommit(commit.rows);
		try {
			const directory = this.#sockets();
			const { cold } = await this.#access.settle(directory.actors());
			if (access.affecting && cold.size > 0) {
				// A socket whose visibility set was lost (the object slept) cannot be diffed: it reconnects.
				for (const socket of directory.all()) {
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
			backlinkTargets: options.backlinkTargets?.(),
			actorIds: [actorId]
		};
		// More work waiting behind this commit and it only wrote property values: its fan-out is merged with the next
		// one (a socket gets one diff for several commits, tagged with the last `seq`), whether the object is overloaded
		// or just busy: writes that cluster cost one derivation and one frame per socket instead of several, which is what
		// keeps the queue short at 1,000 tabs. The writes are all committed and answered; only the pushes are shared. The
		// last task of the queue sends what was held back.
		const mergeable = (moreInGroup || this.#queued > 1) && !options.definition && commit.rows.length > 0 && commit.rows.every((r) => COALESCABLE_KINDS.has(r.kind));
		if (mergeable) {
			this.#pendingFanOut.push(info);
			this.#merged++;
		} else {
			const pending = this.#pendingFanOut;
			this.#pendingFanOut = [];
			try {
				await this.#hub.fanOut(pending.length ? mergeCommits([...pending, info]) : info);
			} catch (error) {
				// The commit stands; the live state may not. Drop the registry and ask every socket to
				// reconnect: `hello` with its last seq replays or resnapshots.
				this.#resync(error);
			}
		}
		// Definitions held outside any subscription (property registry, teamspace and member directory).
		this.#api.broadcastRegistry(registryScopesOf(commit.rows.map((row) => row.kind)), commit.seq);
		if (commit.rows.some((row) => row.kind === 'trash' || row.kind === 'archiveTeamspace')) entry.closeTrashedRooms = true;
		if (access.affecting) entry.roomWork = { scope: access, changes: this.#access.changedActors() };
		this.#access.clearDeltas();
		// Edit to diff: from the start of the commit to the last diff sent (docs/PLAN.md "Operating targets").
		const elapsed = since(entry.startedAt);
		metric(this.env, 'mutation', { labels: ['ok'], value: elapsed, extra: [commit.rows.length] });
		metric(this.env, 'fanout', { value: this.#hub.streamCount(), extra: [elapsed, commit.rows.length] });
		if (this.#governor.record(elapsed, this.#queued - 1) && this.#governor.shouldAlert()) {
			const workspaceId = this.ctx.id.name ?? '';
			console.error(`[workspace] ${workspaceId} is overloaded: commit and fan-out average ${Math.round(this.#governor.average)} ms, ${this.#queued - 1} tasks waiting. Hidden tabs are skipped and value-only commits share fan-outs until it clears.`);
			metric(this.env, 'error', { labels: ['overload', workspaceId], value: 1, extra: [this.#governor.average] });
		}
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
		for (const socket of this.#sockets().all()) {
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
		this.#gauges();
		const result = await this.pruneLog();
		try {
			await this.hourly();
		} catch (error) {
			console.error('[workspace] hourly recompute failed:', error instanceof Error ? (error.stack ?? error.message) : error);
		}
		this.#alarmChecked = false;
		// A big object keeps its hourly gauge (and the storage alert) even when nothing else needs the alarm.
		if (result.remaining > 0 || this.#readsClock() || storageLevel(this.ctx.storage.sql.databaseSize) !== 'ok') await this.#armAlarm();
	}

	/** Storage and live-loop gauges (Analytics Engine), once an hour per active object: the "Workspace DO storage" target. */
	#gauges(): void {
		try {
			const workspaceId = this.ctx.id.name ?? '';
			const bytes = this.ctx.storage.sql.databaseSize;
			metric(this.env, 'storage', { labels: [workspaceId], value: bytes });
			if (storageLevel(bytes) === 'alert') {
				// "Alert at 5 GB" (docs/PLAN.md "Performance, limits and scaling"): the SLO alert reads the `storage` gauge, this line and an
				// `error` point make it impossible to miss. The limit is 10 GB; past 5, shard by type (docs/spikes/p4-scale.md).
				console.error(`[workspace] ${workspaceId} holds ${(bytes / 1024 ** 3).toFixed(2)} GB of SQLite storage (alert at 5 GB, limit 10 GB)`);
				metric(this.env, 'error', { labels: ['storage-alert', workspaceId], value: 1, extra: [bytes] });
			}
			metric(this.env, 'subs', {
				labels: [workspaceId],
				value: this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM socket_sub').one().n,
				extra: [this.#hub.unitCount(), this.#hub.streamSockets().length]
			});
		} catch (error) {
			console.warn('[workspace] gauges failed:', error instanceof Error ? error.message : error);
		}
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
		if (args.locationHint) this.ctx.storage.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', META_LOCATION_HINT, JSON.stringify(args.locationHint));
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
			this.#access.forgetMembers();
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
		const upsert = async (db: WorkspaceDb) => {
			const written = await db.member.upsert({
				where: { userId: args.userId },
				create: { userId: args.userId, role, name, removedAt },
				update: { role, name, removedAt }
			});
			// The role mirror is read by every write before it is queued: forget it the moment the table changes.
			this.#access.forgetMembers();
			return written;
		};
		if (removed) {
			// The user lost access: close their sockets with FORBIDDEN so they do not reconnect.
			for (const socket of this.#sockets().all()) {
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
		for (const socket of this.#sockets().all()) {
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
		this.#directory = null;
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
			{ mid: batch.mid, definition: ops.some(isDefinitionOp), groupable: ops.every((op) => op.op === 'setProp') }
		);
		return { seq: result.seq };
	}

	#applyOp(tx: Parameters<typeof applyPageOp>[0], op: Op, env: Parameters<typeof applyPageOp>[2]): Promise<ChangeRecord[]> {
		if (isPageOp(op)) return applyPageOp(tx, op, env);
		if (isEavOp(op)) return applyEavOp(tx, op, { actorId: env.actorId, now: env.now, stamped: env.stamped });
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

	// ───────────────────────── export and published pages (Editor and files, `export-read.ts`) ─────────────────────────

	#exportDeps(): ExportReadDeps {
		return {
			sql: this.ctx.storage.sql,
			db: this.#db,
			pageAccess: (actor, pageId) => this.#access.pageAccess(actor, pageId),
			can: (actor, pageIds, level) => this.#access.can(actor, pageIds, level),
			visibleNums: (actor) => this.visibleNums(actor),
			queryView: (actor, input) => this.queryView(actor as Actor, input)
		};
	}

	/** A collection's view as a table of display rows (an inline database, exported or published); `null` when unreadable. */
	async exportDatabase(actor: AccessActor, input: { collectionId: string; viewId?: string | null; localFilter?: FilterGroup | null; limit?: number }) {
		return (await import('./export-read')).exportDatabase(this.#exportDeps(), actor, input);
	}

	/** The readable pages under `rootId` (every page when null), in tree order: the plan of a recursive or workspace export. */
	async exportTree(actor: AccessActor, rootId: string | null, limit?: number) {
		return (await import('./export-read')).exportTree(this.#exportDeps(), actor, rootId, limit);
	}

	/** Tells the connected tabs of `userId` something (an export that finished): a `notification` message, not stored. */
	pushNotification(userId: string, notification: Notification): number {
		let sent = 0;
		for (const socketId of this.#hub.streamSockets()) {
			if (this.#socket(socketId)?.actor.userId !== userId) continue;
			if (this.#send(socketId, { t: 'notification', notification })) sent++;
		}
		return sent;
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
		const visible = (await this.#access.visibleSetOf(actor)) ?? new Set<number>();
		const levels = await this.#access.levelsOf(actor);
		return queryViewRows(this.#db, input, {
			userId: actor.userId,
			visible,
			levels,
			seq: this.#hub.headSeq(),
			now: Date.now(),
			bitmaps: this.#options
		});
	}

	/**
	 * The server render's read (`src/server/ssr/`): the snapshots the caller's subscriptions would get from a socket (tree, pages,
	 * backlinks, a view's first window), the definitions the first screen shows, and the log position they were read at, so the
	 * browser store starts from them and its socket resumes at `seq` instead of asking for everything again. Every part runs under
	 * the caller's permissions, like the socket's.
	 */
	async ssrRead(actor: Actor, request: SsrRequest): Promise<SsrRead> {
		await this.#access.ensure(actor);
		const seq = this.#hub.headSeq();
		const out: SsrRead = { seq, windows: [] };
		const ancestors = request.reveal ? this.#hub.ancestorsOf(request.reveal, actor) : [];
		const windows = await Promise.all(
			(request.subs ?? []).map(async (entry): Promise<SeedWindow | null> => {
				const sub = entry.sub.kind === 'tree' && ancestors.length ? { ...entry.sub, parents: [...new Set([...entry.sub.parents, ...ancestors])] } : entry.sub;
				if (sub.kind !== 'view') {
					const snapshot = await this.#hub.oneShot(entry.id, sub, actor, seq);
					return snapshot && snapshot.t === 'snapshot' ? { id: entry.id, sub, snapshot } : null;
				}
				try {
					const result = await this.queryView(actor, {
						collectionId: sub.collectionId,
						...(sub.viewId ? { viewId: sub.viewId } : {}),
						spec: { ...(sub.filter ? { filter: sub.filter } : {}), ...(sub.sorts ? { sorts: sub.sorts as never } : {}), ...(sub.groupBy !== undefined ? { groupBy: sub.groupBy } : {}) },
						window: { limit: sub.limit },
						...(sub.props ? { props: sub.props } : {})
					});
					const base = { t: 'snapshot' as const, id: entry.id, total: result.total, seq, kind: 'view' as const };
					return { id: entry.id, sub, snapshot: result.groups ? { ...base, rows: [], groups: result.groups } : { ...base, rows: result.rows } };
				} catch {
					return null;
				}
			})
		);
		for (const window of windows) if (window) out.windows.push(window);
		if (request.properties) out.properties = await this.readProperties(actor);
		if (request.teamspaces) {
			const list = await this.teamspaces(actor);
			const ranks: Record<string, string> = {};
			await Promise.all(
				list
					.filter((t) => t.myRole !== null)
					.map(async (t) => {
						const mine = (await this.teamspaceMembers(actor, t.id)).find((m) => m.userId === actor.userId);
						if (mine) ranks[t.id] = mine.rank;
					})
			);
			out.teamspaces = { list, ranks };
		}
		if (request.collection) out.collection = await this.readCollection(actor, request.collection);
		return out;
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

	/**
	 * A page's document passed 80% of its size quota, or fell back under it (`bytes` 0 clears): remembered, and pushed to every
	 * connected tab that can read the page (the `quota` message; the store shows a toast). The Page DO calls this when a save
	 * moved the share by five points (`reportQuota` in page-do.ts), and tabs that connect later get it with their `hello`.
	 */
	async pageQuota(pageId: string, bytes: number, limit: number): Promise<void> {
		const key = `quota:${pageId}`;
		if (bytes <= 0 || limit <= 0 || bytes / limit < QUOTA_WARN_RATIO) {
			this.ctx.storage.sql.exec('DELETE FROM meta WHERE key = ?', key);
			return;
		}
		this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify({ bytes, limit }));
		const message: ServerMessage = { t: 'quota', pageId, bytes, limit };
		await Promise.all(
			this.#hub.streamSockets().map(async (socketId) => {
				const socket = this.#socket(socketId);
				if (socket && (await this.#access.pageAccess(socket.actor, pageId))) this.#send(socketId, message);
			})
		);
	}

	/** The pages over the warning share this tab can read, sent after its `hello`. */
	async #sendQuotas(socket: SocketHandle<WorkspaceSocketActor>): Promise<void> {
		const rows = this.ctx.storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key LIKE 'quota:%' LIMIT 50").toArray();
		for (const row of rows) {
			const pageId = row.key.slice('quota:'.length);
			if (!(await this.#access.pageAccess(socket.actor, pageId))) continue;
			try {
				const { bytes, limit } = JSON.parse(row.value) as { bytes: number; limit: number };
				this.#send(socket.socketId, { t: 'quota', pageId, bytes, limit });
			} catch {
				// a malformed row is ignored
			}
		}
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
		const { ingestInTransaction } = await import('./ingest');
		await this.#commit(
			this.#db,
			SYSTEM_ACTOR,
			async (tx) => {
				result = await ingestInTransaction(tx, items);
				await indexBodies(tx, items);
				// A new body makes the AI properties of these rows due again (debounced by the queue job).
				await markAiPages(tx, items.map((item) => item.pageId), Date.now());
				return result.records;
			},
			{ backlinkTargets: () => result?.backlinkTargets ?? [] }
		);
		// Mention emails: new @mentions become `email` jobs (never fails the index batch).
		await import('./mentions')
			.then(({ processMentions }) => processMentions({ db: this.#db, env: this.env, host: this, workspaceId: this.ctx.id.name ?? '' }, items))
			.catch((error) => console.warn('[mentions] failed:', String(error)));
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

	// ───────────────────────── AI properties (Databases track, see ./eav/ai.ts) ─────────────────────────

	/** Sends the AI-property jobs the last commits made due, each delayed to the end of its page's 30-second window. */
	async #flushAi(): Promise<{ pageId: string; propertyId: string; delaySeconds: number }[]> {
		try {
			const due = await flushAi(this.#db, this.ctx.id.name ?? '', Date.now());
			for (const part of chunks(due, 100)) {
				await this.env.JOBS.sendBatch(part.map(({ job, delaySeconds }) => ({ body: job, ...(delaySeconds > 0 ? { delaySeconds } : {}) })));
			}
			return due.map(({ job, delaySeconds }) => ({ pageId: job.pageId, propertyId: job.propertyId, delaySeconds }));
		} catch (error) {
			// The markers stay pending: the next commit (or the 10-minute resend) sends them.
			console.warn('[workspace] queueing AI properties failed:', error instanceof Error ? error.message : error);
			return [];
		}
	}

	/** Queues what is due now (the commits do it themselves; tests and operators call this). Returns what was queued. */
	async aiPropertyFlush(): Promise<{ pageId: string; propertyId: string; delaySeconds: number }[]> {
		return this.#flushAi();
	}

	/**
	 * What a job (or `ai.regenerate`, with `force` and the caller) does for one property of one page: skip, wait out the
	 * debounce, or run the model on the inputs this returns. With an `actor` the page must exist for them and be
	 * theirs to edit.
	 */
	async aiPropertyPrepare(pageId: string, propId: string, options: { force?: boolean; actor?: Actor } = {}): Promise<AiPrepare> {
		if (options.actor) {
			const level = await this.#access.pageAccess(options.actor, pageId);
			if (!level) throw notFound(`Page "${pageId}"`);
			if (level !== 'update' && level !== 'full') throw new WorkspaceError('FORBIDDEN', 'You cannot edit this page');
		}
		return this.#serialize(() => prepareAi(this.#db, propId, pageId, Date.now(), options.force === true));
	}

	/**
	 * Stores the model's answer as the computed value, through the live loop (subscriptions, formulas that read it, search)
	 * like any computed write; it is not an edit by anyone. `token` and `hash` come from `aiPropertyPrepare`.
	 */
	async aiPropertyWrite(pageId: string, propId: string, text: string | null, token: number, hash: string): Promise<{ seq: number }> {
		const current = (await readValues(this.#db, [pageId])).get(pageId)?.[propId] ?? null;
		if (current === text) {
			await aiDone(this.#db, propId, pageId, token, hash);
			return { seq: await headSeq(this.#db) };
		}
		const { seq } = await this.#commit(this.#db, SYSTEM_ACTOR, async (tx, env) => {
			const ctx = { actorId: env.actorId, now: env.now };
			const records = await writeComputedValue(tx, pageId, propId, text, ctx);
			await aiDone(tx, propId, pageId, token, hash);
			const written = new Set(records.flatMap((r) => (r.page ? [r.page] : [])));
			for (const id of written) env.unstamped.add(id);
			const computed = await afterWrite(tx, records, ctx);
			for (const r of computed) if (r.page) env.unstamped.add(r.page);
			const all = [...records, ...computed];
			await indexChanges(tx, all);
			return all;
		});
		return { seq };
	}

	/** The model could not answer: the old value stays, marked stale. */
	async aiPropertyFailed(pageId: string, propId: string): Promise<void> {
		await aiFailed(this.#db, propId, pageId, Date.now());
	}

	/**
	 * Whether each AI property of these pages waits for the model (`pending`) or kept an old value (`stale`). With an
	 * `actor` (the `ai.markers` call) the pages must be ones they can read; others are left out.
	 */
	async aiPropertyMarkers(pageIds: string[], options: { actor?: Actor } = {}): Promise<AiMarker[]> {
		let ids = pageIds;
		if (options.actor) {
			const allowed: string[] = [];
			for (const id of pageIds) if (await this.#access.pageAccess(options.actor, id)) allowed.push(id);
			ids = allowed;
		}
		return readAiMarkers(this.#db, ids);
	}

	// ───────────────────────── CSV imports (Databases track, see ../../import) ─────────────────────────

	/** `import.begin` records the job (the caller must be a member); the Workflow advances it. */
	async importCreate(actor: Actor, job: { id: string; title: string; pageId: string; size: number }): Promise<void> {
		this.#writeDb(actor);
		createJob(this.ctx.storage.sql, { ...job, userId: actor.userId }, Date.now());
	}

	/** The job's progress for its creator, and for owners and admins; `null` for anyone else. */
	importStatus(actor: Actor, id: string) {
		const resolved = this.#access.resolve(actor);
		const job = resolved ? getJob(this.ctx.storage.sql, id) : null;
		if (!job || !resolved) return null;
		return job.userId === actor.userId || resolved.role === 'owner' || resolved.role === 'admin' ? toStatus(job) : null;
	}

	/** Cancels an import (same visibility as `importStatus`): the Workflow stops at its next chunk. */
	importCancel(actor: Actor, id: string) {
		if (!this.importStatus(actor, id)) return null;
		const job = cancelJob(this.ctx.storage.sql, id, Date.now());
		return job ? toStatus(job) : null;
	}

	/** The Workflow reports progress (absolute counts, bytes read, state). */
	importProgress(id: string, progress: Progress) {
		const job = updateJob(this.ctx.storage.sql, id, progress, Date.now());
		return job ? toStatus(job) : null;
	}

	/** The Workflow reads the job before each chunk (to see a cancel). */
	importJob(id: string) {
		return getJob(this.ctx.storage.sql, id);
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
	async filesBegin(actor: Actor, input: BeginInput) {
		return (await filesLib()).beginUpload(this.#filesContext(actor), actor, input);
	}

	/** The caller's pending upload (`PUT /files/:fileId`, the parts endpoints), checked again for access. */
	async filesPending(actor: Actor, fileId: string) {
		return (await filesLib()).pendingUpload(this.#filesContext(actor), actor, fileId);
	}

	async filesRecordUploadId(actor: Actor, fileId: string, uploadId: string): Promise<void> {
		const files = await filesLib();
		const ctx = this.#filesContext(actor);
		await files.pendingUpload(ctx, actor, fileId);
		files.recordUploadId(ctx, fileId, uploadId);
	}

	/** `files.complete`: assembles a multipart upload, checks the bytes, commits the row. */
	async filesComplete(actor: Actor, fileId: string, parts?: { partNumber: number; etag: string }[]) {
		return (await filesLib()).completeUpload(this.#filesContext(actor), actor, fileId, parts);
	}

	async filesAbort(actor: Actor, fileId: string) {
		return (await filesLib()).abortUpload(this.#filesContext(actor), actor, fileId);
	}

	/** A committed file's metadata when `actor` may read its page (`files.get`, and the download route). */
	async filesGet(actor: Actor, fileId: string) {
		return (await filesLib()).getFile(this.#filesContext(actor), fileId);
	}

	/** Like `filesGet` with the R2 key, or `null` (the download route turns that into a 404). */
	async filesResolve(actor: Actor, fileId: string) {
		return (await filesLib()).readableFile(this.#filesContext(actor), fileId);
	}

	/** The weekly sweep for this workspace: uploads never committed are removed. */
	async filesSweep(options: { now?: number; maxAgeMs?: number } = {}) {
		return (await filesLib()).sweepUncommitted(this.ctx.storage.sql, this.env, this.ctx.id.name ?? '', options);
	}

	/** Purge: the files of these pages lose their rows and bytes. */
	async filesPurgePages(pageIds: string[]) {
		return (await filesLib()).purgeFilesOfPages(this.ctx.storage.sql, this.env, this.ctx.id.name ?? '', pageIds);
	}

	/** Storage used and the quota; `setQuota` (bytes, or `null` for the default) changes it. */
	async filesStorage(setQuota?: number | null) {
		const files = await filesLib();
		if (setQuota !== undefined) files.setStorageQuota(this.ctx.storage.sql, setQuota);
		return files.filesUsage(this.ctx.storage.sql);
	}

	// ───────────────────────── search (Accounts, AI, API: src/server/search) ─────────────────────────

	/** What a search of `actor` runs on: raw reads, ANDed with the actor's visibility set (FORBIDDEN for non-members). */
	async #searchContext(actor: Actor, semantic: boolean) {
		this.#writeDb(actor);
		const visible = await this.visibleNums({ userId: actor.userId, role: actor.role });
		const vector = semantic ? (await import('../../search/vectors')).vectorSearchOf(this.env, actor.workspaceId) : null;
		return { db: this.#db, visible, vector };
	}

	/** The search page: full text (plus Vectorize for questions), filters, snippets. Only pages the actor can read. */
	async searchQuery(actor: Actor, input: SearchInput): Promise<SearchResult> {
		const context = await this.#searchContext(actor, true);
		return (await import('../../search/query')).searchPages(context, input);
	}

	/** Quick find (`⌘K`): title prefixes, recently visited pages, then full-text hits. */
	async searchQuick(actor: Actor, input: QuickFindInput): Promise<QuickFindResult> {
		const context = await this.#searchContext(actor, false);
		return (await import('../../search/query')).quickFind(context, actor.userId, input);
	}

	/** Records that `actor` opened a page they can read (feeds quick find's "recent"). Anything else is ignored. */
	async searchVisit(actor: Actor, pageId: string): Promise<void> {
		const context = await this.#searchContext(actor, false);
		const row = await this.#db.page.findUnique({ where: { id: pageId }, select: { num: true, deletedAt: true } });
		if (row && !row.deletedAt && context.visible.has(row.num)) await (await import('../../search/query')).recordVisit(this.#db, actor.userId, row.num);
	}

	/** Backfill for workspaces that existed before search: rebuilds the whole FTS5 index. Idempotent. */
	async reindexAll(): Promise<{ pages: number }> {
		return reindexSearch(this.#db);
	}

	/** Backfill for Vectorize: embeds the chunks of every live page whose hash is new. Idempotent; a no-op without AI/Vectorize. */
	async embedAll(): Promise<EmbedResult[]> {
		const results: EmbedResult[] = [];
		const { applyChunks, chunkIdsOf, diffChunks, forgetChunks } = await import('../../search/embed-store');
		const { embedPages } = await import('../../search/embed');
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
		return (await import('../../search/embed-store')).diffChunks(this.#db, model, pages);
	}

	async embedApply(model: string, pages: PageChunks[]): Promise<void> {
		await (await import('../../search/embed-store')).applyChunks(this.#db, model, pages);
	}

	async embedChunkIds(pageIds: string[]): Promise<string[]> {
		return (await import('../../search/embed-store')).chunkIdsOf(this.#db, pageIds);
	}

	async embedForget(pageIds: string[]): Promise<void> {
		await (await import('../../search/embed-store')).forgetChunks(this.#db, pageIds);
	}

	// ───────────────────────── public API and Ask AI (Accounts, AI, API) ─────────────────────────

	/**
	 * Header and properties of the pages among `ids` the actor may read (the others are left out: they do not exist for
	 * them), plus which of those pages, and which of their parents, are databases (the public API's `parent` type).
	 */
	async apiPages(actor: Actor, ids: string[]): Promise<{ rows: PageRow[]; databases: string[] }> {
		this.#writeDb(actor);
		const levels = new Map<string, AccessLevel>();
		for (const id of [...new Set(ids)].slice(0, 100)) {
			const level = await this.#access.pageAccess(actor, id);
			if (level) levels.set(id, level);
		}
		const rows: PageRow[] = [];
		for (const [id, level] of levels) {
			const row = (await this.#hub.reader.pageRows([id], () => level)).get(id);
			if (row) rows.push(row);
		}
		const probe = [...new Set(rows.flatMap((r) => (r.parentId ? [r.id, r.parentId] : [r.id])))];
		const databases: string[] = [];
		for (const part of chunks(probe)) {
			for (const r of this.ctx.storage.sql
				.exec<{ id: string }>(`SELECT id FROM page WHERE is_database = 1 AND id IN (${part.map(() => '?').join(',')})`, ...part)
				.toArray())
				databases.push(r.id);
		}
		return { rows, databases };
	}

	/** The collection a database page holds (`database_id` of the public API is that page's id), or null. */
	async apiCollectionOfPage(actor: Actor, pageId: string): Promise<string | null> {
		if (!(await this.#access.pageAccess(actor, pageId))) return null;
		const row = this.ctx.storage.sql
			.exec<{ id: string }>('SELECT id FROM collection WHERE page_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', pageId)
			.toArray()[0];
		return row?.id ?? null;
	}

	/** Claims an `Idempotency-Key` (see ./idempotency.ts). */
	idempotencyBegin(scope: string, key: string, requestHash: string): IdempotencyBegin {
		return beginIdempotent(this.ctx.storage.sql, scope, key, requestHash);
	}

	idempotencyFinish(scope: string, key: string, status: number, body: string): void {
		finishIdempotent(this.ctx.storage.sql, scope, key, status, body);
	}

	idempotencyAbandon(scope: string, key: string): void {
		abandonIdempotent(this.ctx.storage.sql, scope, key);
	}

	/**
	 * The passages an Ask AI answer may draw on (src/server/ai/ask.ts): Vectorize and full-text hits with every page the
	 * actor cannot read dropped before ranking, the text of the winners re-chunked from `page_text`. Only text of readable
	 * pages leaves the object.
	 */
	async askRetrieve(actor: Actor, input: { question: string; under?: string }): Promise<Passage[]> {
		this.#writeDb(actor);
		const visible = await this.visibleNums({ userId: actor.userId, role: actor.role });
		const { chunkSearchOf, retrievePassages } = await import('../../ai/ask');
		return retrievePassages(
			{ db: this.#db, visible, vector: chunkSearchOf(this.env, actor.workspaceId) },
			input.question,
			input.under ? { under: input.under } : {}
		);
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
		const gone = pages.filter((p) => !left.has(p.id));
		this.#options.dropPages(gone.map((p) => p.num));
		return gone;
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
		const held = row ? await accessTo(gov.page, { id: pageId }, ['read', 'full'] as const) : null;
		if (!row || !held?.read) throw notFound(`Page "${pageId}"`);
		if (!row.deleted_at || row.trash_root !== pageId) throw invalid('/id', 'not_in_trash', 'Only a page that was moved to the trash can be deleted forever');
		if (!held.full) {
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
		this.#destroyed = true;
		for (const socket of this.#sockets().all()) {
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

	/** Operators and tests: counts the object as overloaded for `ms` milliseconds (0 clears it). */
	async forceOverload(ms: number): Promise<void> {
		this.#governor.force(ms);
	}

	/** Operators and tests: how many plain heads a commit sends at once and how long the rest wait (`HeadCoalescing`). */
	async setHeadCoalescing(options: { min?: number; ms?: number }): Promise<void> {
		this.#hub.setHeadCoalescing(options);
	}

	/** Tests: occupies the commits' queue for `ms`, so what arrives meanwhile queues behind it (the busy object the governor reacts to). */
	async holdQueue(ms: number): Promise<void> {
		await this.#serialize(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	}

	/** Live-loop counters, for tests and operators: shared units, evaluations, sockets with a stream. */
	async liveStats(options: { resetPerf?: boolean; stale?: boolean } = {}): Promise<{
		units: number;
		evaluations: number;
		isolateEvaluations: number;
		streams: number;
		head: number;
		stale: string[];
		perf: typeof fanOutPerf;
		/** The overload governor: state, average commit-and-fan-out milliseconds, declared overloads, merged commits, hidden and stale tabs. */
		governor: { overloaded: boolean; average: number; triggers: number; merged: number; hidden: number; stale: number };
		/** Commits run, groups of several commits sharing a transaction, and the largest group, since the wake. */
		groups: { commits: number; groups: number; largest: number };
		/** The page value cache (null: off): pages read from SQL, entries patched, times emptied, pages held, units maintained from it and units that fell back to SQL. */
		memory: { loads: number; patches: number; clears: number; size: number; units: number; fallbacks: number; plans: { hits: number; misses: number; uncacheable: number } } | null;
		/** The option index: loaded properties, builds since the wake, bytes in the WASM heap (null when bitmaps are off). */
		bitmaps: { loaded: number[]; builds: number; bytes: number; drift: Drift[] } | null;
		/** Sockets held by shards, per shard, and the batches and frames the shards were sent since the wake. */
		shards: { sockets: number[]; local: number; batches: number; sends: number };
	}> {
		const perf = { ...fanOutPerf };
		if (options.resetPerf) resetFanOutPerf();
		const bitmaps = OptionIndex.available()
			? { loaded: this.#options.loadedProps, builds: this.#options.builds, bytes: this.#options.bytes(), drift: options.stale === false ? [] : await this.#options.drift(this.#db) }
			: null;
		this.#sockets();
		return {
			perf,
			shards: { sockets: [...this.#shardCounts].map((n) => n ?? 0), local: this.#sockets().size - this.#remotes.size, batches: this.#router.batches, sends: this.#router.sends },
			governor: { overloaded: this.#governor.overloaded, average: this.#governor.average, triggers: this.#governor.triggers, merged: this.#merged, hidden: this.#hidden.size, stale: this.#stale.size },
			groups: { ...this.#groupStats },
			memory: this.#hub.memoryStats(),
			bitmaps,
			units: this.#hub.unitCount(),
			evaluations: this.#hub.evaluations,
			isolateEvaluations: unitEvaluations(),
			streams: this.#hub.streamSockets().length,
			head: this.#hub.headSeq(),
			stale: options.stale === false ? [] : await this.#hub.staleUnits()
		};
	}

	// ───────────────────────── backup and restore (Sync core P4, see ./backup.ts and src/server/backup) ─────────────────────────
	// Operator-only: reached through `src/server/backup` (the nightly Workflow and the admin route), never from a
	// user's session. A backup pages through the authoritative tables; a restore loads an export, or arms
	// point-in-time recovery. Neither is part of the product surface.

	/**
	 * Starts a backup: holds the commit queue (writes wait, none is dropped; the hold lifts by itself after `holdMs`,
	 * 60 s by default) so every batch reads the same state, and returns the export's header.
	 */
	async backupBegin(holdMs = 60_000): Promise<BackupHeader> {
		const { exportHeader } = await backupLib();
		this.#backupRelease?.();
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const timer = setTimeout(release, Math.min(Math.max(holdMs, 1000), 300_000));
		const lift = () => {
			clearTimeout(timer);
			release();
			if (this.#backupRelease === lift) this.#backupRelease = null;
		};
		this.#backupRelease = lift;
		await new Promise<void>((acquired) => {
			void this.#serialize(async () => {
				acquired();
				await held;
			});
		});
		return exportHeader(this.ctx.storage.sql, this.ctx.id.name ?? '');
	}

	/** The next batch of rows (about 1 MiB). Read only. */
	async backupBatch(header: BackupHeader, cursor: ExportCursor | null): Promise<ExportBatch> {
		const { exportBatch } = await backupLib();
		// Under the hold the queue is closed, so read directly; otherwise take a turn like any other work.
		if (this.#backupRelease) return exportBatch(this.ctx.storage.sql, header, cursor);
		return this.#serialize(async () => exportBatch(this.ctx.storage.sql, header, cursor));
	}

	/** Ends a backup: lifts the hold and says where the change log is now (a different `seq` than the header's means writes happened). */
	async backupEnd(): Promise<{ headSeq: number }> {
		// Imported before the hold lifts: a commit that was waiting must not run before the head is read.
		const { readHeadSeq } = await backupLib();
		this.#backupRelease?.();
		return { headSeq: readHeadSeq(this.ctx.storage.sql) };
	}

	/** The schema a fresh or destroyed object needs, as the constructor builds it (`destroy()` wipes it, an import needs it back). */
	async #bootstrapSchema(): Promise<void> {
		const flags = await migrationFlags(this.ctx.storage, this.env, this.ctx.id.name);
		applyRawSteps(this.ctx.storage, flags);
		ensureFilesTable(this.ctx.storage.sql);
		ensureSearchTables(this.ctx.storage.sql);
		await migrateWorkspace(this.ctx, this.#db, flags);
		ensureEavLayout(this.ctx.storage);
	}

	/**
	 * Prepares the object for an import: the schema is made current, then a populated object is refused unless
	 * `force` (which clears every authoritative, derived and ephemeral row first). A fresh or destroyed object just loads.
	 */
	async importBegin(header: BackupHeader, options: { force?: boolean } = {}): Promise<void> {
		if (header.kind !== 'flarion-workspace-backup' || header.v !== 1) throw new WorkspaceError('BAD_REQUEST', 'Not a Flarion workspace backup');
		if (header.workspaceId !== (this.ctx.id.name ?? header.workspaceId)) throw new WorkspaceError('BAD_REQUEST', 'The backup belongs to another workspace');
		const { isPopulated, prepareFixups, wipeRows } = await backupLib();
		await this.#serialize(async () => {
			const hasPage = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'page'").one().n > 0;
			if (!hasPage) await this.#bootstrapSchema();
			if (isPopulated(this.ctx.storage.sql)) {
				if (!options.force) throw new WorkspaceError('CONFLICT', 'This workspace object holds data: restore into it only with force');
				this.ctx.storage.transactionSync(() => wipeRows(this.ctx.storage.sql));
			}
			prepareFixups(this.ctx.storage.sql);
		});
	}

	/** Loads a batch of export lines, in one transaction. Idempotent. */
	async importBatch(header: BackupHeader, lines: string[]): Promise<number> {
		const { importLines } = await backupLib();
		return this.#serialize(async () => this.ctx.storage.transactionSync(() => importLines(this.ctx.storage.sql, header, lines)));
	}

	/**
	 * Ends an import: checks the loaded row counts against the trailer, restores the change log's counter, rebuilds
	 * the derived tables (titles and properties into the search index here; bodies by the replay), resets what the
	 * object holds in memory and replays indexing.
	 */
	async importFinish(header: BackupHeader, trailer: { counts: Record<string, number>; rows: number }): Promise<{ counts: Record<string, number>; replayed: number }> {
		const { applySelfReferences, countRows, restoreSequences, EXPORT_TABLES } = await backupLib();
		const counts = await this.#serialize(async () => {
			const loaded = countRows(this.ctx.storage.sql, EXPORT_TABLES);
			for (const [table, n] of Object.entries(trailer.counts)) {
				if (loaded[table] !== undefined && loaded[table] !== n) throw new WorkspaceError('CONFLICT', `Restore check failed: table ${table} has ${loaded[table]} rows, the backup ${n}`);
			}
			this.ctx.storage.transactionSync(() => {
				applySelfReferences(this.ctx.storage.sql);
				restoreSequences(this.ctx.storage.sql, header);
			});
			return loaded;
		});
		await this.#serialize(() => reindexSearch(this.#db));
		this.#afterRestoreReset();
		const { pages } = await this.replayIndexing();
		return { counts, replayed: pages };
	}

	/**
	 * What a restore leaves stale in memory: the property registry, visibility sets, the live registry and the row
	 * caches. Every connected tab is told to reconnect (`hello` with its `seq` replays or resnapshots).
	 */
	#afterRestoreReset(): void {
		invalidateRegistry();
		this.#options.invalidateAll();
		this.#access.reset();
		this.#hub.clearRegistry();
		this.#hub.reader.invalidate();
		for (const socket of this.#sockets().all()) {
			try {
				socket.ws.close(CLOSE.TRY_AGAIN, 'resync');
			} catch {
				// already closed
			}
		}
		this.#directory = null;
	}

	/**
	 * Replays indexing: one `index-page` job per live page on the JOBS queue (the consumer reads each body from its
	 * Page DO, so `page_text`, links, the body rows of the search index and the embeddings come back). The version is
	 * "now", newer than anything indexed before the restore.
	 */
	async replayIndexing(): Promise<{ pages: number }> {
		const workspaceId = this.ctx.id.name ?? '';
		const version = Date.now();
		const ids = this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM page WHERE deleted_at IS NULL ORDER BY num').toArray().map((r) => r.id);
		for (const part of chunks(ids, 100)) {
			await this.env.JOBS.sendBatch(part.map((pageId) => ({ body: { type: 'index-page', workspaceId, pageId, version }, contentType: 'json' as const })));
		}
		return { pages: ids.length };
	}

	/**
	 * Point-in-time recovery to `timestamp` (epoch ms, within 30 days): arms the restore and aborts the object, which
	 * wakes up restored. The call that gets here fails by design. The marker the Worker finds (`restore:pending:<id>`) lives
	 * in KV because the restore rolls this object's own storage back. `pitr` is a seam for tests (workerd's local
	 * storage has no bookmarks).
	 */
	async restoreToTimestamp(timestamp: number, pitr: PitrStorage = this.ctx.storage as unknown as PitrStorage): Promise<never> {
		const workspaceId = this.ctx.id.name ?? '';
		const { armPointInTimeRestore } = await backupLib();
		await armPointInTimeRestore(
			pitr,
			timestamp,
			() => this.ctx.abort('point-in-time restore'),
			async (plan) => {
				await this.env.CACHE.put(
					`restore:pending:${workspaceId}`,
					JSON.stringify({ workspaceId, timestamp, bookmark: plan.bookmark, undo: plan.undo, armedAt: Date.now() }),
					{ expirationTtl: 7 * 24 * 3600 }
				);
			}
		);
		throw new Error('unreachable: the object aborts');
	}

	/** The first call on a restored object: resets memory and replays indexing. The Worker drops the marker after it. */
	async afterRestore(): Promise<{ pages: number }> {
		this.#afterRestoreReset();
		return this.replayIndexing();
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
