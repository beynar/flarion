/**
 * A mock of the workspace socket and the private RPC, serving the P0 mock data through the same
 * message shapes as the real server (`src/lib/shared/protocol.ts`). The app runs on it with
 * `?mock=1`; the store's tests drive it directly.
 *
 * `MockServer` keeps an in-memory page table and a commit log. `connect()` returns a `Transport`
 * (a stand-in for the WebSocket) that answers `hello` with `welcome` (and `resumed`), subscriptions
 * with snapshots, and every commit with one `diff` or `head` frame carrying its `seq`. Diffs are
 * computed generically: each subscription's rows before and after a commit are compared and the
 * add, remove, move and update operations that turn one into the other are sent.
 *
 * Tests can control delivery: `holdDelivery()` queues frames until `releaseDelivery()`,
 * `inject()` sends a raw frame to every socket, and `dropConnections(code)` closes them.
 */
import {
	decodeClientMessage,
	encodeServerMessage,
	type BacklinkRow,
	type ClientMessage,
	type PageRow,
	type PresenceUser,
	type ServerMessage,
	type Subscription,
	type TreeRow,
	type Values
} from '#lib/shared/protocol.ts';
import type { Op } from '#lib/shared/ops.ts';
import { TITLE_PROP_ID, type PropertyDef } from '#lib/shared/property-types.ts';
import { evenRanks, rankAfter } from '#lib/shared/sort-keys.ts';
import type { Grant, Invite, Member, Me, Teamspace, TeamspaceMember, Workspace } from '#lib/shared/schemas.ts';
import { installMockRpc, type Rpc } from '#lib/client/rpc.ts';
import * as mock from '#lib/client/mock.ts';
import { WS_CLOSED, WS_CONNECTING, WS_OPEN, type Transport, type TransportFactory } from '#lib/client/socket.ts';

// ───────────────────────────── data ─────────────────────────────

export const MOCK_WORKSPACE: Workspace = {
	id: 'ws_acme',
	name: mock.workspace.name,
	slug: mock.workspace.slug,
	icon: null,
	role: 'owner',
	createdAt: '2026-01-05T09:00:00.000Z'
};

export const MOCK_USER = { id: mock.user.id, name: mock.user.name, email: mock.user.email, image: null as string | null };

const PEOPLE: Member[] = [
	{ userId: 'u_ada', name: 'Ada Lovelace', email: 'ada@acme.example', image: null, role: 'owner', joinedAt: '2026-01-05T09:00:00.000Z' },
	{ userId: 'u_grace', name: 'Grace Hopper', email: 'grace@acme.example', image: null, role: 'admin', joinedAt: '2026-01-08T09:00:00.000Z' },
	{ userId: 'u_alan', name: 'Alan Turing', email: 'alan@acme.example', image: null, role: 'member', joinedAt: '2026-02-02T09:00:00.000Z' },
	{ userId: 'u_margaret', name: 'Margaret Hamilton', email: 'margaret@acme.example', image: null, role: 'member', joinedAt: '2026-03-14T09:00:00.000Z' }
];

const TEAMSPACES: Teamspace[] = [
	{ id: 'ts_engineering', name: 'Engineering', icon: '⚙️', description: '', privacy: 'open', defaultLevel: 'update', createdBy: 'u_grace', myRole: 'member' },
	{ id: 'ts_design', name: 'Design', icon: '🎨', description: '', privacy: 'open', defaultLevel: 'update', createdBy: 'u_margaret', myRole: 'member' }
];

/** Teamspaces as stored (no `myRole`: it depends on who asks) and their members. Marketing is open, Leadership closed, Finance private (hidden from Ada). */
type StoredTeamspace = Omit<Teamspace, 'myRole'>;
const STORED_TEAMSPACES: StoredTeamspace[] = [
	...TEAMSPACES.map(({ myRole: _r, ...t }) => (void _r, t)),
	{ id: 'ts_marketing', name: 'Marketing', icon: '📣', description: 'Campaigns, launches and the brand calendar.', privacy: 'open', defaultLevel: 'update', createdBy: 'u_alan' },
	{ id: 'ts_leadership', name: 'Leadership', icon: '🧭', description: 'Planning and hiring. Joined by invitation.', privacy: 'closed', defaultLevel: 'read', createdBy: 'u_grace' },
	{ id: 'ts_finance', name: 'Finance', icon: '💶', description: 'Budgets.', privacy: 'private', defaultLevel: 'read', createdBy: 'u_grace' }
];
const tm = (teamspaceId: string, userId: string, role: 'owner' | 'member', rank: string): TeamspaceMember => ({ teamspaceId, userId, role, rank });
const STORED_TEAMSPACE_MEMBERS: TeamspaceMember[] = [
	tm('ts_engineering', 'u_grace', 'owner', '10'),
	tm('ts_engineering', 'u_ada', 'member', '10'),
	tm('ts_engineering', 'u_alan', 'member', '10'),
	tm('ts_design', 'u_margaret', 'owner', '10'),
	tm('ts_design', 'u_ada', 'member', '20'),
	tm('ts_marketing', 'u_alan', 'owner', '10'),
	tm('ts_leadership', 'u_grace', 'owner', '10'),
	tm('ts_finance', 'u_grace', 'owner', '10')
];

