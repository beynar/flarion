/**
 * The workspace socket protocol (`/ws/:workspaceId`): JSON text frames, each an object with a
 * discriminating `t`. The same contracts back the mocked socket the UI runs on until the real
 * object exists.
 *
 * Flow
 *   client -> hello { appVersion, lastSeq, subs }      (every connect, first frame)
 *   server -> welcome { seq, userId, ... }
 *   server -> resumed { mode, fromSeq, seq }           (only when hello carried lastSeq)
 *   then, per subscription: snapshot, then diff frames tagged with the commit `seq`
 *
 * Sequence numbers. Every commit gets a `seq` (the last `change` row it appended). `diff` carries
 * the changes of one commit for every subscription of the socket that it touches, in one frame.
 * A commit that touches none of a socket's subscriptions still advances its position through
 * `head { seq }`, so a client can drop the optimistic layer of a `mutate` that returned `{ seq }`
 * once its socket has seen `seq` (a diff or a head with `seq >=` it) and so it always has a fresh
 * `lastSeq` to resume with.
 *
 * Reconnect. The client sends `hello` with its `lastSeq` and every subscription it holds. The
 * server answers `resumed`: `mode: 'replay'` when `lastSeq` is within the log's retention (7 days;
 * the changes since then follow as ordinary `diff` frames, in order, before a `head` with the
 * current seq), or `mode: 'snapshot'` when it is older, in which case a fresh `snapshot` follows
 * for each subscription and the client discards its windows. `subscribe` with an id the socket
 * already uses replaces that subscription (a tree whose expanded branches changed, a view whose
 * local filter changed) and answers with a new `snapshot`.
 *
 * Rows. A `view` or `page` row's `values` come from `props_json` (display), keyed by property id;
 * the title is the `title` property. `update` diffs address one value: `prop` is a property id, or
 * one of the `$`-prefixed row fields `$icon`, `$cover`, `$parent`, `$rank`, `$teamspace`,
 * `$isDatabase`, `$access`, `$hasChildren`.
 *
 * Live views (P3). A `view` subscription is a live query: the collection's membership and the view's filter
 * (ANDed with the subscription's `filter`, a `database_view` block's local filter), sorted, optionally grouped,
 * ANDed with what the actor may see. `snapshot.rows` is the window (the first `limit` rows) and `total` the
 * number of matching pages. Rows beyond the window are never sent. A commit sends, for each view it touches, one
 * ordered list of ops inside the single `diff` frame of the socket:
 *   `remove` first (rows that left, or are pushed out of the window), then `add`/`move` in final position
 *   order (rows that entered, or whose sort value changed, and rows that slid into the window after a leave:
 *   the "refill"), then `update` (one cell of a row the window holds), then `count`. A row that changes
 *   sort position inside the window is a `move`; one that leaves the window and re-enters is `remove` + `add`.
 *   `index` is the position inside the window (inside the group's window of a grouped view) after the earlier
 *   ops of the same list. A frame never repeats a row.
 *   `window { id, limit }` grows (or shrinks) the window and answers with one `diff` (the new rows are `add`s).
 * A definition change that alters what a view means (its filter, sorts, group-by, the collection's source, a
 * property's type or options) is applied as an ordinary diff computed against the new definition; the
 * `registry` frame tells the client to refetch the definitions.
 *
 * Grouped views (boards, grouped lists), additive and backward compatible (ungrouped views are unchanged).
 * When the effective `groupBy` is set, the snapshot carries `groups: [{ key, total, rows }]` in display order
 * (`rows: []` at the top level; `total` at the top level counts distinct pages, a page with several values of
 * a multi-select or relation appears in several groups). `limit` is per group, `window { id, limit, group }`
 * resizes one group (without `group`, all groups; an earlier per-group size is forgotten). Diff ops of a
 * grouped view name their `group` (`GROUP_EMPTY` for pages with no value): `add`, `remove`, `move` and `count`
 * carry `group`; a page changing group is a `remove` in one group and an `add` in the other; `update` ops carry
 * no group (the row is addressed by id, the client updates it in every group that holds it). A `count` with a
 * `group` is that group's total. The op `{ op: 'groups', keys }` replaces the ordered list of group keys: a
 * group the client does not hold is created empty, one missing from `keys` is dropped, the rest are reordered;
 * the server sends it whenever the list changes (a group appears or empties, options were edited) and the
 * adds and counts of the new groups follow it in the same list. The key of a select, status or multi-select
 * group is the option id, a person's group their user id, a relation's the target page id, a checkbox's
 * `true`/`false`, a date's its bucket start (`YYYY-MM-DD`). Option columns are listed even when empty.
 *
 * Trash. A trashed page (and its whole subtree) is removed from every window, tree and backlinks list like any
 * page that stops matching; a restore adds them back. A to-one relation cell to a trashed page reads `null`
 * (an `update` op carries the change on both trash and restore).
 *
 * Version skew. Every socket upgrade and every `/rpc` call carries the build in `x-app-version`
 * (sockets may use the `v` query parameter instead, browsers cannot set headers on a WebSocket).
 * A client older than the server's `MIN_APP_VERSION`, or whose block `kindsVersion` the rooms
 * refuse, is closed with CLOSE.RELOAD_REQUIRED and should reload the page.
 */
