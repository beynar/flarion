/**
 * Access in the Workspace DO: the actor facts of a request, the governed (`$as`) clients, and the
 * per-actor VISIBILITY SETS (docs/PLAN.md "Permissions": "Live queries, search and AI").
 *
 * A visibility set is the `num` of every live page `page.findMany` returns under `$as(actor)`, each with
 * the highest level the actor holds on it (so tree rows can carry `$access` without a query). Sets are
 * cached in memory per actor, ANDed into every subscription result by the live loop and handed to the
 * query engine (`visibleNums`). The viborm policy stays the single source of truth: a set is always
 * computed by asking it, never by a second implementation of its rules.
 *
 * Invalidation (`noteCommit`), lazily, only for the actors and subtrees a change can affect:
 *   create / move / trash / restore   the page's subtree is dirty for every cached actor
 *   grant set / revoke                the grant's page subtree, for actors holding the grant's subject key
 *   teamspace member / default level  the affected members are rebuilt from scratch (their facts change)
 *   workspace membership (`syncMember`) the user is rebuilt from scratch
 *   teamspace archive, anything unknown   every actor rebuilt from scratch (the fallback)
 * A dirty subtree larger than {@link MAX_SUBTREE} pages is a full rebuild too. Recomputing an entry
 * records a per-page `delta` (before/after level) that the live loop turns into `add`/`remove`/`$access`
 * diffs; the deltas live for one commit.
 */
import { createBitmap, roaringReady, type Bitmap } from '../../bitmaps/roaring';
import { LevelMap } from './level-map';
import { ACCESS_LEVELS, type AccessLevel } from '../../db/workspace.schema';
import { actorFacts, type Actor as PolicyActor } from '../../db/policy';
import type { WorkspaceClient, WorkspaceTx } from '../../db/workspace.client';
import { policy } from '../../db/policy';
import type { WorkspaceRole } from '../../auth/session';
import { roomAccessForLevel } from '../../rooms/access';
import type { RoomAccess } from '../../rooms/token';
import type { LogRow } from './changelog';
import { chunks, qmarks } from './util';

export type { AccessLevel };

/**
 * Who is asking. A session `Actor` fits (`userId`, `role`); an anonymous visitor has no `userId` and may
 * carry a public share token. `role` left out means "look it up in the `member` mirror" (rooms and files
 * only know the user id); an unknown or removed member then holds nothing.
 */
export interface AccessActor {
	userId?: string;
	role?: WorkspaceRole | 'anonymous';
	shareToken?: string;
}

/** Which room access a page level maps to (the edytor `access` of PLAN.md "Permissions"). */
export type RoomAccessLevel = RoomAccess;
export const roomAccessOf = roomAccessForLevel;

export const levelRank = (level: AccessLevel): number => ACCESS_LEVELS.indexOf(level);
const NONE = -1;

/** A governed page delegate: viborm's `can`/`assert` are on the `$as` client at runtime. */
export interface GovernedPage {
	can(action: AccessLevel, where: { id: string }): Promise<boolean>;
	can<const A extends readonly AccessLevel[]>(actions: A, where: { id: string }): Promise<{ [K in A[number]]: boolean }>;
	assert(action: AccessLevel | readonly AccessLevel[], where: { id: string }): Promise<void>;
}
/** The governed delegate's read surface with `$access` selections (viborm types them per schema; we only need rows). */
interface RowsDelegate {
	findMany(args: unknown): Promise<unknown[]>;
	findFirst(args: unknown): Promise<unknown>;
}
const pages = (gov: Governed): RowsDelegate => gov.page as unknown as RowsDelegate;
export type Governed = Omit<WorkspaceClient, 'page'> & { page: WorkspaceClient['page'] & GovernedPage };
export type GovernedTx = Omit<WorkspaceTx, 'page'> & { page: WorkspaceTx['page'] & GovernedPage };