const PROPERTIES: PropertyDef[] = [
	{ id: TITLE_PROP_ID, name: 'Name', type: 'title', config: {} },
	{ id: 'owner', name: 'Owner', type: 'person', config: {} },
	{
		id: 'status',
		name: 'Status',
		type: 'status',
		config: {
			options: [
				{ id: 'not_started', name: 'Not started', color: 'gray' },
				{ id: 'in_progress', name: 'In progress', color: 'blue' },
				{ id: 'done', name: 'Done', color: 'green' },
				{ id: 'review', name: 'In review', color: 'orange' }
			],
			groups: [
				{ id: 'todo', name: 'To-do', color: 'gray', optionIds: ['not_started'] },
				{ id: 'doing', name: 'In progress', color: 'blue', optionIds: ['in_progress', 'review'] },
				{ id: 'complete', name: 'Complete', color: 'green', optionIds: ['done'] }
			]
		}
	},
	{ id: 'due', name: 'Due', type: 'date', config: { includeTime: false } },
	{
		id: 'tags',
		name: 'Tags',
		type: 'select',
		config: { options: [{ id: 'onboarding', name: 'Onboarding', color: 'green' }] }
	}
];

const STATUS_BY_NAME: Record<string, string> = { 'Not started': 'not_started', 'In progress': 'in_progress', Done: 'done', 'In review': 'review' };

function seedPages(): PageRow[] {
	const teamspaceOf = (p: mock.MockPage) => (p.section === 'teamspace' ? `ts_${p.teamspace!.toLowerCase()}` : null);
	const creator = (p: mock.MockPage) => (p.section === 'private' ? 'u_ada' : mock.members.find((m) => m.name === p.editedBy)?.email.split('@')[0] === 'grace' ? 'u_grace' : p.editedBy === 'Alan Turing' ? 'u_alan' : p.editedBy === 'Margaret Hamilton' ? 'u_margaret' : 'u_grace');
	const groups = new Map<string, mock.MockPage[]>();
	for (const p of mock.pages) {
		const k = `${p.parent ?? ''}|${p.parent ? '' : (teamspaceOf(p) ?? p.section)}`;
		groups.set(k, [...(groups.get(k) ?? []), p]);
	}
	const rank = new Map<string, string>();
	for (const list of groups.values()) evenRanks(list.length).forEach((r, i) => rank.set(list[i].slug, r));
	return mock.pages.map((p) => {
		const values: Values = { [TITLE_PROP_ID]: p.title };
		for (const prop of p.properties) {
			if (prop.type === 'person') values.owner = [PEOPLE.find((m) => m.name === prop.value)?.userId ?? 'u_ada'];
			else if (prop.type === 'status') values.status = STATUS_BY_NAME[prop.value] ?? 'not_started';
			else if (prop.type === 'date') values.due = { start: '2026-11-21' };
			else if (prop.type === 'select') values.tags = 'onboarding';
		}
		return {
			id: p.slug,
			parentId: p.parent ?? null,
			rank: rank.get(p.slug)!,
			title: p.title,
			icon: p.icon,
			isDatabase: false,
			teamspaceId: teamspaceOf(p),
			hasChildren: mock.pages.some((c) => c.parent === p.slug),
			access: p.section === 'shared' ? 'update' : 'full',
			// a preset key (see page-header/covers.ts)
			cover: p.cover ?? null,
			values,
			createdBy: creator(p),
			createdAt: '2026-10-01T09:00:00.000Z',
			updatedBy: creator(p),
			updatedAt: '2026-11-06T09:00:00.000Z'
		};
	});
}

type Row = TreeRow | PageRow | BacklinkRow;
const toTree = (p: PageRow): TreeRow => ({
	id: p.id,
	parentId: p.parentId,
	rank: p.rank,
	title: p.title,
	icon: p.icon,
	isDatabase: p.isDatabase,
	teamspaceId: p.teamspaceId,
	hasChildren: p.hasChildren,
	access: p.access,
	createdBy: p.createdBy
});

// ───────────────────────────── server ─────────────────────────────

export interface MockServerOptions {
	pages?: PageRow[];
	/** ms between a commit and its frames reaching sockets. 0 delivers synchronously. */
	deliveryDelayMs?: number;
	/** ms the mock RPC takes to answer. */
	rpcLatencyMs?: number;
	userId?: string;
	/** Frames queued per socket go out after this many ms (open and hello answers). */
	openDelayMs?: number;
}

