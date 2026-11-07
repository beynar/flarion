/**
 * The live-update fuzz (docs/PLAN.md "Testing": "apply random writes and assert every subscription window equals a
 * fresh run of its query, with faults injected between steps").
 *
 * A seed builds a workspace in a real Workspace Durable Object (several actors with different visibility, a
 * database with a collection, saved views, random pages) and opens sockets whose subscriptions are random views
 * (filters, sorts, groupings, windows). Then, for N steps, it applies a random write (values, options, moves,
 * create, trash, restore, grants, property and view definitions, bulk batches, batches that fail) or injects a
 * fault (a socket drop and a reconnect from its `seq`, hibernation through `evictDurableObject`, a window that
 * grows). After EVERY step each window every connected client holds, rebuilt by applying the diffs it received,
 * must equal what `queryView` (the engine's `runQuery`, ANDed with the actor's visibility set) answers now.
 */
import { evictDurableObject } from 'cloudflare:test';
import { vi } from 'vitest';
import { andFilters, GROUP_EMPTY, validateFilter, type FilterGroup, type FilterNode, type GroupBySpec, type SortSpec } from '../../../src/lib/shared/filter-ast';
import type { Op } from '../../../src/lib/shared/ops';
import { createRegistry, type PropertyDef } from '../../../src/lib/shared/property-types';
import type { ServerMessage, Subscription } from '../../../src/lib/shared/protocol';
import { rankAfter } from '../../../src/lib/shared/sort-keys';
import type { Actor } from '../../../src/server/auth/session';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { rng, type Rng } from '../../unit/shared/helpers';
import { connect, type Connection } from '../socket/helpers';
import { actorOf, batch, createWorkspace, inside, type Fixture } from '../workspace/helpers';
import { SocketModel, type ModelRow } from './model';

// ───────────────────────────── the world ─────────────────────────────

const opt = (id: string) => ({ id, name: id.toUpperCase(), color: 'default' as const });
const optionIds = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

const DEFS: PropertyDef[] = [
	{ id: 'amount', name: 'Amount', type: 'number', config: { format: 'number' } },
	{ id: 'notes', name: 'Notes', type: 'text', config: {} },
	{ id: 'prio', name: 'Priority', type: 'select', config: { options: optionIds('p', 4).map(opt) } },
	{ id: 'tags', name: 'Tags', type: 'multi_select', config: { options: optionIds('t', 4).map(opt) } },
	{ id: 'done', name: 'Done', type: 'checkbox', config: {} },
	{ id: 'due', name: 'Due', type: 'date', config: { includeTime: false } },
	{ id: 'who', name: 'Who', type: 'person', config: {} },
	{ id: 'edited', name: 'Edited', type: 'last_edited_time', config: {} },
	{ id: 'created', name: 'Created', type: 'created_time', config: {} },
	{ id: 'size', name: 'Size', type: 'formula', config: { expression: 'prop("Amount") * 2', resultType: 'number' } }
];
const registry = createRegistry([{ id: 'title', name: 'Title', type: 'title', config: {} }, ...DEFS]);

const USERS = ['owner-1', 'u1', 'u2', 'g1'] as const;
const ROLES: Record<string, Actor['role']> = { 'owner-1': 'owner', u1: 'member', u2: 'member', g1: 'guest' };
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'plan', 'bug', 'launch', 'review', 'Épsilon', 'zeta'];
const dev = (user: string) => ({ 'x-flarion-dev-actor': user, 'x-flarion-dev-role': ROLES[user] });

export interface SubSpec {
	id: string;
	sub: Extract<Subscription, { kind: 'view' }>;
	/** Per-group sizes the client asked for after the subscription (a reconnect forgets them). */
	groupLimits: Record<string, number>;
}

const text = (r: Rng) => `${r.pick(WORDS)} ${r.pick(WORDS)}`;
const day = (r: Rng) => `2026-0${r.int(1, 3)}-${String(r.int(1, 28)).padStart(2, '0')}`;

