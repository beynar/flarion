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
import type { Member, Teamspace, Workspace } from '#lib/shared/schemas.ts';
import type { ViewDef } from '#lib/shared/definitions.ts';
import { compareRank, rankAfter } from '#lib/shared/sort-keys.ts';

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
	error?: string;
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

/** A subscription id within the protocol's 40 characters. */
export function subKey(prefix: string, id: string): string {
	const k = `${prefix}:${id}`;
	if (k.length <= 40) return k;
	let h1 = 5381;
	let h2 = 52711;
	for (let i = 0; i < id.length; i++) {
		h1 = (h1 * 33) ^ id.charCodeAt(i);
		h2 = (h2 * 31) ^ id.charCodeAt(i);
	}
	return `${prefix}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${id.length}`;
}

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
	readonly views = new SvelteMap<string, ViewDef[]>();
	status = $state<SocketStatus>('connecting');
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
	#loadedParents = new Set<string>([ROOT]);
	#expanded = new Set<string | null>([null]);
	#treeTimer: unknown = null;
	#registry = createRegistry([]);
	#socket: WorkspaceSocket | null = null;
	#midCounter = 0;
	#cacheTimer: unknown = null;
	#recentOpened: string[] = [];
	#openPages = new Map<string, { release: () => void; ancestors: Map<string, () => void> }>();
	#myPage: string | null = null;
	#started = false;
	#disposed = false;
	#resumedMode: 'replay' | 'snapshot' | null = null;

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
		const cache = this.#cache();
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
			},
			onFatal: (action, code, reason) => this.#fatal(action, code, reason),
			reauth: this.#o.reauth
		});
		this.#socket.start();
		void this.refreshProperties();
		void this.refreshDirectory();
	}

	dispose(): void {
		if (this.#disposed) return;
		void this.flushTitles();
		this.#disposed = true;
		this.#socket?.dispose();
		for (const t of this.#titleTimers.values()) this.#clock.clearTimeout(t);
		for (const l of this.#layers) if (l.timer) this.#clock.clearTimeout(l.timer);
		if (this.#treeTimer) this.#clock.clearTimeout(this.#treeTimer);
		if (this.#cacheTimer) this.#clock.clearTimeout(this.#cacheTimer);
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

	async refreshProperties(): Promise<void> {
		try {
			this.properties = await this.#rpc.property.list();
			this.#registry = createRegistry(this.properties);
		} catch {
			// the registry only gates optimistic validation; the server validates for real
		}
	}

	async refreshDirectory(): Promise<void> {
		const [members, teamspaces] = await Promise.allSettled([
			this.#rpc.workspace.members.list(),
			this.#rpc.workspace.teamspaces.list()
		]);
		if (members.status === 'fulfilled') this.members = members.value;
		if (teamspaces.status === 'fulfilled') this.teamspaces = teamspaces.value;
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
			this.#subs.set(id, { sub, count: 1 });
			this.#openWindow(id, sub);
			this.#send({ t: 'subscribe', id, sub });
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
			seq: prev?.seq ?? null
		});
	}

	#closeWindow(id: string): void {
		const w = this.windows.get(id);
		this.windows.delete(id);
		this.#pendingDiffs.delete(id);
		if (w) this.#gc(new Set(w.ids));
	}

	/** Grows or shrinks a view window. */
	setWindow(id: string, limit: number, group?: string): void {
		const held = this.#subs.get(id);
		if (held && held.sub.kind === 'view') held.sub = { ...held.sub, limit };
		this.#send({ t: 'window', id, limit, group });
	}

	#send(msg: ClientMessage): void {
		this.#socket?.send(msg);
	}

	#hello(): { lastSeq: number | null; subs: SubscriptionEntry[]; extra: ClientMessage[] } {
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
		return { lastSeq, subs, extra };
	}

	// ───────────────────────────── tree ─────────────────────────────

	/** Opens a branch of the sidebar: its children are subscribed. */
	expand(id: string): void {
		if (this.#expanded.has(id)) return;
		this.#expanded.add(id);
		this.expanded = new Set([...this.#expanded].filter((x): x is string => x !== null));
		this.#scheduleTree();
	}

	collapse(id: string): void {
		if (!this.#expanded.delete(id)) return;
		this.expanded = new Set([...this.#expanded].filter((x): x is string => x !== null));
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
		if (this.#treeTimer) return;
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
				return;
			case 'presence':
				for (const entry of msg.entries) {
					if (entry.users.length) this.presence.set(entry.pageId, entry.users);
					else this.presence.delete(entry.pageId);
				}
				return;
			case 'notification':
				this.notifications = [msg.notification, ...this.notifications.filter((n) => n.id !== msg.notification.id)].slice(0, 100);
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
				ids.push(row.id);
				rows.set(row.id, row);
			}
		} else {
			for (const row of msg.rows) {
				ids.push(row.id);
				rows.set(row.id, row);
			}
		}
		this.windows.set(msg.id, { ...w, status: 'ready', ids, rows, total: msg.total, seq: msg.seq, error: undefined });
		if (w.kind === 'tree' || w.kind === 'page') {
			const keep = new Set(ids);
			this.#gc(new Set([...touched].filter((id) => !keep.has(id))));
			this.#touch(touched);
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
		if (this.seq !== null && msg.seq <= this.seq && !msg.subs.some((s) => this.windows.get(s.id)?.status === 'pending')) {
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
			if (w.seq !== null && msg.seq <= w.seq) continue;
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
		}
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
			result = await (send ?? ((m) => this.#rpc.mutate({ mid: m, ops, appVersion: this.#o.appVersion ?? APP_VERSION })))(mid);
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
		return this.subscribe('pg:set', { kind: 'page', pageIds: list });
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

	/** Rows of a window (view and backlinks) with optimistic value edits applied. */
	windowRows(windowId: string): (ViewRow | BacklinkRow)[] {
		const w = this.windows.get(windowId);
		if (!w) return [];
		return w.ids.flatMap((id): (ViewRow | BacklinkRow)[] => {
			const row = w.rows.get(id);
			if (!row) return [];
			if (!('values' in row)) return [row];
			let values = row.values;
			let title = row.title;
			for (const layer of this.#layers)
				for (const op of layer.ops) {
					if ((op.op === 'setProp' || op.op === 'addOption' || op.op === 'removeOption') && op.page === id) {
						if (op.prop === SYSTEM_TITLE && op.op === 'setProp') title = typeof op.value === 'string' ? op.value : '';
						else {
							const def = this.#registry.get(op.prop);
							const r = def ? applyValueOp(def, values[op.prop] ?? null, op) : null;
							if (r?.ok) values = { ...values, [op.prop]: r.value };
							else if (!def && op.op === 'setProp') values = { ...values, [op.prop]: op.value };
						}
					}
				}
			return [{ ...row, values, title }];
		});
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
			if (Array.isArray(fav)) this.favorites = fav.filter((x): x is string => typeof x === 'string');
			const rec = JSON.parse(s.getItem(`${this.#prefKey}.recent`) ?? '[]');
			if (Array.isArray(rec)) this.recent = rec.filter((x) => x && typeof x.id === 'string' && typeof x.at === 'number').slice(0, MAX_RECENT);
		} catch {
			// corrupt preferences: start empty
		}
	}

	#savePref(name: 'fav' | 'recent', value: unknown): void {
		try {
			this.#storage()?.setItem(`${this.#prefKey}.${name}`, JSON.stringify(value));
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

const TREE_ID = 'tree';

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
