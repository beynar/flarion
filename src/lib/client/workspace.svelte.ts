/**
 * The workspace runes store: everything the signed-in app shows that comes from the Workspace
 * Durable Object.
 *
 * Data
 * - `pages`: normalized page entities (tree fields, header, property values), as the user sees
 *   them: the server's state (`#base`) with every optimistic layer on top.
 * - `windows`: one entry per subscription (`tree`, `page`, `view`, `backlinks`) with its status,
 *   ordered ids and total. `view` and `backlinks` rows live in their window.
 * - `properties` (the registry), `views`, `presence`, `seq`, `status`.
 *
 * Sync rules (docs/PLAN.md, "Real-time sync")
 * - Messages are applied strictly in `seq` order. A diff for a subscription whose snapshot has not
 *   arrived is buffered and replayed (in seq order, skipping what the snapshot already holds)
 *   when it does. A diff at or below the applied `seq`, or below its subscription's snapshot, is a
 *   duplicate and dropped.
 * - `mutate(ops)` applies the ops to an optimistic layer keyed by a mutation id, calls
 *   `rpc.mutate`, and drops the layer once the socket has delivered the returned `seq` (a diff or
 *   a head at or above it). A failed call rolls the layer back and raises a notification.
 * - Offline (socket not online) property edits, moves and new pages are refused; page bodies are
 *   edited in edytor rooms and are not the store's business.
 * - The last tree and recent pages are cached in IndexedDB for an instant start; a cold start
 *   resumes from the cached `seq` when the server still has the log.
 */
import { getContext, setContext, untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Rpc } from '#lib/client/rpc.ts';
import { defaultCache, type CacheBackend, type CacheSnapshot } from '#lib/client/idb.ts';
import { APP_VERSION, newId } from '#lib/client/runtime.ts';
import {
	WorkspaceSocket,
	workspaceSocketUrl,
	type Clock,
	type SocketStatus,
	type TransportFactory,
	type FatalAction
} from '#lib/client/socket.ts';
import {
	applyValueOp,
	type Op,
	type SetPropOp,
	type ValueOp,
	type CreateOp
} from '#lib/shared/ops.ts';
import {
	TITLE_PROP_ID,
	createRegistry,
	type PropValue,
	type PropertyDef
} from '#lib/shared/property-types.ts';
import type {
	AccessLevel,
	BacklinkRow,
	ClientMessage,
	DiffOp,
	Notification,
	PageRow,
	PresenceUser,
	ServerMessage,
	SnapshotMessage,
	Subscription,
	SubscriptionEntry,
	SubscriptionKind,
	TreeRow,
	Values,
	ViewRow
} from '#lib/shared/protocol.ts';
import { MAX_WINDOW } from '#lib/shared/protocol.ts';
import type { ArchivedTeamspace, Member, Teamspace, TeamspaceMember, Workspace } from '#lib/shared/schemas.ts';
import type { CollectionDef, ViewDef } from '#lib/shared/definitions.ts';
import { GROUP_EMPTY, type FilterGroup, type GroupBySpec } from '#lib/shared/filter-ast.ts';
import { compareRank, placeAt, rankAfter } from '#lib/shared/sort-keys.ts';
import { PAGE_SET_ID, TREE_ID, subKey } from '#lib/shared/sub-key.ts';
import type { StoreSeed } from '#lib/shared/seed.ts';
import { writeExpandedCookie, writePrefsCookie } from '#lib/client/ui-cookies.ts';

// ───────────────────────────── types ─────────────────────────────

export interface PageEntity {
	id: string;
	parentId: string | null;
	rank: string;
	title: string;
	icon: string | null;
	cover: string | null;
	isDatabase: boolean;
	teamspaceId: string | null;
	hasChildren: boolean;
	access: AccessLevel;
	/** Property values by property id (the title lives in `title`). */
	values: Values;
	createdBy: string | null;
	createdAt: string | null;
	updatedBy: string | null;
	updatedAt: string | null;
	/** True while only the tree fields are known (no `page` subscription has delivered it). */
	partial: boolean;
}

export type WindowStatus = 'pending' | 'ready' | 'error';

/** One group of a grouped `view` window: its key, how many rows it holds in all, and the ids loaded so far. */
export interface GroupWindow {
	key: string;
	total: number;
	ids: string[];
}

export interface WindowState {
	id: string;
	kind: SubscriptionKind;
	sub: Subscription;
	status: WindowStatus;
	/** Ids in window order (tree and page windows address `pages`; view and backlinks use `rows`). */
	ids: string[];
	/** Rows of `view` and `backlinks` windows. */
	rows: Map<string, ViewRow | BacklinkRow>;
	total: number;
	/** The `seq` of the snapshot this window is built on. */
	seq: number | null;
	/** Grouped `view` windows: the groups in display order (`ids` is then every id loaded, once). */
	groups?: GroupWindow[];
	error?: string;
}

/** A database's definition and views, as the view host reads them. */
export interface CollectionBundle {
	collection: CollectionDef;
	views: ViewDef[];
}

/** A `view` window ready to render. `groups` is set for a grouped view (`loaded` counts the server's rows, for "Load more"). */
export interface ViewData {
	status: WindowStatus;
	total: number;
	rows: ViewRow[];
	groups?: { key: string; total: number; loaded: number; rows: ViewRow[] }[];
}

export interface PageRef {
	id: string;
	title: string;
	icon: string | null;
}

export interface Toasty {
	kind: 'error' | 'info' | 'success';
	title: string;
	description?: string;
}

export type MutationSender = (mid: string) => Promise<{ seq: number }>;

export class OfflineError extends Error {
	constructor() {
		super('You are offline');
		this.name = 'OfflineError';
	}
}

export interface WorkspaceStoreOptions {
	workspace: Workspace;
	user: { id: string; name: string; email?: string; image?: string | null };
	rpc: Rpc;
	/** The transport of the workspace socket; the browser WebSocket when absent. */
	socketFactory?: TransportFactory;
	socketUrl?: string;
	clock?: Clock;
	cache?: CacheBackend | null;
	notify?: (t: Toasty) => void;
	/** The tab asked to reload (build too old) or sign in again. */
	onFatal?: (action: FatalAction, code: number, reason: string) => void;
	reauth?: () => Promise<boolean>;
	/** A page's lock changed (the `lock` push): the page lock cache applies it. */
	onLock?: (lock: { pageId: string; locked: boolean; lockedBy: string | null; lockedAt: number | null }) => void;
	/** The socket reconnected: pushes were missed, so what is cached outside the store (page locks) is read again. */
	onReconnect?: () => void;
	/** The store of a server render (`+layout.svelte`): it schedules nothing and never reads the network. */
	renderingOnServer?: boolean;
	appVersion?: string;
	storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
	/** Debounce of title edits, ms. */
	titleDebounceMs?: number;
	/** How long a layer may wait for its `seq` while online before it is dropped anyway, ms. */
	layerTimeoutMs?: number;
	cacheDebounceMs?: number;
	heartbeatMs?: number;
}

type Layer = { mid: string; ops: Op[]; seq: number | null; timer: unknown };
type DiffFrame = Extract<ServerMessage, { t: 'diff' }>;

const ROOT = '$root';
const MAX_RECENT = 30;
const SYSTEM_TITLE = TITLE_PROP_ID;

const key = (p: string | null) => p ?? ROOT;

export { subKey };

function entityFromTree(row: TreeRow, prev?: PageEntity): PageEntity {
	return {
		id: row.id,
		parentId: row.parentId,
		rank: row.rank,
		title: row.title,
		icon: row.icon,
		cover: prev?.cover ?? null,
		isDatabase: row.isDatabase,
		teamspaceId: row.teamspaceId,
		hasChildren: row.hasChildren,
		access: row.access,
		values: prev?.values ?? {},
		createdBy: row.createdBy,
		createdAt: prev?.createdAt ?? null,
		updatedBy: prev?.updatedBy ?? null,
		updatedAt: prev?.updatedAt ?? null,
		partial: prev ? prev.partial : true
	};
}

function entityFromPage(row: PageRow): PageEntity {
	const { [SYSTEM_TITLE]: _title, ...values } = row.values;
	void _title;
	return {
		id: row.id,
		parentId: row.parentId,
		rank: row.rank,
		title: row.title,
		icon: row.icon,
		cover: row.cover,
		isDatabase: row.isDatabase,
		teamspaceId: row.teamspaceId,
		hasChildren: row.hasChildren,
		access: row.access,
		values,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
		updatedBy: row.updatedBy,
		updatedAt: row.updatedAt,
		partial: false
	};
}

const isPageRow = (row: unknown): row is PageRow => !!row && typeof row === 'object' && 'values' in row && 'createdAt' in row;
const isTreeRow = (row: unknown): row is TreeRow => !!row && typeof row === 'object' && 'hasChildren' in row;

/** The tree row of an entity, for the cache. */
function toTreeRow(e: PageEntity): TreeRow {
	return {
		id: e.id,
		parentId: e.parentId,
		rank: e.rank,
		title: e.title,
		icon: e.icon,
		isDatabase: e.isDatabase,
		teamspaceId: e.teamspaceId,
		hasChildren: e.hasChildren,
		access: e.access,
		createdBy: e.createdBy
	};
}

function toPageRow(e: PageEntity): PageRow {
	return {
		...toTreeRow(e),
		cover: e.cover,
		values: e.values,
		createdAt: e.createdAt ?? '',
		updatedBy: e.updatedBy,
		updatedAt: e.updatedAt ?? ''
	};
}

/** Applies one `update` diff to an entity. */
function updateEntity(e: PageEntity, prop: string, value: unknown): PageEntity {
	switch (prop) {
		case '$icon':
			return { ...e, icon: (value as string | null) ?? null };
		case '$cover':
			return { ...e, cover: (value as string | null) ?? null };
		case '$parent':
			return { ...e, parentId: (value as string | null) ?? null };
		case '$rank':
			return typeof value === 'string' ? { ...e, rank: value } : e;
		case '$teamspace':
			return { ...e, teamspaceId: (value as string | null) ?? null };
		case '$isDatabase':
			return { ...e, isDatabase: !!value };
		case '$access':
			return { ...e, access: value as AccessLevel };
		case '$hasChildren':
			return { ...e, hasChildren: !!value };
		case SYSTEM_TITLE:
			return { ...e, title: typeof value === 'string' ? value : '' };
		default:
			return { ...e, values: { ...e.values, [prop]: value as PropValue | null } };
	}
}

// ───────────────────────────── the store ─────────────────────────────

export class WorkspaceStore {
	readonly workspace: Workspace;
	readonly user: WorkspaceStoreOptions['user'];
	readonly clientId = newId('c');

	// reactive state -------------------------------------------------------------------------
	/** The pages as the user sees them: server state plus optimistic layers. */
	readonly pages = new SvelteMap<string, PageEntity>();
	readonly windows = new SvelteMap<string, WindowState>();
	/** Who is on which page (everyone, me included). */
	readonly presence = new SvelteMap<string, PresenceUser[]>();
	/** Views of each collection (by collection id), as fetched by `loadCollection` and edited optimistically. */
	readonly views = new SvelteMap<string, ViewDef[]>();
	/** The collection definitions behind them. */
	readonly collections = new SvelteMap<string, CollectionDef>();
	status = $state<SocketStatus>('connecting');
	/** The socket has been online at least once (a page from the server render is "connecting", not "reconnecting"). */
	wasOnline = $state(false);
	/** The log position applied so far, null before the first snapshot. */
	seq = $state<number | null>(null);
	/** The tree is on screen (from the cache or the server). */
	ready = $state(false);
	/** What is on screen came from the cache and the server has not confirmed it yet. */
	stale = $state(false);
	/** The server refused this build: show the reload prompt. */
	outdated = $state(false);
	/** The workspace is gone or access was withdrawn. */
	closed = $state<null | 'forbidden' | 'gone' | 'reauth'>(null);
	properties = $state.raw<PropertyDef[]>([]);
	members = $state.raw<Member[]>([]);
	teamspaces = $state.raw<Teamspace[]>([]);
	/** My sidebar order of the teamspaces I belong to (`teamspace_member.rank`), by teamspace id. */
	teamspaceRanks = $state.raw<Record<string, string>>({});
	notifications = $state.raw<Notification[]>([]);
	/** Mutations sent and not yet delivered back by the socket. */
	pending = $state(0);
	expanded = $state.raw<ReadonlySet<string>>(new Set());
	recent = $state.raw<{ id: string; at: number }[]>([]);
	favorites = $state.raw<string[]>([]);