import * as v from 'valibot';
import { filterGroupSchema, groupBySpecSchema, sortsSchema } from './filter-ast.js';
import { idSchema, propValueSchema } from './property-types.js';
import { rankSchema } from './definitions.js';

export const PROTOCOL_VERSION = 1;

// ───────────────────────────── versions and close codes ─────────────────────────────

export const APP_VERSION_HEADER = 'x-app-version';
export const APP_VERSION_PARAM = 'v';
/** The workspace a `/rpc` call acts on (sockets and rooms carry it in the URL). */
export const WORKSPACE_HEADER = 'x-workspace-id';

/** Application close codes (4000-4999) of the workspace socket. 4401 matches edytor rooms. */
export const CLOSE = {
	NORMAL: 1000,
	GOING_AWAY: 1001,
	/** A frame that is not valid JSON or does not match any message schema. */
	BAD_MESSAGE: 4400,
	/** The session expired or is invalid: refresh it, then reconnect. */
	AUTH_EXPIRED: 4401,
	/** The user has no access to this workspace (anymore). */
	FORBIDDEN: 4403,
	/** The workspace was deleted. */
	WORKSPACE_GONE: 4410,
	/** The client build is outdated: reload the page. */
	RELOAD_REQUIRED: 4426,
	/** Too many messages: back off before reconnecting. */
	RATE_LIMITED: 4429,
	/** The object is restarting or overloaded: reconnect with backoff. */
	TRY_AGAIN: 4503
} as const;
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

export type CloseAction = 'reload' | 'reauth' | 'reconnect' | 'backoff' | 'stop';

/** What a client should do after the socket closed with `code`. */
export function closeAction(code: number): CloseAction {
	switch (code) {
		case CLOSE.RELOAD_REQUIRED:
			return 'reload';
		case CLOSE.AUTH_EXPIRED:
			return 'reauth';
		case CLOSE.RATE_LIMITED:
		case CLOSE.TRY_AGAIN:
			return 'backoff';
		case CLOSE.FORBIDDEN:
		case CLOSE.WORKSPACE_GONE:
		case CLOSE.BAD_MESSAGE:
			return 'stop';
		default:
			return 'reconnect';
	}
}

/** Dotted numeric versions: `1.4.2`, `20261107.3`. Missing parts are 0. */
export function parseAppVersion(version: string): number[] | null {
	if (!/^\d+(\.\d+){0,3}$/.test(version)) return null;
	return version.split('.').map(Number);
}

/** -1, 0, 1; null when either is not a dotted numeric version. */
export function compareAppVersions(a: string, b: string): -1 | 0 | 1 | null {
	const pa = parseAppVersion(a);
	const pb = parseAppVersion(b);
	if (!pa || !pb) return null;
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	return 0;
}

