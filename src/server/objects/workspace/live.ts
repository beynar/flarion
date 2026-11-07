/**
 * The live loop: subscription registry, snapshots, per-commit diffs and reconnect replay
 * (docs/PLAN.md "Real-time sync").
 *
 * Registry (SQL, so it survives hibernation; attachments hold only `{ socketId, actor }`):
 *   socket_stream   the one iterator per socket every server message is pushed on
 *   socket_sub      what a socket subscribed to, and the window of a view/backlinks subscription
 *   sub_unit        a shared unit: one evaluated query (the children of one parent, one page, one
 *                   collection...) with its ordered ids, whatever number of sockets watch it
 *   sub_link        the units of a socket subscription, in window order
 *
 * Identical queries with the same visibility scope map to the same unit key, so a hundred sockets on one
 * board cost one evaluation per commit. A commit re-evaluates only the units it can touch, diffs each
 * unit's new ids against the stored ones, derives every subscription's window diff from that (a window is
 * the concatenation of its units, cut at its limit), and sends each socket one `diff` frame; sockets the
 * commit does not touch get a `head`.
 */
import type {
	BacklinkRow,
	DiffOp,
	PageRow,
	ServerMessage,
	Subscription,
	SubscriptionEntry,
	TreeRow,
	ViewRow
} from '../../../lib/shared/protocol';
import { MAX_SUBSCRIPTIONS_PER_SOCKET, MAX_WINDOW } from '../../../lib/shared/protocol';
import { TITLE_PROP_ID } from '../../../lib/shared/property-types';
import { visibilityScope } from './actor';
import type { VisibilityView } from './access';
import type { Actor } from '../../auth/session';
import type { LogRow } from './changelog';
import { RowReader, type AccessOf } from './rows';
import { chunks, MAX_PARAMS, qmarks } from './util';

export type UnitKind = 'tree' | 'page' | 'backlinks' | 'view';

interface UnitRef {
	key: string;
	kind: UnitKind;
	spec: Record<string, unknown>;
}

interface SubRow {
	socketId: string;
	subId: string;
	kind: Subscription['kind'];
	sub: Subscription;
	lim: number | null;
	unitKeys: string[];
}

/** What a commit hands the loop. */
export interface CommitInfo {
	seq: number;
	rows: readonly LogRow[];
	/** `$hasChildren` of parents whose first or last live child appeared or went away: id -> its new value. */
	hasChildrenFlips?: ReadonlyMap<string, boolean>;
	/** Pages whose backlinks changed without a page row changing (index ingestion). */
	backlinkTargets?: readonly string[];
}

export interface LiveHost {
	sql: SqlStorage;
	/** Pushes a message on the socket's stream; false when the socket or its stream is gone. */
	send(socketId: string, message: ServerMessage): boolean;
	/** The actor stored in the socket's attachment. */
	actorOf(socketId: string): Actor | null;
	/** The actor's visibility set, current as of the commit being fanned out (fails closed: nothing visible). */
	view(actor: Actor): VisibilityView;
}

const fnv = (text: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
};

export function unitsOf(sub: Subscription, scope: string): UnitRef[] {
	switch (sub.kind) {
		case 'tree':
			return [...new Set(sub.parents)].map((parent) => ({
				key: `tree|${scope}|${parent ?? ''}`,
				kind: 'tree' as const,
				spec: { parent }
			}));
		case 'page':
			return [...new Set(sub.pageIds)].map((id) => ({ key: `page|${scope}|${id}`, kind: 'page' as const, spec: { id } }));
		case 'backlinks':
			return [{ key: `bl|${scope}|${sub.pageId}`, kind: 'backlinks', spec: { pageId: sub.pageId } }];
		case 'view': {
			// Filter, sorts and grouping belong to the unit (they change its ids); `props` and `limit` do not.
			const query = { filter: sub.filter ?? null, sorts: sub.sorts ?? null, groupBy: sub.groupBy ?? null };
			return [
				{
					key: `view|${scope}|${sub.collectionId}|${sub.viewId ?? ''}|${fnv(JSON.stringify(query))}`,
					kind: 'view',
					spec: { collectionId: sub.collectionId, viewId: sub.viewId ?? null, ...query }
				}
			];
		}
	}
}