	/** Children of each parent id (roots under `null`), sorted by rank. */
	readonly byParent = $derived.by(() => {
		const map = new Map<string, PageEntity[]>();
		for (const e of this.pages.values()) {
			const k = key(e.parentId);
			const list = map.get(k);
			if (list) list.push(e);
			else map.set(k, [e]);
		}
		for (const list of map.values()) list.sort((a, b) => compareRank(a.rank, b.rank) || compareRank(a.id, b.id));
		return map;
	});

	readonly canEdit = $derived(this.status === 'online');

	// internals ------------------------------------------------------------------------------
	readonly #o: WorkspaceStoreOptions;
	readonly #rpc: Rpc;
	readonly #base = new Map<string, PageEntity>();
	#layers: Layer[] = [];
	#drafts = new Map<string, string>();
	#titleTimers = new Map<string, unknown>();
	#subs = new Map<string, { sub: Subscription; count: number }>();
	#pendingDiffs = new Map<string, DiffFrame[]>();
	/** View windows resized and not yet answered: the answer is a diff at the log's head, possibly already applied. */
	#awaitingWindow = new Set<string>();
	#loadedParents = new Set<string>([ROOT]);
	#expanded = new Set<string | null>([null]);
	#treeTimer: unknown = null;
	#registry = createRegistry([]);
	#socket: WorkspaceSocket | null = null;
	#midCounter = 0;
	#cacheTimer: unknown = null;
	#registryTimer: unknown = null;
	#directoryTimer: unknown = null;
	/** A `welcome` was received already: the next one is a reconnect. */
	#welcomed = false;
	/** Bumped by every definition write: an older registry fetch must not overwrite it. */
	#defVersion = 0;
	#recentOpened: string[] = [];
	#openPages = new Map<string, { release: () => void; ancestors: Map<string, () => void> }>();
	#myPage: string | null = null;
	#started = false;
	#disposed = false;
	#resumedMode: 'replay' | 'snapshot' | null = null;
	/** Seeded by the server render (`seed`): the cache is skipped, the first registry and directory reads are already here. */
	#seeded = false;
	/** The registry and directory came with the seed and nothing has been committed since (`welcome` checks): refreshing them is a no-op. */
	#seedFresh = false;
	#seededSeq: number | null = null;
	/** Windows the seed made that no component has subscribed to yet: the first `subscribe` of the same id claims one without a message. */
	#unclaimed = new Set<string>();
	/** The first `hello` was built: from here a `subscribe` must reach the server. */
	#helloSent = false;

	constructor(options: WorkspaceStoreOptions) {
		this.#o = options;
		this.#rpc = options.rpc;
		this.workspace = options.workspace;
		this.user = options.user;
	}

	// ───────────────────────────── lifecycle ─────────────────────────────

	/** Loads the cache, connects the socket and fetches the registry. Safe to call once. */
	async start(): Promise<void> {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		this.#loadPrefs();
		// Seeded by the server: its tree is fresher than the browser's cache, which would only make a stale first paint.
		const cache = this.#seeded ? null : this.#cache();
		const snapshot = cache ? await cache.load(this.workspace.id) : null;
		if (this.#disposed) return;
		if (snapshot) this.#restore(snapshot);
		this.initTree();

		this.#socket = new WorkspaceSocket({
			url:
				this.#o.socketUrl ??
				(() =>
					typeof window === 'undefined'
						? `ws://localhost/ws/${encodeURIComponent(this.workspace.id)}`
						: workspaceSocketUrl(this.workspace.id, this.#o.appVersion ?? APP_VERSION)),
			appVersion: this.#o.appVersion ?? APP_VERSION,
			clientId: this.clientId,
			factory: this.#o.socketFactory,
			clock: this.#o.clock,
			heartbeatMs: this.#o.heartbeatMs,
			hello: () => this.#hello(),
			onMessage: (m) => this.receive(m),
			onStatus: (s) => {
				this.status = s;
				if (s === 'online') this.wasOnline = true;
			},
			onFatal: (action, code, reason) => this.#fatal(action, code, reason),
			reauth: this.#o.reauth
		});
		this.#socket.start();
		// Hidden tabs are the first thing an overloaded Workspace DO stops serving; the server resynchronizes on show.
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this.#onVisibility);
		}
		if (!this.#seeded) {
			void this.refreshProperties();
			void this.refreshDirectory();
		}
	}