/**
 * Whether a client may talk to this server: `ok`, or `reload` when its version is below `min`.
 * A non-numeric version (a git sha) is accepted only when it equals `current`; the literal `dev` (the
 * dev server's build) is accepted when `allowDev` is true (the default for this pure helper: servers
 * pass `false` outside development and test, see `objects/workspace/versions.ts`).
 */
export function checkClientVersion(
	client: string | null | undefined,
	versions: { min: string; current: string; allowDev?: boolean }
): 'ok' | 'reload' {
	if (!client) return 'reload';
	const c = compareAppVersions(client, versions.min);
	if (c === null) return client === versions.current || (client === 'dev' && versions.allowDev !== false) ? 'ok' : 'reload';
	return c < 0 ? 'reload' : 'ok';
}

// ───────────────────────────── rows ─────────────────────────────

export const ACCESS_LEVELS = ['read', 'comment', 'update', 'full'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const accessLevelSchema = v.picklist(ACCESS_LEVELS);

const iso = v.pipe(v.string(), v.maxLength(40));
export const valuesSchema = v.record(v.string(), v.nullable(propValueSchema));
export type Values = v.InferOutput<typeof valuesSchema>;

/** A sidebar row. */
export const treeRowSchema = v.object({
	id: idSchema,
	parentId: v.nullable(idSchema),
	rank: rankSchema,
	title: v.string(),
	icon: v.nullable(v.string()),
	isDatabase: v.boolean(),
	teamspaceId: v.nullable(idSchema),
	hasChildren: v.boolean(),
	access: accessLevelSchema,
	/** Who created the page (null for pages made by the system): Private and Shared in the sidebar. */
	createdBy: v.nullable(v.string())
});
export type TreeRow = v.InferOutput<typeof treeRowSchema>;

/** A page's header and properties. */
export const pageRowSchema = v.object({
	...treeRowSchema.entries,
	cover: v.nullable(v.string()),
	values: valuesSchema,
	createdAt: iso,
	updatedBy: v.nullable(v.string()),
	updatedAt: iso
});
export type PageRow = v.InferOutput<typeof pageRowSchema>;

/** A row of a database view. */
export const viewRowSchema = v.object({
	id: idSchema,
	title: v.string(),
	icon: v.nullable(v.string()),
	cover: v.optional(v.nullable(v.string())),
	values: valuesSchema,
	access: v.optional(accessLevelSchema)
});
export type ViewRow = v.InferOutput<typeof viewRowSchema>;

/** A page that links to the subscribed page. */
export const backlinkRowSchema = v.object({
	id: idSchema,
	title: v.string(),
	icon: v.nullable(v.string()),
	kind: v.picklist(['mention', 'link', 'subpage'])
});
export type BacklinkRow = v.InferOutput<typeof backlinkRowSchema>;

export const rowSchema = v.union([pageRowSchema, treeRowSchema, viewRowSchema, backlinkRowSchema]);
export type Row = PageRow | TreeRow | ViewRow | BacklinkRow;

// ───────────────────────────── subscriptions ─────────────────────────────

export const SUBSCRIPTION_KINDS = ['tree', 'page', 'view', 'backlinks'] as const;
export type SubscriptionKind = (typeof SUBSCRIPTION_KINDS)[number];

export const MAX_WINDOW = 1000;
export const MAX_SUBSCRIPTIONS_PER_SOCKET = 100;

const subId = v.pipe(v.string(), v.minLength(1), v.maxLength(40));
const limit = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_WINDOW));