type SocketSubs = Map<string, Subscription>;

export class MockServer {
	readonly pages = new Map<string, PageRow>();
	readonly trashed = new Map<string, PageRow>();
	readonly log: { seq: number; ops: Op[]; mid?: string }[] = [];
	readonly sockets = new Set<MockSocket>();
	readonly clientMessages: ClientMessage[] = [];
	readonly presence = new Map<string, PresenceUser[]>();
	readonly invites: Invite[] = [];
	teamspaces: StoredTeamspace[] = structuredClone(STORED_TEAMSPACES);
	teamspaceMembers: TeamspaceMember[] = structuredClone(STORED_TEAMSPACE_MEMBERS);
	grants: Grant[] = [];
	properties: PropertyDef[] = structuredClone(PROPERTIES);
	seq = 100;
	connections = 0;
	/** Close new connections at once with this code (a rejected upgrade). */
	rejectWith: number | null = null;
	/** Fail the next `mutate` with this error. */
	failNext: unknown = null;
	readonly #opts: Required<Omit<MockServerOptions, 'pages'>>;
	#held: (() => void)[] | null = null;

	constructor(options: MockServerOptions = {}) {
		this.#opts = { deliveryDelayMs: 25, rpcLatencyMs: 40, userId: MOCK_USER.id, openDelayMs: 10, ...options };
		for (const p of options.pages ?? seedPages()) this.pages.set(p.id, p);
	}

	get userId(): string {
		return this.#opts.userId;
	}
	get rpcLatencyMs(): number {
		return this.#opts.rpcLatencyMs;
	}
	get openDelayMs(): number {
		return this.#opts.openDelayMs;
	}

	/** A `TransportFactory` for `WorkspaceStore` and `WorkspaceSocket`. */
	get factory(): TransportFactory {
		return () => this.connect();
	}

	connect(): MockSocket {
		this.connections++;
		const socket = new MockSocket(this);
		this.sockets.add(socket);
		return socket;
	}

	// frame delivery -----------------------------------------------------------------------

