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
 *
 * View units (`view-unit.ts`) hold the ordered ids of a live database view, per group when grouped, and are
 * maintained incrementally through the query engine; the property-to-subscription index (`sub_prop`) finds the
 * units a commit's writes can touch. Evaluating a view is asynchronous (the engine runs through viborm), so
 * `register`, `snapshot`, `resizeWindow`, `fanOut` and `replaySub` are async: the Workspace DO runs them in the
 * same serial queue as commits, so a socket message never observes a half fanned-out commit.
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
import type { WorkspaceDb } from '../../db/workspace.client';
import type { LogRow } from './changelog';
import { RowReader, type AccessOf } from './rows';
import { chunks, MAX_PARAMS, qmarks } from './util';
import { filterKey } from '../../../lib/shared/filter-ast';
import { loadEavRegistry, type EavRegistry } from './eav/registry';
import {
	EDITED,
	EMPTY_STATE,
	FLAT,
	MAX_INCREMENTAL,
	TupleCache,
	ViewState,
	evaluateView,
	groupKeysFor,
	maintainView,
	resolveView,
	unitReads,
	type ResolvedView,
	type ViewUnitSpec
} from './view-unit';

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
	/** Per-group window sizes of a grouped view (group key -> limit); the others use `lim`. */
	glim: Record<string, number>;
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
	/** The base client: view units run the query engine on it (read only). */
	db: WorkspaceDb;
	/** Epoch ms, for relative dates. */
	now(): number;
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

/**
 * The shared units of a subscription. `scope` is the visibility scope of the unit's key; `me` is set (with a
 * `me:` scope) for a view whose query reads `is me`, so users never share an evaluation they would not share.
 */