/** Dirty subtrees above this many pages are rebuilt in full instead. */
export const MAX_SUBTREE = 600;
/** Pages checked per statement when recomputing a subtree (the policy takes ~15 of the 100 bound values). */
const CHECK_CHUNK = 60;
/** Cached actors; the oldest idle entries go first. */
const MAX_ENTRIES = 1000;

/** A level change of one page for one actor: ranks, -1 = not visible. */
export interface PageDelta {
	before: number;
	after: number;
}

interface Entry {
	key: string;
	actor: AccessActor & { role: WorkspaceRole | 'anonymous' };
	facts: PolicyActor;
	/** num -> level rank of every live page the actor can read. */
	levels: LevelMap;
	/**
	 * The same pages as a Roaring bitmap (null while roaring is not loaded): the live loop counts and cuts windows with
	 * bitmap intersections instead of one `has` per page. Replaced, never changed in place, so a view taken earlier
	 * keeps the set it was taken with.
	 */
	bits: Bitmap | null;
	dirty: 'full' | Set<number> | null;
	/** Unique across entries and bumped by every recompute: what a cached window derived from this entry was derived from. */
	rev: number;
	/** Facts must be re-read before the next recompute (a teamspace membership or default level changed). */
	staleFacts: boolean;
	delta: Map<number, PageDelta>;
	/** Last use, for eviction. */
	used: number;
}

/** What the live loop asks of an actor's visibility, synchronously, after `settle`. */
export interface VisibilityView {
	/** Visible now. */
	has(num: number): boolean;
	/** Visible before the commit being fanned out (equals `has` when nothing changed for the page). */
	hadBefore(num: number): boolean;
	/** Level now (`read` when unknown: callers only ask about visible pages). */
	level(num: number): AccessLevel;
	levelBefore(num: number): AccessLevel | null;
	/** Pages whose visibility or level changed in this commit. */
	readonly delta: ReadonlyMap<number, PageDelta>;
	/** The visible pages as a bitmap (`has` for sets), or null when bitmaps are off. */
	readonly bits: Bitmap | null;
	/** Changes whenever the actor's levels do (a cached window of this actor is valid for one `rev`). */
	readonly rev: number;
}

const EMPTY_DELTA: ReadonlyMap<number, PageDelta> = new Map();
const NOTHING: VisibilityView = {
	has: () => false,
	hadBefore: () => false,
	level: () => 'read',
	levelBefore: () => null,
	delta: EMPTY_DELTA,
	bits: null,
	rev: 0
};

export const actorKey = (a: { userId?: string; role?: string; shareToken?: string }): string =>
	`${a.userId ?? ''}|${a.role ?? ''}|${a.shareToken ?? ''}`;

const asRecord = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});

export interface AccessHost {
	db: WorkspaceClient;
	sql: SqlStorage;
}

/** Result of {@link AccessService.noteCommit}: what the live loop and the room sync need to know. */
export interface CommitAccess {
	/** The commit can change what some actor sees or may do. */
	affecting: boolean;
	/** Pages whose subtrees the commit touched structurally or by grant (ids), for the room sync. */
	roots: string[];
	/** Teamspaces whose members' access changed (membership, default level, archive): their pages' rooms. */
	teamspaces: string[];
	/** Everything may have changed (a workspace member left or changed role): every open room is re-checked. */
	everything: boolean;
}

export class AccessService {
	readonly #sql: SqlStorage;
	/** `policy(db)` is typed by an enormous generic; the runtime surface is `$as(facts)`. */
	readonly #governed: { $as(facts: PolicyActor): Governed };
	readonly #entries = new Map<string, Entry>();
	readonly #inflight = new Map<string, Promise<void>>();
	/** Bumped by every commit: an entry read across a commit is read again. */
	#epoch = 0;
	readonly #facts = new Map<string, PolicyActor>();
	readonly #clients = new WeakMap<PolicyActor, Governed>();
	#clock = 0;
	/** Source of `Entry.rev`. */
	#revs = 0;