export const subscriptionSchema = v.variant('kind', [
	/** Children of each listed parent (`null` is the root level): the expanded branches of the sidebar. */
	v.object({ kind: v.literal('tree'), parents: v.pipe(v.array(v.nullable(idSchema)), v.maxLength(500)) }),
	/** Header and properties of open pages. */
	v.object({ kind: v.literal('page'), pageIds: v.pipe(v.array(idSchema), v.maxLength(50)) }),
	/**
	 * A window of a database view. `filter` is ANDed with the view's own (a `database_view` block's
	 * local filter); `sorts` and `groupBy`, when present, replace the view's.
	 */
	v.object({
		kind: v.literal('view'),
		collectionId: idSchema,
		viewId: v.optional(idSchema),
		filter: v.optional(filterGroupSchema),
		sorts: v.optional(sortsSchema),
		groupBy: v.optional(v.nullable(groupBySpecSchema)),
		/** Properties the client shows; the row values carry only these (and the filter/sort ones are kept server side). */
		props: v.optional(v.pipe(v.array(idSchema), v.maxLength(200))),
		/** Window size: per group when grouped. */
		limit
	}),
	v.object({ kind: v.literal('backlinks'), pageId: idSchema, limit: v.optional(limit) })
]);
export type Subscription = v.InferOutput<typeof subscriptionSchema>;

export const subscriptionEntrySchema = v.object({ id: subId, sub: subscriptionSchema });
export type SubscriptionEntry = v.InferOutput<typeof subscriptionEntrySchema>;

// ───────────────────────────── diffs ─────────────────────────────

const group = v.optional(v.string());

/**
 * One change to a subscription's window. In a grouped view each op names its `group`
 * (GROUP_EMPTY for rows with no value); a row changing group is a `remove` and an `add`.
 */
export const diffOpSchema = v.variant('op', [
	v.object({ op: v.literal('add'), index: v.pipe(v.number(), v.integer(), v.minValue(0)), row: rowSchema, group }),
	v.object({ op: v.literal('remove'), id: idSchema, group }),
	v.object({ op: v.literal('move'), id: idSchema, index: v.pipe(v.number(), v.integer(), v.minValue(0)), group }),
	v.object({ op: v.literal('update'), id: idSchema, prop: v.string(), value: v.nullable(propValueSchema) }),
	v.object({ op: v.literal('count'), total: v.pipe(v.number(), v.integer(), v.minValue(0)), group }),
	/** Grouped views: the ordered keys of the groups (see the module header). */
	v.object({ op: v.literal('groups'), keys: v.array(v.string()) })
]);
export type DiffOp = v.InferOutput<typeof diffOpSchema>;

const total = v.pipe(v.number(), v.integer(), v.minValue(0));
const seqNum = v.pipe(v.number(), v.integer(), v.minValue(0));

export const groupSnapshotSchema = v.object({ key: v.string(), total, rows: v.array(rowSchema) });
export type GroupSnapshot = v.InferOutput<typeof groupSnapshotSchema>;

// ───────────────────────────── presence and notifications ─────────────────────────────

export const presenceUserSchema = v.object({
	userId: idSchema,
	name: v.string(),
	color: v.optional(v.string()),
	avatar: v.optional(v.nullable(v.string()))
});
export type PresenceUser = v.InferOutput<typeof presenceUserSchema>;

export const presenceEntrySchema = v.object({ pageId: idSchema, users: v.array(presenceUserSchema) });
export type PresenceEntry = v.InferOutput<typeof presenceEntrySchema>;

export const NOTIFICATION_KINDS = ['mention', 'comment', 'reply', 'invite', 'page_shared', 'access_changed', 'reminder'] as const;
export const notificationSchema = v.object({
	id: idSchema,
	kind: v.picklist(NOTIFICATION_KINDS),
	pageId: v.nullable(idSchema),
	actorId: v.nullable(idSchema),
	text: v.string(),
	createdAt: iso,
	readAt: v.nullable(iso)
});
export type Notification = v.InferOutput<typeof notificationSchema>;

// ───────────────────────────── client -> server ─────────────────────────────