/** Window diff over id lists: `remove`s, then `add`s and `move`s in order (indexes are positions after the earlier ops). */
export function diffWindows<R>(oldIds: readonly string[], newIds: readonly string[], rowFor: (id: string) => R | undefined): DiffOp[] {
	const ops: DiffOp[] = [];
	const keep = new Set(newIds);
	const cur = oldIds.filter((id) => {
		if (keep.has(id)) return true;
		ops.push({ op: 'remove', id });
		return false;
	});
	for (let i = 0; i < newIds.length; i++) {
		const id = newIds[i];
		if (cur[i] === id) continue;
		const at = cur.indexOf(id);
		if (at < 0) {
			const row = rowFor(id);
			if (!row) continue;
			ops.push({ op: 'add', index: i, row: row as never });
			cur.splice(i, 0, id);
		} else {
			ops.push({ op: 'move', id, index: i });
			cur.splice(at, 1);
			cur.splice(i, 0, id);
		}
	}
	return ops;
}

type RowKind = 'tree' | 'page' | 'view' | 'backlinks';
type AnyRow = TreeRow | PageRow | ViewRow | BacklinkRow;

interface Touch {
	/** Pages whose membership in some unit can change (create, move, trash, restore, and subtrees). */
	structPages: Set<string>;
	/** Parents whose children changed ('' is the root level). */
	parents: Set<string>;
	structural: boolean;
	all: boolean;
	/** page -> value properties written. */
	valueProps: Map<string, Set<string>>;
	/** page -> `$` fields that changed. */
	fields: Map<string, Set<string>>;
	subtreeRoots: string[];
	/** Roots whose subtree changed teamspace. */
	teamspaceRoots: string[];
	backlinkTargets: Set<string>;
}

/** Change kinds that write one property of one page (the EAV module's `setProp`, `addOption`, `removeOption`). */
const VALUE_KINDS: ReadonlySet<string> = new Set(['setProp', 'addOption', 'removeOption', 'setComputed']);
const addTo = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
	let set = map.get(key);
	if (!set) map.set(key, (set = new Set()));
	set.add(value);
};
const asRecord = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});

export function analyze(rows: readonly LogRow[]): Touch {
	const t: Touch = {
		structPages: new Set(),
		parents: new Set(),
		structural: false,
		all: false,
		valueProps: new Map(),
		fields: new Map(),
		subtreeRoots: [],
		teamspaceRoots: [],
		backlinkTargets: new Set()
	};
	for (const row of rows) {
		const oldV = asRecord(row.old);
		const newV = asRecord(row.new);
		switch (row.kind) {
			case 'create':
				t.structural = true;
				if (row.page) t.structPages.add(row.page);
				t.parents.add((newV.parentId as string | null) ?? '');
				break;
			case 'move':
				t.structural = true;
				if (!row.page) break;
				t.structPages.add(row.page);
				t.parents.add((oldV.parentId as string | null) ?? '');
				t.parents.add((newV.parentId as string | null) ?? '');
				if (oldV.parentId !== newV.parentId) addTo(t.fields, row.page, '$parent');
				if (oldV.rank !== newV.rank) addTo(t.fields, row.page, '$rank');
				if (oldV.teamspaceId !== newV.teamspaceId) {
					addTo(t.fields, row.page, '$teamspace');
					t.teamspaceRoots.push(row.page);
				}
				break;
			case 'trash':
				t.structural = true;
				if (!row.page) break;
				t.structPages.add(row.page);
				t.subtreeRoots.push(row.page);
				t.parents.add((oldV.parentId as string | null) ?? '');
				break;
			case 'restore':
				t.structural = true;
				if (!row.page) break;
				t.structPages.add(row.page);
				t.subtreeRoots.push(row.page);
				t.parents.add((newV.parentId as string | null) ?? '');
				break;
			case 'setPage':
				if (!row.page) break;
				if ('icon' in newV) addTo(t.fields, row.page, '$icon');
				if ('cover' in newV) addTo(t.fields, row.page, '$cover');
				break;
			case 'links':
				for (const id of [...((newV.add as string[]) ?? []), ...((newV.remove as string[]) ?? [])]) t.backlinkTargets.add(id);
				break;
			case 'archiveTeamspace':
				t.structural = true;
				t.all = true;
				break;
			case 'grant.set':
			case 'grant.revoke':
			case 'member.sync':
				// Access changes: no unit changes, but every affected actor's windows do (their visibility delta).
				break;
			default:
				if (row.page && row.prop && VALUE_KINDS.has(row.kind)) {
					addTo(t.valueProps, row.page, row.prop);
				} else if (!row.kind.startsWith('teamspace')) {
					// Definition ops (collections, members, views, properties): they can change a view's rows.
					t.structural = true;
				}
		}
	}
	return t;
}