	#onVisibility = (): void => {
		this.#send({ t: 'visibility', hidden: document.hidden });
	};

	dispose(): void {
		if (this.#disposed) return;
		void this.flushTitles();
		this.#disposed = true;
		if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#onVisibility);
		this.#socket?.dispose();
		for (const t of this.#titleTimers.values()) this.#clock.clearTimeout(t);
		for (const l of this.#layers) if (l.timer) this.#clock.clearTimeout(l.timer);
		if (this.#treeTimer) this.#clock.clearTimeout(this.#treeTimer);
		if (this.#cacheTimer) this.#clock.clearTimeout(this.#cacheTimer);
		if (this.#registryTimer) this.#clock.clearTimeout(this.#registryTimer);
		if (this.#directoryTimer) this.#clock.clearTimeout(this.#directoryTimer);
	}

	/** True for the store the server renders with: nothing may schedule work or read the network then (the render answers one request). */
	get #renderingOnServer(): boolean {
		return this.#o.renderingOnServer === true;
	}

	get #clock(): Clock {
		return (
			this.#o.clock ?? {
				setTimeout: (fn, ms) => setTimeout(fn, ms),
				clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
				random: () => Math.random()
			}
		);
	}

	#cache(): CacheBackend | null {
		if (this.#o.cache === null) return null;
		return (this.#o.cache ??= defaultCache());
	}

	#notify(t: Toasty): void {
		this.#o.notify?.(t);
	}

	#fatal(action: FatalAction, code: number, reason: string): void {
		if (action === 'reload') this.outdated = true;
		else if (action === 'reauth') this.closed = 'reauth';
		else this.closed = code === 4410 ? 'gone' : 'forbidden';
		this.#o.onFatal?.(action, code, reason);
	}

	/** The socket, for tests and the oRPC-over-socket client. */
	get socket(): WorkspaceSocket | null {
		return this.#socket;
	}

	// ───────────────────────────── registry and directory ─────────────────────────────

	async refreshProperties(force = false): Promise<void> {
		// What the server render read a moment ago (`seed`) is as fresh as a fetch, until a commit says otherwise (`welcome`).
		if (this.#seedFresh && !force) return;
		const version = this.#defVersion;
		try {
			const list = await this.#rpc.property.list();
			// A definition write started meanwhile: its own refresh follows, and this answer is older.
			if (version !== this.#defVersion) return;
			this.#setRegistry(list);
		} catch {
			// the registry only gates optimistic validation; the server validates for real
		}
	}

	async refreshDirectory(force = false): Promise<void> {
		if (this.#seedFresh && !force) return;
		const [members, teamspaces] = await Promise.allSettled([
			this.#rpc.workspace.members.list(),
			this.#rpc.workspace.teamspaces.list()
		]);
		if (members.status === 'fulfilled') this.members = members.value;
		if (teamspaces.status === 'fulfilled') {
			this.teamspaces = teamspaces.value;
			await this.#loadTeamspaceRanks(teamspaces.value);
		}
	}

	/** My sidebar order: each of my teamspaces carries my own `rank` in its member list. */
	async #loadTeamspaceRanks(list: readonly Teamspace[]): Promise<void> {
		const mine = list.filter((t) => t.myRole !== null);
		const results = await Promise.allSettled(mine.map((t) => this.#rpc.workspace.teamspaces.members.list({ teamspaceId: t.id })));
		const ranks: Record<string, string> = {};
		results.forEach((r, i) => {
			if (r.status !== 'fulfilled') return;
			const me = r.value.find((m) => m.userId === this.user.id);
			if (me) ranks[mine[i].id] = me.rank;
		});
		this.teamspaceRanks = ranks;
	}

	/** The teamspaces I belong to, in my sidebar order. */
	get myTeamspaces(): Teamspace[] {
		const ranks = this.teamspaceRanks;
		return this.teamspaces
			.filter((t) => t.myRole !== null)
			.sort((a, b) => compareRank(ranks[a.id] ?? '', ranks[b.id] ?? '') || a.name.localeCompare(b.name));
	}

	/** True when the workspace role (owner, admin) holds `full` on everything. */
	get isAdmin(): boolean {
		return this.workspace.role === 'owner' || this.workspace.role === 'admin';
	}

	/**
	 * A page in a teamspace the directory does not list (I was just added to it, or it was just created):
	 * the directory is not pushed, so it is fetched again.
	 */
	#checkTeamspaces(ids: Iterable<string>): void {
		if (!this.ready && this.teamspaces.length === 0 && this.members.length === 0) return;
		for (const id of ids) {
			const ts = this.#base.get(id)?.teamspaceId;
			if (ts && !this.teamspaces.some((t) => t.id === ts)) return this.#scheduleDirectoryRefresh();
		}
	}

	#scheduleDirectoryRefresh(): void {
		if (this.#directoryTimer || this.#disposed || this.#renderingOnServer) return;
		this.#directoryTimer = this.#clock.setTimeout(() => {
			this.#directoryTimer = null;
			void this.refreshDirectory(true);
		}, 150);
	}

	/** Debounced registry refresh: another client created a property or an option. */
	#scheduleRegistryRefresh(): void {
		if (this.#registryTimer || this.#disposed || this.#renderingOnServer) return;
		this.#registryTimer = this.#clock.setTimeout(() => {
			this.#registryTimer = null;
			void this.refreshProperties(true);
		}, 150);
	}

	// ───────────────────────────── subscriptions ─────────────────────────────

	/**
	 * Holds a subscription (reference counted by id). Identical ids share one subscription; the
	 * returned function releases this holder.
	 */
	subscribe(id: string, sub: Subscription): () => void {
		return untrack(() => this.#subscribe(id, sub));
	}

	#subscribe(id: string, sub: Subscription): () => void {
		const held = this.#subs.get(id);
		if (held) {
			held.count++;
			if (JSON.stringify(held.sub) !== JSON.stringify(sub)) {
				held.sub = sub;
				this.#openWindow(id, sub);
				this.#send({ t: 'subscribe', id, sub });
			}
		} else {
			// A window the server render seeded under this id and subscription is claimed without a message: the socket's `hello` holds
			// it (with `lastSeq`), so the server replays what happened since instead of sending the snapshot again.
			const seeded = this.#unclaimed.delete(id) && !this.#helloSent && JSON.stringify(this.windows.get(id)?.sub) === JSON.stringify(sub);
			this.#subs.set(id, { sub, count: 1 });
			this.#openWindow(id, sub);
			if (!seeded) this.#send({ t: 'subscribe', id, sub });
		}
		let released = false;
		return () =>
			untrack(() => {
				if (released) return;
				released = true;
				const h = this.#subs.get(id);
				if (!h) return;
				if (--h.count > 0) return;
				this.#subs.delete(id);
				this.#closeWindow(id);
				this.#send({ t: 'unsubscribe', id });
			});
	}

	#openWindow(id: string, sub: Subscription): void {
		const prev = this.windows.get(id);
		this.windows.set(id, {
			id,
			kind: sub.kind,
			sub,
			status: prev?.status === 'ready' ? 'ready' : 'pending',
			ids: prev?.ids ?? [],
			rows: prev?.rows ?? new Map(),
			total: prev?.total ?? 0,
			seq: prev?.seq ?? null,
			...(prev?.groups ? { groups: prev.groups } : {})
		});
	}

	#closeWindow(id: string): void {
		const w = this.windows.get(id);
		this.windows.delete(id);
		this.#awaitingWindow.delete(id);
		this.#pendingDiffs.delete(id);
		if (w) this.#gc(new Set(w.ids));
	}

	/**
	 * Grows or shrinks a view window; `group` addresses one group of a grouped view (the limit of the others is
	 * unchanged). A group's limit is not part of the held subscription, so a reconnect resubscribes with the
	 * view's own `limit` for every group.
	 */
	setWindow(id: string, limit: number, group?: string): void {
		const held = this.#subs.get(id);
		if (held && held.sub.kind === 'view' && group === undefined) held.sub = { ...held.sub, limit };
		this.#awaitingWindow.add(id);
		this.#send({ t: 'window', id, limit, ...(group !== undefined ? { group } : {}) });
	}

	/**
	 * Grows a flat view window to `want` rows, at most `MAX_WINDOW` (the protocol's cap, 1000 rows per view or group:
	 * past it a view is searched or filtered, not scrolled). A request that is not larger than the one already out
	 * is dropped, so a scroll handler may call it on every event.
	 */
	growWindow(id: string, want: number): void {
		const held = this.#subs.get(id);
		if (!held || held.sub.kind !== 'view') return;
		const target = Math.min(MAX_WINDOW, want);
		if (target <= held.sub.limit) return;
		this.setWindow(id, target);
	}

	/** Asks the server for a fresh snapshot of a held subscription (a view's definition changed). */
	resubscribe(id: string): void {
		const held = this.#subs.get(id);
		if (!held) return;
		this.#send({ t: 'subscribe', id, sub: held.sub });
	}

	/** The share of the document quota last shown for a page, so a toast appears once per five points. */
	readonly #quotaShown = new Map<string, number>();

	#send(msg: ClientMessage): void {
		this.#socket?.send(msg);
	}

	#hello(): { lastSeq: number | null; subs: SubscriptionEntry[]; extra: ClientMessage[] } {
		this.#helloSent = true;
		// Seeded windows nobody subscribed to (the page changed before they were used) are not held by the server: drop them.
		if (this.#unclaimed.size) {
			for (const id of this.#unclaimed) {
				const w = this.windows.get(id);
				if (w && !this.#subs.has(id)) {
					this.windows.delete(id);
					this.#gc(new Set(w.ids));
				}
			}
			this.#unclaimed.clear();
		}
		const entries = (ws: WindowState[]) => ws.map((w) => ({ id: w.id, sub: this.#subs.get(w.id)?.sub ?? w.sub }));
		const all = [...this.windows.values()].filter((w) => this.#subs.has(w.id));
		const extra: ClientMessage[] = [];
		let lastSeq: number | null = null;
		let subs: SubscriptionEntry[];
		if (this.seq !== null) {
			// We hold state: ask the server to replay what we missed for the subscriptions we hold,
			// and subscribe afresh to the rest.
			lastSeq = this.seq;
			const held = all.filter((w) => w.status === 'ready');
			subs = entries(held);
			for (const w of all) if (w.status !== 'ready') extra.push({ t: 'subscribe', id: w.id, sub: this.#subs.get(w.id)?.sub ?? w.sub });
		} else {
			subs = entries(all);
		}
		this.#resumedMode = null;
		if (this.#myPage) extra.push({ t: 'presence', pageId: this.#myPage });
		// A tab that connects while hidden says so: an overloaded object does not re-evaluate its views (docs/PLAN.md runbook).
		if (typeof document !== 'undefined' && document.hidden) extra.push({ t: 'visibility', hidden: true });
		return { lastSeq, subs, extra };
	}

	// ───────────────────────────── tree ─────────────────────────────

	/** Opens a branch of the sidebar: its children are subscribed. */
	expand(id: string): void {
		if (this.#expanded.has(id)) return;
		this.#expanded.add(id);
		this.expanded = new Set([...this.#expanded].filter((x): x is string => x !== null));
		writeExpandedCookie(this.workspace.id, this.expanded);
		this.#scheduleTree();
	}

	collapse(id: string): void {
		if (!this.#expanded.delete(id)) return;
		this.expanded = new Set([...this.#expanded].filter((x): x is string => x !== null));
		writeExpandedCookie(this.workspace.id, this.expanded);
		this.#scheduleTree();
	}

	toggle(id: string): void {
		if (this.#expanded.has(id)) this.collapse(id);
		else this.expand(id);
	}

	isExpanded(id: string): boolean {
		return this.expanded.has(id);
	}

	/** `loading` between expanding a branch and the snapshot that carries its children. */
	branchState(id: string): 'collapsed' | 'loading' | 'ready' {
		if (!this.expanded.has(id)) return 'collapsed';
		return this.#loadedParents.has(id) && this.windows.get(TREE_ID)?.status === 'ready' ? 'ready' : 'loading';
	}

	#scheduleTree(): void {
		if (this.#treeTimer || this.#renderingOnServer) return;
		this.#treeTimer = this.#clock.setTimeout(() => {
			this.#treeTimer = null;
			this.#syncTreeNow(true);
		}, 20);
	}

	/** Registers the `tree` subscription (start() does this; tests that feed `receive` call it). */
	initTree(): void {
		this.#syncTreeNow(false);
	}

	#syncTreeNow(send: boolean): void {
		const sub: Subscription = { kind: 'tree', parents: [...this.#expanded] };
		const held = this.#subs.get(TREE_ID);
		if (held) held.sub = sub;
		else this.#subs.set(TREE_ID, { sub, count: 1 });
		const prev = this.windows.get(TREE_ID);
		this.windows.set(TREE_ID, {
			id: TREE_ID,
			kind: 'tree',
			sub,
			status: prev?.status ?? 'pending',
			ids: prev?.ids ?? [],
			rows: new Map(),
			total: prev?.total ?? 0,
			seq: prev?.seq ?? null
		});
		if (send) this.#send({ t: 'subscribe', id: TREE_ID, sub });
	}

	// ───────────────────────────── receiving ─────────────────────────────

	/** Feeds one server message into the store. The socket calls this; tests call it directly. */
	receive(msg: ServerMessage): void {
		switch (msg.t) {
			case 'welcome':
				this.#awaitingWindow.clear();
				// The first welcome of a store the server render seeded: if the log moved on since the render read it, a definition may
				// have changed in between (pushes only reach connected tabs), so the registry, the directory and the collections are read again.
				if (!this.#welcomed && this.#seedFresh && this.#seededSeq !== null && msg.seq > this.#seededSeq) {
					this.#seedFresh = false;
					this.#scheduleCollectionsRefresh();
					this.#scheduleRegistryRefresh();
					this.#scheduleDirectoryRefresh();
				}
				// A reconnect: definition changes pushed while the socket was down (the log replays page and
				// value changes, not the registry or the directory) are fetched again.
				if (this.#welcomed) {
					this.#scheduleCollectionsRefresh();
					this.#scheduleRegistryRefresh();
					this.#scheduleDirectoryRefresh();
					this.#o.onReconnect?.();
				}
				this.#welcomed = true;
				return;
			case 'quota': {
				// "Warn at 80% of the document quota": once per page, again at every five points more.
				const share = Math.floor((msg.bytes / msg.limit) * 20) / 20;
				if ((this.#quotaShown.get(msg.pageId) ?? 0) >= share) return;
				this.#quotaShown.set(msg.pageId, share);
				this.#notify({
					kind: 'info',
					title: 'This page is nearly full',
					description: `Its content is ${Math.round((msg.bytes / msg.limit) * 100)}% of the size limit; past it, edits are refused. Split it into subpages.`
				});
				return;
			}
			case 'lock':
				this.#o.onLock?.({ pageId: msg.pageId, locked: msg.locked, lockedBy: msg.lockedBy, lockedAt: msg.lockedAt });
				return;
			case 'registry':
				// A view or collection definition changed (a view made in another tab shows up here without a refocus).
				if (msg.scopes.includes('collections')) this.#scheduleCollectionsRefresh();
				if (msg.scopes.includes('properties')) this.#scheduleRegistryRefresh();
				if (msg.scopes.includes('directory')) this.#scheduleDirectoryRefresh();
				return;
			case 'resumed':
				this.#resumedMode = msg.mode;
				if (msg.mode === 'snapshot') {
					// Fresh snapshots follow for every subscription: until then what is on screen is stale.
					this.seq = null;
					for (const [id, w] of this.windows) this.windows.set(id, { ...w, status: 'pending' });
				}
				return;
			case 'snapshot':
				this.#applySnapshot(msg);
				return;
			case 'diff':
				this.#applyDiff(msg);
				return;
			case 'head':
				this.#advance(msg.seq);
				// The end of a replay: the cached state has caught up with the log.
				if (this.stale && this.#resumedMode === 'replay') this.stale = false;
				// Nothing the held windows show changed up to `seq` (a `head` says so, and a replay ends with one), so they are current as of it. A
				// window that was read earlier (seeded by the server render, or kept across a reconnect) must not look older than the log: the answer to a
				// resize is a diff at the log's head, and one "at or below" the window's position is taken for a duplicate (`#applyDiff`).
				for (const [id, w] of this.windows) {
					if (w.status === 'ready' && w.seq !== null && w.seq < msg.seq && this.#subs.has(id)) this.windows.set(id, { ...w, seq: msg.seq });
				}
				return;
			case 'presence':
				for (const entry of msg.entries) {
					if (entry.users.length) this.presence.set(entry.pageId, entry.users);
					else this.presence.delete(entry.pageId);
				}
				return;
			case 'notification':
				this.notifications = [msg.notification, ...this.notifications.filter((n) => n.id !== msg.notification.id)].slice(0, 100);
				if (msg.notification.kind === 'access_changed' || msg.notification.kind === 'page_shared') this.#scheduleDirectoryRefresh();
				return;
			case 'error': {
				if (msg.id) {
					const w = this.windows.get(msg.id);
					if (w) this.windows.set(msg.id, { ...w, status: 'error', error: msg.code });
					this.#pendingDiffs.delete(msg.id);
				} else if (msg.code === 'forbidden') {
					this.closed = 'forbidden';
				}
				return;
			}
			case 'pong':
				return;
		}
	}

	#advance(seq: number): void {
		if (this.seq === null || seq > this.seq) this.seq = seq;
		this.#dropDelivered();
		this.#scheduleCache();
	}

	#applySnapshot(msg: SnapshotMessage): void {
		const w = this.windows.get(msg.id);
		if (!w) return;
		const touched = new Set<string>(w.ids);
		const ids: string[] = [];
		const rows = new Map<string, ViewRow | BacklinkRow>();
		let groups: GroupWindow[] | undefined;
		if (msg.kind === 'tree') {
			for (const row of msg.rows) {
				this.#base.set(row.id, entityFromTree(row, this.#base.get(row.id)));
				ids.push(row.id);
				touched.add(row.id);
			}
			const parents = (this.#subs.get(msg.id)?.sub ?? w.sub) as Extract<Subscription, { kind: 'tree' }>;
			this.#loadedParents = new Set((parents.parents ?? []).map(key));
		} else if (msg.kind === 'page') {
			for (const row of msg.rows) {
				this.#base.set(row.id, entityFromPage(row));
				ids.push(row.id);
				touched.add(row.id);
			}
		} else if (msg.kind === 'view') {
			const all = msg.groups ? msg.groups.flatMap((g) => g.rows) : msg.rows;
			for (const row of all) {
				if (!rows.has(row.id)) ids.push(row.id);
				rows.set(row.id, row);
			}
			if (msg.groups) {
				groups = msg.groups.map((g) => ({ key: g.key, total: g.total, ids: g.rows.map((r) => r.id) }));
			}
		} else {
			for (const row of msg.rows) {
				ids.push(row.id);
				rows.set(row.id, row);
			}
		}
		this.windows.set(msg.id, { ...w, status: 'ready', ids, rows, total: msg.total, seq: msg.seq, groups, error: undefined });
		if (w.kind === 'tree' || w.kind === 'page') {
			const keep = new Set(ids);
			this.#gc(new Set([...touched].filter((id) => !keep.has(id))));
			this.#touch(touched);
			this.#checkTeamspaces(ids);
		}
		this.#advance(msg.seq);
		if (msg.id === TREE_ID) {
			this.ready = true;
			this.stale = false;
		}
		// Diffs that raced ahead of this snapshot.
		const buffered = this.#pendingDiffs.get(msg.id);
		if (buffered) {
			this.#pendingDiffs.delete(msg.id);
			buffered.sort((a, b) => a.seq - b.seq);
			for (const frame of buffered) if (frame.seq > msg.seq) this.#applyDiffTo(frame, msg.id);
			const last = buffered.at(-1);
			if (last) this.#advance(last.seq);
		}
		this.#ensureAncestors();
	}

	#applyDiff(msg: DiffFrame): void {
		// The answer to a `window` message carries the log's head: no newer than what the window holds.
		const answersWindow = (id: string) => {
			const w = this.windows.get(id);
			return this.#awaitingWindow.has(id) && !!w && w.status === 'ready' && w.seq !== null && msg.seq <= w.seq;
		};
		if (this.seq !== null && msg.seq <= this.seq && !msg.subs.some((s) => this.windows.get(s.id)?.status === 'pending' || answersWindow(s.id))) {
			return; // already applied (a replay overlapping what we hold)
		}
		for (const s of msg.subs) {
			const w = this.windows.get(s.id);
			if (!w) continue;
			if (w.status === 'pending') {
				const list = this.#pendingDiffs.get(s.id) ?? [];
				list.push({ ...msg, subs: [s] });
				this.#pendingDiffs.set(s.id, list);
				continue;
			}
			if (answersWindow(s.id)) {
				this.#awaitingWindow.delete(s.id);
			} else if (w.seq !== null && msg.seq <= w.seq) continue;
			this.#applyDiffTo({ ...msg, subs: [s] }, s.id);
		}
		// Frames held for a snapshot do not advance the log position past it.
		if (!msg.subs.some((s) => this.windows.get(s.id)?.status === 'pending')) this.#advance(msg.seq);
		else this.#dropDelivered();
		this.#ensureAncestors();
	}

	#applyDiffTo(frame: DiffFrame, id: string): void {
		const w = this.windows.get(id);
		const ops = frame.subs.find((s) => s.id === id)?.ops;
		if (!w || !ops) return;
		if (w.kind === 'view') {
			this.windows.set(id, { ...this.#applyViewOps(w, ops), seq: Math.max(w.seq ?? 0, frame.seq) });
			return;
		}
		const shared = w.kind === 'tree' || w.kind === 'page';
		const ids = [...w.ids];
		const rows = new Map(w.rows);
		let total = w.total;
		const touched = new Set<string>();
		const dropped = new Set<string>();
		for (const op of ops) total = this.#applyOp(op, shared, ids, rows, total, touched, dropped);
		this.windows.set(id, { ...w, ids, rows, total, seq: Math.max(w.seq ?? 0, frame.seq) });
		if (shared) {
			this.#gc(dropped);
			this.#touch(touched);
			this.#checkTeamspaces(touched);
		}
	}

	#applyOp(
		op: DiffOp,
		shared: boolean,
		ids: string[],
		rows: Map<string, ViewRow | BacklinkRow>,
		total: number,
		touched: Set<string>,
		dropped: Set<string>
	): number {
		switch (op.op) {
			case 'add': {
				const row = op.row;
				const at = Math.min(op.index, ids.length);
				const existing = ids.indexOf(row.id);
				if (existing !== -1) ids.splice(existing, 1);
				ids.splice(at > ids.length ? ids.length : at, 0, row.id);
				if (shared) {
					if (isPageRow(row)) this.#base.set(row.id, entityFromPage(row));
					else if (isTreeRow(row)) this.#base.set(row.id, entityFromTree(row, this.#base.get(row.id)));
					touched.add(row.id);
					if (isTreeRow(row) && row.parentId) {
						// A new child: its parent now has children even if the server's row says otherwise.
						const parent = this.#base.get(row.parentId);
						if (parent && !parent.hasChildren) {
							this.#base.set(parent.id, { ...parent, hasChildren: true });
							touched.add(parent.id);
						}
					}
				} else {
					rows.set(row.id, row as ViewRow | BacklinkRow);
				}
				return existing === -1 ? total + 1 : total;
			}
			case 'remove': {
				const i = ids.indexOf(op.id);
				if (i === -1) return total;
				ids.splice(i, 1);
				if (shared) {
					dropped.add(op.id);
					touched.add(op.id);
				} else rows.delete(op.id);
				return Math.max(0, total - 1);
			}
			case 'move': {
				const i = ids.indexOf(op.id);
				if (i === -1) return total;
				ids.splice(i, 1);
				ids.splice(Math.min(op.index, ids.length), 0, op.id);
				return total;
			}
			case 'update': {
				if (shared) {
					const e = this.#base.get(op.id);
					if (e) {
						if (!op.prop.startsWith('$') && op.prop !== SYSTEM_TITLE && !this.#registry.get(op.prop)) this.#scheduleRegistryRefresh();
						this.#base.set(op.id, updateEntity(e, op.prop, op.value));
						touched.add(op.id);
						// A page changing parent leaves the old parent's window.
					}
				} else {
					const row = rows.get(op.id) as ViewRow | undefined;
					if (row) {
						if (op.prop === SYSTEM_TITLE) rows.set(op.id, { ...row, title: typeof op.value === 'string' ? op.value : '' });
						else if (op.prop === '$icon') rows.set(op.id, { ...row, icon: (op.value as string | null) ?? null });
						else if (op.prop === '$cover') rows.set(op.id, { ...row, cover: (op.value as string | null) ?? null });
						else rows.set(op.id, { ...row, values: { ...row.values, [op.prop]: op.value } });
					}
				}
				return total;
			}
			case 'count':
				return op.total;
			case 'groups':
				return total;
		}
	}

	/** The group-by of a view subscription: its own override, else its saved view's. */
	#groupSpecOf(w: WindowState): GroupBySpec | null {
		if (w.sub.kind !== 'view') return null;
		if (w.sub.groupBy !== undefined) return w.sub.groupBy;
		const sub = w.sub;
		return this.views.get(sub.collectionId)?.find((v) => v.id === (sub.viewId ?? this.views.get(sub.collectionId)?.[0]?.id))?.groupBy ?? null;
	}

	/**
	 * Applies the ops of one commit to a `view` window, flat or grouped. In a grouped window `add`, `remove`
	 * and `move` name their group (a row changing group is a `remove` and an `add`), `count` carries a group's
	 * total (or the window's, without `group`), and `update` is row-level. A `groups` op carries the ordered group
	 * keys (created empty, dropped or reordered); an `add` naming a group the window lacks creates it as a
	 * fallback, where the group-by order puts it.
	 */
	#applyViewOps(w: WindowState, ops: DiffOp[]): WindowState {
		const rows = new Map(w.rows);
		const ids = [...w.ids];
		const groups = w.groups ? w.groups.map((g) => ({ ...g, ids: [...g.ids] })) : undefined;
		let total = w.total;
		const findGroup = (key: string | undefined) => groups?.find((g) => g.key === (key ?? GROUP_EMPTY));
		const heldAnywhere = (id: string) => (groups ? groups.some((g) => g.ids.includes(id)) : ids.includes(id));
		const drop = (id: string) => {
			if (heldAnywhere(id)) return;
			rows.delete(id);
			const i = ids.indexOf(id);
			if (i !== -1) ids.splice(i, 1);
		};
		for (const op of ops) {
			switch (op.op) {
				case 'add': {
					const row = op.row as ViewRow;
					rows.set(row.id, row);
					if (groups) {
						if (!ids.includes(row.id)) ids.push(row.id);
						const g = findGroup(op.group) ?? this.#newGroup(groups, op.group ?? GROUP_EMPTY, this.#groupSpecOf(w));
						const had = g.ids.indexOf(row.id);
						if (had !== -1) g.ids.splice(had, 1);
						else g.total += 1;
						g.ids.splice(Math.min(op.index, g.ids.length), 0, row.id);
					} else {
						const had = ids.indexOf(row.id);
						if (had !== -1) ids.splice(had, 1);
						else total += 1;
						ids.splice(Math.min(op.index, ids.length), 0, row.id);
					}
					break;
				}
				case 'remove': {
					if (groups) {
						const targets = op.group !== undefined ? [findGroup(op.group)] : groups;
						for (const g of targets) {
							const i = g?.ids.indexOf(op.id) ?? -1;
							if (g && i !== -1) {
								g.ids.splice(i, 1);
								g.total = Math.max(0, g.total - 1);
							}
						}
						drop(op.id);
					} else {
						const i = ids.indexOf(op.id);
						if (i === -1) break;
						ids.splice(i, 1);
						rows.delete(op.id);
						total = Math.max(0, total - 1);
					}
					break;
				}
				case 'move': {
					const list = groups ? findGroup(op.group)?.ids : ids;
					if (!list) break;
					const i = list.indexOf(op.id);
					if (i === -1) break;
					list.splice(i, 1);
					list.splice(Math.min(op.index, list.length), 0, op.id);
					break;
				}
				case 'update': {
					const row = rows.get(op.id) as ViewRow | undefined;
					if (!row) break;
					if (op.prop === SYSTEM_TITLE) rows.set(op.id, { ...row, title: typeof op.value === 'string' ? op.value : '' });
					else if (op.prop === '$icon') rows.set(op.id, { ...row, icon: (op.value as string | null) ?? null });
					else if (op.prop === '$cover') rows.set(op.id, { ...row, cover: (op.value as string | null) ?? null });
					else if (op.prop === '$rank') rows.set(op.id, typeof op.value === 'string' ? { ...row, rank: op.value } : row);
					else if (op.prop === '$parent') rows.set(op.id, { ...row, parentId: (op.value as string | null) ?? null });
					else if (op.prop === '$access') rows.set(op.id, { ...row, access: op.value as AccessLevel });
					else if (op.prop.startsWith('$')) break;
					else rows.set(op.id, { ...row, values: { ...row.values, [op.prop]: op.value } });
					break;
				}
				case 'groups': {
					if (!groups) break;
					// The server's ordered list of group keys: new ones start empty, missing ones go, the rest reorder.
					const next = op.keys.map((key) => groups.find((g) => g.key === key) ?? ({ key, total: 0, ids: [] } as GroupWindow));
					groups.splice(0, groups.length, ...next);
					for (const id of [...rows.keys()]) drop(id);
					break;
				}
				case 'count': {
					if (groups && op.group !== undefined) {
						const g = findGroup(op.group);
						if (g) g.total = op.total;
					} else total = op.total;
					break;
				}
			}
		}
		let kept = groups;
		return { ...w, ids, rows, total, ...(kept ? { groups: kept } : {}) };
	}

	/** Inserts an empty group where the group-by order puts it. */
	#newGroup(groups: GroupWindow[], key: string, spec: GroupBySpec | null): GroupWindow {
		const g: GroupWindow = { key, total: 0, ids: [] };
		const empty = groups.findIndex((x) => x.key === GROUP_EMPTY);
		const end = empty === -1 ? groups.length : empty;
		if (key === GROUP_EMPTY) {
			groups.push(g);
			return g;
		}
		const def = spec ? this.#registry.get(spec.prop) : undefined;
		const options = def && (def.type === 'select' || def.type === 'status' || def.type === 'multi_select') ? def.config.options.map((o) => o.id) : [];
		const sort = spec?.sort ?? 'manual';
		let at = end;
		if (sort === 'manual' && options.length) {
			const rank = options.indexOf(key);
			at = groups.findIndex((x, i) => i < end && options.indexOf(x.key) > rank);
			if (at === -1) at = end;
		} else {
			const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0) * (sort === 'desc' ? -1 : 1);
			at = groups.findIndex((x, i) => i < end && cmp(x.key, key) > 0);
			if (at === -1) at = end;
		}
		groups.splice(at, 0, g);
		return g;
	}

	/** Removes base entities no tree or page window holds any more. */
	#gc(candidates: Set<string>): void {
		if (!candidates.size) return;
		const held = new Set<string>();
		for (const w of this.windows.values()) if (w.kind === 'tree' || w.kind === 'page') for (const id of w.ids) held.add(id);
		const dropped: string[] = [];
		for (const id of candidates) {
			if (held.has(id)) continue;
			if (this.#base.delete(id)) dropped.push(id);
		}
		if (dropped.length) this.#touch(new Set(dropped));
	}

	// ───────────────────────────── layers: the visible state ─────────────────────────────

	/** Recomputes the visible entity of each id (server state, layers, title drafts). */
	#touch(ids: Iterable<string>): void {
		for (const id of ids) {
			const e = this.#compute(id);
			if (e) {
				const cur = this.pages.get(id);
				if (!cur || !sameEntity(cur, e)) this.pages.set(id, e);
			} else if (this.pages.has(id)) this.pages.delete(id);
		}
	}

	#touchAll(): void {
		const ids = new Set<string>([...this.#base.keys(), ...this.pages.keys()]);
		for (const l of this.#layers) for (const id of opPages(l.ops)) ids.add(id);
		this.#touch(ids);
	}

	#compute(id: string): PageEntity | undefined {
		let e = this.#base.get(id);
		for (const layer of this.#layers) for (const op of layer.ops) e = this.#applyLayerOp(e, op, id);
		const draft = this.#drafts.get(id);
		if (e && draft !== undefined) e = { ...e, title: draft };
		return e;
	}

	#applyLayerOp(e: PageEntity | undefined, op: Op, id: string): PageEntity | undefined {
		switch (op.op) {
			case 'create': {
				if (op.id === id) return e ?? entityFromCreate(op, this.user.id);
				if (e && op.parentId === id && !e.hasChildren) return { ...e, hasChildren: true };
				return e;
			}
			case 'setProp':
			case 'addOption':
			case 'removeOption': {
				if (!e || op.page !== id) return e;
				return this.#applyValue(e, op);
			}
			case 'move': {
				if (e && op.page === id) {
					return {
						...e,
						parentId: op.parentId,
						rank: op.rank,
						teamspaceId: op.teamspaceId !== undefined ? op.teamspaceId : e.teamspaceId
					};
				}
				if (e && op.parentId === id && !e.hasChildren) return { ...e, hasChildren: true };
				return e;
			}
			case 'trash':
				return op.page === id ? undefined : e;
			case 'setPage': {
				if (!e || op.page !== id) return e;
				return {
					...e,
					icon: op.icon !== undefined ? op.icon : e.icon,
					cover: op.cover !== undefined ? op.cover : e.cover
				};
			}
			default:
				return e;
		}
	}

	#applyValue(e: PageEntity, op: ValueOp): PageEntity {
		if (op.prop === SYSTEM_TITLE) {
			if (op.op !== 'setProp') return e;
			return { ...e, title: typeof op.value === 'string' ? op.value : '' };
		}
		const def = this.#registry.get(op.prop);
		const current = e.values[op.prop] ?? null;
		if (!def) {
			// Registry not loaded yet: a plain setProp still shows; the server validates.
			return op.op === 'setProp' ? { ...e, values: { ...e.values, [op.prop]: op.value } } : e;
		}
		const r = applyValueOp(def, current, op);
		return r.ok ? { ...e, values: { ...e.values, [op.prop]: r.value } } : e;
	}

	#dropDelivered(): void {
		if (this.seq === null) return;
		const keep: Layer[] = [];
		const touched = new Set<string>();
		for (const l of this.#layers) {
			if (l.seq !== null && l.seq <= this.seq) {
				if (l.timer) this.#clock.clearTimeout(l.timer);
				for (const id of opPages(l.ops)) touched.add(id);
			} else keep.push(l);
		}
		if (keep.length === this.#layers.length) return;
		this.#layers = keep;
		this.pending = keep.length;
		this.#touch(touched);
	}

	/** Number of optimistic layers alive, for tests and the "saving" indicator. */
	get layerCount(): number {
		return this.#layers.length;
	}

	// ───────────────────────────── writes ─────────────────────────────

	/**
	 * Applies `ops` optimistically and sends them. Resolves with the commit's `seq`; rejects (after
	 * rolling the layer back and raising a notification) when the call fails.
	 */
	async mutate(ops: Op[], send?: MutationSender): Promise<{ seq: number }> {
		if (!this.canEdit) {
			this.#notify({ kind: 'error', title: 'You are offline', description: 'Edits to properties and the page tree need a connection.' });
			throw new OfflineError();
		}
		for (const op of ops) {
			if (op.op === 'setProp' || op.op === 'addOption' || op.op === 'removeOption') {
				if (op.prop === SYSTEM_TITLE) continue;
				const def = this.#registry.get(op.prop);
				if (!def) continue;
				const cur = this.#base.get(op.page)?.values[op.prop] ?? null;
				const r = applyValueOp(def, cur, op);
				if (!r.ok) {
					this.#notify({ kind: 'error', title: 'That value is not allowed', description: r.issues[0]?.message });
					throw new Error(r.issues[0]?.message ?? 'Invalid value');
				}
			}
		}
		const mid = `${this.clientId}-${++this.#midCounter}`;
		const layer: Layer = { mid, ops, seq: null, timer: null };
		this.#layers.push(layer);
		this.pending = this.#layers.length;
		this.#touch(opPages(ops));
		let result: { seq: number };
		try {
			result = await (send ?? ((m) => this.#sendWithRetry(() => this.#rpc.mutate({ mid: m, ops, appVersion: this.#o.appVersion ?? APP_VERSION }))))(mid);
		} catch (error) {
			this.#rollback(layer);
			this.#notify(failure(error));
			throw error;
		}
		layer.seq = result.seq;
		if (this.#layers.includes(layer)) {
			// The socket may already have delivered it.
			this.#dropDelivered();
			if (this.#layers.includes(layer)) {
				const arm = (): void => {
					layer.timer = this.#clock.setTimeout(() => {
						layer.timer = null;
						if (!this.#layers.includes(layer)) return;
						// Offline the head cannot come: keep waiting. Online and still waiting means it
						// never will: show the server's state again.
						if (this.status !== 'online') arm();
						else this.#rollback(layer);
					}, this.#o.layerTimeoutMs ?? 15_000);
				};
				arm();
			}
		}
		return result;
	}

	/**
	 * A workspace that is busy answers 503 `SERVICE_UNAVAILABLE` (its object's queue is long): the same mutation, same id, goes out
	 * again after a pause (the object returns the first answer to a retry it already applied), up to four more times. Anything else fails at once.
	 */
	async #sendWithRetry(call: () => Promise<{ seq: number }>): Promise<{ seq: number }> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await call();
			} catch (error) {
				if (attempt >= 4 || (error as { code?: unknown } | null)?.code !== 'SERVICE_UNAVAILABLE') throw error;
				await new Promise<void>((resolve) => this.#clock.setTimeout(resolve, 250 * 2 ** attempt + Math.random() * 100));
			}
		}
	}

	#rollback(layer: Layer): void {
		if (layer.timer) this.#clock.clearTimeout(layer.timer);
		const i = this.#layers.indexOf(layer);
		if (i === -1) return;
		this.#layers.splice(i, 1);
		this.pending = this.#layers.length;
		this.#touch(opPages(layer.ops));
	}

	/** Title edit: last writer wins. The text shows at once; the `setProp` goes out after a pause. */
	setTitle(id: string, title: string): void {
		if (!this.canEdit) {
			this.#notify({ kind: 'error', title: 'You are offline', description: 'Titles can be edited again when you reconnect.' });
			return;
		}
		this.#drafts.set(id, title);
		this.#touch([id]);
		const t = this.#titleTimers.get(id);
		if (t) this.#clock.clearTimeout(t);
		this.#titleTimers.set(
			id,
			this.#clock.setTimeout(() => void this.#flushTitle(id), this.#o.titleDebounceMs ?? 250)
		);
	}

	async #flushTitle(id: string): Promise<void> {
		const t = this.#titleTimers.get(id);
		if (t) this.#clock.clearTimeout(t);
		this.#titleTimers.delete(id);
		const title = this.#drafts.get(id);
		if (title === undefined) return;
		const op: SetPropOp = { op: 'setProp', page: id, prop: TITLE_PROP_ID, value: title };
		// mutate pushes its layer before it awaits, so the draft can go at once.
		const p = this.mutate([op]);
		this.#drafts.delete(id);
		try {
			await p;
		} catch {
			// rolled back and reported by mutate
		}
	}

	/** Sends every pending title edit now (navigation, tab close). */
	async flushTitles(): Promise<void> {
		await Promise.all([...this.#titleTimers.keys()].map((id) => this.#flushTitle(id)));
	}

	/** `setPage` for the icon and the cover. */
	setPage(id: string, patch: { icon?: string | null; cover?: string | null }): Promise<{ seq: number }> {
		return this.mutate([{ op: 'setPage', page: id, ...patch }]);
	}

	/**
	 * Creates a page and resolves with its id once the server accepted it. It appears in the tree at
	 * once (an optimistic `create`); the call is `rpc.page.create` so the server picks the rank
	 * when the branch is not loaded.
	 */
	async createPage(opts: {
		parentId: string | null;
		teamspaceId?: string | null;
		title?: string;
		icon?: string | null;
		isDatabase?: boolean;
	}): Promise<string> {
		const id = newId('p');
		const siblings = (this.byParent.get(key(opts.parentId)) ?? []).filter(
			(s) => opts.parentId !== null || (s.teamspaceId ?? null) === (opts.teamspaceId ?? null)
		);
		const rank = rankAfter(siblings.at(-1)?.rank ?? null);
		const parent = opts.parentId ? this.pages.get(opts.parentId) : undefined;
		const teamspaceId = opts.parentId ? (parent?.teamspaceId ?? null) : (opts.teamspaceId ?? null);
		const values = opts.title ? { [TITLE_PROP_ID]: opts.title } : undefined;
		const op: CreateOp = {
			op: 'create',
			id,
			parentId: opts.parentId,
			rank,
			...(opts.parentId === null ? { teamspaceId } : {}),
			...(opts.icon !== undefined ? { icon: opts.icon } : {}),
			...(opts.isDatabase ? { isDatabase: true } : {}),
			...(values ? { values } : {})
		};
		if (opts.parentId) this.expand(opts.parentId);
		await this.mutate([op], async () => {
			const ref = await this.#rpc.page.create({
				id,
				parentId: opts.parentId,
				...(opts.parentId === null ? { teamspaceId } : {}),
				...(opts.icon !== undefined ? { icon: opts.icon } : {}),
				...(opts.isDatabase ? { isDatabase: true } : {}),
				...(values ? { values } : {})
			});
			return { seq: ref.seq };
		});
		return id;
	}

	/**
	 * Creates a row of a database view. The server derives what it starts with (`page.create` with `viewId`: the
	 * collection's defaults and the values that keep the row in the view and its local filter); `predicted` is the
	 * client's guess (`newRowInit`), shown as the optimistic layer until the server's answer, and `extra` (a board
	 * column's group value) is sent as explicit values that win over the derived ones.
	 */
	async createViewRow(opts: {
		id: string;
		viewId: string;
		localFilter?: FilterGroup | null;
		predicted: { parentId: string | null; values: Values };
		extra?: Values;
	}): Promise<string> {
		const { id, predicted } = opts;
		const siblings = this.byParent.get(key(predicted.parentId)) ?? [];
		const rank = rankAfter(siblings.at(-1)?.rank ?? null);
		const op: CreateOp = { op: 'create', id, parentId: predicted.parentId, rank, values: predicted.values };
		if (predicted.parentId) this.expand(predicted.parentId);
		await this.mutate([op], async () => {
			const ref = await this.#rpc.page.create({
				id,
				viewId: opts.viewId,
				...(opts.localFilter ? { localFilter: opts.localFilter } : {}),
				values: { [TITLE_PROP_ID]: '', ...(opts.extra ?? {}) }
			});
			return { seq: ref.seq };
		});
		return id;
	}

	// ───────────────────────────── moving, trashing, duplicating ─────────────────────────────

	/** Re-sends the tree subscription: a fresh snapshot (after my access changed). */
	refreshTree(): void {
		this.#syncTreeNow(true);
	}

	/**
	 * Waits until the children of `parentId` are loaded (opens the branch if needed). Gives up after
	 * `timeoutMs` and resolves false.
	 */
	async ensureLoaded(parentId: string | null, timeoutMs = 2000): Promise<boolean> {
		if (parentId === null) return true;
		this.expand(parentId);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.branchState(parentId) === 'ready') return true;
			await new Promise((r) => setTimeout(r, 20));
		}
		return this.branchState(parentId) === 'ready';
	}

	/** The section a root page sits in. */
	sectionOf(p: PageEntity): { kind: 'teamspace'; id: string } | { kind: 'private' } | { kind: 'shared' } {
		if (p.teamspaceId) return { kind: 'teamspace', id: p.teamspaceId };
		return this.#isMine(p) ? { kind: 'private' } : { kind: 'shared' };
	}

	/** True when `id` is `ancestorId` or lies inside its subtree (as far as the tree is loaded). */
	isInside(id: string, ancestorId: string): boolean {
		let cur: PageEntity | undefined = this.pages.get(id);
		let guard = 0;
		while (cur && guard++ < 200) {
			if (cur.id === ancestorId) return true;
			cur = cur.parentId ? this.pages.get(cur.parentId) : undefined;
		}
		return false;
	}

	/**
	 * Whether `id` may be dropped at `target`: a new parent (null: the top level of a section) and, at
	 * the top level, the section (`teamspaceId`; null is Private, or Shared with `shared`). Refuses a
	 * move into its own subtree, a change of parent or section without `full` access, a parent the user
	 * cannot edit, a teamspace the user is not in, and putting somebody else's page in Private.
	 */
	canMove(
		id: string,
		target: { parentId: string | null; teamspaceId?: string | null; shared?: boolean }
	): { ok: true } | { ok: false; reason: string } {
		const page = this.pages.get(id);
		if (!page) return { ok: false, reason: 'Page not loaded' };
		if (target.parentId !== null && this.isInside(target.parentId, id)) return { ok: false, reason: 'A page cannot move inside itself' };
		const parent = target.parentId ? this.pages.get(target.parentId) : undefined;
		const destSection = target.parentId ? null : target.teamspaceId ? `ts:${target.teamspaceId}` : target.shared ? 'shared' : 'private';
		const pageSection = page.parentId ? null : page.teamspaceId ? `ts:${page.teamspaceId}` : this.#isMine(page) ? 'private' : 'shared';
		const sameParent = page.parentId === target.parentId;
		const sameSection = sameParent && (target.parentId !== null || pageSection === destSection);
		if (page.access === 'read' || page.access === 'comment') return { ok: false, reason: 'You cannot edit this page' };
		if (!sameSection && page.access !== 'full') return { ok: false, reason: 'You need full access to move this page' };
		if (target.parentId) {
			if (!parent) return { ok: false, reason: 'Destination not loaded' };
			if (!sameParent && parent.access !== 'full' && parent.access !== 'update') return { ok: false, reason: 'You cannot add pages inside that page' };
		} else if (!sameSection) {
			if (destSection === 'shared') return { ok: false, reason: 'Pages become shared from the Share menu' };
			if (target.teamspaceId) {
				const ts = this.teamspaces.find((t) => t.id === target.teamspaceId);
				if (!ts || (ts.myRole === null && !this.isAdmin)) return { ok: false, reason: 'Join that teamspace first' };
			} else if (!this.#isMine(page)) return { ok: false, reason: 'Only the creator can put a page in Private' };
		}
		return { ok: true };
	}

	/**
	 * Moves a page. `target.index` is the position among the new siblings (those of the same section at
	 * the top level), or `beforeId` / `afterId` name a sibling. The rank comes from `placeAt`; when no
	 * rank fits, the neighbours are rebalanced in the same batch. Optimistic, through `mutate`.
	 */
	async movePage(
		id: string,
		target: { parentId: string | null; teamspaceId?: string | null; shared?: boolean; index?: number; beforeId?: string | null; afterId?: string | null }
	): Promise<boolean> {
		const verdict = this.canMove(id, target);
		if (!verdict.ok) {
			this.#notify({ kind: 'info', title: 'Cannot move the page there', description: verdict.reason });
			return false;
		}
		const page = this.pages.get(id)!;
		if (target.parentId) await this.ensureLoaded(target.parentId);
		const destTeamspace = target.parentId ? (this.pages.get(target.parentId)?.teamspaceId ?? null) : (target.teamspaceId ?? null);
		const siblings = this.#siblingsIn(target.parentId, destTeamspace, !!target.shared).filter((s) => s.id !== id);
		let index = target.index ?? siblings.length;
		if (target.beforeId) index = siblings.findIndex((s) => s.id === target.beforeId);
		else if (target.afterId) {
			const at = siblings.findIndex((s) => s.id === target.afterId);
			index = at === -1 ? -1 : at + 1;
		}
		if (index < 0) index = siblings.length;
		const placed = placeAt(siblings.map((s) => ({ id: s.id, rank: s.rank })), id, index);
		const teamspaceChanged = (page.teamspaceId ?? null) !== destTeamspace;
		const ops: Op[] = [
			{
				op: 'move',
				page: id,
				parentId: target.parentId,
				rank: placed.rank,
				...(teamspaceChanged || target.parentId === null ? { teamspaceId: destTeamspace } : {})
			}
		];
		for (const r of placed.rebalanced ?? []) {
			const sib = this.pages.get(r.id);
			if (sib) ops.push({ op: 'move', page: r.id, parentId: sib.parentId, rank: r.rank });
		}
		if (target.parentId) this.expand(target.parentId);
		try {
			await this.mutate(ops);
			return true;
		} catch {
			return false;
		}
	}

	/** The pages `id` sits among in the sidebar: its parent's children, or its section's top level. */
	siblingsOf(id: string): PageEntity[] {
		const p = this.pages.get(id);
		if (!p) return [];
		if (p.parentId !== null) return this.children(p.parentId);
		return this.#siblingsIn(null, p.teamspaceId ?? null, !p.teamspaceId && !this.#isMine(p));
	}

	/** The pages a moved page would sit among: the children of `parentId`, or the roots of a section. */
	#siblingsIn(parentId: string | null, teamspaceId: string | null, shared: boolean): PageEntity[] {
		const kids = this.children(parentId);
		if (parentId !== null) return kids;
		return kids.filter((k) => (k.teamspaceId ?? null) === teamspaceId && (teamspaceId !== null || this.#isMine(k) === !shared));
	}

	/** Moves a page and its subpages to the trash (restore from Trash). */
	async trashPage(id: string): Promise<boolean> {
		try {
			await this.mutate([{ op: 'trash', page: id }]);
			return true;
		} catch {
			return false;
		}
	}

	/** Duplicates a page (and its subpages); resolves with the copy's id. */
	async duplicatePage(id: string, includeSubpages = true): Promise<string | null> {
		if (!this.canEdit) {
			this.#notify({ kind: 'error', title: 'You are offline', description: 'Duplicating needs a connection.' });
			return null;
		}
		try {
			const ref = await this.#rpc.page.duplicate({ id, includeSubpages });
			return ref.id;
		} catch (error) {
			this.#notify(failure(error));
			return null;
		}
	}

	// ───────────────────────────── property values and definitions ─────────────────────────────

	/** Sets one property of a page (null clears it). Optimistic. */
	setValue(page: string, prop: string, value: PropValue | null): Promise<{ seq: number }> {
		return this.mutate([{ op: 'setProp', page, prop, value }]);
	}

	addOption(page: string, prop: string, option: string): Promise<{ seq: number }> {
		return this.mutate([{ op: 'addOption', page, prop, option }]);
	}

	removeOption(page: string, prop: string, option: string): Promise<{ seq: number }> {
		return this.mutate([{ op: 'removeOption', page, prop, option }]);
	}

	#setRegistry(defs: PropertyDef[]): void {
		this.properties = defs;
		this.#registry = createRegistry(defs);
	}

	/** Runs definition ops with the registry updated at once; a failure restores it. */
	async #defineOps(ops: Op[], next: PropertyDef[]): Promise<{ seq: number }> {
		const before = this.properties;
		this.#defVersion++;
		this.#setRegistry(next);
		try {
			const result = await this.mutate(ops);
			void this.refreshProperties();
			return result;
		} catch (error) {
			this.#setRegistry(before);
			throw error;
		}
	}

	/** Adds a property to the workspace registry. Optimistic. */
	createProperty(def: PropertyDef): Promise<{ seq: number }> {
		return this.#defineOps([{ op: 'createProperty', property: def }], [...this.properties, def]);
	}

	/** Renames a property and/or replaces its config (select options live in the config). Optimistic. */
	updateProperty(id: string, patch: { name?: string; config?: Record<string, unknown> }): Promise<{ seq: number }> {
		const next = this.properties.map((p) => (p.id === id ? ({ ...p, ...(patch.name ? { name: patch.name } : {}), ...(patch.config ? { config: patch.config } : {}) } as PropertyDef) : p));
		return this.#defineOps([{ op: 'updateProperty', id, ...patch }], next);
	}

	deleteProperty(id: string): Promise<{ seq: number }> {
		return this.#defineOps([{ op: 'deleteProperty', id }], this.properties.filter((p) => p.id !== id));
	}

	// ───────────────────────────── databases: collections and views ─────────────────────────────

	#collectionLoads = new Map<string, Promise<CollectionBundle | null>>();
	#collectionsTimer: unknown = null;
	/** Collections a view asked for that did not exist (yet): a `collections` push fetches them again. */
	#missingCollections = new Set<string>();

	/** Fetches a collection and its views (cached in `collections` and `views`). `force` fetches again. */
	loadCollection(id: string, force = false): Promise<CollectionBundle | null> {
		const cached = this.collections.get(id);
		const views = this.views.get(id);
		if (!force && cached && views) return Promise.resolve({ collection: cached, views });
		const inflight = this.#collectionLoads.get(id);
		if (inflight) return inflight;
		const run = (async () => {
			try {
				const fetched = await this.#rpc.collection.get({ id });
				this.#missingCollections.delete(id);
				// What did not change keeps its object: a definition push also echoes this tab's own edits, and replacing
				// equal objects would re-render the open view (and close its menus) for nothing.
				const before = this.views.get(id);
				const found: CollectionBundle = {
					collection: sameData(this.collections.get(id), fetched.collection) ? (this.collections.get(id) as CollectionDef) : fetched.collection,
					views: fetched.views.map((v) => {
						const held = before?.find((x) => x.id === v.id);
						return held && sameData(held, v) ? held : v;
					})
				};
				if (this.collections.get(id) !== found.collection) this.collections.set(id, found.collection);
				if (!before || before.length !== found.views.length || found.views.some((v, i) => v !== before[i])) this.views.set(id, found.views);
				return found;
			} catch {
				this.#missingCollections.add(id);
				return null;
			} finally {
				this.#collectionLoads.delete(id);
			}
		})();
		this.#collectionLoads.set(id, run);
		return run;
	}

	#scheduleCollectionsRefresh(): void {
		if (this.#collectionsTimer || this.#disposed || this.#renderingOnServer || (this.collections.size === 0 && this.#missingCollections.size === 0)) return;
		this.#collectionsTimer = this.#clock.setTimeout(() => {
			this.#collectionsTimer = null;
			for (const id of new Set([...this.collections.keys(), ...this.#missingCollections])) void this.loadCollection(id, true);
		}, 150);
	}

	/** Re-reads every collection this tab shows (a tab coming back to the foreground). */
	refreshCollections(): void {
		for (const id of [...this.collections.keys()]) void this.loadCollection(id, true);
	}

	/**
	 * Edits a view (name, type, filter, sorts, group-by, columns). The local copy changes at once and the call
	 * goes out; a failure restores it. The view's windows are asked for a fresh snapshot afterwards, in case the
	 * server does not recompute them for a definition change.
	 */
	async updateView(
		collectionId: string,
		viewId: string,
		patch: Partial<Pick<ViewDef, 'name' | 'type' | 'filter' | 'sorts' | 'groupBy' | 'columns'>>
	): Promise<void> {
		const before = this.views.get(collectionId) ?? [];
		this.views.set(collectionId, before.map((v) => (v.id === viewId ? { ...v, ...patch } : v)));
		try {
			await this.mutate([{ op: 'updateView', id: viewId, ...patch }]);
		} catch (error) {
			this.views.set(collectionId, before);
			throw error;
		}
	}

	/** Adds a view (last in the tab bar). Resolves with its id. */
	async createView(
		collectionId: string,
		input: { type: ViewDef['type']; name: string; id?: string; onCreated?: (id: string) => void } & Partial<Pick<ViewDef, 'filter' | 'sorts' | 'groupBy' | 'columns'>>
	): Promise<string> {
		const before = this.views.get(collectionId) ?? [];
		const id = input.id ?? newId('v');
		const rank = rankAfter(before.at(-1)?.rank ?? null);
		const view: ViewDef = {
			id,
			collectionId,
			type: input.type,
			name: input.name,
			filter: input.filter ?? { and: [] },
			sorts: input.sorts ?? [],
			groupBy: input.groupBy ?? null,
			columns: input.columns ?? { columns: [], options: {} },
			rank
		};
		this.views.set(collectionId, [...before, view]);
		input.onCreated?.(id);
		try {
			await this.mutate([
				{
					op: 'createView',
					id,
					collectionId,
					type: view.type,
					name: view.name,
					filter: view.filter,
					sorts: view.sorts,
					groupBy: view.groupBy,
					columns: view.columns,
					rank
				}
			]);
		} catch (error) {
			this.views.set(collectionId, before);
			throw error;
		}
		return id;
	}

	async deleteView(collectionId: string, viewId: string): Promise<void> {
		const before = this.views.get(collectionId) ?? [];
		this.views.set(collectionId, before.filter((v) => v.id !== viewId));
		try {
			await this.mutate([{ op: 'deleteView', id: viewId }]);
		} catch (error) {
			this.views.set(collectionId, before);
			throw error;
		}
	}

	/**
	 * Creates a full-page database: a page (`isDatabase`), its collection (id = the page's id, membership
	 * "parent is this page") and a default table view, as the editor does for an inline one. Resolves with the id.
	 */
	async createDatabase(opts: { parentId: string | null; teamspaceId?: string | null; title?: string; icon?: string | null }): Promise<string> {
		const id = await this.createPage({ ...opts, title: opts.title ?? 'Untitled database', isDatabase: true });
		try {
			await this.#rpc.collection.create({ id, pageId: id, sourceAst: { and: [{ prop: '$parent', op: 'is', value: id }] } });
			await this.#rpc.view.create({ collectionId: id, type: 'table', name: 'Table' });
		} catch (error) {
			this.#notify(failure(error));
			throw error;
		}
		return id;
	}

	// ───────────────────────────── teamspaces ─────────────────────────────

	async #teamspaceCall<T>(call: () => Promise<T>, refreshTree = false): Promise<T> {
		try {
			const out = await call();
			await this.refreshDirectory();
			if (refreshTree) this.refreshTree();
			return out;
		} catch (error) {
			this.#notify(failure(error));
			throw error;
		}
	}

	createTeamspace(input: { name: string; icon?: string | null; description?: string; privacy: Teamspace['privacy']; defaultLevel: AccessLevel }): Promise<Teamspace> {
		return this.#teamspaceCall(() => this.#rpc.workspace.teamspaces.create(input));
	}

	updateTeamspace(input: { id: string; name?: string; icon?: string | null; description?: string; privacy?: Teamspace['privacy']; defaultLevel?: AccessLevel }): Promise<Teamspace> {
		return this.#teamspaceCall(() => this.#rpc.workspace.teamspaces.update(input), true);
	}

	archiveTeamspace(id: string): Promise<{ seq: number }> {
		return this.#teamspaceCall(() => this.#rpc.workspace.teamspaces.archive({ id }), true);
	}

	/** Archived teamspaces I own (Settings lists them with a restore button). */
	archivedTeamspaces(): Promise<ArchivedTeamspace[]> {
		return this.#rpc.workspace.teamspaces.archived();
	}

	/** Brings an archived teamspace and the pages its archive took back; the tree refreshes for them. */
	restoreTeamspace(id: string): Promise<{ seq: number }> {
		return this.#teamspaceCall(() => this.#rpc.workspace.teamspaces.restore({ id }), true);
	}

	/** Joins an open teamspace (or adds a member when `userId` is given); the tree refreshes for the pages it brings. */
	addTeamspaceMember(teamspaceId: string, userId: string = this.user.id, role?: 'owner' | 'member'): Promise<TeamspaceMember> {
		return this.#teamspaceCall(() => this.#rpc.workspace.teamspaces.members.add({ teamspaceId, userId, ...(role ? { role } : {}) }), userId === this.user.id);
	}

	setTeamspaceMemberRole(teamspaceId: string, userId: string, role: 'owner' | 'member'): Promise<TeamspaceMember> {
		return this.#teamspaceCall(() => this.#rpc.workspace.teamspaces.members.setRole({ teamspaceId, userId, role }));
	}

	removeTeamspaceMember(teamspaceId: string, userId: string): Promise<unknown> {
		return this.#teamspaceCall(() => this.#rpc.workspace.teamspaces.members.remove({ teamspaceId, userId }), userId === this.user.id);
	}

	teamspaceMembers(teamspaceId: string): Promise<TeamspaceMember[]> {
		return this.#rpc.workspace.teamspaces.members.list({ teamspaceId });
	}

	// ───────────────────────────── opening pages ─────────────────────────────

	/**
	 * Subscribes the `page` and `backlinks` subscriptions of a page (and the pages above it, for
	 * breadcrumbs) and records the visit. Returns the release function.
	 */
	openPage(id: string): () => void {
		// Called from effects: reading and writing the maps here must not make the caller depend on them.
		return untrack(() => this.#openPage(id));
	}

	#openPage(id: string): () => void {
		const releases = [this.subscribe(subKey('pg', id), { kind: 'page', pageIds: [id] }), this.subscribe(subKey('bl', id), { kind: 'backlinks', pageId: id })];
		const entry = { release: () => releases.forEach((r) => r()), ancestors: new Map<string, () => void>() };
		this.#openPages.set(id, entry);
		this.visit(id);
		this.#ensureAncestors();
		return () => {
			entry.release();
			for (const r of entry.ancestors.values()) r();
			this.#openPages.delete(id);
		};
	}

	/** Subscribes to a set of pages by id (home: recent and favorite pages). */
	watchPages(ids: string[]): () => void {
		const list = [...new Set(ids)].slice(0, 50);
		if (!list.length) return () => {};
		return this.subscribe(PAGE_SET_ID, { kind: 'page', pageIds: list });
	}

	/** Pages above `id` that no subscription holds yet get a `page` subscription of their own. */
	#ensureAncestors(): void {
		for (const [id, entry] of this.#openPages) {
			let cur = this.pages.get(id);
			let guard = 0;
			while (cur?.parentId && guard++ < 64) {
				const parent = this.pages.get(cur.parentId);
				if (!parent) {
					const pid = cur.parentId;
					if (!entry.ancestors.has(pid)) entry.ancestors.set(pid, this.subscribe(subKey('pg', pid), { kind: 'page', pageIds: [pid] }));
					break;
				}
				cur = parent;
			}
		}
	}

	/** Opens the sidebar branches above `id`, so the active page is visible in the tree. */
	reveal(id: string): void {
		const chain = this.ancestors(id); // tracked: opens more branches as ancestors load
		untrack(() => {
			for (const a of chain) this.expand(a.id);
		});
	}

	/** Tells the workspace which page this tab is on (null: none). */
	setPresence(pageId: string | null): void {
		this.#myPage = pageId;
		this.#send({ t: 'presence', pageId });
	}

	/** Mock mode only: starts with some history so the home page is not empty. */
	seedPrefs(recent: string[], favorites: string[]): void {
		untrack(() => {
			if (!this.recent.length) this.recent = recent.map((id, i) => ({ id, at: Date.now() - (i + 1) * 47 * 60_000 }));
			if (!this.favorites.length) this.favorites = favorites;
		});
	}

	/** People on a page other than me. */
	othersOn(pageId: string): PresenceUser[] {
		return (this.presence.get(pageId) ?? []).filter((u) => u.userId !== this.user.id);
	}

	backlinks(pageId: string): BacklinkRow[] {
		const w = this.windows.get(subKey('bl', pageId));
		return w ? (w.ids.map((id) => w.rows.get(id)).filter(Boolean) as BacklinkRow[]) : [];
	}

	/** The layers' value ops by page, and the pages an unconfirmed layer trashes. */
	#layerIndex(): { ops: Map<string, ValueOp[]>; trashed: Set<string> } {
		const ops = new Map<string, ValueOp[]>();
		const trashed = new Set<string>();
		for (const layer of this.#layers)
			for (const op of layer.ops) {
				if (op.op === 'trash') trashed.add(op.page);
				else if (op.op === 'restore') trashed.delete(op.page);
				else if (op.op === 'setProp' || op.op === 'addOption' || op.op === 'removeOption') {
					const list = ops.get(op.page);
					if (list) list.push(op);
					else ops.set(op.page, [op]);
				}
			}
		return { ops, trashed };
	}

	/** A row with the unconfirmed value edits of `list` applied on top of the server's values. */
	#layeredRow(row: ViewRow, list: ValueOp[] | undefined): ViewRow {
		if (!list?.length) return row;
		let values = row.values;
		let title = row.title;
		for (const op of list) {
			if (op.prop === SYSTEM_TITLE) {
				if (op.op === 'setProp') title = typeof op.value === 'string' ? op.value : '';
				continue;
			}
			const def = this.#registry.get(op.prop);
			const r = def ? applyValueOp(def, values[op.prop] ?? null, op) : null;
			if (r?.ok) values = { ...values, [op.prop]: r.value };
			else if (!def && op.op === 'setProp') values = { ...values, [op.prop]: op.value };
		}
		return values === row.values && title === row.title ? row : { ...row, values, title };
	}

	/** Rows of a window (view and backlinks) with optimistic value edits applied. */
	windowRows(windowId: string): (ViewRow | BacklinkRow)[] {
		const w = this.windows.get(windowId);
		if (!w) return [];
		void this.pending;
		const { ops, trashed } = this.#layerIndex();
		return w.ids.flatMap((id): (ViewRow | BacklinkRow)[] => {
			const row = w.rows.get(id);
			if (!row || trashed.has(id)) return [];
			return 'values' in row ? [this.#layeredRow(row, ops.get(id))] : [row];
		});
	}

	/**
	 * A `view` window as the screen shows it: flat `rows`, or `groups` with their rows, with the unconfirmed edits
	 * applied. A card whose group-by property is being edited moves to its new group at once (at the end of it);
	 * the server's diff then puts it at its sorted place. `undefined` before the window exists.
	 */
	viewData(windowId: string): ViewData | undefined {
		const w = this.windows.get(windowId);
		if (!w || w.kind !== 'view') return undefined;
		void this.pending;
		const { ops, trashed } = this.#layerIndex();
		const byId = new Map<string, ViewRow>();
		for (const [id, row] of w.rows) if (!trashed.has(id) && 'values' in row) byId.set(id, this.#layeredRow(row as ViewRow, ops.get(id)));
		const total = Math.max(0, w.total - [...trashed].filter((id) => w.rows.has(id)).length);
		if (!w.groups) {
			return { status: w.status, total, rows: w.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) };
		}
		const spec = this.#groupSpecOf(w);
		const def = spec ? this.#registry.get(spec.prop) : undefined;
		const keysOf = (value: PropValue | null | undefined): string[] | null => {
			if (!def) return null;
			if (def.type === 'checkbox') return [value === true ? 'true' : 'false'];
			if (def.type === 'date' || def.type === 'relation') return null;
			const list = Array.isArray(value) ? value : typeof value === 'string' && value !== '' ? [value] : [];
			return list.length ? list : [GROUP_EMPTY];
		};
		// Rows whose group-by value is edited by a layer: where they belong now.
		const moved = new Map<string, string[]>();
		if (spec) {
			for (const [id, list] of ops) {
				if (!byId.has(id) || !list.some((op) => op.prop === spec.prop)) continue;
				const keys = keysOf(byId.get(id)!.values[spec.prop]);
				if (keys) moved.set(id, keys);
			}
		}
		const groups = w.groups.map((g) => {
			let idsIn = g.ids.filter((id) => byId.has(id) && (!moved.has(id) || moved.get(id)!.includes(g.key)));
			let t = g.total - (g.ids.length - idsIn.length);
			for (const [id, keys] of moved) {
				if (keys.includes(g.key) && !g.ids.includes(id)) {
					idsIn = [...idsIn, id];
					t += 1;
				}
			}
			return { key: g.key, total: Math.max(t, idsIn.length), loaded: g.ids.length, rows: idsIn.map((id) => byId.get(id)!) };
		});
		return { status: w.status, total, rows: [], groups };
	}

	// ───────────────────────────── reads ─────────────────────────────

	page(id: string): PageEntity | undefined {
		return this.pages.get(id);
	}

	/** The subscription window of an open page, for its loading and error state. */
	pageStatus(id: string): WindowStatus | 'none' {
		return this.windows.get(subKey('pg', id))?.status ?? 'none';
	}

	titleOf(id: string): string {
		return this.pages.get(id)?.title || 'Untitled';
	}

	children(parentId: string | null): PageEntity[] {
		return this.byParent.get(key(parentId)) ?? [];
	}

	/** Pages above `id`, nearest root first. Stops at the first one not loaded. */
	ancestors(id: string): PageEntity[] {
		const chain: PageEntity[] = [];
		let cur = this.pages.get(id);
		let guard = 0;
		while (cur?.parentId && guard++ < 64) {
			const parent = this.pages.get(cur.parentId);
			if (!parent) break;
			chain.unshift(parent);
			cur = parent;
		}
		return chain;
	}

	/** True when every page above `id` is loaded (the breadcrumbs are complete). */
	hasFullPath(id: string): boolean {
		const e = this.pages.get(id);
		if (!e) return false;
		return !e.parentId || this.ancestors(id)[0]?.parentId === null;
	}

	/** Pages in teamspace `teamspaceId`, at the top level. */
	teamspaceRoots(teamspaceId: string): PageEntity[] {
		return this.children(null).filter((p) => p.teamspaceId === teamspaceId);
	}

	/**
	 * Root pages outside any teamspace that I created (Private) or someone else shared with me (Shared);
	 * tree rows carry `createdBy`.
	 */
	#isMine(p: PageEntity): boolean {
		return p.createdBy === this.user.id;
	}
	privateRoots(): PageEntity[] {
		return this.children(null).filter((p) => p.teamspaceId === null && this.#isMine(p));
	}
	sharedRoots(): PageEntity[] {
		return this.children(null).filter((p) => p.teamspaceId === null && !this.#isMine(p));
	}

	resolvePage(id: string): PageRef | null {
		const p = this.pages.get(id);
		return p ? { id: p.id, title: p.title || 'Untitled', icon: p.icon } : null;
	}

	/** Title-prefix matches over the pages the store knows, recent visits first. P4 adds full text. */
	searchPages(query: string, limit = 10): PageRef[] {
		const q = query.trim().toLowerCase();
		const recentRank = new Map(this.recent.map((r, i) => [r.id, i]));
		const out: PageEntity[] = [];
		for (const p of this.pages.values()) {
			const t = (p.title || 'Untitled').toLowerCase();
			if (!q || t.startsWith(q) || t.split(/\s+/).some((w) => w.startsWith(q))) out.push(p);
		}
		out.sort((a, b) => {
			const ap = (a.title || 'Untitled').toLowerCase().startsWith(q) ? 0 : 1;
			const bp = (b.title || 'Untitled').toLowerCase().startsWith(q) ? 0 : 1;
			return ap - bp || (recentRank.get(a.id) ?? 1e6) - (recentRank.get(b.id) ?? 1e6) || a.title.localeCompare(b.title);
		});
		return out.slice(0, limit).map((p) => ({ id: p.id, title: p.title || 'Untitled', icon: p.icon }));
	}

	searchPeople(query: string, limit = 8): { id: string; name: string; email: string; image: string | null }[] {
		const q = query.trim().toLowerCase();
		return this.members
			.filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().startsWith(q))
			.slice(0, limit)
			.map((m) => ({ id: m.userId, name: m.name, email: m.email, image: m.image }));
	}

	// ───────────────────────────── recents and favorites ─────────────────────────────

	get #prefKey(): string {
		return `flarion.${this.workspace.id}.${this.user.id}`;
	}

	#storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
		if (this.#o.storage !== undefined) return this.#o.storage;
		try {
			return typeof localStorage === 'undefined' ? null : localStorage;
		} catch {
			return null;
		}
	}

	#loadPrefs(): void {
		const s = this.#storage();
		if (!s) return;
		try {
			const fav = JSON.parse(s.getItem(`${this.#prefKey}.fav`) ?? '[]');
			if (Array.isArray(fav) && (fav.length || !this.favorites.length)) this.favorites = fav.filter((x): x is string => typeof x === 'string');
			const rec = JSON.parse(s.getItem(`${this.#prefKey}.recent`) ?? '[]');
			if (Array.isArray(rec) && (rec.length || !this.recent.length)) this.recent = rec.filter((x) => x && typeof x.id === 'string' && typeof x.at === 'number').slice(0, MAX_RECENT);
			// The cookie the next server render reads is kept in step (a first visit after the cookie existed finds none).
			writePrefsCookie(this.workspace.id, this.favorites, this.recent);
		} catch {
			// corrupt preferences: start empty
		}
	}

	#savePref(name: 'fav' | 'recent', value: unknown): void {
		try {
			this.#storage()?.setItem(`${this.#prefKey}.${name}`, JSON.stringify(value));
			writePrefsCookie(this.workspace.id, this.favorites, this.recent);
		} catch {
			// quota or private mode
		}
	}

	/** Records that the user opened a page (local recents; the server keeps its own through `search.visit`). */
	visit(id: string): void {
		untrack(() => this.#visit(id));
	}

	#visit(id: string): void {
		this.recent = [{ id, at: Date.now() }, ...this.recent.filter((r) => r.id !== id)].slice(0, MAX_RECENT);
		this.#savePref('recent', this.recent);
		if (!this.#recentOpened.includes(id)) this.#recentOpened = [id, ...this.#recentOpened].slice(0, MAX_RECENT);
		void this.#rpc.search.visit({ id }).catch(() => {});
	}

	isFavorite(id: string): boolean {
		return this.favorites.includes(id);
	}

	/** Favorites are kept per user in localStorage for P1 (no server list yet). */
	toggleFavorite(id: string): void {
		this.favorites = this.isFavorite(id) ? this.favorites.filter((f) => f !== id) : [id, ...this.favorites];
		this.#savePref('fav', this.favorites);
	}

	// ───────────────────────────── seed (server render) ─────────────────────────────

	/**
	 * Starts the store from what the server render read (`StoreSeed`, `src/server/ssr/`): the snapshots a socket would have sent
	 * for the first screen, applied as such, plus the definitions around them. Called by the layout and the page before anything
	 * renders (on the server for the HTML, and in the browser for hydration, with the same data, so both render the same markup).
	 * The socket's first `hello` then carries the seeded windows with the log position they were read at, and the server replays
	 * only what happened since: no snapshot is fetched twice. A window the store already holds at the same position or later is
	 * left alone (a client-side navigation brings the next page's seed to a store that is live).
	 */
	seed(seed: StoreSeed): void {
		untrack(() => this.#seed(seed));
	}

	#seed(seed: StoreSeed): void {
		const live = this.#started;
		if (!live) this.#seeded = true;
		if (seed.properties) this.#setRegistry(seed.properties);
		if (seed.members) this.members = seed.members;
		if (seed.teamspaces) {
			this.teamspaces = seed.teamspaces.list;
			this.teamspaceRanks = seed.teamspaces.ranks;
		}
		if (seed.collection && !this.collections.has(seed.collection.collection.id)) {
			this.collections.set(seed.collection.collection.id, seed.collection.collection);
			this.views.set(seed.collection.collection.id, seed.collection.views);
		}
		if (seed.prefs && !this.recent.length && !this.favorites.length) {
			this.favorites = seed.prefs.favorites;
			this.recent = seed.prefs.recent;
		}
		if (seed.expanded && !live) {
			this.#expanded = new Set<string | null>([null, ...seed.expanded]);
			this.expanded = new Set(seed.expanded);
		}
		let min: number | null = null;
		for (const { id, sub, snapshot } of seed.windows ?? []) {
			const held = this.windows.get(id);
			if (held && held.status === 'ready' && held.seq !== null && held.seq >= snapshot.seq) continue;
			if (snapshot.kind === 'tree') {
				const sub2: Subscription = { kind: 'tree', parents: [...this.#expanded] };
				this.#subs.set(TREE_ID, { sub: sub2, count: 1 });
				this.windows.set(TREE_ID, { id: TREE_ID, kind: 'tree', sub: sub2, status: 'pending', ids: [], rows: new Map(), total: 0, seq: null });
			} else {
				this.windows.set(id, { id, kind: sub.kind, sub, status: 'pending', ids: [], rows: new Map(), total: 0, seq: null });
				this.#unclaimed.add(id);
			}
			this.#applySnapshot(snapshot);
			min = min === null ? snapshot.seq : Math.min(min, snapshot.seq);
		}
		if (!live && min !== null) {
			// `#applySnapshot` moved the position to the newest snapshot: the socket resumes from the oldest, and a window newer than that
			// drops the replayed diffs it already holds (`window.seq`).
			this.seq = min;
			this.#seededSeq = Math.max(this.#seededSeq ?? 0, min);
			this.#seedFresh = true;
		}
		if (live && min !== null) this.#seededSeq = null;
		this.stale = false;
	}

	// ───────────────────────────── cache ─────────────────────────────

	#restore(snapshot: CacheSnapshot): void {
		for (const row of snapshot.tree) this.#base.set(row.id, entityFromTree(row));
		for (const row of snapshot.pages) this.#base.set(row.id, entityFromPage(row));
		this.#expanded = new Set<string | null>([null, ...snapshot.expanded.filter((x) => x !== null)]);
		this.expanded = new Set([...this.#expanded].filter((x): x is string => x !== null));
		this.windows.set(TREE_ID, {
			id: TREE_ID,
			kind: 'tree',
			sub: { kind: 'tree', parents: [...this.#expanded] },
			status: 'ready',
			ids: snapshot.tree.map((r) => r.id),
			rows: new Map(),
			total: snapshot.tree.length,
			seq: snapshot.seq
		});
		this.#loadedParents = new Set([...this.#expanded].map(key));
		this.seq = snapshot.seq;
		this.#touchAll();
		this.ready = snapshot.tree.length > 0;
		this.stale = true;
	}

	#scheduleCache(): void {
		if (this.#o.cache === null || this.#disposed) return;
		if (this.#cacheTimer) return;
		this.#cacheTimer = this.#clock.setTimeout(() => {
			this.#cacheTimer = null;
			void this.saveCache();
		}, this.#o.cacheDebounceMs ?? 1500);
	}

	/** Writes the tree and recent pages to the cache (only the server's state, never a layer). */
	async saveCache(): Promise<void> {
		const cache = this.#cache();
		const tree = this.windows.get(TREE_ID);
		if (!cache || !tree || tree.status !== 'ready' || this.seq === null) return;
		const rows = tree.ids.map((id) => this.#base.get(id)).filter((e): e is PageEntity => !!e);
		const pages = this.#recentOpened
			.map((id) => this.#base.get(id))
			.filter((e): e is PageEntity => !!e && !e.partial)
			.map(toPageRow);
		await cache.save({
			workspaceId: this.workspace.id,
			seq: this.seq,
			expanded: [...this.#expanded],
			tree: rows.map(toTreeRow),
			pages,
			savedAt: Date.now()
		});
	}
}

// ───────────────────────────── helpers ─────────────────────────────

function opPages(ops: Op[]): Set<string> {
	const out = new Set<string>();
	for (const op of ops) {
		switch (op.op) {
			case 'create':
				out.add(op.id);
				if (op.parentId) out.add(op.parentId);
				break;
			case 'move':
				out.add(op.page);
				if (op.parentId) out.add(op.parentId);
				break;
			case 'setProp':
			case 'addOption':
			case 'removeOption':
			case 'trash':
			case 'restore':
			case 'setPage':
				out.add(op.page);
				break;
			default:
		}
	}
	return out;
}

function entityFromCreate(op: CreateOp, userId: string): PageEntity {
	const title = op.values?.[TITLE_PROP_ID];
	const { [TITLE_PROP_ID]: _t, ...values } = op.values ?? {};
	void _t;
	const now = new Date().toISOString();
	return {
		id: op.id,
		parentId: op.parentId,
		rank: op.rank,
		title: typeof title === 'string' ? title : '',
		icon: op.icon ?? null,
		cover: op.cover ?? null,
		isDatabase: !!op.isDatabase,
		teamspaceId: op.teamspaceId ?? null,
		hasChildren: false,
		access: 'full',
		values: values as Values,
		createdBy: userId,
		createdAt: now,
		updatedBy: userId,
		updatedAt: now,
		partial: false
	};
}

/** Structural equality of plain JSON data (key order does not matter). */
function sameData(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	return ka.every((k) => k in b && sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function sameEntity(a: PageEntity, b: PageEntity): boolean {
	if (a === b) return true;
	return (
		a.parentId === b.parentId &&
		a.rank === b.rank &&
		a.title === b.title &&
		a.icon === b.icon &&
		a.cover === b.cover &&
		a.isDatabase === b.isDatabase &&
		a.teamspaceId === b.teamspaceId &&
		a.hasChildren === b.hasChildren &&
		a.access === b.access &&
		a.partial === b.partial &&
		a.updatedAt === b.updatedAt &&
		(a.values === b.values || JSON.stringify(a.values) === JSON.stringify(b.values))
	);
}

function failure(error: unknown): Toasty {
	const e = error as { code?: string; message?: string; data?: { issues?: { message: string }[] } };
	if (e?.code === 'VALIDATION_FAILED') {
		return { kind: 'error', title: 'That change was rejected', description: e.data?.issues?.[0]?.message ?? e.message };
	}
	if (e?.code === 'APP_OUTDATED') return { kind: 'error', title: 'Reload to continue', description: 'This version of the app is outdated.' };
	if (e?.code === 'FORBIDDEN' || e?.code === 'UNAUTHORIZED') {
		return { kind: 'error', title: 'You do not have access to that', description: e.message };
	}
	return { kind: 'error', title: 'Could not save your change', description: e?.message ?? 'Check your connection and try again.' };
}

// ───────────────────────────── context ─────────────────────────────

const CTX = Symbol('flarion.workspace');

/** Provides the store to the component tree (call during component initialization). */
export function setWorkspaceContext(read: () => WorkspaceStore | undefined): void {
	setContext(CTX, read);
}

/** The store of the workspace being shown; throws outside `(app)/[ws]`. */
export function useWorkspace(): WorkspaceStore {
	const read = getContext<(() => WorkspaceStore | undefined) | undefined>(CTX);
	const store = read?.();
	if (!store) throw new Error('useWorkspace() outside a workspace');
	return store;
}

/** The store of the workspace being shown, or `undefined` outside `(app)/[ws]` (the standalone editor). */
export function tryWorkspace(): WorkspaceStore | undefined {
	return getContext<(() => WorkspaceStore | undefined) | undefined>(CTX)?.();
}