export const clientMessageSchema = v.variant('t', [
	/** First frame of every connection. `lastSeq` null: a fresh start. `subs`: everything to (re)subscribe. */
	v.object({
		t: v.literal('hello'),
		appVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
		kindsVersion: v.optional(v.number()),
		clientId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
		lastSeq: v.nullable(seqNum),
		subs: v.pipe(v.array(subscriptionEntrySchema), v.maxLength(MAX_SUBSCRIPTIONS_PER_SOCKET))
	}),
	v.object({ t: v.literal('subscribe'), id: subId, sub: subscriptionSchema }),
	v.object({ t: v.literal('unsubscribe'), id: subId }),
	/** Grows (or shrinks) a view subscription's window; `group` addresses one group of a grouped view. */
	v.object({ t: v.literal('window'), id: subId, limit, group: v.optional(v.string()) }),
	/** The page this tab is on, null when none. */
	v.object({ t: v.literal('presence'), pageId: v.nullable(idSchema) }),
	v.object({ t: v.literal('notifications.read'), ids: v.pipe(v.array(idSchema), v.minLength(1), v.maxLength(100)) }),
	v.object({ t: v.literal('ping') })
]);
export type ClientMessage = v.InferOutput<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage['t'];

// ───────────────────────────── server -> client ─────────────────────────────

export const REGISTRY_SCOPES = ['properties', 'directory'] as const;
export type RegistryScope = (typeof REGISTRY_SCOPES)[number];

/** Which definition scopes a commit's change kinds touch (empty for ordinary page and value edits). */
export function registryScopesOf(kinds: Iterable<string>): RegistryScope[] {
	const scopes = new Set<RegistryScope>();
	for (const kind of kinds) {
		if (/^(create|update|delete)Property$/.test(kind)) scopes.add('properties');
		else if (kind.startsWith('teamspace.') || kind === 'archiveTeamspace' || kind === 'member.sync') scopes.add('directory');
	}
	return REGISTRY_SCOPES.filter((scope) => scopes.has(scope));
}

const snapshotBase = { t: v.literal('snapshot'), id: subId, total, seq: seqNum };

export const serverMessageSchema = v.variant('t', [
	v.object({
		t: v.literal('welcome'),
		protocol: v.number(),
		/** The server's build. */
		appVersion: v.string(),
		minAppVersion: v.string(),
		kindsVersion: v.number(),
		userId: idSchema,
		/** The log's head when the socket was accepted. */
		seq: seqNum
	}),
	v.object({
		t: v.literal('resumed'),
		mode: v.picklist(['replay', 'snapshot']),
		fromSeq: v.nullable(seqNum),
		seq: seqNum
	}),
	/** The first state of a subscription. Grouped views fill `groups` and leave `rows` empty. */
	v.variant('kind', [
		v.object({ ...snapshotBase, kind: v.literal('tree'), rows: v.array(treeRowSchema) }),
		v.object({ ...snapshotBase, kind: v.literal('page'), rows: v.array(pageRowSchema) }),
		v.object({
			...snapshotBase,
			kind: v.literal('view'),
			rows: v.array(viewRowSchema),
			groups: v.optional(v.array(v.object({ key: v.string(), total, rows: v.array(viewRowSchema) })))
		}),
		v.object({ ...snapshotBase, kind: v.literal('backlinks'), rows: v.array(backlinkRowSchema) })
	]),
	/** One commit's changes, for each subscription it touches. */
	v.object({
		t: v.literal('diff'),
		seq: seqNum,
		subs: v.array(v.object({ id: subId, ops: v.pipe(v.array(diffOpSchema), v.minLength(1)) }))
	}),
	/** The log advanced to `seq` without touching this socket's subscriptions. */
	v.object({ t: v.literal('head'), seq: seqNum }),
	/** Each entry replaces the list of who is on that page; an empty list means nobody. */
	v.object({ t: v.literal('presence'), entries: v.array(presenceEntrySchema) }),
	v.object({ t: v.literal('notification'), notification: notificationSchema }),
	/**
	 * A commit changed workspace-level definitions that clients hold outside any subscription: `properties` is
	 * the property registry (a property or an option was created, renamed or deleted), `directory` is the member
	 * and teamspace directory (a teamspace, its membership or a workspace member changed). The client fetches
	 * the lists again (`property.list`, `workspace.members.list`, `workspace.teamspaces.list`); the frame carries
	 * no data because each actor reads what they may see. `seq` is the commit's.
	 */
	v.object({ t: v.literal('registry'), scopes: v.pipe(v.array(v.picklist(REGISTRY_SCOPES)), v.minLength(1)), seq: seqNum }),
	/**
	 * A page's lock changed (`page.lock.set`). Sent to every connected tab whose person can read the page: the
	 * lock lives in the page's room, and this saves the polling. `bypass` (full access) is the receiver's own and
	 * is not carried; the client keeps the one it read with `page.lock.get`.
	 */
	v.object({
		t: v.literal('lock'),
		pageId: idSchema,
		locked: v.boolean(),
		lockedBy: v.nullable(v.string()),
		lockedAt: v.nullable(v.number())
	}),
	v.object({
		t: v.literal('error'),
		code: v.picklist(['bad_subscription', 'forbidden', 'not_found', 'too_many_subscriptions', 'internal']),
		message: v.string(),
		/** The subscription the error concerns. */
		id: v.optional(subId)
	}),
	v.object({ t: v.literal('pong') })
]);
export type ServerMessage = v.InferOutput<typeof serverMessageSchema>;
export type ServerMessageType = ServerMessage['t'];
export type SnapshotMessage = Extract<ServerMessage, { t: 'snapshot' }>;