export function unitsOf(sub: Subscription, scope: string, me?: string): UnitRef[] {
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
			// Filter, sorts and grouping belong to the unit (they change its ids); `props` and `limit` do not. The
			// key hashes the canonical filter, so equivalent filters share a unit.
			const query: Record<string, unknown> = {
				filter: sub.filter ? filterKey(sub.filter) : null,
				sorts: sub.sorts ?? null
			};
			if (sub.groupBy !== undefined) query.groupBy = sub.groupBy;
			const spec: ViewUnitSpec = {
				collectionId: sub.collectionId,
				viewId: sub.viewId ?? null,
				filter: sub.filter ?? null,
				sorts: sub.sorts ?? null,
				...(sub.groupBy !== undefined ? { groupBy: sub.groupBy } : {}),
				...(me ? { me } : {})
			};
			return [
				{
					key: `view|${scope}|${sub.collectionId}|${sub.viewId ?? ''}|${fnv(JSON.stringify(query))}`,
					kind: 'view',
					spec: spec as unknown as Record<string, unknown>
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
/** What a unit holds: ordered ids, or the state of a view unit. */
type UnitValue = string[] | ViewState;

interface Touch {
	/** Pages whose membership in some unit can change (create, move, trash, restore, and subtrees). */
	structPages: Set<string>;
	/** Parents whose children changed ('' is the root level). */
	parents: Set<string>;
	structural: boolean;
	all: boolean;
	/** A definition changed (property, collection, view, member): every view unit is evaluated in full. */
	definition: boolean;
	/** The clock moved (a system `clock` record): units with relative dates are evaluated in full. */
	clock: boolean;
	/** page -> value properties written. */
	valueProps: Map<string, Set<string>>;
	/** page -> `$` fields that changed. */
	fields: Map<string, Set<string>>;
	subtreeRoots: string[];
	/** Roots whose subtree changed teamspace. */
	teamspaceRoots: string[];
	/** Descendants of the roots that changed teamspace. */
	teamspaceDescendants: Set<string>;
	backlinkTargets: Set<string>;
	/** Pages created, trashed or restored (a trash or restore brings its whole subtree): candidates of every view. */
	lifecycle: Set<string>;
	/** Pages that moved (parent, teamspace or rank). */
	moved: Set<string>;
	/** Pages the commit stamps as edited (every page with a record but a create or a links record). */
	edited: Set<string>;
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
		definition: false,
		clock: false,
		valueProps: new Map(),
		fields: new Map(),
		subtreeRoots: [],
		teamspaceRoots: [],
		teamspaceDescendants: new Set(),
		backlinkTargets: new Set(),
		lifecycle: new Set(),
		moved: new Set(),
		edited: new Set()
	};
	for (const row of rows) {
		const oldV = asRecord(row.old);
		const newV = asRecord(row.new);
		if (row.page && row.kind !== 'create' && row.kind !== 'links') t.edited.add(row.page);
		switch (row.kind) {
			case 'create':
				t.structural = true;
				if (row.page) {
					t.structPages.add(row.page);
					t.lifecycle.add(row.page);
				}
				t.parents.add((newV.parentId as string | null) ?? '');
				break;
			case 'move':
				t.structural = true;
				if (!row.page) break;
				t.structPages.add(row.page);
				t.moved.add(row.page);
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
			case 'restoreTeamspace':
				t.structural = true;
				t.all = true;
				break;
			case 'clock':
				t.clock = true;
				break;
			case 'moveMember':
				// A hand-picked member's rank is the row's manual-order key: views holding the page send `$rank`.
				if (row.page) addTo(t.fields, row.page, '$memberRank');
				t.structural = true;
				t.definition = true;
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
					t.definition = true;
				}
		}
	}
	return t;
}

const countEvaluations = { value: 0 };
/** Test hook: how many unit evaluations ran in this isolate. */
export const unitEvaluations = () => countEvaluations.value;

/** The windows of one view subscription for one actor, at one point in time. */
interface WindowSet {
	/** Group keys in display order (`[FLAT]` when ungrouped). */
	keys: string[];
	lists: Map<string, { all: string[]; window: string[] }>;
	/** Distinct visible pages. */
	distinct: number;
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

export class LiveHub {
	readonly #host: LiveHost;
	readonly #reader: RowReader;
	readonly #sql: SqlStorage;
	/** Evaluations performed by this instance (per wake), for the "evaluated once" guarantee. */
	evaluations = 0;
	/** Page id -> dense number: numbers never change, so this never needs invalidating. */
	readonly #nums = new Map<string, number>();
	/** Parsed view unit states (the SQL row is the source of truth; this skips re-parsing big lists). */
	readonly #states = new Map<string, ViewState>();
	/** Resolved view units, dropped whenever a definition changes. */
	readonly #resolved = new Map<string, ResolvedView | null>();

	constructor(host: LiveHost) {
		this.#host = host;
		this.#sql = host.sql;
		this.#reader = new RowReader(host.sql, host.db);
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
		const dead = this.#all<{ unit_key: string }>('SELECT unit_key FROM sub_unit WHERE unit_key NOT IN (SELECT DISTINCT unit_key FROM sub_link)');
		if (dead.length === 0) return;
		this.#run('DELETE FROM sub_unit WHERE unit_key NOT IN (SELECT DISTINCT unit_key FROM sub_link)');
		this.#run('DELETE FROM sub_prop WHERE unit_key NOT IN (SELECT DISTINCT unit_key FROM sub_link)');
		for (const { unit_key } of dead) {
			this.#states.delete(unit_key);
			this.#resolved.delete(unit_key);
		}
	}

	/** Forgets every socket's registry (after a failed fan-out: the clients reconnect and resume). */
	clearRegistry(): void {
		for (const table of ['socket_stream', 'socket_sub', 'sub_link', 'sub_unit', 'sub_prop']) this.#run(`DELETE FROM ${table}`);
		this.#states.clear();
		this.#resolved.clear();
	}

	subCount(socketId: string): number {
		return this.#all<{ n: number }>('SELECT COUNT(*) AS n FROM socket_sub WHERE socket_id = ?', socketId)[0].n;
	}

	unitCount(): number {
		return this.#all<{ n: number }>('SELECT COUNT(*) AS n FROM sub_unit')[0].n;
	}

	/** Test/diagnostic: units whose stored ids differ from a fresh evaluation (should always be empty). */
	async staleUnits(): Promise<string[]> {
		const stale: string[] = [];
		for (const u of this.#all<{ unit_key: string; kind: UnitKind; spec: string; ids: string }>('SELECT unit_key, kind, spec, ids FROM sub_unit')) {
			const spec = JSON.parse(u.spec) as Record<string, unknown>;
			if (u.kind === 'view') {
				const resolved = await resolveView(this.#host.db, spec as unknown as ViewUnitSpec);
				const fresh = resolved ? await evaluateView(this.#host.db, resolved, spec as unknown as ViewUnitSpec, { now: this.#host.now() }) : EMPTY_STATE;
				if (!fresh.equals(ViewState.parse(u.ids))) stale.push(u.unit_key);
			} else if (JSON.stringify(this.#evaluate(u.kind, spec, false)) !== u.ids) stale.push(u.unit_key);
		}
		return stale;
	}

	// ───────────────────────── units ─────────────────────────

	/** Tree, page and backlinks units: synchronous reads of the object's SQLite. */
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
				return [];
		}
	}

	#unitIds(key: string): string[] {
		const row = this.#all<{ ids: string }>('SELECT ids FROM sub_unit WHERE unit_key = ?', key)[0];
		return row ? (JSON.parse(row.ids) as string[]) : [];
	}

	#viewState(key: string): ViewState {
		let state = this.#states.get(key);
		if (!state) {
			const row = this.#all<{ ids: string }>('SELECT ids FROM sub_unit WHERE unit_key = ?', key)[0];
			state = row ? ViewState.parse(row.ids) : EMPTY_STATE;
			this.#states.set(key, state);
		}
		return state;
	}

	#writeView(key: string, state: ViewState): void {
		this.#run('UPDATE sub_unit SET ids = ? WHERE unit_key = ?', state.serialize(), key);
		this.#states.set(key, state);
	}

	#valueOf(key: string, kind: UnitKind): UnitValue {
		return kind === 'view' ? this.#viewState(key) : this.#unitIds(key);
	}

	async #resolve(key: string, spec: ViewUnitSpec, fresh = false): Promise<ResolvedView | null> {
		if (!fresh && this.#resolved.has(key)) return this.#resolved.get(key) ?? null;
		const resolved = await resolveView(this.#host.db, spec);
		this.#resolved.set(key, resolved);
		this.#indexUnit(key, resolved);
		return resolved;
	}

	/** The property-to-subscription index of a view unit, and its flags (1: reads the clock, 2: hand-picked only). */
	#indexUnit(key: string, resolved: ResolvedView | null): void {
		this.#run('DELETE FROM sub_prop WHERE unit_key = ?', key);
		if (!resolved) {
			this.#run('UPDATE sub_unit SET flags = 0 WHERE unit_key = ?', key);
			return;
		}
		for (const prop of resolved.props) this.#run('INSERT OR IGNORE INTO sub_prop (prop, unit_key) VALUES (?, ?)', prop, key);
		this.#run('UPDATE sub_unit SET flags = ? WHERE unit_key = ?', (resolved.timed ? 1 : 0) | (resolved.manual ? 2 : 0), key);
	}

	async #ensureUnit(unit: UnitRef): Promise<void> {
		const existing = this.#all<{ ids: string }>('SELECT ids FROM sub_unit WHERE unit_key = ?', unit.key)[0];
		if (existing) return;
		if (unit.kind === 'view') {
			const spec = unit.spec as unknown as ViewUnitSpec;
			this.evaluations++;
			countEvaluations.value++;
			const resolved = await resolveView(this.#host.db, spec);
			const state = resolved ? await evaluateView(this.#host.db, resolved, spec, { now: this.#host.now() }) : EMPTY_STATE;
			this.#run('INSERT OR REPLACE INTO sub_unit (unit_key, kind, spec, ids) VALUES (?, ?, ?, ?)', unit.key, unit.kind, JSON.stringify(unit.spec), state.serialize());
			this.#states.set(unit.key, state);
			this.#resolved.set(unit.key, resolved);
			this.#indexUnit(unit.key, resolved);
			return;
		}
		const ids = this.#evaluate(unit.kind, unit.spec);
		this.#run('INSERT INTO sub_unit (unit_key, kind, spec, ids) VALUES (?, ?, ?, ?)', unit.key, unit.kind, JSON.stringify(unit.spec), JSON.stringify(ids));
	}

	// ───────────────────────── subscriptions ─────────────────────────

	/** Registers (or replaces) a subscription: its units are evaluated now when nobody watches them yet. */
	async register(socketId: string, subId: string, sub: Subscription, actor: Actor): Promise<void> {
		this.#unregister(socketId, subId);
		const lim = sub.kind === 'view' ? sub.limit : sub.kind === 'backlinks' ? (sub.limit ?? MAX_WINDOW) : null;
		this.#run('INSERT INTO socket_sub (socket_id, sub_id, kind, spec, lim) VALUES (?, ?, ?, ?, ?)', socketId, subId, sub.kind, JSON.stringify(sub), lim);
		let units: UnitRef[];
		if (sub.kind === 'view') {
			// A query that reads `is me` is evaluated for that user; the rest is shared by everyone.
			const probe = unitsOf(sub, visibilityScope(actor))[0];
			const resolved = await resolveView(this.#host.db, probe.spec as unknown as ViewUnitSpec);
			units = resolved?.usesMe ? unitsOf(sub, `me:${actor.userId}`, actor.userId) : [probe];
		} else {
			units = unitsOf(sub, visibilityScope(actor));
		}
		for (const [ord, unit] of units.entries()) {
			await this.#ensureUnit(unit);
			this.#run('INSERT INTO sub_link (socket_id, sub_id, ord, unit_key) VALUES (?, ?, ?, ?)', socketId, subId, ord, unit.key);
		}
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
		const row = this.#all<{ kind: Subscription['kind']; spec: string; lim: number | null; glim: string | null }>(
			'SELECT kind, spec, lim, glim FROM socket_sub WHERE socket_id = ? AND sub_id = ?',
			socketId,
			subId
		)[0];
		if (!row) return null;
		const unitKeys = this.#all<{ unit_key: string }>(
			'SELECT unit_key FROM sub_link WHERE socket_id = ? AND sub_id = ? ORDER BY ord',
			socketId,
			subId
		).map((r) => r.unit_key);
		return {
			socketId,
			subId,
			kind: row.kind,
			sub: JSON.parse(row.spec) as Subscription,
			lim: row.lim,
			glim: row.glim ? (JSON.parse(row.glim) as Record<string, number>) : {},
			unitKeys
		};
	}

	/** Every subscription of a socket, in registration order of their ids. */
	subscriptions(socketId: string): SubscriptionEntry[] {
		return this.#all<{ sub_id: string; spec: string }>('SELECT sub_id, spec FROM socket_sub WHERE socket_id = ?', socketId).map((r) => ({
			id: r.sub_id,
			sub: JSON.parse(r.spec) as Subscription
		}));
	}

	// ───────────────────────── rows ─────────────────────────

	async #rowsFor(sub: Subscription, ids: readonly string[], access: AccessOf): Promise<Map<string, AnyRow>> {
		switch (sub.kind) {
			case 'tree':
				return this.#reader.treeRows(ids, access);
			case 'page':
				return this.#reader.pageRows(ids, access);
			case 'view':
				return this.#reader.viewRows(ids, access, sub.props, sub.collectionId);
			case 'backlinks':
				return this.#reader.backlinkRows(ids, sub.pageId);
		}
	}

	// ───────────────────────── view windows ─────────────────────────

	/** The windows of a view subscription over `state`, for the pages `has` lets through. */
	#windows(state: ViewState, row: Pick<SubRow, 'lim' | 'glim'>, has: (num: number) => boolean, registry: EavRegistry): WindowSet {
		const limit = row.lim ?? MAX_WINDOW;
		const lists = new Map<string, { all: string[]; window: string[] }>();
		if (!state.groupBy) {
			const all = this.#visible(state.lists.get(FLAT) ?? [], has);
			lists.set(FLAT, { all, window: all.slice(0, limit) });
			return { keys: [FLAT], lists, distinct: all.length };
		}
		const sizes = new Map<string, number>();
		const distinct = new Set<string>();
		for (const [key, list] of state.lists) {
			const all = this.#visible(list, has);
			if (all.length === 0) continue;
			sizes.set(key, all.length);
			lists.set(key, { all, window: all.slice(0, row.glim[key] ?? limit) });
			for (const id of all) distinct.add(id);
		}
		const keys = groupKeysFor(registry, state.groupBy, sizes);
		// A hidden group (an empty one with `hideEmpty`) is not a window the client holds.
		const shown = new Set(keys);
		for (const key of [...lists.keys()]) if (!shown.has(key)) lists.delete(key);
		for (const key of keys) if (!lists.has(key)) lists.set(key, { all: [], window: [] });
		return { keys, lists, distinct: distinct.size };
	}

	#windowIds(set: WindowSet): Set<string> {
		const out = new Set<string>();
		for (const key of set.keys) for (const id of set.lists.get(key)?.window ?? []) out.add(id);
		return out;
	}

	/** The ops that turn the windows `oldW` into `newW` (see the protocol header for their order). */
	async #viewWindowOps(row: SubRow, grouped: boolean, oldW: WindowSet, newW: WindowSet, view: VisibilityView, forceKeys: boolean): Promise<DiffOp[]> {
		const ops: DiffOp[] = [];
		// Rows are needed for every page that enters a window, even one the same page's other group already holds.
		const added = new Set<string>();
		for (const key of newW.keys) {
			const before = new Set(oldW.lists.get(key)?.window ?? []);
			for (const id of newW.lists.get(key)?.window ?? []) if (!before.has(id)) added.add(id);
		}
		const rows = added.size ? await this.#rowsFor(row.sub, [...added], view.level) : new Map<string, AnyRow>();
		if (grouped && (forceKeys || !sameKeys(oldW.keys, newW.keys))) ops.push({ op: 'groups', keys: newW.keys });
		for (const key of newW.keys) {
			const before = oldW.lists.get(key)?.window ?? [];
			const after = newW.lists.get(key)?.window ?? [];
			const gops = diffWindows(before, after, (id) => rows.get(id));
			if (grouped) for (const op of gops) (op as { group?: string }).group = key;
			ops.push(...gops);
		}
		return ops;
	}

	#viewCounts(grouped: boolean, oldW: WindowSet, newW: WindowSet): DiffOp[] {
		const ops: DiffOp[] = [];
		for (const key of newW.keys) {
			const before = oldW.lists.get(key)?.all.length ?? 0;
			const after = newW.lists.get(key)?.all.length ?? 0;
			if (before !== after) ops.push({ op: 'count', total: after, ...(grouped ? { group: key } : {}) });
		}
		if (grouped && oldW.distinct !== newW.distinct) ops.push({ op: 'count', total: newW.distinct });
		return ops;
	}

	// ───────────────────────── snapshots ─────────────────────────

	async snapshot(socketId: string, subId: string, actor: Actor, seq: number): Promise<ServerMessage | null> {
		const row = this.#loadSub(socketId, subId);
		if (!row) return null;
		const view = this.#host.view(actor);
		if (row.kind === 'view') {
			const state = this.#viewState(row.unitKeys[0]);
			const registry = await loadEavRegistry(this.#host.db);
			const set = this.#windows(state, row, (n) => view.has(n), registry);
			const sub = row.sub as Extract<Subscription, { kind: 'view' }>;
			if (!state.groupBy) {
				const window = set.lists.get(FLAT)?.window ?? [];
				const rows = await this.#reader.viewRows(window, view.level, sub.props, sub.collectionId);
				return { t: 'snapshot', id: subId, total: set.distinct, seq, kind: 'view', rows: window.map((id) => rows.get(id)).filter((r): r is ViewRow => !!r) };
			}
			const everything = this.#windowIds(set);
			const rows = await this.#reader.viewRows([...everything], view.level, sub.props, sub.collectionId);
			const groups = set.keys.map((key) => {
				const list = set.lists.get(key) ?? { all: [], window: [] };
				return { key, total: list.all.length, rows: list.window.map((id) => rows.get(id)).filter((r): r is ViewRow => !!r) };
			});
			return { t: 'snapshot', id: subId, total: set.distinct, seq, kind: 'view', rows: [], groups };
		}
		const all = this.#visible(this.#concat(row.unitKeys), (n) => view.has(n));
		const window = row.lim === null ? all : all.slice(0, row.lim);
		const rows = await this.#rowsFor(row.sub, window, view.level);
		const list = window.map((id) => rows.get(id)).filter((r): r is AnyRow => !!r);
		const base = { t: 'snapshot' as const, id: subId, total: all.length, seq };
		switch (row.kind) {
			case 'tree':
				return { ...base, kind: 'tree', rows: list as TreeRow[] };
			case 'page':
				return { ...base, kind: 'page', rows: list as PageRow[] };
			case 'backlinks':
				return { ...base, kind: 'backlinks', rows: list as BacklinkRow[] };
		}
		return null;
	}

	/** Ids of the non-view units of a subscription, concatenated. */
	#concat(unitKeys: readonly string[], overrides?: ReadonlyMap<string, UnitValue>): string[] {
		const out: string[] = [];
		for (const key of unitKeys) out.push(...((overrides?.get(key) as string[] | undefined) ?? this.#unitIds(key)));
		return out;
	}

	// ───────────────────────── window ─────────────────────────

	/**
	 * Resizes a view/backlinks window; returns the diff to send (null when nothing changes). `group` resizes one
	 * group of a grouped view; without it every group gets the new size.
	 */
	async resizeWindow(socketId: string, subId: string, limit: number, actor: Actor, group?: string): Promise<DiffOp[] | null> {
		const row = this.#loadSub(socketId, subId);
		if (!row || (row.kind !== 'view' && row.kind !== 'backlinks')) return null;
		const view = this.#host.view(actor);
		if (row.kind === 'view') {
			const state = this.#viewState(row.unitKeys[0]);
			const registry = await loadEavRegistry(this.#host.db);
			const next = { lim: row.lim, glim: { ...row.glim } };
			if (group !== undefined && state.groupBy) next.glim[group] = limit;
			else {
				next.lim = limit;
				next.glim = {};
			}
			const sub = { ...row.sub, ...(group === undefined ? { limit } : {}) } as Subscription;
			this.#run('UPDATE socket_sub SET spec = ?, lim = ?, glim = ? WHERE socket_id = ? AND sub_id = ?', JSON.stringify(sub), next.lim, JSON.stringify(next.glim), socketId, subId);
			const oldW = this.#windows(state, row, (n) => view.has(n), registry);
			const newW = this.#windows(state, next, (n) => view.has(n), registry);
			const updated: SubRow = { ...row, sub, lim: next.lim, glim: next.glim };
			const ops = await this.#viewWindowOps(updated, !!state.groupBy, oldW, newW, view, false);
			if (ops.length === 0) return null;
			// The rows that slide in are `add`s, which a client counts: say what the totals are (they do not change
			// when a window grows, only what is held does), the groups' first.
			if (state.groupBy) for (const key of newW.keys) ops.push({ op: 'count', total: newW.lists.get(key)?.all.length ?? 0, group: key });
			ops.push({ op: 'count', total: newW.distinct });
			return ops;
		}
		const sub = { ...row.sub, limit } as Subscription;
		this.#run('UPDATE socket_sub SET spec = ?, lim = ? WHERE socket_id = ? AND sub_id = ?', JSON.stringify(sub), limit, socketId, subId);
		const all = this.#visible(this.#concat(row.unitKeys), (n) => view.has(n));
		const oldW = row.lim === null ? all : all.slice(0, row.lim);
		const newW = all.slice(0, limit);
		const rows = await this.#rowsFor(sub, newW, view.level);
		const ops = diffWindows(oldW, newW, (id) => rows.get(id));
		if (ops.length === 0) return null;
		ops.push({ op: 'count', total: all.length });
		return ops;
	}

	// ───────────────────────── commits ─────────────────────────

	/** Fans one commit out: diffs to the sockets it touches, `head` to the rest. */
	async fanOut(commit: CommitInfo): Promise<void> {
		const touch = analyze(commit.rows);
		for (const id of commit.backlinkTargets ?? []) touch.backlinkTargets.add(id);
		for (const id of commit.hasChildrenFlips?.keys() ?? []) addTo(touch.fields, id, '$hasChildren');
		if (touch.definition) {
			this.#resolved.clear();
			this.#reader.invalidate();
		}
		if (touch.subtreeRoots.length > 0 || touch.teamspaceRoots.length > 0) {
			const sub = this.#reader.subtree([...touch.subtreeRoots, ...touch.teamspaceRoots]);
			for (const id of sub) touch.structPages.add(id);
			// Descendants of a page that moved teamspace carry the new teamspace.
			for (const id of this.#reader.subtree(touch.teamspaceRoots)) {
				if (!touch.teamspaceRoots.includes(id)) {
					addTo(touch.fields, id, '$teamspace');
					touch.teamspaceDescendants.add(id);
				}
			}
			if (touch.subtreeRoots.length) {
				const trashed = this.#reader.subtree(touch.subtreeRoots);
				for (const id of trashed) touch.lifecycle.add(id);
				for (const id of this.#reader.linkTargetsOf(trashed)) touch.backlinkTargets.add(id);
				// A to-one relation to a trashed (or restored) page reads null (or the page again).
				for (const [holder, prop] of this.#reader.relationHolders(trashed)) addTo(touch.valueProps, holder, prop);
			}
		}

		// A two-way relation edit changes the cell of the pages it points at (their reverse side).
		const reverseOf = new Map<string, string>();
		for (const r of this.#reader.forwardRelations()) if (r.reverse) reverseOf.set(r.id, r.reverse);
		if (reverseOf.size > 0) {
			for (const row of commit.rows) {
				const reverse = row.kind === 'setProp' && row.prop ? reverseOf.get(row.prop) : undefined;
				if (!reverse) continue;
				for (const side of [row.old, row.new]) if (Array.isArray(side)) for (const id of side) if (typeof id === 'string') addTo(touch.valueProps, id, reverse);
			}
		}

		const units = this.#all<{ unit_key: string; kind: UnitKind; spec: string; flags: number }>('SELECT unit_key, kind, spec, flags FROM sub_unit');
		const streams = this.streamSockets();
		const streaming = new Set(streams);
		const diffs = new Map<string, { id: string; ops: DiffOp[] }[]>();
		const resets = new Map<string, string[]>();

		// Sockets whose actor's visibility changed in this commit: every window of theirs is re-derived.
		const visibilityHit: { socketId: string; subId: string }[] = [];
		for (const socketId of streams) {
			const actor = this.#host.actorOf(socketId);
			if (actor && this.#host.view(actor).delta.size > 0) {
				for (const entry of this.subscriptions(socketId)) visibilityHit.push({ socketId, subId: entry.id });
			}
		}

		if ((units.length > 0 && streams.length > 0) || visibilityHit.length > 0) {
			const registry = await loadEavRegistry(this.#host.db);
			// 1. Re-evaluate the units the commit can touch and keep the ones whose ids changed.
			const changed = new Map<string, { old: UnitValue; next: UnitValue }>();
			for (const u of units) {
				if (u.kind === 'view') continue;
				const spec = JSON.parse(u.spec) as Record<string, unknown>;
				if (!this.#touches(u.kind, spec, touch)) continue;
				const old = this.#unitIds(u.unit_key);
				const next = this.#evaluate(u.kind, spec);
				if (JSON.stringify(old) !== JSON.stringify(next)) {
					changed.set(u.unit_key, { old, next });
					this.#run('UPDATE sub_unit SET ids = ? WHERE unit_key = ?', JSON.stringify(next), u.unit_key);
				}
			}
			const rescope = new Set<string>();
			if (streams.length > 0) await this.#maintainViews(units, touch, changed, rescope);
			// Subscriptions whose unit changed hands: registered again (the right unit for their user), fresh snapshot.
			const rescoped = new Set<string>();
			if (rescope.size > 0) {
				for (const link of this.#subsOfUnits([...rescope])) {
					const row = this.#loadSub(link.socketId, link.subId);
					const actor = this.#host.actorOf(link.socketId);
					if (!row || !actor) continue;
					await this.register(link.socketId, link.subId, row.sub, actor);
					rescoped.add(`${link.socketId}\u0000${link.subId}`);
					const list = resets.get(link.socketId) ?? [];
					list.push(link.subId);
					resets.set(link.socketId, list);
				}
				this.#gcUnits();
			}

			// 2. Units holding a page whose values or fields changed, for `update` ops.
			const updated = new Set<string>([...touch.valueProps.keys(), ...touch.fields.keys()]);
			const holding = this.#unitsHolding([...updated]);
			const affected = new Set<string>([...changed.keys(), ...holding]);
			// A definition change (options edited...) can reorder or drop groups without moving any page.
			if (touch.definition) for (const u of units) if (u.kind === 'view') affected.add(u.unit_key);

			const subs = this.#subsOfUnits([...affected]);
			const seen = new Set(subs.map((l) => `${l.socketId}\u0000${l.subId}`));
			for (const hit of visibilityHit) if (!seen.has(`${hit.socketId}\u0000${hit.subId}`)) subs.push(hit);

			if (subs.length > 0) {
				const cache = await CommitCache.create(this.#reader, updated);
				const ids = new Map<string, string[]>();
				const currentOf = (key: string) => {
					let v = ids.get(key);
					if (!v) ids.set(key, (v = this.#unitIds(key)));
					return v;
				};
				for (const link of subs) {
					const row = this.#loadSub(link.socketId, link.subId);
					const actor = this.#host.actorOf(link.socketId);
					if (!row || !actor || !streaming.has(link.socketId) || rescoped.has(`${link.socketId}\u0000${link.subId}`)) continue;
					const view = this.#host.view(actor);
					let ops: DiffOp[];
					if (row.kind === 'view') {
						const key = row.unitKeys[0];
						const next = this.#viewState(key);
						const old = (changed.get(key)?.old as ViewState | undefined) ?? next;
						if (old.grouped !== next.grouped) {
							// Ungrouped to grouped (or back): the windows have another shape, a fresh snapshot replaces them.
							const list = resets.get(link.socketId) ?? [];
							list.push(link.subId);
							resets.set(link.socketId, list);
							continue;
						}
						const oldW = this.#windows(old, row, (n) => view.hadBefore(n), registry);
						const newW = this.#windows(next, row, (n) => view.has(n), registry);
						ops = await this.#viewWindowOps(row, next.grouped, oldW, newW, view, touch.definition);
						const oldIds = this.#windowIds(oldW);
						const inBoth = [...this.#windowIds(newW)].filter((id) => oldIds.has(id));
						ops.push(...cache.updatesFor(row.sub, row.kind, inBoth, touch));
						ops.push(...this.#accessUpdates(inBoth, view));
						ops.push(...this.#viewCounts(next.grouped, oldW, newW));
					} else {
						const oldMap = new Map<string, UnitValue>();
						for (const key of row.unitKeys) oldMap.set(key, changed.get(key)?.old ?? currentOf(key));
						// ANDed with the actor's visibility: before the commit for the old window, after it for the new.
						const newAll = this.#visible(this.#concat(row.unitKeys), (n) => view.has(n));
						const oldAll = this.#visible(this.#concat(row.unitKeys, oldMap), (n) => view.hadBefore(n));
						const lim = row.lim;
						const oldW = lim === null ? oldAll : oldAll.slice(0, lim);
						const newW = lim === null ? newAll : newAll.slice(0, lim);
						const oldSet = new Set(oldW);
						const added = newW.filter((id) => !oldSet.has(id));
						const rows = added.length ? await this.#rowsFor(row.sub, added, view.level) : new Map<string, AnyRow>();
						ops = diffWindows(oldW, newW, (id) => rows.get(id));
						const inBoth = newW.filter((id) => oldSet.has(id));
						ops.push(...cache.updatesFor(row.sub, row.kind, inBoth, touch));
						if (row.kind === 'tree' || row.kind === 'page') ops.push(...this.#accessUpdates(inBoth, view));
						if (oldAll.length !== newAll.length) ops.push({ op: 'count', total: newAll.length });
					}
					if (ops.length) {
						const list = diffs.get(link.socketId) ?? [];
						list.push({ id: link.subId, ops });
						diffs.set(link.socketId, list);
					}
				}
			}
		}

		// 3. One frame per socket: its diff, or a head (and a fresh snapshot where a window changed shape).
		for (const socketId of streams) {
			const subsOf = diffs.get(socketId);
			const message: ServerMessage = subsOf ? { t: 'diff', seq: commit.seq, subs: subsOf } : { t: 'head', seq: commit.seq };
			if (!this.#host.send(socketId, message)) {
				this.dropSocket(socketId);
				continue;
			}
			const actor = this.#host.actorOf(socketId);
			for (const subId of resets.get(socketId) ?? []) {
				const snap = actor ? await this.snapshot(socketId, subId, actor, commit.seq) : null;
				if (snap) this.#host.send(socketId, snap);
			}
		}
	}

	/** A level that changed on a page the actor keeps seeing. */
	#accessUpdates(ids: readonly string[], view: VisibilityView): DiffOp[] {
		const ops: DiffOp[] = [];
		for (const id of ids) {
			const num = this.#numOf(id);
			const d = num === undefined ? undefined : view.delta.get(num);
			if (d && d.before >= 0 && d.after >= 0 && d.before !== d.after) {
				ops.push({ op: 'update', id, prop: '$access', value: view.level(num as number) });
			}
		}
		return ops;
	}

	/**
	 * Brings every view unit up to date with a commit. Units the commit cannot touch are skipped without a
	 * query (the `sub_prop` index finds the ones that read a property it wrote); the rest are maintained
	 * incrementally for the commit's candidate pages, or evaluated in full (see `view-unit.ts`).
	 */
	async #maintainViews(
		units: readonly { unit_key: string; kind: UnitKind; spec: string; flags: number }[],
		touch: Touch,
		changed: Map<string, { old: UnitValue; next: UnitValue }>,
		rescope: Set<string>
	): Promise<void> {
		const viewUnits = units.filter((u) => u.kind === 'view');
		if (viewUnits.length === 0) return;
		const db = this.#host.db;
		const now = this.#host.now();
		const full = touch.definition || touch.all;
		const pageLevel = touch.lifecycle.size > 0 || touch.moved.size > 0;

		const writtenProps = new Set<string>();
		for (const props of touch.valueProps.values()) for (const p of props) writtenProps.add(p);
		const editedPages = new Set<string>([...touch.edited, ...touch.valueProps.keys(), ...touch.fields.keys()]);
		if (editedPages.size > 0) writtenProps.add(EDITED);
		const indexed = this.#unitsReading([...writtenProps]);

		const tuples = new TupleCache(db, now);
		for (const u of viewUnits) {
			const key = u.unit_key;
			const timed = touch.clock && (u.flags & 1) !== 0;
			if (!full && !timed && !pageLevel && !indexed.has(key)) continue;
			const spec = JSON.parse(u.spec) as unknown as ViewUnitSpec;
			const resolved = await this.#resolve(key, spec, full);
			// A saved view now reads "is me" (or no longer does): its unit is shared by the wrong people.
			if (resolved && resolved.usesMe !== (spec.me !== undefined)) {
				rescope.add(key);
				continue;
			}
			const old = this.#viewState(key);
			let next: ViewState;
			if (!resolved) {
				next = EMPTY_STATE;
			} else if (full || timed || resolved.manual) {
				next = await evaluateView(db, resolved, spec, { now });
			} else {
				const candidates = this.#viewCandidates(resolved, touch, old, editedPages);
				if (candidates.size === 0) continue;
				const list = [...candidates];
				const liveCount = this.#reader.liveIds(list).size;
				const incremental =
					liveCount > MAX_INCREMENTAL ? null : await maintainView({ db, resolved, spec, state: old, candidates: list, reader: this.#reader, tuples, now });
				next = incremental ?? (await evaluateView(db, resolved, spec, { now }));
			}
			this.evaluations++;
			countEvaluations.value++;
			if (!old.equals(next)) {
				changed.set(key, { old, next });
				this.#writeView(key, next);
			}
		}
	}

	/** The pages whose membership, group or position in a view unit may change in this commit. */
	#viewCandidates(resolved: ResolvedView, touch: Touch, old: ViewState, editedPages: ReadonlySet<string>): Set<string> {
		const out = new Set<string>();
		for (const [page, props] of touch.valueProps) if (unitReads(resolved.props, props)) out.add(page);
		if (resolved.props.includes(EDITED)) for (const id of editedPages) out.add(id);
		for (const id of touch.lifecycle) out.add(id);
		if (touch.moved.size > 0) {
			const readsPlace = resolved.props.includes('$parent') || resolved.props.includes('$teamspace');
			const held = readsPlace ? null : new Set(old.ids());
			for (const id of touch.moved) if (readsPlace || held!.has(id)) out.add(id);
		}
		if (resolved.props.includes('$teamspace')) for (const id of touch.teamspaceDescendants) out.add(id);
		return out;
	}

	/** Units of the index that read one of `props`. */
	#unitsReading(props: readonly string[]): Set<string> {
		const out = new Set<string>();
		for (const part of chunks(props, MAX_PARAMS)) {
			for (const r of this.#all<{ unit_key: string }>(`SELECT DISTINCT unit_key FROM sub_prop WHERE prop IN (${qmarks(part.length)})`, ...part)) out.add(r.unit_key);
		}
		return out;
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
				return false;
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
			for (const r of this.#all<{ unit_key: string; kind: UnitKind }>('SELECT unit_key, kind FROM sub_unit')) {
				const ids = r.kind === 'view' ? this.#viewState(r.unit_key).ids() : this.#unitIds(r.unit_key);
				if (ids.some((id) => wanted.has(id))) keys.add(r.unit_key);
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
	async replaySub(socketId: string, subId: string, actor: Actor, touch: Touch, seq: number): Promise<ServerMessage | null> {
		const row = this.#loadSub(socketId, subId);
		if (!row) return null;
		const touched = new Set<string>([...touch.structPages, ...touch.valueProps.keys(), ...touch.fields.keys()]);
		for (const parent of touch.parents) if (parent) touched.add(parent);
		const view = this.#host.view(actor);
		if (row.kind === 'view') {
			// Any value, field or page-level change can move a page into or out of a view: fresh snapshot. So does
			// a grouped view, whatever changed: the client may have grown a group's window, which `hello` cannot say.
			const hit = touch.structural || touch.clock || touch.backlinkTargets.size > 0 || touched.size > 0 || this.#viewState(row.unitKeys[0]).grouped;
			return hit ? this.snapshot(socketId, subId, actor, seq) : null;
		}
		const all = this.#visible(this.#concat(row.unitKeys), (n) => view.has(n));
		const window = row.lim === null ? all : all.slice(0, row.lim);
		if (row.kind === 'backlinks') {
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
		const rows = await this.#rowsFor(row.sub, window.filter((id) => touched.has(id)), view.level);
		const ops: DiffOp[] = [...touched].map((id) => ({ op: 'remove' as const, id }));
		window.forEach((id, index) => {
			const r = rows.get(id);
			if (r) ops.push({ op: 'add', index, row: r as never });
		});
		ops.push({ op: 'count', total: all.length });
		return { t: 'diff', seq, subs: [{ id: subId, ops }] };
	}

	/** Whether any live view unit reads the clock (relative dates): the alarm then commits a `clock` record. */
	hasClockUnits(): boolean {
		return this.#all<{ n: number }>('SELECT COUNT(*) AS n FROM sub_unit WHERE kind = ? AND (flags & 1) = 1', 'view')[0].n > 0;
	}
}

/** Change kinds that alter who can see what. */
const ACCESS_KINDS: ReadonlySet<string> = new Set(['grant.set', 'grant.revoke', 'member.sync', 'teamspace.member', 'teamspace.update', 'archiveTeamspace', 'restoreTeamspace']);

/** Replays touching more pages (or log rows) than this are answered with fresh snapshots instead. */
export const MAX_REPLAY_PAGES = 200;
export const MAX_REPLAY_ROWS = 2000;

/** Fresh page data for the `update` ops of one commit, read once. */
class CommitCache {
	readonly #values: Awaited<ReturnType<RowReader['currentValues']>>;
	readonly #structure: ReturnType<RowReader['structure']>;
	readonly #reader: RowReader;
	/** Member ranks per hand-picked-only collection (null: the collection orders by page rank). */
	readonly #memberRanks = new Map<string, Map<string, string> | null>();

	private constructor(reader: RowReader, values: Awaited<ReturnType<RowReader['currentValues']>>, structure: ReturnType<RowReader['structure']>) {
		this.#reader = reader;
		this.#values = values;
		this.#structure = structure;
	}

	static async create(reader: RowReader, pages: ReadonlySet<string>): Promise<CommitCache> {
		const ids = [...pages];
		return new CommitCache(reader, await reader.currentValues(ids), reader.structure(ids));
	}

	/** The manual-order key of `id` in a view of `collectionId`: its member rank in a hand-picked-only collection, else its page rank. */
	#rankIn(collectionId: string, id: string, pageRank: string): string {
		let ranks = this.#memberRanks.get(collectionId);
		if (ranks === undefined) {
			ranks = this.#reader.memberRanks(collectionId, [...this.#structure.keys()]);
			this.#memberRanks.set(collectionId, ranks);
		}
		return ranks?.get(id) ?? pageRank;
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
						if (kind === 'tree' || kind === 'page' || kind === 'view') push('$parent', structure.parentId as never);
						break;
					case '$rank':
						if (kind === 'tree' || kind === 'page') push('$rank', structure.rank);
						else if (kind === 'view') push('$rank', this.#rankIn((sub as Extract<Subscription, { kind: 'view' }>).collectionId, id, structure.rank));
						break;
					case '$memberRank':
						if (kind === 'view') push('$rank', this.#rankIn((sub as Extract<Subscription, { kind: 'view' }>).collectionId, id, structure.rank));
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