function randomValue(r: Rng, prop: string): unknown {
	switch (prop) {
		case 'amount':
			return r.pick([0, 1, 2, 3, 5, 8, 13, 21, 50, 100]);
		case 'notes':
			return text(r);
		case 'prio':
			return r.pick(optionIds('p', 4));
		case 'tags':
			return optionIds('t', 4).filter(() => r.bool(0.4));
		case 'done':
			return r.bool();
		case 'due':
			return { start: day(r) };
		case 'who':
			return ['owner-1', 'u1', 'u2'].filter(() => r.bool(0.4));
		default:
			return text(r);
	}
}
const VALUE_PROPS = ['amount', 'notes', 'prio', 'tags', 'done', 'due', 'who', 'title'] as const;

function randomCondition(r: Rng, dbId: string): FilterNode {
	switch (r.pick(['amount', 'notes', 'prio', 'tags', 'done', 'due', 'who', 'title', '$parent', 'size'] as const)) {
		case 'amount':
			return { prop: 'amount', op: r.pick(['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const), value: r.pick([0, 3, 8, 20, 50]) };
		case 'size':
			return { prop: 'size', op: r.pick(['gt', 'lt'] as const), value: r.pick([2, 10, 40]) };
		case 'notes':
			return r.bool(0.8) ? { prop: 'notes', op: 'contains', value: r.pick(['a', 'e', 'plan', 'bug', 'z']) } : { prop: 'notes', op: r.pick(['is_empty', 'is_not_empty'] as const) };
		case 'title':
			return { prop: 'title', op: 'contains', value: r.pick(['a', 'e', 'n', 'plan']) };
		case 'prio':
			return r.bool(0.85) ? { prop: 'prio', op: r.pick(['is', 'is_not'] as const), value: r.pick(optionIds('p', 4)) } : { prop: 'prio', op: r.pick(['is_empty', 'is_not_empty'] as const) };
		case 'tags':
			return { prop: 'tags', op: r.pick(['contains', 'not_contains'] as const), value: r.pick(optionIds('t', 4)) };
		case 'done':
			return { prop: 'done', op: 'is', value: r.bool() };
		case 'due':
			return r.bool(0.8) ? { prop: 'due', op: r.pick(['before', 'after', 'is'] as const), value: { kind: 'exact', date: day(r) } } : { prop: 'due', op: r.pick(['is_empty', 'is_not_empty'] as const) };
		case 'who':
			return r.bool(0.8) ? { prop: 'who', op: r.pick(['contains', 'not_contains'] as const), value: r.pick(['owner-1', 'u1', 'u2']) } : { prop: 'who', op: 'is_empty' };
		default:
			return { prop: '$parent', op: r.pick(['is', 'is_not'] as const), value: dbId };
	}
}

function randomFilter(r: Rng, dbId: string): FilterGroup | undefined {
	if (r.bool(0.25)) return undefined;
	for (let i = 0; i < 20; i++) {
		const n = r.int(1, 3);
		const nodes: FilterNode[] = Array.from({ length: n }, () => (r.bool(0.2) ? ({ [r.pick(['and', 'or'] as const)]: [randomCondition(r, dbId), randomCondition(r, dbId)] } as FilterGroup) : randomCondition(r, dbId)));
		const group = { [r.pick(['and', 'or'] as const)]: nodes } as FilterGroup;
		if (validateFilter(group, registry).ok) return group;
	}
	return undefined;
}

function randomSorts(r: Rng): SortSpec[] | undefined {
	if (r.bool(0.2)) return undefined;
	const pool = ['title', 'amount', 'notes', 'prio', 'tags', 'done', 'due', 'edited', 'created', 'size'];
	const out: SortSpec[] = [];
	for (let i = r.pick([0, 1, 1, 2]); i > 0; i--) {
		const prop = r.pick(pool);
		if (!out.some((s) => s.prop === prop)) out.push({ prop, dir: r.pick(['asc', 'desc'] as const), ...(r.bool(0.3) ? { nulls: r.pick(['first', 'last'] as const) } : {}) });
	}
	return out;
}

function randomGroupBy(r: Rng): GroupBySpec | null | undefined {
	if (r.bool(0.45)) return undefined;
	if (r.bool(0.15)) return null;
	const prop = r.pick(['prio', 'tags', 'done', 'who', 'due']);
	return { prop, ...(r.bool(0.3) ? { sort: r.pick(['manual', 'asc', 'desc'] as const) } : {}), ...(r.bool(0.25) ? { hideEmpty: true } : {}), ...(prop === 'due' ? { bucket: 'month' as const } : {}) };
}

// ───────────────────────────── clients ─────────────────────────────

let firstPumpError: string | undefined;

class Client {
	conn!: Connection;
	cursor = 0;
	readonly model = new SocketModel();
	connected = false;
	subs: SubSpec[] = [];
	constructor(
		readonly user: string,
		readonly ws: Fixture
	) {}
	get actor(): Actor {
		return actorOf(this.ws.id, this.user, ROLES[this.user]);
	}

	async open(lastSeq: number | null): Promise<void> {
		this.conn = await connect(this.ws.id, dev(this.user));
		this.cursor = 0;
		this.connected = true;
		if (lastSeq === null) this.model.lastSeq = 0;
		this.conn.rawHello({ lastSeq, subs: this.subs.map((s) => ({ id: s.id, sub: s.sub })) });
		await this.conn.log.wait((m) => m.t === 'head');
		this.pump();
	}

	pump(): void {
		try {
			this.cursor = this.model.follow(this.conn.log.messages, this.cursor);
		} catch (error) {
			// The first failure is the finding; retries after it only repeat a half-applied frame.
			firstPumpError ??= `${this.user}: ${error instanceof Error ? error.message : String(error)}`;
			throw error;
		}
	}

	async reached(seq: number): Promise<void> {
		await vi.waitFor(
			() => {
				this.pump();
				if (this.model.lastSeq < seq) throw new Error(`socket of ${this.user} is at ${this.model.lastSeq}, not ${seq}`);
			},
			{ timeout: 4000, interval: 5 }
		);
		// A window that changed shape gets its snapshot right after the commit's frame: wait for the socket to go quiet.
		for (let i = 0; i < 20; i++) {
			const n = this.conn.log.messages.length;
			await new Promise((res) => setTimeout(res, 4));
			if (this.conn.log.messages.length === n) break;
		}
		this.pump();
	}
}

// ───────────────────────────── the run ─────────────────────────────

export interface FuzzOptions {
	steps?: number;
	pages?: number;
	subsPerSocket?: number;
}

export interface FuzzStats {
	steps: number;
	checks: number;
	ops: Record<string, number>;
	reconnects: number;
	replays: number;
	evictions: number;
	failedBatches: number;
	windowOps: number;
}

export class FuzzFailure extends Error {}

interface PageState {
	id: string;
	deleted: boolean;
	root: string | null;
	parent: string | null;
	teamspace: string | null;
}

export async function runFuzz(seed: number, options: FuzzOptions = {}): Promise<FuzzStats> {
	firstPumpError = undefined;
	const r = rng(seed);
	const steps = options.steps ?? 70;
	const ws = await createWorkspace(`fz${seed}`);
	const owner = ws.owner;
	const stub = ws.stub;
	const trace: string[] = [];
	const stats: FuzzStats = { steps: 0, checks: 0, ops: {}, reconnects: 0, replays: 0, evictions: 0, failedBatches: 0, windowOps: 0 };
	const note = (line: string) => {
		trace.push(line);
		if (trace.length > 60) trace.shift();
	};
	const count = (key: string) => (stats.ops[key] = (stats.ops[key] ?? 0) + 1);

	let step = -1;
	const fail = (message: string): never => {
		throw new FuzzFailure(`live-update fuzz failed\n  seed: ${seed}, step: ${step}\n  ${message}\n  last steps:\n    ${trace.join('\n    ')}`);
	};

	// People: a member in a private teamspace with the owner, a member outside it, a guest.
	for (const u of ['u1', 'u2']) await stub.syncMember({ userId: u, role: 'member', name: u });
	await stub.syncMember({ userId: 'g1', role: 'guest', name: 'g1' });
	const secret = await stub.createTeamspace(owner, { name: 'Secret', icon: null, privacy: 'private', defaultLevel: 'update' });
	await stub.addTeamspaceMember(owner, { teamspaceId: secret.id, userId: 'u1' });

	// Properties, the database page and its collection.
	let rank = rankAfter(null);
	const nextRank = () => (rank = rankAfter(rank));
	const dbId = 'db';
	const collectionKinds = r.pick(['parent', 'parent', 'open', 'hand'] as const);
	const source: FilterGroup | null =
		collectionKinds === 'parent' ? { and: [{ prop: '$parent', op: 'is', value: dbId }] } : collectionKinds === 'open' ? { or: [{ prop: '$parent', op: 'is', value: dbId }, { prop: 'prio', op: 'is', value: 'p1' }] } : null;
	await stub.apply(owner, batch(DEFS.map((property) => ({ op: 'createProperty', property }) as Op)));
	await stub.apply(owner, batch([{ op: 'create', id: dbId, parentId: null, rank: nextRank(), teamspaceId: ws.generalId, isDatabase: true, values: { title: 'DB' } } as Op, { op: 'createCollection', id: 'c1', pageId: dbId, ...(source ? { sourceAst: source } : {}) } as Op]));
	const viewIds: string[] = [];
	const viewOps: Op[] = [];
	for (let i = 0; i < 3; i++) {
		const groupBy = randomGroupBy(r);
		const filter = randomFilter(r, dbId);
		const sorts = randomSorts(r);
		viewIds.push(`v${i}`);
		viewOps.push({ op: 'createView', id: `v${i}`, collectionId: 'c1', type: i === 1 ? 'board' : 'table', name: `View ${i}`, ...(filter ? { filter } : {}), ...(sorts ? { sorts } : {}), ...(groupBy ? { groupBy } : {}), rank: nextRank() } as Op);
	}
	await stub.apply(owner, batch(viewOps));

	// Pages: under the database, at the root of either teamspace, or nested.
	const ids: string[] = [];
	let counter = 0;
	const createPageOp = (parent: string | null, teamspace?: string): Op => {
		const id = `n${++counter}`;
		const values: Record<string, unknown> = { title: text(r) };
		for (const p of VALUE_PROPS) if (p !== 'title' && r.bool(0.55)) values[p] = randomValue(r, p);
		ids.push(id);
		return { op: 'create', id, parentId: parent, rank: nextRank(), ...(parent === null ? { teamspaceId: teamspace ?? ws.generalId } : {}), values } as Op;
	};
	const initial: Op[] = [];
	for (let i = 0; i < (options.pages ?? 36); i++) {
		const pick = r.next();
		initial.push(createPageOp(pick < 0.55 ? dbId : pick < 0.8 ? null : pick < 0.9 ? null : ids.length ? r.pick(ids) : null, pick >= 0.8 && pick < 0.9 ? secret.id : undefined));
	}
	await stub.apply(owner, batch(initial));
	// Some pages belong to a collection by hand (only meaningful for a hand-picked collection, harmless otherwise).
	if (collectionKinds === 'hand') await stub.apply(owner, batch(ids.slice(0, 20).map((id) => ({ op: 'addMember', collection: 'c1', page: id, rank: nextRank() }) as Op)));
	// A guest sees what is shared with them.
	const grants = new Map<string, string>();
	const share = async (user: string, page: string, level: 'read' | 'update' | 'full') => {
		const g = await stub.setGrant(owner, { pageId: page, subjectKind: 'user', subjectId: user, level });
		grants.set(`${user}:${page}`, g.id);
	};
	for (const id of ids.filter(() => r.bool(0.2))) await share('g1', id, 'read');
	await share('g1', dbId, 'read');

	// Sockets and subscriptions: every actor, one or two sockets, random views.
	const clients: Client[] = [];
	const randomSub = (id: string): SubSpec => {
		const viewId = r.bool(0.4) ? r.pick(viewIds) : undefined;
		const filter = r.bool(0.5) ? randomFilter(r, dbId) : undefined;
		const sorts = r.bool(0.5) ? randomSorts(r) : undefined;
		const groupBy = r.bool(0.5) ? randomGroupBy(r) : undefined;
		return {
			id,
			groupLimits: {},
			sub: {
				kind: 'view',
				collectionId: 'c1',
				...(viewId ? { viewId } : {}),
				...(filter ? { filter } : {}),
				...(sorts ? { sorts } : {}),
				...(groupBy !== undefined ? { groupBy } : {}),
				...(r.bool(0.25) ? { props: ['title', 'amount', 'prio', 'done'] } : {}),
				limit: r.pick([2, 3, 5, 8, 20])
			}
		};
	};
	for (const user of USERS) {
		for (let k = 0; k < (user === 'owner-1' ? 2 : 1); k++) {
			const c = new Client(user, ws);
			for (let i = 0; i < (options.subsPerSocket ?? 6); i++) c.subs.push(randomSub(`s${i}`));
			await c.open(null);
			clients.push(c);
		}
	}

	// ── invariant ──
	const checkAll = async (where: string): Promise<void> => {
		for (const c of clients) {
			if (!c.connected) continue;
			c.pump();
			for (const s of c.subs) {
				stats.checks++;
				const w = c.model.windows.get(s.id);
				if (!w) fail(`${where}: ${c.user} has no window for ${s.id}`);
				const problem = await compareWindow(stub, c.actor, s, w!);
				if (problem) {
					const live = await stub.liveStats();
					const views = JSON.stringify((await stub.readViews(owner, 'c1')).map((v) => ({ id: v.id, filter: v.filter, sorts: v.sorts, groupBy: v.groupBy })));
					note(`views now: ${views}`);
					if (live.stale.length) {
						const dump = await inside(stub, (sql) => ({
							unit: sql.exec<{ ids: string }>('SELECT ids FROM sub_unit WHERE unit_key = ?', live.stale[0]).toArray()[0]?.ids.slice(0, 600),
							pages: sql.exec('SELECT id, rank, created_at, updated_at, json_extract(props_json, \'$.prio\') AS prio, json_extract(props_json, \'$.amount\') AS amount FROM page WHERE id IN (\'n14\', \'n20\', \'n6\', \'n5\')').toArray()
						}));
						note(`unit ${JSON.stringify(dump)}`);
					}
					fail(`${where}: ${c.user}/${s.id}: ${problem}\n  sub: ${JSON.stringify(s.sub)}\n  group limits: ${JSON.stringify(s.groupLimits)}\n  units out of date after the commit: ${live.stale.length ? live.stale.join(', ') : 'none (the unit is right, the diff is wrong)'}`);
				}
			}
			if (c.model.errors.length) fail(`${where}: ${c.user} received errors ${JSON.stringify(c.model.errors)}`);
		}
	};
	await checkAll('initial snapshots');

	const pagesNow = (): Promise<PageState[]> =>
		inside(stub, (sql) =>
			sql
				.exec<{ id: string; deleted_at: string | null; trash_root: string | null; parent_id: string | null; teamspace_id: string | null }>('SELECT id, deleted_at, trash_root, parent_id, teamspace_id FROM page ORDER BY num')
				.toArray()
				.map((p) => ({ id: p.id, deleted: !!p.deleted_at, root: p.trash_root, parent: p.parent_id, teamspace: p.teamspace_id }))
		);

	const settle = async (seq: number): Promise<void> => {
		for (const c of clients) if (c.connected) await c.reached(seq);
	};

	const runOps = async (label: string, ops: Op[], actor: Actor = owner): Promise<boolean> => {
		note(`${label} by ${actor.userId}: ${JSON.stringify(ops).slice(0, 400)}`);
		try {
			const { seq } = await stub.apply(actor, batch(ops));
			await settle(seq);
			return true;
		} catch (error) {
			const decoded = decodeWorkspaceError(error);
			if (!decoded) throw error;
			stats.failedBatches++;
			note(`  refused: ${decoded.code} ${decoded.message}`);
			return false;
		}
	};

	// ── one random write ──
	const randomWrite = async (pages: PageState[]): Promise<{ label: string; ops: Op[]; actor: Actor }> => {
		const live = pages.filter((p) => !p.deleted).map((p) => p.id);
		const rows = live.filter((id) => id !== dbId);
		const roots = pages.filter((p) => p.deleted && p.root === p.id).map((p) => p.id);
		const pick = (list: string[]) => (list.length ? r.pick(list) : null);
		const actor = r.bool(0.9) ? owner : actorOf(ws.id, 'u1', 'member');
		let inBulk = false;
		const one = (): { label: string; ops: Op[] } => {
			const roll = r.next();
			if (roll < 0.34) {
				const page = pick(rows);
				const prop = r.pick(VALUE_PROPS);
				return { label: 'setProp', ops: page ? [{ op: 'setProp', page, prop, value: r.bool(0.12) ? null : randomValue(r, prop) } as Op] : [] };
			}
			if (roll < 0.44) {
				const page = pick(rows);
				const add = r.bool();
				const prop = r.pick(['tags', 'who']);
				const option = prop === 'tags' ? r.pick(optionIds('t', 4)) : r.pick(['owner-1', 'u1', 'u2']);
				return { label: add ? 'addOption' : 'removeOption', ops: page ? [{ op: add ? 'addOption' : 'removeOption', page, prop, option } as Op] : [] };
			}
			if (roll < 0.56) {
				const parent = r.bool(0.6) ? dbId : r.bool(0.5) ? null : pick(live);
				return { label: 'create', ops: [createPageOp(parent, parent === null && r.bool(0.2) ? secret.id : undefined)] };
			}
			if (roll < 0.66) {
				const page = pick(rows);
				return { label: 'trash', ops: page ? [{ op: 'trash', page }] : [] };
			}
			if (roll < 0.74) {
				const page = pick(roots);
				return { label: 'restore', ops: page ? [{ op: 'restore', page }] : [] };
			}
			if (roll < 0.84) {
				const page = pick(rows);
				const state = pages.find((p) => p.id === page);
				const parent = r.bool(0.5) ? dbId : r.bool(0.4) ? null : pick(live);
				if (!page || !state) return { label: 'move', ops: [] };
				return { label: 'move', ops: [{ op: 'move', page, parentId: parent, rank: nextRank(), ...(parent === null ? { teamspaceId: state.teamspace } : {}) } as Op] };
			}
			if (roll < 0.9) {
				const page = pick(rows);
				return { label: 'setPage', ops: page ? [{ op: 'setPage', page, icon: r.pick(['🚀', '⭐', null]) } as Op] : [] };
			}
			// A batch that fails after a valid op: refused, rolled back (never inside a bulk batch).
			if (inBulk) return { label: 'bad', ops: [] };
			return { label: 'bad', ops: [{ op: 'setProp', page: pick(rows) ?? dbId, prop: 'amount', value: 1 } as Op, { op: 'setProp', page: 'ghost-page', prop: 'amount', value: 2 } as Op] };
		};
		if (r.bool(0.25)) {
			// A bulk batch: several writes, one commit, one message per socket.
			const ops: Op[] = [];
			const parts: string[] = [];
			inBulk = true;
			for (let i = r.int(3, 9); i > 0; i--) {
				const w = one();
				ops.push(...w.ops);
				parts.push(w.label);
			}
			return { label: `bulk(${parts.join(',')})`, ops, actor };
		}
		const w = one();
		return { ...w, actor };
	};

	const guestsGrant = async () => {
		const pages = (await pagesNow()).filter((p) => !p.deleted).map((p) => p.id);
		const user = r.pick(['g1', 'u2', 'u1']);
		const page = r.pick(pages.filter((id) => id !== dbId));
		const key = `${user}:${page}`;
		const existing = grants.get(key);
		note(`grant ${existing && r.bool(0.5) ? 'revoke' : 'set'} ${key}`);
		if (existing && r.bool(0.5)) {
			grants.delete(key);
			return stub.revokeGrant(owner, existing);
		}
		const g = await stub.setGrant(owner, { pageId: page, subjectKind: 'user', subjectId: user, level: r.pick(['read', 'update', 'full'] as const) });
		grants.set(key, g.id);
		return { seq: (await stub.liveStats()).head };
	};

	const dropped: { client: Client; at: number }[] = [];

	try {
	for (step = 0; step < steps; step++) {
		stats.steps++;
		const roll = r.next();
		if (roll < 0.62) {
			count('write');
			const w = await randomWrite(await pagesNow());
			count(w.label.startsWith('bulk') ? 'bulk' : w.label);
			if (w.ops.length === 0) continue;
			await runOps(w.label, w.ops, w.actor);
		} else if (roll < 0.68) {
			count('grant');
			const { seq } = await guestsGrant();
			await settle(seq);
		} else if (roll < 0.72) {
			count('definition');
			if (r.bool(0.5)) {
				// Options of a select are edited: reordered, renamed, one removed or added (group order, sort order).
				const ids2 = r.shuffle(optionIds('p', 4)).slice(0, r.int(2, 4));
				if (r.bool(0.4)) ids2.push('p9');
				await runOps('updateProperty prio', [{ op: 'updateProperty', id: 'prio', config: { options: ids2.map(opt) } } as Op]);
			} else {
				const id = r.pick(viewIds);
				const groupBy = randomGroupBy(r);
				const sorts = randomSorts(r);
				const filter = randomFilter(r, dbId);
				await runOps(`updateView ${id}`, [{ op: 'updateView', id, ...(filter ? { filter } : {}), ...(sorts ? { sorts } : {}), ...(groupBy !== undefined ? { groupBy } : {}) } as Op]);
			}
		} else if (roll < 0.77) {
			// A window grows (or shrinks), the whole view or one group of it.
			count('window');
			stats.windowOps++;
			const open = clients.filter((c) => c.connected);
			const c = r.pick(open);
			const s = r.pick(c.subs);
			const w = c.model.windows.get(s.id);
			const limit = r.pick([1, 2, 4, 9, 30]);
			const group = w?.groups && w.groups.length && r.bool(0.6) ? r.pick(w.groups).key : undefined;
			note(`window ${c.user}/${s.id} limit=${limit}${group !== undefined ? ` group=${group}` : ''}`);
			c.conn.send({ t: 'window', id: s.id, limit, ...(group !== undefined ? { group } : {}) });
			if (group !== undefined) s.groupLimits[group] = limit;
			else {
				s.sub = { ...s.sub, limit };
				s.groupLimits = {};
			}
			await new Promise((res) => setTimeout(res, 25));
			await vi.waitFor(async () => {
				c.pump();
				const probe = await compareWindow(stub, c.actor, s, c.model.windows.get(s.id)!);
				if (probe) throw new Error(probe);
			}, { timeout: 3000, interval: 10 }).catch(() => undefined);
		} else if (roll < 0.83) {
			// A socket drops; writes continue; it comes back from its last seq (some steps later).
			const open = clients.filter((c) => c.connected);
			if (open.length > 2) {
				count('drop');
				const c = r.pick(open);
				note(`drop ${c.user}`);
				c.conn.ws.close(1000, 'drop');
				c.connected = false;
				dropped.push({ client: c, at: step + r.int(0, 3) });
			}
		} else if (roll < 0.88) {
			count('evict');
			stats.evictions++;
			note('evict the Workspace DO');
			await evictDurableObject(stub);
		} else {
			count('write');
			const w = await randomWrite(await pagesNow());
			count(w.label.startsWith('bulk') ? 'bulk' : w.label);
			if (w.ops.length > 0) await runOps(w.label, w.ops, w.actor);
		}

		// Reconnect what was dropped long enough ago, resuming from its last seq.
		for (const d of [...dropped]) {
			if (d.at > step) continue;
			dropped.splice(dropped.indexOf(d), 1);
			stats.reconnects++;
			// Its window sizes were forgotten with the connection: the client resubscribes with the base limit.
			for (const s of d.client.subs) s.groupLimits = {};
			note(`reconnect ${d.client.user} from seq ${d.client.model.lastSeq}`);
			await d.client.open(d.client.model.lastSeq);
			if (d.client.model.resumed === 'replay') stats.replays++;
			d.client.model.resumed = null;
		}
		await checkAll(`after step ${step}`);
	}
	} catch (error) {
		if (error instanceof FuzzFailure) throw error;
		fail(firstPumpError ?? `${error instanceof Error ? error.message : String(error)}`);
	}
	for (const d of dropped) {
		for (const s of d.client.subs) s.groupLimits = {};
		await d.client.open(d.client.model.lastSeq);
	}
	await checkAll('end');
	const live = await stub.liveStats();
	if (live.stale.length) fail(`stored units differ from a fresh evaluation: ${live.stale.join(', ')}`);
	for (const c of clients) if (c.connected) c.conn.ws.close();
	return stats;
}

// ───────────────────────────── comparison ─────────────────────────────

type Stub = Fixture['stub'];

/** The fresh answer for a subscription (what a one-shot `collection.query` of the same spec returns). */
async function freshOf(stub: Stub, actor: Actor, s: SubSpec) {
	const { sub } = s;
	const groupWindows = Object.fromEntries(Object.entries(s.groupLimits).map(([k, limit]) => [k, { offset: 0, limit }]));
	return stub.queryView(actor, {
		collectionId: sub.collectionId,
		...(sub.viewId ? { viewId: sub.viewId } : {}),
		spec: { ...(sub.filter ? { filter: sub.filter } : {}), ...(sub.sorts ? { sorts: sub.sorts } : {}), ...(sub.groupBy !== undefined ? { groupBy: sub.groupBy } : {}) },
		window: { offset: 0, limit: sub.limit },
		...(Object.keys(groupWindows).length ? { groupWindows } : {}),
		...(sub.props ? { props: sub.props } : {})
	});
}

const rowKey = (row: { title?: string; icon?: string | null; values?: Record<string, unknown>; access?: string }) =>
	JSON.stringify({ title: row.title, icon: row.icon ?? null, access: row.access ?? null, values: Object.fromEntries(Object.entries(row.values ?? {}).filter(([k, v]) => k !== 'title' && v !== null && v !== undefined).sort(([a], [b]) => a.localeCompare(b))) });

/** null when the window equals the fresh answer, else what differs. */
export async function compareWindow(stub: Stub, actor: Actor, s: SubSpec, w: import('./model').WindowModel): Promise<string | null> {
	let fresh;
	try {
		fresh = await freshOf(stub, actor, s);
	} catch (error) {
		return `the fresh query threw: ${error instanceof Error ? error.message : String(error)}`;
	}
	const diffRows = (held: Map<string, ModelRow>, ids: string[], want: { id: string; title: string; icon: string | null; values: Record<string, unknown>; access?: string }[]): string | null => {
		for (let i = 0; i < want.length; i++) {
			const mine = held.get(ids[i]);
			if (!mine) return `row ${ids[i]} is not held`;
			if (rowKey(mine) !== rowKey(want[i])) return `row ${want[i].id} differs:\n    window: ${rowKey(mine)}\n    fresh:  ${rowKey(want[i])}`;
		}
		return null;
	};
	if (fresh.groups) {
		if (!w.groups) return 'fresh query is grouped, the window is flat';
		const wantKeys = fresh.groups.map((g) => g.key);
		const haveKeys = w.groups.map((g) => g.key);
		if (JSON.stringify(wantKeys) !== JSON.stringify(haveKeys)) return `group keys ${JSON.stringify(haveKeys)} != fresh ${JSON.stringify(wantKeys)}`;
		if (w.total !== fresh.total) return `total ${w.total} != fresh ${fresh.total}`;
		for (const g of fresh.groups) {
			const mine = w.groups.find((x) => x.key === g.key)!;
			if (mine.total !== g.total) return `group ${g.key}: total ${mine.total} != fresh ${g.total}`;
			const wantIds = g.rows.map((x) => x.id);
			if (JSON.stringify(mine.ids) !== JSON.stringify(wantIds)) return `group ${g.key}: ids ${JSON.stringify(mine.ids)} != fresh ${JSON.stringify(wantIds)}`;
			const bad = diffRows(w.rows, mine.ids, g.rows);
			if (bad) return `group ${g.key}: ${bad}`;
		}
		return null;
	}
	if (w.groups) return 'fresh query is flat, the window is grouped';
	const wantIds = fresh.rows.map((x) => x.id);
	if (JSON.stringify(w.ids) !== JSON.stringify(wantIds)) return `ids ${JSON.stringify(w.ids)} != fresh ${JSON.stringify(wantIds)} (total ${w.total} vs ${fresh.total})`;
	if (w.total !== fresh.total) return `total ${w.total} != fresh ${fresh.total}`;
	return diffRows(w.rows, w.ids, fresh.rows);
}

export { andFilters, GROUP_EMPTY };
export type { ServerMessage };