const countEvaluations = { value: 0 };
/** Test hook: how many unit evaluations ran in this isolate. */
export const unitEvaluations = () => countEvaluations.value;

export class LiveHub {
	readonly #host: LiveHost;
	readonly #reader: RowReader;
	readonly #sql: SqlStorage;
	/** Evaluations performed by this instance (per wake), for the "evaluated once" guarantee. */
	evaluations = 0;
	/** Page id -> dense number: numbers never change, so this never needs invalidating. */
	readonly #nums = new Map<string, number>();

	constructor(host: LiveHost) {
		this.#host = host;
		this.#sql = host.sql;
		this.#reader = new RowReader(host.sql);
	}

	get reader(): RowReader {
		return this.#reader;
	}

	// ───────────────────────── visibility ─────────────────────────

	#numsOf(ids: readonly string[]): void {
		const missing = ids.filter((id) => !this.#nums.has(id));
		if (missing.length === 0) return;
		for (const [id, num] of this.#reader.nums(missing)) this.#nums.set(id, num);
		if (this.#nums.size > 200_000) this.#nums.clear();
	}

	/** `ids` ANDed with a visibility predicate on dense numbers (a page that is gone has no number: dropped). */
	#visible(ids: readonly string[], has: (num: number) => boolean): string[] {
		this.#numsOf(ids);
		return ids.filter((id) => {
			const num = this.#nums.get(id);
			return num !== undefined && has(num);
		});
	}

	#numOf(id: string): number | undefined {
		this.#numsOf([id]);
		return this.#nums.get(id);
	}

	// ───────────────────────── storage helpers ─────────────────────────