	constructor(host: AccessHost) {
		this.#sql = host.sql;
		this.#governed = (policy as unknown as (db: WorkspaceClient) => { $as(facts: PolicyActor): Governed })(host.db);
	}

	// ───────────────────────── facts and governed clients ─────────────────────────

	/** The role of a user from the `member` mirror (null: unknown or removed). */
	memberRole(userId: string): WorkspaceRole | null {
		const known = this.#roles.get(userId);
		if (known !== undefined) return known;
		const row = this.#sql.exec<{ role: string; removed_at: string | null }>('SELECT role, removed_at FROM member WHERE user_id = ?', userId).toArray()[0];
		const role = row && !row.removed_at ? (row.role as WorkspaceRole) : null;
		if (this.#roles.size >= 5000) this.#roles.clear();
		this.#roles.set(userId, role);
		return role;
	}

	/** Roles read from the `member` table, kept until it changes (`forgetMembers`: every write of that table says so, and a `member.sync` commit does). */
	readonly #roles = new Map<string, WorkspaceRole | null>();

	forgetMembers(): void {
		this.#roles.clear();
	}

	/** Fills in the role of an actor that only names a user; null when that user holds no membership. */
	resolve(actor: AccessActor): (AccessActor & { role: WorkspaceRole | 'anonymous' }) | null {
		if (actor.role) return { ...actor, role: actor.role };
		if (!actor.userId) return { ...actor, role: 'anonymous' };
		const role = this.memberRole(actor.userId);
		return role ? { ...actor, role } : null;
	}

	/** The policy's actor facts for a resolved actor (teamspace memberships read from the object, cached). */
	facts(actor: AccessActor & { role: WorkspaceRole | 'anonymous' }): PolicyActor {
		const key = actorKey(actor);
		const cached = this.#facts.get(key);
		if (cached) return cached;
		const memberships = actor.userId
			? this.#sql
					.exec<{ teamspaceId: string; role: string }>(
						`SELECT m.teamspace_id AS teamspaceId, m.role AS role FROM teamspace_member m
						 JOIN teamspace t ON t.id = m.teamspace_id WHERE m.user_id = ? AND t.deleted_at IS NULL`,
						actor.userId
					)
					.toArray()
			: [];
		const teamspaces = this.#sql
			.exec<{ id: string; defaultLevel: string }>('SELECT id, default_level AS defaultLevel FROM teamspace WHERE deleted_at IS NULL')
			.toArray();
		const facts = actorFacts({
			userId: actor.userId,
			role: actor.role,
			shareToken: actor.shareToken,
			memberships,
			teamspaces
		});
		this.#facts.set(key, facts);
		if (this.#facts.size > MAX_ENTRIES) this.#facts.delete(this.#facts.keys().next().value as string);
		return facts;
	}

	/** The client every call of this actor runs on: `db.$as(facts)`. Null when the user holds no membership. */
	governed(actor: AccessActor): Governed | null {
		const resolved = this.resolve(actor);
		return resolved ? this.#governedFor(this.facts(resolved)) : null;
	}

	/**
	 * `$as(facts)` builds a client (it snapshots the facts, binds the policy's controls and wraps every model): about half of a
	 * property edit's CPU time when it ran per call. The facts of an actor are one cached object until they change, so the client
	 * is kept with them, and the per-client caches (the property registry) live as long as it does.
	 */
	#governedFor(facts: PolicyActor): Governed {
		let client = this.#clients.get(facts);
		if (!client) this.#clients.set(facts, (client = this.#governed.$as(facts)));
		return client;
	}

	/** True for owners and admins (full access to everything). */
	isAdmin(actor: AccessActor): boolean {
		const resolved = this.resolve(actor);
		return !!resolved && (resolved.role === 'owner' || resolved.role === 'admin');
	}

	// ───────────────────────── point checks ─────────────────────────

	/** The highest level the actor holds on a live page, or null (no access, trashed, unknown page). */
	async pageAccess(actor: AccessActor, pageId: string): Promise<AccessLevel | null> {
		const gov = this.governed(actor);
		if (!gov) return null;
		const row = (await pages(gov).findFirst({ where: { id: pageId, deletedAt: null }, select: { $access: true } })) as {
			$access: Record<AccessLevel, boolean>;
		} | null;
		return row ? levelOfAccess(row.$access) : null;
	}

	/** Whether the actor holds `level` on each (live) page. */
	async can(actor: AccessActor, pageIds: readonly string[], level: AccessLevel): Promise<Record<string, boolean>> {
		const out: Record<string, boolean> = Object.fromEntries(pageIds.map((id) => [id, false]));
		const gov = this.governed(actor);
		if (!gov) return out;
		for (const part of chunks([...new Set(pageIds)], CHECK_CHUNK)) {
			const rows = (await pages(gov).findMany({
				where: { id: { in: part }, deletedAt: null },
				select: { id: true, $access: true }
			})) as { id: string; $access: Record<AccessLevel, boolean> }[];
			for (const r of rows) out[r.id] = r.$access[level] === true;
		}
		return out;
	}

	// ───────────────────────── visibility sets ─────────────────────────

	async #fresh(actor: AccessActor & { role: WorkspaceRole | 'anonymous' }, facts: PolicyActor): Promise<LevelMap> {
		const gov = this.#governed.$as(facts);
		const rows = (await pages(gov).findMany({ where: { deletedAt: null }, select: { num: true, $access: true } })) as {
			num: number;
			$access: Record<AccessLevel, boolean>;
		}[];
		return new LevelMap(rows.map((r) => [r.num, rankOfAccess(r.$access)] as [number, number]));
	}