	schedule(fn: () => void, delay: number): void {
		const run = () => {
			if (this.#held) this.#held.push(fn);
			else fn();
		};
		if (delay <= 0) queueMicrotask(run);
		else setTimeout(run, delay);
	}

	/** Queues every frame from now on, until `releaseDelivery()`. */
	holdDelivery(): void {
		this.#held ??= [];
	}
	releaseDelivery(order?: (a: number, b: number) => number): void {
		const queued = this.#held ?? [];
		this.#held = null;
		const idx = queued.map((_, i) => i);
		if (order) idx.sort(order);
		for (const i of idx) queued[i]();
	}

	/** Sends a raw frame to every open socket. */
	inject(msg: ServerMessage): void {
		for (const s of this.sockets) s.push(msg);
	}

	dropConnections(code = 1006, reason = ''): void {
		for (const s of [...this.sockets]) s.serverClose(code, reason);
	}

	setPresence(pageId: string, users: PresenceUser[]): void {
		if (users.length) this.presence.set(pageId, users);
		else this.presence.delete(pageId);
		this.inject({ t: 'presence', entries: [{ pageId, users }] });
	}

	// state ---------------------------------------------------------------------------------

	children(parentId: string | null, teamspaceId?: string | null): PageRow[] {
		return [...this.pages.values()]
			.filter((p) => p.parentId === parentId && (parentId !== null || teamspaceId === undefined || p.teamspaceId === teamspaceId))
			.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
	}

	rowsFor(sub: Subscription): Row[] {
		switch (sub.kind) {
			case 'tree':
				return sub.parents.flatMap((parent) => this.children(parent).map(toTree));
			case 'page':
				return sub.pageIds.flatMap((id) => (this.pages.has(id) ? [structuredClone(this.pages.get(id)!)] : []));
			case 'backlinks':
				return this.backlinksOf(sub.pageId);
			default:
				return [];
		}
	}

	backlinksOf(pageId: string): BacklinkRow[] {
		const page = this.pages.get(pageId);
		if (!page) return [];
		const subs = this.children(pageId).map((c) => ({ id: c.id, title: c.title, icon: c.icon, kind: 'subpage' as const }));
		const mentions = pageId === 'architecture' ? [{ id: 'roadmap', title: 'Roadmap', icon: '🗺️', kind: 'mention' as const }] : [];
		return [...mentions, ...subs.slice(0, 0)];
	}

	/** Applies ops, appends to the log and delivers diffs. Returns the commit's seq. */
	commit(ops: Op[], mid?: string): number {
		const before = new Map<MockSocket, Map<string, Row[]>>();
		for (const s of this.sockets) before.set(s, s.snapshotRows());
		for (const op of ops) this.#apply(op);
		const seq = ++this.seq;
		this.log.push({ seq, ops, mid });
		for (const s of [...this.sockets]) {
			const prev = before.get(s) ?? new Map();
			this.schedule(() => s.deliverCommit(seq, prev), this.#opts.deliveryDelayMs);
		}
		return seq;
	}

	#apply(op: Op): void {
		const now = new Date().toISOString();
		switch (op.op) {
			case 'create': {
				const title = op.values?.[TITLE_PROP_ID];
				const siblings = this.children(op.parentId, op.parentId === null ? (op.teamspaceId ?? null) : undefined);
				const parent = op.parentId ? this.pages.get(op.parentId) : undefined;
				this.pages.set(op.id, {
					id: op.id,
					parentId: op.parentId,
					rank: op.rank ?? rankAfter(siblings.at(-1)?.rank ?? null),
					title: typeof title === 'string' ? title : '',
					icon: op.icon ?? null,
					isDatabase: !!op.isDatabase,
					teamspaceId: op.parentId ? (parent?.teamspaceId ?? null) : (op.teamspaceId ?? null),
					hasChildren: false,
					access: 'full',
					cover: op.cover ?? null,
					values: { ...(op.values as Values | undefined), ...(typeof title === 'string' ? { [TITLE_PROP_ID]: title } : {}) },
					createdBy: this.userId,
					createdAt: now,
					updatedBy: this.userId,
					updatedAt: now
				});
				if (parent) parent.hasChildren = true;
				break;
			}
			case 'setProp': {
				const p = this.pages.get(op.page);
				if (!p) break;
				if (op.prop === TITLE_PROP_ID) p.title = typeof op.value === 'string' ? op.value : '';
				p.values = { ...p.values, [op.prop]: op.value };
				p.updatedAt = now;
				p.updatedBy = this.userId;
				break;
			}
			case 'addOption':
			case 'removeOption': {
				const p = this.pages.get(op.page);
				if (!p) break;
				const cur = Array.isArray(p.values[op.prop]) ? (p.values[op.prop] as string[]) : [];
				p.values = { ...p.values, [op.prop]: op.op === 'addOption' ? [...new Set([...cur, op.option])] : cur.filter((x) => x !== op.option) };
				break;
			}
			case 'setPage': {
				const p = this.pages.get(op.page);
				if (!p) break;
				if (op.icon !== undefined) p.icon = op.icon;
				if (op.cover !== undefined) p.cover = op.cover;
				break;
			}
			case 'move': {
				const p = this.pages.get(op.page);
				if (!p) break;
				const old = p.parentId ? this.pages.get(p.parentId) : undefined;
				p.parentId = op.parentId;
				p.rank = op.rank;
				if (op.teamspaceId !== undefined) p.teamspaceId = op.teamspaceId;
				if (old) old.hasChildren = this.children(old.id).length > 0 && this.children(old.id).some((c) => c.id !== p.id);
				const parent = op.parentId ? this.pages.get(op.parentId) : undefined;
				if (parent) parent.hasChildren = true;
				break;
			}
			case 'trash': {
				const walk = (id: string) => {
					for (const c of this.children(id)) walk(c.id);
					const p = this.pages.get(id);
					if (p) {
						this.trashed.set(id, p);
						this.pages.delete(id);
					}
				};
				const p = this.pages.get(op.page);
				walk(op.page);
				const parent = p?.parentId ? this.pages.get(p.parentId) : undefined;
				if (parent) parent.hasChildren = this.children(parent.id).length > 0;
				break;
			}
			case 'restore': {
				const p = this.trashed.get(op.page);
				if (p) {
					this.trashed.delete(op.page);
					this.pages.set(p.id, p);
				}
				break;
			}
			case 'createProperty':
				if (!this.properties.some((d) => d.id === op.property.id)) this.properties = [...this.properties, structuredClone(op.property) as PropertyDef];
				break;
			case 'updateProperty':
				this.properties = this.properties.map((d) =>
					d.id === op.id ? ({ ...d, ...(op.name ? { name: op.name } : {}), ...(op.config ? { config: op.config } : {}) } as PropertyDef) : d
				);
				break;
			case 'deleteProperty':
				this.properties = this.properties.filter((d) => d.id !== op.id);
				for (const p of this.pages.values()) {
					if (op.id in p.values) {
						const { [op.id]: _gone, ...rest } = p.values;
						void _gone;
						p.values = rest;
					}
				}
				break;
			default:
		}
	}
}

// ───────────────────────────── one connection ─────────────────────────────

/** The server end of one WebSocket. Implements the client's `Transport`. */
export class MockSocket implements Transport {
	readyState: number = WS_CONNECTING;
	onopen: ((ev?: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
	onerror: ((ev?: unknown) => void) | null = null;
	readonly subs: SocketSubs = new Map();
	readonly #server: MockServer;
	#welcomed = false;

	constructor(server: MockServer) {
		this.#server = server;
		server.schedule(() => {
			if (this.readyState !== WS_CONNECTING) return;
			if (server.rejectWith !== null) {
				this.serverClose(server.rejectWith, 'rejected');
				return;
			}
			this.readyState = WS_OPEN;
			this.onopen?.();
		}, server.openDelayMs);
	}

	send(data: string): void {
		if (this.readyState !== WS_OPEN) throw new Error('MockSocket is not open');
		const decoded = decodeClientMessage(data);
		if (!decoded.ok) {
			this.serverClose(4400, decoded.message);
			return;
		}
		const msg = decoded.value;
		this.#server.clientMessages.push(msg);
		this.#server.schedule(() => this.#handle(msg), 0);
	}

	close(code = 1000, reason = ''): void {
		if (this.readyState === WS_CLOSED) return;
		this.readyState = WS_CLOSED;
		this.#server.sockets.delete(this);
		void reason;
		void code;
	}

	serverClose(code: number, reason = ''): void {
		if (this.readyState === WS_CLOSED) return;
		this.readyState = WS_CLOSED;
		this.#server.sockets.delete(this);
		this.onclose?.({ code, reason });
	}

	push(msg: ServerMessage): void {
		if (this.readyState !== WS_OPEN) return;
		this.onmessage?.({ data: encodeServerMessage(msg) });
	}

	#answer(msg: ServerMessage): void {
		this.#server.schedule(() => this.push(msg), 0);
	}

	#snapshot(id: string, sub: Subscription): void {
		const rows = this.#server.rowsFor(sub);
		if (sub.kind === 'page' && sub.pageIds.some((p) => !this.#server.pages.has(p)) && rows.length === 0) {
			this.#answer({ t: 'error', code: 'not_found', message: 'Page not found', id });
			return;
		}
		this.#answer({ t: 'snapshot', kind: sub.kind, id, rows, total: rows.length, seq: this.#server.seq } as ServerMessage);
	}

	#handle(msg: ClientMessage): void {
		const server = this.#server;
		switch (msg.t) {
			case 'hello': {
				this.#welcomed = true;
				this.#answer({
					t: 'welcome',
					protocol: 1,
					appVersion: 'dev',
					minAppVersion: '0.0.0',
					kindsVersion: 1,
					userId: server.userId,
					seq: server.seq
				});
				for (const entry of msg.subs) this.subs.set(entry.id, entry.sub);
				if (msg.lastSeq !== null) {
					if (msg.lastSeq === server.seq) {
						this.#answer({ t: 'resumed', mode: 'replay', fromSeq: msg.lastSeq, seq: server.seq });
						this.#answer({ t: 'head', seq: server.seq });
					} else {
						this.#answer({ t: 'resumed', mode: 'snapshot', fromSeq: msg.lastSeq, seq: server.seq });
						for (const [id, sub] of this.subs) this.#snapshot(id, sub);
					}
				} else {
					for (const [id, sub] of this.subs) this.#snapshot(id, sub);
				}
				if (server.presence.size) {
					this.#answer({ t: 'presence', entries: [...server.presence].map(([pageId, users]) => ({ pageId, users })) });
				}
				return;
			}
			case 'subscribe':
				this.subs.set(msg.id, msg.sub);
				this.#snapshot(msg.id, msg.sub);
				return;
			case 'unsubscribe':
				this.subs.delete(msg.id);
				return;
			case 'presence': {
				const me: PresenceUser = { userId: server.userId, name: MOCK_USER.name };
				for (const [pageId, users] of [...server.presence]) {
					const rest = users.filter((u) => u.userId !== me.userId);
					if (rest.length !== users.length) server.setPresence(pageId, rest);
				}
				if (msg.pageId) server.setPresence(msg.pageId, [...(server.presence.get(msg.pageId) ?? []), me]);
				return;
			}
			case 'ping':
				this.#answer({ t: 'pong' });
				return;
			default:
		}
	}

	snapshotRows(): Map<string, Row[]> {
		return new Map([...this.subs].map(([id, sub]) => [id, this.#server.rowsFor(sub)]));
	}

	/** Sends the diff of one commit (or a head) given the rows each subscription had before it. */
	deliverCommit(seq: number, before: Map<string, Row[]>): void {
		if (this.readyState !== WS_OPEN || !this.#welcomed) return;
		const subs: { id: string; ops: import('#lib/shared/protocol.ts').DiffOp[] }[] = [];
		for (const [id, sub] of this.subs) {
			const ops = diffRows(before.get(id) ?? [], this.#server.rowsFor(sub));
			if (ops.length) subs.push({ id, ops });
		}
		this.push(subs.length ? { t: 'diff', seq, subs } : { t: 'head', seq });
	}
}

const FIELDS = ['title', 'icon', 'cover', 'parentId', 'rank', 'teamspaceId', 'isDatabase', 'access', 'hasChildren'] as const;
const FIELD_PROP: Record<string, string> = {
	title: TITLE_PROP_ID,
	icon: '$icon',
	cover: '$cover',
	parentId: '$parent',
	rank: '$rank',
	teamspaceId: '$teamspace',
	isDatabase: '$isDatabase',
	access: '$access',
	hasChildren: '$hasChildren'
};

/** The ops that turn `before` into `after` (adds and moves at indexes, removes, per-value updates). */
export function diffRows(before: Row[], after: Row[]): import('#lib/shared/protocol.ts').DiffOp[] {
	const ops: import('#lib/shared/protocol.ts').DiffOp[] = [];
	const afterIds = new Set(after.map((r) => r.id));
	const beforeById = new Map(before.map((r) => [r.id, r]));
	const cur = before.map((r) => r.id);
	for (const r of before) {
		if (!afterIds.has(r.id)) {
			ops.push({ op: 'remove', id: r.id });
			cur.splice(cur.indexOf(r.id), 1);
		}
	}
	after.forEach((row, i) => {
		const had = beforeById.get(row.id);
		if (!had) {
			ops.push({ op: 'add', index: i, row: row as never });
			cur.splice(i, 0, row.id);
			return;
		}
		if (cur[i] !== row.id) {
			cur.splice(cur.indexOf(row.id), 1);
			cur.splice(i, 0, row.id);
			ops.push({ op: 'move', id: row.id, index: i });
		}
		const a = had as Record<string, unknown>;
		const b = row as Record<string, unknown>;
		for (const f of FIELDS) {
			if (f in b && JSON.stringify(a[f]) !== JSON.stringify(b[f])) ops.push({ op: 'update', id: row.id, prop: FIELD_PROP[f], value: b[f] as never });
		}
		const av = (a.values ?? {}) as Values;
		const bv = (b.values ?? {}) as Values;
		for (const k of new Set([...Object.keys(av), ...Object.keys(bv)])) {
			if (k === TITLE_PROP_ID) continue;
			if (JSON.stringify(av[k]) !== JSON.stringify(bv[k])) ops.push({ op: 'update', id: row.id, prop: k, value: bv[k] ?? null });
		}
	});
	if (after.length !== before.length) ops.push({ op: 'count', total: after.length });
	return ops;
}

// ───────────────────────────── the mock RPC ─────────────────────────────

const later = <T>(ms: number, fn: () => T): Promise<T> => new Promise((res, rej) => setTimeout(() => { try { res(fn()); } catch (e) { rej(e); } }, ms));

const notAvailable = (path: string[]) => () => Promise.reject(new Error(`rpc.${path.join('.')} is not available in mock mode`));
function fallbackProxy(path: string[] = []): unknown {
	return new Proxy(() => undefined, { get: (_t, p) => (typeof p === 'string' ? fallbackProxy([...path, p]) : undefined), apply: () => notAvailable(path)() });
}

type Delay = <T>(fn: () => T) => Promise<T>;
const mockError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** `workspace.teamspaces.*` over the server's in-memory teamspaces and members (privacy and roles as the real server). */
function teamspacesRpc(server: MockServer, delay: Delay) {
	const me = server.userId;
	const roleOf = (id: string) => server.teamspaceMembers.find((m) => m.teamspaceId === id && m.userId === me)?.role ?? null;
	const view = (t: StoredTeamspace): Teamspace => ({ ...t, myRole: roleOf(t.id) });
	const live = (id: string) => {
		const t = server.teamspaces.find((x) => x.id === id);
		if (!t || (t.privacy === 'private' && !roleOf(id))) throw mockError('NOT_FOUND', `Teamspace "${id}" not found`);
		return t;
	};
	const owners = (id: string) => server.teamspaceMembers.filter((m) => m.teamspaceId === id && m.role === 'owner').length;
	const nextRank = () => String(Math.max(0, ...server.teamspaceMembers.filter((m) => m.userId === me).map((m) => Number(m.rank) || 0)) + 10);
	return {
		list: () => delay(() => server.teamspaces.filter((t) => t.privacy !== 'private' || roleOf(t.id)).map(view)),
		create: (input: { name: string; icon?: string | null; description?: string; privacy: Teamspace['privacy']; defaultLevel: Teamspace['defaultLevel'] }) =>
			delay(() => {
				const t: StoredTeamspace = {
					id: `ts_${Date.now().toString(36)}${server.teamspaces.length}`,
					name: input.name,
					icon: input.icon ?? null,
					description: input.description ?? '',
					privacy: input.privacy,
					defaultLevel: input.defaultLevel,
					createdBy: me
				};
				server.teamspaces.push(t);
				server.teamspaceMembers.push(tm(t.id, me, 'owner', nextRank()));
				return view(t);
			}),
		update: (input: { id: string } & Partial<Omit<StoredTeamspace, 'id' | 'createdBy'>>) =>
			delay(() => {
				const t = live(input.id);
				const { id: _id, ...patch } = input;
				void _id;
				Object.assign(t, patch);
				return view(t);
			}),
		archive: (input: { id: string }) =>
			delay(() => {
				live(input.id);
				server.teamspaces = server.teamspaces.filter((t) => t.id !== input.id);
				server.teamspaceMembers = server.teamspaceMembers.filter((m) => m.teamspaceId !== input.id);
				return { seq: server.commit([]) };
			}),
		members: {
			list: (input: { teamspaceId: string }) =>
				delay(() => {
					live(input.teamspaceId);
					return server.teamspaceMembers.filter((m) => m.teamspaceId === input.teamspaceId);
				}),
			add: (input: { teamspaceId: string; userId: string; role?: 'owner' | 'member' }) =>
				delay(() => {
					live(input.teamspaceId);
					const existing = server.teamspaceMembers.find((m) => m.teamspaceId === input.teamspaceId && m.userId === input.userId);
					if (existing) {
						if (input.role) existing.role = input.role;
						return existing;
					}
					const row = tm(input.teamspaceId, input.userId, input.role ?? 'member', input.userId === me ? nextRank() : '10');
					server.teamspaceMembers.push(row);
					return row;
				}),
			setRole: (input: { teamspaceId: string; userId: string; role: 'owner' | 'member' }) =>
				delay(() => {
					const row = server.teamspaceMembers.find((m) => m.teamspaceId === input.teamspaceId && m.userId === input.userId);
					if (!row) throw mockError('NOT_FOUND', `Member "${input.userId}" not found`);
					if (row.role === 'owner' && input.role !== 'owner' && owners(input.teamspaceId) <= 1) throw mockError('CONFLICT', 'A teamspace needs at least one owner');
					row.role = input.role;
					return row;
				}),
			remove: (input: { teamspaceId: string; userId: string }) =>
				delay(() => {
					const row = server.teamspaceMembers.find((m) => m.teamspaceId === input.teamspaceId && m.userId === input.userId);
					if (!row) return {};
					if (row.role === 'owner' && owners(input.teamspaceId) <= 1) throw mockError('CONFLICT', 'A teamspace needs at least one owner');
					server.teamspaceMembers = server.teamspaceMembers.filter((m) => m !== row);
					return {};
				})
		}
	};
}

/** `page.grants.*` over the server's in-memory grants; ancestors' grants come back marked inherited. */
function grantsRpc(server: MockServer, delay: Delay) {
	return {
		list: (input: { id: string }) =>
			delay(() => {
				const out: Grant[] = [];
				let cur = server.pages.get(input.id);
				let guard = 0;
				while (cur && guard++ < 50) {
					for (const g of server.grants.filter((x) => x.pageId === cur!.id)) {
						out.push(cur.id === input.id ? g : { ...g, inherited: true, fromPageId: cur.id });
					}
					cur = cur.parentId ? server.pages.get(cur.parentId) : undefined;
				}
				return out;
			}),
		set: (input: { pageId: string; subjectKind: Grant['subjectKind']; subjectId: string | null; level: Grant['level']; email?: string }) =>
			delay(() => {
				if (server.pages.get(input.pageId)?.access !== 'full') throw mockError('FORBIDDEN', 'You need full access to share this page');
				let subjectId = input.subjectId;
				let pending = false;
				if (input.subjectKind === 'user' && !subjectId && input.email) {
					const member = PEOPLE.find((m) => m.email.toLowerCase() === input.email!.toLowerCase());
					if (member) subjectId = member.userId;
					else pending = true;
				}
				const same = (g: Grant) =>
					g.pageId === input.pageId && g.subjectKind === input.subjectKind && g.subjectId === subjectId && (!pending || g.email === input.email);
				const existing = server.grants.find(same);
				if (existing) {
					existing.level = input.level;
					return structuredClone(existing);
				}
				const grant: Grant = {
					id: `gr_${server.grants.length + 1}_${Date.now().toString(36)}`,
					pageId: input.pageId,
					subjectKind: input.subjectKind,
					subjectId,
					level: input.level,
					token: input.subjectKind === 'public' ? `tok_${Math.random().toString(36).slice(2, 12)}` : null,
					createdBy: server.userId,
					...(pending ? { pending: true, email: input.email } : {})
				};
				server.grants.push(grant);
				return structuredClone(grant);
			}),
		revoke: (input: { grantId: string }) =>
			delay(() => {
				server.grants = server.grants.filter((g) => g.id !== input.grantId);
				return { seq: server.commit([]) };
			})
	};
}

export function createMockRpc(server: MockServer): Rpc {
	const delay = <T>(fn: () => T) => later(server.rpcLatencyMs, fn);
	const me = (): Me => ({ ...MOCK_USER, emailVerified: true, workspaces: [MOCK_WORKSPACE] });
	const impl = {
		me: () => delay(me),
		workspace: {
			list: () => delay(() => [MOCK_WORKSPACE]),
			get: () => delay(() => MOCK_WORKSPACE),
			members: {
				list: () => delay(() => PEOPLE),
				setRole: () => delay(() => ({})),
				remove: () => delay(() => ({}))
			},
			invites: {
				list: () => delay(() => server.invites),
				create: (input: { email: string; role: 'admin' | 'member' | 'guest' }) =>
					delay(() => {
						const invite: Invite = {
							id: `inv_${server.invites.length + 1}`,
							email: input.email,
							role: input.role,
							createdBy: MOCK_USER.id,
							expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
							acceptedAt: null
						};
						server.invites.push(invite);
						return invite;
					}),
				revoke: (input: { id: string }) =>
					delay(() => {
						const i = server.invites.findIndex((x) => x.id === input.id);
						if (i !== -1) server.invites.splice(i, 1);
						return {};
					})
			},
			teamspaces: teamspacesRpc(server, delay)
		},
		property: {
			list: () => delay(() => server.properties),
			create: (input: { property: PropertyDef }) => delay(() => ({ seq: server.commit([{ op: 'createProperty', property: input.property }]) })),
			update: (input: { id: string; name?: string; config?: Record<string, unknown> }) =>
				delay(() => ({ seq: server.commit([{ op: 'updateProperty', ...input }]) })),
			delete: (input: { id: string }) => delay(() => ({ seq: server.commit([{ op: 'deleteProperty', id: input.id }]) }))
		},
		page: {
			create: (input: { id?: string; parentId: string | null; rank?: string; teamspaceId?: string | null; icon?: string | null; values?: Values; isDatabase?: boolean }) =>
				delay(() => {
					const id = input.id ?? `pg_${Date.now().toString(36)}`;
					const seq = server.commit([{ op: 'create', id, parentId: input.parentId, rank: input.rank, teamspaceId: input.teamspaceId, icon: input.icon, isDatabase: input.isDatabase, values: input.values } as Op]);
					return { id, num: server.pages.size, seq };
				}),
			get: (input: { id: string }) => delay(() => {
				const p = server.pages.get(input.id);
				if (!p) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
				return p;
			}),
			roomToken: () => delay(() => ({ token: 'rt1.mock', expiresAt: Date.now() + 600_000, access: 'write' as const })),
			trash: (input: { id: string }) => delay(() => ({ seq: server.commit([{ op: 'trash', page: input.id }]) })),
			restore: (input: { id: string }) => delay(() => ({ seq: server.commit([{ op: 'restore', page: input.id }]) })),
			trashList: () => delay(() => ({ items: [], nextCursor: null })),
			grants: grantsRpc(server, delay)
		},
		mutate: (input: { mid: string; ops: Op[] }) =>
			delay(() => {
				if (server.failNext) {
					const e = server.failNext;
					server.failNext = null;
					throw e;
				}
				return { seq: server.commit(input.ops, input.mid) };
			}),
		search: {
			visit: () => delay(() => ({})),
			quick: (input: { q: string }) =>
				delay(() => ({
					items: [...server.pages.values()]
						.filter((p) => p.title.toLowerCase().startsWith(input.q.toLowerCase()))
						.map((p) => ({ id: p.id, title: p.title, icon: p.icon, source: 'title' as const }))
				}))
		}
	};
	const merge = (target: Record<string, unknown>, source: Record<string, unknown>): unknown =>
		new Proxy(target, {
			get(t, prop) {
				if (typeof prop !== 'string') return undefined;
				const own = t[prop];
				if (own && typeof own === 'object') return merge(own as Record<string, unknown>, {});
				if (own !== undefined) return own;
				return fallbackProxy([prop]);
			}
		});
	return merge(impl as unknown as Record<string, unknown>, {}) as Rpc;
}

// ───────────────────────────── the app's singleton ─────────────────────────────

let singleton: MockServer | null = null;

/** The server the mock-mode app talks to (created on first use). */
export function getMockServer(): MockServer {
	return (singleton ??= new MockServer());
}

/** Turns mock mode on: installs the mock RPC client. Idempotent. */
export function installMock(): MockServer {
	const server = getMockServer();
	installMockRpc(createMockRpc(server));
	return server;
}