	#all<T extends Record<string, SqlStorageValue>>(query: string, ...params: unknown[]): T[] {
		return this.#sql.exec<T>(query, ...params).toArray();
	}
	#run(query: string, ...params: unknown[]): void {
		this.#sql.exec(query, ...params);
	}

	headSeq(): number {
		const row = this.#all<{ s: number | null }>('SELECT MAX(seq) AS s FROM change')[0];
		if (row?.s != null) return row.s;
		return this.logFloor();
	}

	logFloor(): number {
		const row = this.#all<{ value: string }>("SELECT value FROM meta WHERE key = 'log_floor'")[0];
		const n = row ? Number(JSON.parse(row.value)) : 0;
		return Number.isFinite(n) ? n : 0;
	}

	/** Changes after `seq`, oldest first; null when there are too many to replay. */
	changesSince(seq: number): LogRow[] | null {
		const rows = this.#all<{
			seq: number;
			ts: number;
			actor: string;
			commit_id: string;
			kind: string;
			page: string | null;
			prop: string | null;
			old_json: string | null;
			new_json: string | null;
		}>(
			'SELECT seq, ts, actor, commit_id, kind, page, prop, old_json, new_json FROM change WHERE seq > ? ORDER BY seq LIMIT ?',
			seq,
			MAX_REPLAY_ROWS + 1
		);
		if (rows.length > MAX_REPLAY_ROWS) return null;
		return rows.map((r) => ({
			seq: r.seq,
			ts: r.ts,
			actor: r.actor,
			commitId: r.commit_id,
			kind: r.kind,
			page: r.page,
			prop: r.prop,
			old: r.old_json === null ? null : JSON.parse(r.old_json),
			new: r.new_json === null ? null : JSON.parse(r.new_json)
		}));
	}

	// ───────────────────────── streams ─────────────────────────

	bindStream(socketId: string, requestId: string, clientId: string, now: number): void {
		this.#run(
			'INSERT OR REPLACE INTO socket_stream (socket_id, request_id, client_id, opened_at) VALUES (?, ?, ?, ?)',
			socketId,
			requestId,
			clientId,
			now
		);
	}

	streamOf(socketId: string): string | null {
		return this.#all<{ request_id: string }>('SELECT request_id FROM socket_stream WHERE socket_id = ?', socketId)[0]?.request_id ?? null;
	}

	streamSockets(): string[] {
		return this.#all<{ socket_id: string }>('SELECT socket_id FROM socket_stream').map((r) => r.socket_id);
	}

	/** Forgets a socket: its stream, its subscriptions, and units nobody watches any more. */
	dropSocket(socketId: string): void {
		this.#run('DELETE FROM socket_stream WHERE socket_id = ?', socketId);
		this.#run('DELETE FROM socket_sub WHERE socket_id = ?', socketId);
		this.#run('DELETE FROM sub_link WHERE socket_id = ?', socketId);
		this.#gcUnits();
	}

	#gcUnits(): void {
		this.#run('DELETE FROM sub_unit WHERE unit_key NOT IN (SELECT DISTINCT unit_key FROM sub_link)');
	}

	/** Forgets every socket's registry (after a failed fan-out: the clients reconnect and resume). */
	clearRegistry(): void {
		for (const table of ['socket_stream', 'socket_sub', 'sub_link', 'sub_unit']) this.#run(`DELETE FROM ${table}`);
	}

	subCount(socketId: string): number {
		return this.#all<{ n: number }>('SELECT COUNT(*) AS n FROM socket_sub WHERE socket_id = ?', socketId)[0].n;
	}

	unitCount(): number {
		return this.#all<{ n: number }>('SELECT COUNT(*) AS n FROM sub_unit')[0].n;
	}

	/** Test/diagnostic: units whose stored ids differ from a fresh evaluation (should always be empty). */
	staleUnits(): string[] {
		const stale: string[] = [];
		for (const u of this.#all<{ unit_key: string; kind: UnitKind; spec: string; ids: string }>(
			'SELECT unit_key, kind, spec, ids FROM sub_unit'
		)) {
			const fresh = this.#evaluate(u.kind, JSON.parse(u.spec), false);
			if (JSON.stringify(fresh) !== u.ids) stale.push(u.unit_key);
		}
		return stale;
	}

	// ───────────────────────── units ─────────────────────────

	#evaluate(kind: UnitKind, spec: Record<string, unknown>, count = true): string[] {
		if (count) {
			this.evaluations++;
			countEvaluations.value++;
		}
		switch (kind) {
			case 'tree':
				return this.#reader.treeIds((spec.parent as string | null) ?? null);
			case 'page':
				return this.#reader.pageIds(spec.id as string);
			case 'backlinks':
				return this.#reader.backlinkIds(spec.pageId as string);
			case 'view':
				return this.#reader.viewIds(spec.collectionId as string);
		}
	}

	#unitIds(key: string): string[] {
		const row = this.#all<{ ids: string }>('SELECT ids FROM sub_unit WHERE unit_key = ?', key)[0];
		return row ? (JSON.parse(row.ids) as string[]) : [];
	}

	#ensureUnit(unit: UnitRef): string[] {
		const existing = this.#all<{ ids: string }>('SELECT ids FROM sub_unit WHERE unit_key = ?', unit.key)[0];
		if (existing) return JSON.parse(existing.ids) as string[];
		const ids = this.#evaluate(unit.kind, unit.spec);
		this.#run('INSERT INTO sub_unit (unit_key, kind, spec, ids) VALUES (?, ?, ?, ?)', unit.key, unit.kind, JSON.stringify(unit.spec), JSON.stringify(ids));
		return ids;
	}

	// ───────────────────────── subscriptions ─────────────────────────

	/** Registers (or replaces) a subscription; returns its full ids (the window is the first `lim`). */
	register(socketId: string, subId: string, sub: Subscription, actor: Actor): { ids: string[]; lim: number | null } {
		this.#unregister(socketId, subId);
		const lim = sub.kind === 'view' ? sub.limit : sub.kind === 'backlinks' ? (sub.limit ?? MAX_WINDOW) : null;
		this.#run('INSERT INTO socket_sub (socket_id, sub_id, kind, spec, lim) VALUES (?, ?, ?, ?, ?)', socketId, subId, sub.kind, JSON.stringify(sub), lim);
		const units = unitsOf(sub, visibilityScope(actor));
		const ids: string[] = [];
		units.forEach((unit, ord) => {
			ids.push(...this.#ensureUnit(unit));
			this.#run('INSERT INTO sub_link (socket_id, sub_id, ord, unit_key) VALUES (?, ?, ?, ?)', socketId, subId, ord, unit.key);
		});
		return { ids, lim };
	}

	unregister(socketId: string, subId: string): void {
		this.#unregister(socketId, subId);
		this.#gcUnits();
	}

	#unregister(socketId: string, subId: string): void {
		this.#run('DELETE FROM socket_sub WHERE socket_id = ? AND sub_id = ?', socketId, subId);
		this.#run('DELETE FROM sub_link WHERE socket_id = ? AND sub_id = ?', socketId, subId);
	}

	#loadSub(socketId: string, subId: string): SubRow | null {
		const row = this.#all<{ kind: Subscription['kind']; spec: string; lim: number | null }>(
			'SELECT kind, spec, lim FROM socket_sub WHERE socket_id = ? AND sub_id = ?',
			socketId,
			subId
		)[0];
		if (!row) return null;
		const unitKeys = this.#all<{ unit_key: string }>(
			'SELECT unit_key FROM sub_link WHERE socket_id = ? AND sub_id = ? ORDER BY ord',
			socketId,
			subId
		).map((r) => r.unit_key);
		return { socketId, subId, kind: row.kind, sub: JSON.parse(row.spec) as Subscription, lim: row.lim, unitKeys };
	}

	/** Every subscription of a socket, in registration order of their ids. */
	subscriptions(socketId: string): SubscriptionEntry[] {
		return this.#all<{ sub_id: string; spec: string }>('SELECT sub_id, spec FROM socket_sub WHERE socket_id = ?', socketId).map((r) => ({
			id: r.sub_id,
			sub: JSON.parse(r.spec) as Subscription
		}));
	}

	// ───────────────────────── rows ─────────────────────────

	#rowsFor(sub: Subscription, ids: readonly string[], access: AccessOf): Map<string, AnyRow> {
		switch (sub.kind) {
			case 'tree':
				return this.#reader.treeRows(ids, access);
			case 'page':
				return this.#reader.pageRows(ids, access);
			case 'view':
				return this.#reader.viewRows(ids, access, sub.props);
			case 'backlinks':
				return this.#reader.backlinkRows(ids, sub.pageId);
		}
	}

	// ───────────────────────── snapshots ─────────────────────────

	snapshot(socketId: string, subId: string, actor: Actor, seq: number): ServerMessage | null {
		const row = this.#loadSub(socketId, subId);
		if (!row) return null;
		const view = this.#host.view(actor);
		const all = this.#visible(this.#concat(row.unitKeys), (n) => view.has(n));
		const window = row.lim === null ? all : all.slice(0, row.lim);
		const rows = this.#rowsFor(row.sub, window, view.level);
		const list = window.map((id) => rows.get(id)).filter((r): r is AnyRow => !!r);
		const base = { t: 'snapshot' as const, id: subId, total: all.length, seq };
		switch (row.kind) {
			case 'tree':
				return { ...base, kind: 'tree', rows: list as TreeRow[] };
			case 'page':
				return { ...base, kind: 'page', rows: list as PageRow[] };
			case 'view':
				return { ...base, kind: 'view', rows: list as ViewRow[] };
			case 'backlinks':
				return { ...base, kind: 'backlinks', rows: list as BacklinkRow[] };
		}
	}

	#concat(unitKeys: readonly string[], overrides?: ReadonlyMap<string, string[]>): string[] {
		const out: string[] = [];
		for (const key of unitKeys) out.push(...(overrides?.get(key) ?? this.#unitIds(key)));
		return out;
	}

	// ───────────────────────── window ─────────────────────────

	/** Resizes a view/backlinks window; returns the diff to send (null when nothing changes). */
	resizeWindow(socketId: string, subId: string, limit: number, actor: Actor): DiffOp[] | null {
		const row = this.#loadSub(socketId, subId);
		if (!row || (row.kind !== 'view' && row.kind !== 'backlinks')) return null;
		const sub = { ...row.sub, limit } as Subscription;
		this.#run('UPDATE socket_sub SET spec = ?, lim = ? WHERE socket_id = ? AND sub_id = ?', JSON.stringify(sub), limit, socketId, subId);
		const view = this.#host.view(actor);
		const all = this.#visible(this.#concat(row.unitKeys), (n) => view.has(n));
		const oldW = row.lim === null ? all : all.slice(0, row.lim);
		const newW = all.slice(0, limit);
		const rows = this.#rowsFor(sub, newW, view.level);
		const ops = diffWindows(oldW, newW, (id) => rows.get(id));
		return ops.length ? ops : null;
	}

	// ───────────────────────── commits ─────────────────────────

	/** Fans one commit out: diffs to the sockets it touches, `head` to the rest. Synchronous. */
	fanOut(commit: CommitInfo): void {
		const touch = analyze(commit.rows);
		for (const id of commit.backlinkTargets ?? []) touch.backlinkTargets.add(id);
		for (const id of commit.hasChildrenFlips?.keys() ?? []) addTo(touch.fields, id, '$hasChildren');
		if (touch.subtreeRoots.length > 0 || touch.teamspaceRoots.length > 0) {
			const sub = this.#reader.subtree([...touch.subtreeRoots, ...touch.teamspaceRoots]);
			for (const id of sub) touch.structPages.add(id);
			// Descendants of a page that moved teamspace carry the new teamspace.
			for (const id of this.#reader.subtree(touch.teamspaceRoots)) {
				if (!touch.teamspaceRoots.includes(id)) addTo(touch.fields, id, '$teamspace');
			}
			if (touch.subtreeRoots.length) {
				for (const id of this.#reader.linkTargetsOf(this.#reader.subtree(touch.subtreeRoots))) touch.backlinkTargets.add(id);
			}
		}

		const units = this.#all<{ unit_key: string; kind: UnitKind; spec: string }>('SELECT unit_key, kind, spec FROM sub_unit');
		const streams = this.streamSockets();
		const streaming = new Set(streams);
		const diffs = new Map<string, { id: string; ops: DiffOp[] }[]>();

		// Sockets whose actor's visibility changed in this commit: every window of theirs is re-derived.
		const visibilityHit: { socketId: string; subId: string }[] = [];
		for (const socketId of streams) {
			const actor = this.#host.actorOf(socketId);
			if (actor && this.#host.view(actor).delta.size > 0) {
				for (const entry of this.subscriptions(socketId)) visibilityHit.push({ socketId, subId: entry.id });
			}
		}

		if ((units.length > 0 && streams.length > 0) || visibilityHit.length > 0) {
			// 1. Re-evaluate the units the commit can touch and keep the ones whose ids changed.
			const changed = new Map<string, { old: string[]; next: string[] }>();
			for (const u of units) {
				const spec = JSON.parse(u.spec) as Record<string, unknown>;
				if (!this.#touches(u.kind, spec, touch)) continue;
				const old = this.#unitIds(u.unit_key);
				const next = this.#evaluate(u.kind, spec);
				if (JSON.stringify(old) !== JSON.stringify(next)) {
					changed.set(u.unit_key, { old, next });
					this.#run('UPDATE sub_unit SET ids = ? WHERE unit_key = ?', JSON.stringify(next), u.unit_key);
				}
			}

			// 2. Units holding a page whose values or fields changed, for `update` ops.
			const updated = new Set<string>([...touch.valueProps.keys(), ...touch.fields.keys()]);
			const holding = this.#unitsHolding([...updated]);
			const affected = new Set<string>([...changed.keys(), ...holding]);

			const subs = this.#subsOfUnits([...affected]);
			const seen = new Set(subs.map((l) => `${l.socketId}\u0000${l.subId}`));
			for (const hit of visibilityHit) if (!seen.has(`${hit.socketId}\u0000${hit.subId}`)) subs.push(hit);

			if (subs.length > 0) {
				const cache = new CommitCache(this.#reader, updated);
				const ids = new Map<string, string[]>();
				const currentOf = (key: string) => {
					let v = ids.get(key);
					if (!v) ids.set(key, (v = this.#unitIds(key)));
					return v;
				};
				for (const link of subs) {
					const row = this.#loadSub(link.socketId, link.subId);
					const actor = this.#host.actorOf(link.socketId);
					if (!row || !actor || !streaming.has(link.socketId)) continue;
					const view = this.#host.view(actor);
					const oldMap = new Map<string, string[]>();
					for (const key of row.unitKeys) oldMap.set(key, changed.get(key)?.old ?? currentOf(key));
					// ANDed with the actor's visibility: before the commit for the old window, after it for the new.
					const newAll = this.#visible(this.#concat(row.unitKeys), (n) => view.has(n));
					const oldAll = this.#visible(this.#concat(row.unitKeys, oldMap), (n) => view.hadBefore(n));
					const lim = row.lim;
					const oldW = lim === null ? oldAll : oldAll.slice(0, lim);
					const newW = lim === null ? newAll : newAll.slice(0, lim);
					const oldSet = new Set(oldW);
					const added = newW.filter((id) => !oldSet.has(id));
					const rows = added.length ? this.#rowsFor(row.sub, added, view.level) : new Map<string, AnyRow>();
					const ops = diffWindows(oldW, newW, (id) => rows.get(id));
					const inBoth = newW.filter((id) => oldSet.has(id));
					ops.push(...cache.updatesFor(row.sub, row.kind, inBoth, touch));
					if (row.kind === 'tree' || row.kind === 'page' || row.kind === 'view') {
						// A level that changed on a page the actor keeps seeing.
						for (const id of inBoth) {
							const num = this.#numOf(id);
							const d = num === undefined ? undefined : view.delta.get(num);
							if (d && d.before >= 0 && d.after >= 0 && d.before !== d.after) {
								ops.push({ op: 'update', id, prop: '$access', value: view.level(num as number) });
							}
						}
					}
					if (oldAll.length !== newAll.length) ops.push({ op: 'count', total: newAll.length });
					if (ops.length) {
						const list = diffs.get(link.socketId) ?? [];
						list.push({ id: link.subId, ops });
						diffs.set(link.socketId, list);
					}
				}
			}
		}

		// 3. One frame per socket: its diff, or a head.
		for (const socketId of streams) {
			const subsOf = diffs.get(socketId);
			const message: ServerMessage = subsOf
				? { t: 'diff', seq: commit.seq, subs: subsOf }
				: { t: 'head', seq: commit.seq };
			if (!this.#host.send(socketId, message)) this.dropSocket(socketId);
		}
	}

	#touches(kind: UnitKind, spec: Record<string, unknown>, t: Touch): boolean {
		if (t.all) return true;
		switch (kind) {
			case 'tree': {
				const parent = (spec.parent as string | null) ?? '';
				return t.parents.has(parent) || (parent !== '' && t.structPages.has(parent));
			}
			case 'page':
				return t.structPages.has(spec.id as string);
			case 'backlinks':
				return t.backlinkTargets.has(spec.pageId as string) || t.structPages.has(spec.pageId as string);
			case 'view':
				return t.structural;
		}
	}

	#unitsHolding(pageIds: readonly string[]): string[] {
		if (pageIds.length === 0) return [];
		const keys = new Set<string>();
		if (pageIds.length <= 50) {
			for (const id of pageIds) {
				for (const r of this.#all<{ unit_key: string }>('SELECT unit_key FROM sub_unit WHERE instr(ids, ?) > 0', JSON.stringify(id))) {
					keys.add(r.unit_key);
				}
			}
		} else {
			const wanted = new Set(pageIds);
			for (const r of this.#all<{ unit_key: string; ids: string }>('SELECT unit_key, ids FROM sub_unit')) {
				if ((JSON.parse(r.ids) as string[]).some((id) => wanted.has(id))) keys.add(r.unit_key);
			}
		}
		return [...keys];
	}

	#subsOfUnits(keys: readonly string[]): { socketId: string; subId: string }[] {
		const seen = new Map<string, { socketId: string; subId: string }>();
		for (const part of chunks(keys, MAX_PARAMS)) {
			for (const r of this.#all<{ socket_id: string; sub_id: string }>(
				`SELECT DISTINCT socket_id, sub_id FROM sub_link WHERE unit_key IN (${qmarks(part.length)})`,
				...part
			)) {
				seen.set(`${r.socket_id}\u0000${r.sub_id}`, { socketId: r.socket_id, subId: r.sub_id });
			}
		}
		return [...seen.values()];
	}

	// ───────────────────────── reconnect ─────────────────────────

	/**
	 * Answers a reconnect that carried `lastSeq`: `snapshot` mode when the log no longer reaches back that
	 * far (or the gap touches too many pages), otherwise `replay`. In replay the changes since `lastSeq`
	 * go through the same rules as a live commit, evaluated against the current state, so a tree or page
	 * subscription gets `remove` + `add` for every page the gap touched (a `remove` of a page the client
	 * never held is a no-op), and a view or backlinks window touched by the gap gets a fresh snapshot.
	 */
	planResume(lastSeq: number, changes: readonly LogRow[] | null): { mode: 'replay' | 'snapshot'; touch: Touch | null } {
		const head = this.headSeq();
		if (lastSeq > head || lastSeq < this.logFloor() || changes === null) return { mode: 'snapshot', touch: null };
		// A gap with access changes (shares, memberships, roles): what each actor may see moved, and the log
		// does not say how for them. Fresh snapshots.
		if (changes.some((r) => ACCESS_KINDS.has(r.kind))) return { mode: 'snapshot', touch: null };
		const touch = analyze(changes);
		if (touch.subtreeRoots.length || touch.teamspaceRoots.length) {
			for (const id of this.#reader.subtree([...touch.subtreeRoots, ...touch.teamspaceRoots])) touch.structPages.add(id);
		}
		const touchedPages = new Set<string>([...touch.structPages, ...touch.valueProps.keys(), ...touch.fields.keys()]);
		for (const parent of touch.parents) if (parent) touchedPages.add(parent);
		if (touch.all || touchedPages.size > MAX_REPLAY_PAGES) return { mode: 'snapshot', touch: null };
		return { mode: 'replay', touch };
	}

	/** The replay of one subscription: a diff, a snapshot, or nothing. */
	replaySub(socketId: string, subId: string, actor: Actor, touch: Touch, seq: number): ServerMessage | null {
		const row = this.#loadSub(socketId, subId);
		if (!row) return null;
		const touched = new Set<string>([...touch.structPages, ...touch.valueProps.keys(), ...touch.fields.keys()]);
		for (const parent of touch.parents) if (parent) touched.add(parent);
		const view = this.#host.view(actor);
		const all = this.#visible(this.#concat(row.unitKeys), (n) => view.has(n));
		const window = row.lim === null ? all : all.slice(0, row.lim);
		if (row.kind === 'view' || row.kind === 'backlinks') {
			const hit = touch.structural || touch.backlinkTargets.size > 0 || window.some((id) => touched.has(id));
			return hit ? this.snapshot(socketId, subId, actor, seq) : null;
		}
		// tree / page: idempotent remove + add for every touched page, when the gap can concern this window.
		const relevant =
			row.sub.kind === 'tree'
				? row.sub.parents.some((p) => touch.parents.has(p ?? '') || (p !== null && touch.structPages.has(p))) ||
					window.some((id) => touched.has(id))
				: row.sub.kind === 'page' && row.sub.pageIds.some((id) => touched.has(id));
		if (!relevant) return null;
		const rows = this.#rowsFor(row.sub, window.filter((id) => touched.has(id)), view.level);
		const ops: DiffOp[] = [...touched].map((id) => ({ op: 'remove' as const, id }));
		window.forEach((id, index) => {
			const r = rows.get(id);
			if (r) ops.push({ op: 'add', index, row: r as never });
		});
		ops.push({ op: 'count', total: all.length });
		return { t: 'diff', seq, subs: [{ id: subId, ops }] };
	}
}

/** Change kinds that alter who can see what. */
const ACCESS_KINDS: ReadonlySet<string> = new Set(['grant.set', 'grant.revoke', 'member.sync', 'teamspace.member', 'teamspace.update', 'archiveTeamspace']);

/** Replays touching more pages (or log rows) than this are answered with fresh snapshots instead. */
export const MAX_REPLAY_PAGES = 200;
export const MAX_REPLAY_ROWS = 2000;

/** Fresh page data for the `update` ops of one commit, read once. */
class CommitCache {
	readonly #values: ReturnType<RowReader['currentValues']>;
	readonly #structure: ReturnType<RowReader['structure']>;

	constructor(reader: RowReader, pages: ReadonlySet<string>) {
		const ids = [...pages];
		this.#values = reader.currentValues(ids);
		this.#structure = reader.structure(ids);
	}

	updatesFor(sub: Subscription, kind: RowKind, ids: readonly string[], touch: Touch): DiffOp[] {
		const ops: DiffOp[] = [];
		for (const id of ids) {
			const values = this.#values.get(id);
			const structure = this.#structure.get(id);
			if (!values || !structure) continue;
			const push = (prop: string, value: DiffOp extends infer D ? (D extends { op: 'update'; value: infer V } ? V : never) : never) =>
				ops.push({ op: 'update', id, prop, value });
			for (const prop of touch.valueProps.get(id) ?? []) {
				if (prop === TITLE_PROP_ID) {
					push('title', values.title);
				} else if (kind === 'page' || (kind === 'view' && (!(sub as { props?: string[] }).props || (sub as { props?: string[] }).props!.includes(prop)))) {
					push(prop, (values.values[prop] ?? null) as never);
				}
			}
			for (const field of touch.fields.get(id) ?? []) {
				switch (field) {
					case '$icon':
						push('$icon', values.icon);
						break;
					case '$cover':
						if (kind === 'page' || kind === 'view') push('$cover', values.cover);
						break;
					case '$parent':
						if (kind === 'tree' || kind === 'page') push('$parent', structure.parentId as never);
						break;
					case '$rank':
						if (kind === 'tree' || kind === 'page') push('$rank', structure.rank);
						break;
					case '$teamspace':
						if (kind === 'tree' || kind === 'page') push('$teamspace', structure.teamspaceId as never);
						break;
					case '$hasChildren':
						if (kind === 'tree' || kind === 'page') push('$hasChildren', structure.hasChildren);
						break;
				}
			}
		}
		return ops;
	}
}