// ───────────────────────────── encode and decode ─────────────────────────────

export const MAX_CLIENT_FRAME_BYTES = 256 * 1024;
export const MAX_SERVER_FRAME_BYTES = 1024 * 1024;

export type DecodeResult<T> =
	| { ok: true; value: T }
	| { ok: false; code: 'too_large' | 'not_text' | 'not_json' | 'invalid'; message: string };

function toText(raw: string | ArrayBuffer | Uint8Array, max: number): string | DecodeResult<never> {
	let text: string;
	if (typeof raw === 'string') {
		// UTF-16 length is a lower bound of the UTF-8 length; a cheap precheck before measuring.
		if (raw.length > max) return { ok: false, code: 'too_large', message: `Frame exceeds ${max} bytes` };
		text = raw;
	} else {
		const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
		if (bytes.byteLength > max) return { ok: false, code: 'too_large', message: `Frame exceeds ${max} bytes` };
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		} catch {
			return { ok: false, code: 'not_text', message: 'Frame is not valid UTF-8' };
		}
	}
	if (new TextEncoder().encode(text).byteLength > max)
		return { ok: false, code: 'too_large', message: `Frame exceeds ${max} bytes` };
	return text;
}

function decode<T>(schema: v.GenericSchema<unknown, T>, raw: string | ArrayBuffer | Uint8Array, max: number): DecodeResult<T> {
	const text = toText(raw, max);
	if (typeof text !== 'string') return text;
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { ok: false, code: 'not_json', message: 'Frame is not valid JSON' };
	}
	const r = v.safeParse(schema, json);
	if (!r.success) {
		const first = r.issues[0];
		const where = (first.path ?? []).map((p) => String(p.key)).join('.');
		return { ok: false, code: 'invalid', message: `${where ? where + ': ' : ''}${first.message}` };
	}
	return { ok: true, value: r.output };
}

/** Serializes a message. Callers should send only messages that satisfy the schema. */
export const encodeClientMessage = (msg: ClientMessage): string => JSON.stringify(msg);
export const encodeServerMessage = (msg: ServerMessage): string => JSON.stringify(msg);

export const decodeClientMessage = (raw: string | ArrayBuffer | Uint8Array): DecodeResult<ClientMessage> =>
	decode(clientMessageSchema, raw, MAX_CLIENT_FRAME_BYTES);
export const decodeServerMessage = (raw: string | ArrayBuffer | Uint8Array): DecodeResult<ServerMessage> =>
	decode(serverMessageSchema, raw, MAX_SERVER_FRAME_BYTES);

/** UTF-8 size of an encoded frame, to check it against MAX_SERVER_FRAME_BYTES before sending. */
export const frameBytes = (encoded: string): number => new TextEncoder().encode(encoded).byteLength;

export { GROUP_EMPTY } from './filter-ast.js';