	async #subtree(entry: Entry, nums: readonly number[]): Promise<Map<number, number>> {
		const gov = this.#governed.$as(entry.facts);
		const out = new Map<number, number>();
		for (const part of chunks(nums, CHECK_CHUNK)) {
			const rows = (await pages(gov).findMany({
				where: { num: { in: part }, deletedAt: null },
				select: { num: true, $access: true }
			})) as { num: number; $access: Record<AccessLevel, boolean> }[];
			for (const r of rows) out.set(r.num, rankOfAccess(r.$access));
		}
		return out;
	}

	#entry(actor: AccessActor & { role: WorkspaceRole | 'anonymous' }): Entry | undefined {
		return this.#entries.get(actorKey(actor));
	}

	/**
	 * Brings an actor's entry up to date (creating it the first time) and returns it with this recompute's
	 * `delta`. Concurrent callers share one recompute; a change that marks the entry dirty while it runs
	 * leaves it dirty, and the loop runs it again.
	 */
	async #settleEntry(actor: AccessActor & { role: WorkspaceRole | 'anonymous' }): Promise<Entry> {
		const key = actorKey(actor);
		for (let rounds = 0; rounds < 8; rounds++) {
			const running = this.#inflight.get(key);
			if (running) {
				await running.catch(() => undefined);
				continue;
			}
			const entry = this.#entries.get(key);
			if (entry && entry.dirty === null && !entry.staleFacts) {
				entry.used = ++this.#clock;
				return entry;
			}
			const work: Promise<void> = this.#recompute(actor, key, entry).finally(() => {
				if (this.#inflight.get(key) === work) this.#inflight.delete(key);
			});
			this.#inflight.set(key, work);
			await work;
		}
		const last = this.#entries.get(key);
		if (!last) throw new Error('visibility set could not be settled');
		return last;
	}

	async #recompute(actor: AccessActor & { role: WorkspaceRole | 'anonymous' }, key: string, entry: Entry | undefined): Promise<void> {
		if (!entry) {
			// A commit between the read and the insert would be missed (the entry was not there to mark): read again.
			for (let attempt = 0; attempt < 3; attempt++) {
				const epoch = this.#epoch;
				const facts = this.facts(actor);
				const levels = await this.#fresh(actor, facts);
				if (epoch !== this.#epoch && attempt < 2) continue;
				this.#entries.set(key, { key, actor, facts, levels, bits: bitsOf(levels), dirty: null, rev: ++this.#revs, staleFacts: false, delta: new Map(), used: ++this.#clock });
				this.#evict();
				return;
			}
			return;
		}
		if (entry.staleFacts) {
			this.#facts.delete(key);
			entry.facts = this.facts(actor);
			entry.staleFacts = false;
		}
		const dirty = entry.dirty;
		entry.dirty = null;
		const before = entry.levels;
		if (dirty === 'full' || dirty === null || dirty.size > MAX_SUBTREE) {
			const after = await this.#fresh(actor, entry.facts);
			for (const [num, rank] of after) if (before.get(num) !== rank) entry.delta.set(num, { before: before.get(num) ?? NONE, after: rank });
			for (const [num, rank] of before) if (!after.has(num)) entry.delta.set(num, { before: rank, after: NONE });
			entry.levels = after;
			entry.bits = bitsOf(after);
		} else {
			const nums = [...dirty];
			const fresh = await this.#subtree(entry, nums);
			// Changed in place (the dirty pages only): a copy of a 50,000-page map per connected actor per commit was
			// the cost of every page create. The live loop takes its `view` after this settles.
			const bits = entry.bits ? entry.bits.clone() : null;
			for (const num of nums) {
				const was = before.get(num) ?? NONE;
				const now = fresh.get(num) ?? NONE;
				if (now === NONE) {
					before.delete(num);
					bits?.delete(num);
				} else {
					before.set(num, now);
					bits?.add(num);
				}
				if (was !== now) entry.delta.set(num, { before: was, after: now });
			}
			entry.bits = bits;
		}
		entry.rev = ++this.#revs;
		entry.used = ++this.#clock;
	}

	#evict(): void {
		if (this.#entries.size <= MAX_ENTRIES) return;
		let oldest: Entry | undefined;
		for (const e of this.#entries.values()) if (!oldest || e.used < oldest.used) oldest = e;
		if (oldest) this.#entries.delete(oldest.key);
	}

	/** The actor's visibility set, up to date. `null` when the actor holds no membership at all. */
	async visibleNums(actor: AccessActor): Promise<Set<number> | null> {
		const entry = await this.#visible(actor);
		if (!entry) return null;
		return new Set(entry.levels.keys());
	}

	async #visible(actor: AccessActor): Promise<Entry | null> {
		const resolved = this.resolve(actor);
		return resolved ? this.#settleEntry(resolved) : null;
	}

	/** Levels of the pages in `nums` the actor can see (num -> level), for callers that need `$access`. */
	async levelsOf(actor: AccessActor): Promise<{ get(num: number): AccessLevel | undefined } | null> {
		const entry = await this.#visible(actor);
		if (!entry) return null;
		const { levels } = entry;
		// A lookup into the set itself (the callers ask about the few rows of a window), not a copy of 50,000 entries.
		return { get: (num) => (levels.has(num) ? ACCESS_LEVELS[levels.get(num) as number] : undefined) };
	}

	/** The actor's visible pages as a copy-free `Set`-shaped view, for the query engine (null: no membership). */
	async visibleSetOf(actor: AccessActor): Promise<ReadonlySet<number> | null> {
		const entry = await this.#visible(actor);
		return entry ? entry.levels.asSet() : null;
	}

	/** Makes sure an actor's entry exists and is current (sockets call this before the sync paths run). */
	async ensure(actor: AccessActor): Promise<void> {
		await this.#visible(actor);
	}

	/** Whether the actor currently has a cached entry (tests, diagnostics). */
	cached(actor: AccessActor): boolean {
		const resolved = this.resolve(actor);
		return !!resolved && this.#entries.has(actorKey(resolved));
	}

	/** Synchronous view for the live loop. Fails closed: no entry means nothing is visible. */
	view(actor: AccessActor): VisibilityView {
		const resolved = this.resolve(actor);
		const entry = resolved ? this.#entry(resolved) : undefined;
		if (!entry) return NOTHING;
		const { levels, delta, bits, rev } = entry;
		return {
			bits,
			rev,
			has: (num) => levels.has(num),
			hadBefore: (num) => {
				const d = delta.get(num);
				return d ? d.before !== NONE : levels.has(num);
			},
			level: (num) => ACCESS_LEVELS[levels.get(num) ?? 0]!,
			levelBefore: (num) => {
				const d = delta.get(num);
				const rank = d ? d.before : (levels.get(num) ?? NONE);
				return rank === NONE ? null : ACCESS_LEVELS[rank]!;
			},
			delta
		};
	}

	// ───────────────────────── invalidation ─────────────────────────

	/** Marks everything a member's change affects (a `syncMember`): their entry and facts are rebuilt. */
	noteMember(userId: string): void {
		this.#facts.clear();
		// A role change gives the user another actor key: the old entries are dropped, the new ones start cold
		// (their sockets reconnect, see `syncMember`).
		for (const [key, e] of this.#entries) if (e.actor.userId === userId) this.#entries.delete(key);
	}

	#rebuild(e: Entry): void {
		e.dirty = 'full';
		e.staleFacts = true;
	}

	#dirtyPages(nums: readonly number[], matches: (e: Entry) => boolean = () => true): void {
		for (const e of this.#entries.values()) {
			if (!matches(e) || e.dirty === 'full') continue;
			const set = e.dirty ?? (e.dirty = new Set());
			for (const n of nums) set.add(n);
			if (set.size > MAX_SUBTREE) e.dirty = 'full';
		}
	}

	#numsOf(ids: readonly string[]): number[] {
		const out: number[] = [];
		for (const part of chunks(ids, 90)) {
			for (const r of this.#sql.exec<{ num: number }>(`SELECT num FROM page WHERE id IN (${qmarks(part.length)})`, ...part).toArray()) out.push(r.num);
		}
		return out;
	}

	#subtreeNums(roots: readonly string[]): number[] {
		const out = new Set<number>();
		for (const root of roots) {
			for (const r of this.#sql
				.exec<{ num: number }>(
					`WITH RECURSIVE sub(id) AS (SELECT id FROM page WHERE id = ? UNION ALL SELECT p.id FROM page p JOIN sub ON p.parent_id = sub.id)
					 SELECT page.num AS num FROM page JOIN sub ON page.id = sub.id`,
					root
				)
				.toArray())
				out.add(r.num);
		}
		return [...out];
	}

	/**
	 * Called with a commit's change rows, before the live loop fans them out: forgets stale deltas, marks
	 * what the commit invalidates, and says whether it can change anyone's access (rooms, resyncs).
	 */
	noteCommit(rows: readonly LogRow[]): CommitAccess {
		this.#epoch++;
		for (const e of this.#entries.values()) e.delta.clear();
		let affecting = false;
		let everything = false;
		const roots = new Set<string>();
		const teamspaces = new Set<string>();
		const structural: string[] = [];
		const created: string[] = [];
		for (const row of rows) {
			const oldV = asRecord(row.old);
			const newV = asRecord(row.new);
			switch (row.kind) {
				case 'create':
					if (row.page) created.push(row.page);
					break;
				case 'move':
				case 'trash':
				case 'restore':
					if (row.page) {
						structural.push(row.page);
						roots.add(row.page);
					}
					affecting = true;
					break;
				case 'grant.set':
				case 'grant.revoke': {
					affecting = true;
					if (row.page) roots.add(row.page);
					const key = (newV.subjectKey ?? oldV.subjectKey) as string | undefined;
					if (row.page) {
						const nums = this.#subtreeNums([row.page]);
						this.#dirtyPages(nums, (e) => !key || e.facts.subjects.includes(key));
					}
					break;
				}
				case 'teamspace.member': {
					affecting = true;
					if (row.prop) teamspaces.add(row.prop);
					this.#facts.clear();
					const userId = (newV.userId ?? oldV.userId) as string | undefined;
					for (const e of this.#entries.values()) if (!userId || e.actor.userId === userId) this.#rebuild(e);
					break;
				}
				case 'teamspace.update':
					if ('defaultLevel' in newV) {
						affecting = true;
						if (row.prop) teamspaces.add(row.prop);
						this.#facts.clear();
						for (const e of this.#entries.values()) this.#rebuild(e);
					}
					break;
				case 'teamspace.create':
					// The creator is its first owner: their facts (and so their set) change.
					this.#facts.clear();
					for (const e of this.#entries.values()) if (e.actor.userId === row.actor) this.#rebuild(e);
					break;
				case 'archiveTeamspace':
				case 'restoreTeamspace':
					affecting = true;
					if (row.prop) teamspaces.add(row.prop);
					this.#facts.clear();
					for (const e of this.#entries.values()) this.#rebuild(e);
					break;
				case 'member.sync':
					this.#roles.clear();
					affecting = true;
					everything = true;
					if (row.prop) this.noteMember(row.prop);
					break;
			}
		}
		if (structural.length > 0 || created.length > 0) {
			const nums = [...this.#subtreeNums(structural), ...this.#numsOf(created)];
			this.#dirtyPages(nums);
		}
		return { affecting, roots: [...roots], teamspaces: [...teamspaces], everything };
	}

	/**
	 * Brings the entries of the given actors up to date (the connected sockets' actors, before a fan-out).
	 * Returns the keys of actors that had no entry: their sockets cannot be diffed, only resynced.
	 */
	async settle(actors: readonly AccessActor[]): Promise<{ cold: Set<string> }> {
		const cold = new Set<string>();
		const seen = new Set<string>();
		for (const actor of actors) {
			const resolved = this.resolve(actor);
			if (!resolved) continue;
			const key = actorKey(resolved);
			if (seen.has(key)) continue;
			seen.add(key);
			if (!this.#entries.has(key)) cold.add(key);
			await this.#settleEntry(resolved);
		}
		return { cold };
	}

	/** Drops the per-commit deltas (after the fan-out). */
	clearDeltas(): void {
		for (const e of this.#entries.values()) e.delta.clear();
	}

	/** Entries holding a delta: who changed, for the room sync. */
	changedActors(): { actor: AccessActor & { role: WorkspaceRole | 'anonymous' }; delta: ReadonlyMap<number, PageDelta> }[] {
		return [...this.#entries.values()].filter((e) => e.delta.size > 0).map((e) => ({ actor: e.actor, delta: e.delta }));
	}

	/** Forgets everything (tests, a failed fan-out). */
	reset(): void {
		this.#entries.clear();
		this.#facts.clear();
		this.#roles.clear();
	}
}

/** A bitmap of the visible pages, or null when roaring is not loaded. */
function bitsOf(levels: LevelMap): Bitmap | null {
	if (!roaringReady()) return null;
	const bits = createBitmap(levels.keys());
	bits.optimize();
	return bits;
}

/** The highest level a `$access` object grants. */
export function levelOfAccess(access: Record<string, boolean>): AccessLevel | null {
	for (let i = ACCESS_LEVELS.length - 1; i >= 0; i--) if (access[ACCESS_LEVELS[i]!] === true) return ACCESS_LEVELS[i]!;
	return null;
}

function rankOfAccess(access: Record<string, boolean>): number {
	const level = levelOfAccess(access);
	return level ? levelRank(level) : 0; // a page the actor can read holds at least `read`
}
