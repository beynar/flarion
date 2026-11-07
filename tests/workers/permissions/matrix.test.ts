/**
 * The permission matrix (docs/PLAN.md "Testing"): random trees, teamspaces (all three privacies and every
 * default level), memberships (owner, admin, member, guest) and grants (user, teamspace, workspace,
 * public), checked against the plain-TypeScript reference model in `model.ts` for owners, admins, members,
 * guests and anonymous visitors with and without a share token.
 *
 * Two parts:
 *  - STATIC: the state is written with raw SQL, then `can`, `pageAccess` and `visibleNums` are compared
 *    with the model for every actor and page.
 *  - INCREMENTAL: the visibility sets are hot in memory, then random grants, revokes, moves across
 *    teamspaces, teamspace memberships, role changes, removals, trashes and restores are applied through
 *    the Workspace DO's API, and after every step the (incrementally invalidated) sets and the access
 *    answers must equal a fresh evaluation of the model.
 */
import { describe, expect, test } from 'vitest';
import type { AccessActor, AccessLevel } from '../../../src/server/objects/workspace/access';
import { decodeWorkspaceError } from '../../../src/server/objects/workspace/errors';
import { actorOf, batch, inside, ranks } from '../workspace/helpers';
import { workspaceStub } from '../socket/helpers';
import { LEVELS, levelOf, subtreeOf, visibleSet, type Asker, type Model } from './model';
import { chance, generate, load, pick, prng, type Random } from './scenario';

type Stub = ReturnType<typeof workspaceStub>;

const levelName = (rank: number): AccessLevel | null => (rank < 0 ? null : LEVELS[rank]!);

interface Named {
	name: string;
	asker: Asker;
	actor: AccessActor;
}

/** Every kind of caller the matrix covers. Roles come from the model at the time of asking. */
function askers(model: Model): Named[] {
	const out: Named[] = [];
	for (const u of model.users.values()) out.push({ name: `${u.role} ${u.id}`, asker: { kind: 'user', id: u.id }, actor: { userId: u.id, role: u.role } });
	const live = model.grants.find((g) => g.kind === 'public' && !g.revoked);
	const revoked = model.grants.find((g) => g.kind === 'public' && g.revoked);
	out.push({ name: 'anonymous, no token', asker: { kind: 'anonymous' }, actor: { role: 'anonymous' } });
	out.push({ name: 'anonymous, wrong token', asker: { kind: 'anonymous', token: 'nope' }, actor: { role: 'anonymous', shareToken: 'nope' } });
	if (live?.token) out.push({ name: 'anonymous, public link', asker: { kind: 'anonymous', token: live.token }, actor: { role: 'anonymous', shareToken: live.token } });
	if (revoked?.token) out.push({ name: 'anonymous, revoked link', asker: { kind: 'anonymous', token: revoked.token }, actor: { role: 'anonymous', shareToken: revoked.token } });
	return out;
}

/** A member who also holds a share token is both at once: the union of what each gives. */
function memberWithToken(model: Model): Named | null {
	const live = model.grants.find((g) => g.kind === 'public' && !g.revoked);
	const m1 = model.users.get('m1');
	if (!live?.token || !m1) return null;
	return { name: `${m1.role} m1 with a token`, asker: { kind: 'user', id: 'm1' }, actor: { userId: 'm1', role: m1.role, shareToken: live.token } };
}

/** The model for `member + token` (levelOf takes one asker): the better of the two. */
const bestOf = (model: Model, a: Named, pageId: string) => {
	const own = levelOf(model, a.asker, pageId);
	if (!a.actor.shareToken || a.asker.kind !== 'user') return own;
	return Math.max(own, levelOf(model, { kind: 'anonymous', token: a.actor.shareToken }, pageId));
};

async function compare(stub: Stub, model: Model, who: Named[], options: { all: boolean; random: Random }): Promise<void> {
	const ids = [...model.pages.keys()];
	const nums = (set: Iterable<number>) => [...set].sort((a, b) => a - b);
	for (const a of who) {
		const expected = new Map(ids.map((id) => [id, bestOf(model, a, id)]));
		const visible = new Set<number>();
		for (const [id, rank] of expected) if (rank >= 0) visible.add(model.pages.get(id)!.num);
		expect(nums(await stub.visibleNums(a.actor)), `visible set of ${a.name}`).toEqual(nums(visible));

		// `can` for every page at every level: 4 statements per 60 pages.
		for (const level of LEVELS) {
			const got = await stub.can(a.actor, options.all ? ids : ids.slice(0, 40), level);
			for (const [id, ok] of Object.entries(got)) {
				expect(ok, `${a.name} can ${level} ${id}`).toBe(expected.get(id)! >= LEVELS.indexOf(level));
			}
		}
		// `pageAccess` on a sample (it is one statement per page).
		const sample = options.all ? ids.filter(() => chance(options.random, 0.35)) : ids.filter(() => chance(options.random, 0.15));
		for (const id of sample) {
			expect(await stub.pageAccess(a.actor, id), `${a.name} pageAccess ${id}`).toBe(levelName(expected.get(id)!));
		}
	}
}

async function fresh(label: string): Promise<{ stub: Stub; id: string }> {
	const id = `${label}-${crypto.randomUUID().slice(0, 8)}`;
	const stub = workspaceStub(id);
	await stub.ping();
	return { stub, id };
}

const SEEDS = Array.from({ length: 30 }, (_, i) => 1000 + i * 7);
const INCREMENTAL_SEEDS = [11, 29, 47, 83, 131, 211, 307, 401, 509, 613, 719, 823];

describe('static matrix', () => {
	test('a share on a big subtree falls back to a full rebuild and still equals the model', { timeout: 120_000 }, async () => {
		// More pages under one root than a dirty subtree may hold (MAX_SUBTREE): the lazy recompute rebuilds in full.
		const model = generate(77, { pages: 40, teamspaces: 3, grants: 0 });
		for (let n = 41; n <= 760; n++) {
			model.pages.set(`p${n}`, { id: `p${n}`, num: n, parent: n === 41 ? null : `p${41 + Math.floor((n - 42) / 3)}`, teamspace: n === 41 ? null : model.pages.get(`p${41 + Math.floor((n - 42) / 3)}`)?.teamspace ?? null, createdBy: 'm1', deleted: false, trashRoot: null });
		}
		model.pages.get('p41')!.createdBy = 'm1';
		const { stub, id } = await fresh('big');
		await inside(stub, (sql) => load(sql, model));
		const guest = { name: 'guest g1', asker: { kind: 'user', id: 'g1' } as Asker, actor: { userId: 'g1', role: 'guest' as const } };
		const member = { name: 'member m3', asker: { kind: 'user', id: 'm3' } as Asker, actor: { userId: 'm3', role: 'member' as const } };
		expect((await stub.visibleNums(guest.actor)).size).toBe(0);
		await stub.visibleNums(member.actor);
		// The grant reaches ~720 pages at once for the guest: 720 > MAX_SUBTREE, so the entry is rebuilt, not patched.
		await stub.setGrant(actorOf(id, 'own', 'owner'), { pageId: 'p41', subjectKind: 'user', subjectId: 'g1', level: 'comment' });
		model.grants.push({ id: 'big', page: 'p41', kind: 'user', subject: 'g1', level: 'comment', token: null, revoked: false });
		const got = [...(await stub.visibleNums(guest.actor))].sort((a, b) => a - b);
		expect(got).toEqual([...visibleSet(model, guest.asker)].sort((a, b) => a - b));
		expect(got.length).toBeGreaterThan(700);
		await stub.can(guest.actor, ['p41', 'p42', 'p760'], 'comment').then((r) => expect(r).toEqual({ p41: true, p42: true, p760: true }));
		expect((await stub.can(guest.actor, ['p41'], 'update')).p41).toBe(false);
	});

	test.each(SEEDS)('seed %i: can, pageAccess and visibleNums equal the reference model', { timeout: 120_000 }, async (seed) => {
		const model = generate(seed);
		const { stub } = await fresh('matrix');
		await inside(stub, (sql) => load(sql, model));
		const who = [...askers(model), ...[memberWithToken(model)].filter((x): x is Named => !!x)];
		await compare(stub, model, who, { all: true, random: prng(seed) });
	});

	test('the matrix is not vacuous: every role sees something different, and every level occurs', async () => {
		let sawLevel = new Set<number>();
		const sizes = new Map<string, Set<number>>();
		for (const seed of SEEDS) {
			const model = generate(seed);
			for (const a of askers(model)) {
				const size = visibleSet(model, a.asker).size;
				const key = a.name.split(/[ ,]/)[0]!;
				sizes.set(key, (sizes.get(key) ?? new Set()).add(size));
				for (const p of model.pages.keys()) sawLevel.add(levelOf(model, a.asker, p));
			}
		}
		expect([...sawLevel].sort()).toEqual([-1, 0, 1, 2, 3]);
		// Admins see all live pages; members and guests see strictly less on some seeds; anonymous visitors see only links.
		for (const role of ['owner', 'admin', 'member', 'guest', 'anonymous']) expect(sizes.get(role)?.size, role).toBeGreaterThan(0);
		expect(Math.max(...(sizes.get('member') ?? [0]))).toBeGreaterThan(Math.max(...(sizes.get('guest') ?? [0])));
		expect(Math.max(...(sizes.get('admin') ?? [0]))).toBeGreaterThan(Math.max(...(sizes.get('member') ?? [0])));
	});
});

// ───────────────────────── incremental invalidation ─────────────────────────

/** One random step applied to the model and to the object; returns a description for failure messages. */
async function step(stub: Stub, wsId: string, model: Model, random: Random, n: number): Promise<string> {
	const owner = actorOf(wsId, 'own', 'owner');
	const ids = [...model.pages.keys()];
	const live = ids.filter((id) => !model.pages.get(id)!.deleted);
	const nonGuests = [...model.users.values()].filter((u) => u.role !== 'guest');
	const op = pick(random, ['grant', 'grant', 'revoke', 'move', 'move', 'create', 'create', 'create', 'teamspace', 'member+', 'member-', 'role', 'trash', 'restore', 'remove'] as const);
	switch (op) {
		case 'grant': {
			const page = pick(random, live);
			// A page is shared with a teamspace its sharer can see: private ones are invisible to non-members.
			const visibleTeamspaces = [...model.teamspaces.values()].filter((t) => t.privacy !== 'private' || t.members.has('own')).map((t) => t.id);
			const kind0 = pick(random, ['user', 'teamspace', 'workspace', 'public'] as const);
			const kind = kind0 === 'teamspace' && visibleTeamspaces.length === 0 ? 'workspace' : kind0;
			const level = pick(random, LEVELS);
			const subject = kind === 'user' ? pick(random, [...model.users.keys()]) : kind === 'teamspace' ? pick(random, visibleTeamspaces) : null;
			const grant = await stub.setGrant(owner, { pageId: page, subjectKind: kind, subjectId: subject, level });
			const same = model.grants.find((g) => !g.revoked && g.page === page && g.kind === kind && g.subject === subject);
			if (same) same.level = level;
			else model.grants.push({ id: grant.id, page, kind, subject, level, token: kind === 'public' ? grant.token : null, revoked: false } as never);
			return `grant ${kind}:${subject} ${level} on ${page}`;
		}
		case 'revoke': {
			const grants = model.grants.filter((g) => !g.revoked && !model.pages.get(g.page)!.deleted);
			if (grants.length === 0) return 'revoke (none)';
			const g = pick(random, grants);
			await stub.revokeGrant(owner, g.id);
			g.revoked = true;
			return `revoke ${g.kind}:${g.subject} on ${g.page}`;
		}
		case 'move': {
			const page = pick(random, live);
			const below = new Set(subtreeOf(model, page));
			const targets = live.filter((id) => !below.has(id));
			const parent = chance(random, 0.3) || targets.length === 0 ? null : pick(random, targets);
			const teamspace = pick(random, [null, ...model.teamspaces.keys()]);
			const op = { op: 'move' as const, page, parentId: parent, rank: ranks(80)[n % 80]!, ...(parent === null ? { teamspaceId: teamspace } : {}) };
			await stub.apply(owner, batch([op]));
			const p = model.pages.get(page)!;
			p.parent = parent;
			const dest = parent ? model.pages.get(parent)!.teamspace : teamspace;
			for (const sub of subtreeOf(model, page)) model.pages.get(sub)!.teamspace = dest;
			return `move ${page} under ${parent ?? 'root'} into ${dest ?? 'private'}`;
		}
		case 'create': {
			// Who may add a page where: asked of the object, answered by the plan's rule written out in the model.
			const user = pick(random, [...model.users.values()]);
			const asker: Asker = { kind: 'user', id: user.id };
			const parent = chance(random, 0.55) ? pick(random, ids) : null; // live or trashed or none
			const teamspace = parent === null ? pick(random, [null, ...model.teamspaces.keys()]) : undefined;
			const guest = user.role === 'guest';
			const admin = user.role === 'owner' || user.role === 'admin';
			const memberAt = (ts: string) => {
				const t = model.teamspaces.get(ts);
				const m = guest ? undefined : t?.members.get(user.id);
				return !t || !m ? -1 : m === 'owner' ? 3 : LEVELS.indexOf(t.level);
			};
			let expected: 'ok' | 'FORBIDDEN' | 'VALIDATION_FAILED';
			if (parent !== null) {
				const level = levelOf(model, asker, parent);
				expected = level < 0 ? 'VALIDATION_FAILED' : level >= 2 ? 'ok' : 'FORBIDDEN';
			} else {
				expected = admin || (teamspace ? memberAt(teamspace) >= 2 : !guest) ? 'ok' : 'FORBIDDEN';
			}
			const id = `n${n}`;
			const actor = actorOf(wsId, user.id, user.role);
			let outcome: string = 'ok';
			let made: { num: number } | undefined;
			try {
				made = await stub.createPage(actor, { id, parentId: parent, ...(teamspace !== undefined ? { teamspaceId: teamspace } : {}), appVersion: '0.0.1' });
			} catch (error) {
				outcome = decodeWorkspaceError(error)?.code ?? String(error);
			}
			expect(outcome, `${user.role} ${user.id} creates ${id} under ${parent ?? `root of ${teamspace ?? 'private'}`}`).toBe(expected);
			if (made) {
				const under = parent ? model.pages.get(parent)!.teamspace : (teamspace ?? null);
				model.pages.set(id, { id, num: made.num, parent, teamspace: under, createdBy: user.id, deleted: false, trashRoot: null });
			}
			return `create ${id} by ${user.id}: ${outcome}`;
		}
		case 'teamspace': {
			const creator = pick(random, nonGuests);
			const privacy = pick(random, ['open', 'closed', 'private'] as const);
			const level = pick(random, LEVELS);
			const ts = await stub.createTeamspace(actorOf(wsId, creator.id, creator.role), { name: `T${n}`, privacy, defaultLevel: level });
			model.teamspaces.set(ts.id, { id: ts.id, privacy, level, members: new Map([[creator.id, 'owner']]) });
			return `teamspace ${ts.id} by ${creator.id}`;
		}
		case 'member+': {
			const ts = pick(random, [...model.teamspaces.values()]);
			const who = pick(random, nonGuests);
			// Only a teamspace owner manages members: act as one (a teamspace whose owners all left is left alone).
			const actingOwner = [...ts.members].find(([, role]) => role === 'owner')?.[0];
			if (!actingOwner || ts.members.has(who.id)) return 'add to teamspace (skipped)';
			const actor = actorOf(wsId, actingOwner, model.users.get(actingOwner)!.role);
			const role = chance(random, 0.3) ? 'owner' : 'member';
			await stub.addTeamspaceMember(actor, { teamspaceId: ts.id, userId: who.id, role });
			ts.members.set(who.id, role);
			return `add ${who.id} to ${ts.id} as ${role}`;
		}
		case 'member-': {
			const ts = pick(random, [...model.teamspaces.values()]);
			const removable = [...ts.members].filter(([id, role]) => role !== 'owner' || [...ts.members.values()].filter((r) => r === 'owner').length > 1).map(([id]) => id);
			if (removable.length === 0) return 'remove from teamspace (none)';
			const who = pick(random, removable);
			const actingOwner = [...ts.members].find(([, role]) => role === 'owner')?.[0];
			if (!actingOwner) return 'remove from teamspace (skipped)';
			await stub.removeTeamspaceMember(actorOf(wsId, actingOwner, model.users.get(actingOwner)!.role), { teamspaceId: ts.id, userId: who });
			ts.members.delete(who);
			return `remove ${who} from ${ts.id}`;
		}
		case 'role': {
			const user = pick(random, [...model.users.values()].filter((u) => u.id !== 'own'));
			const role = pick(random, ['member', 'guest', 'admin'] as const);
			await stub.syncMember({ userId: user.id, role, name: user.id });
			// A guest holds no teamspace: the object drops the memberships of a member demoted to guest.
			if (role === 'guest' && user.role !== 'guest') for (const ts of model.teamspaces.values()) ts.members.delete(user.id);
			user.role = role;
			return `role ${user.id} -> ${role}`;
		}
		case 'remove': {
			const user = pick(random, [...model.users.values()].filter((u) => u.role === 'guest' || u.role === 'member'));
			await stub.syncMember({ userId: user.id, role: null });
			for (const ts of model.teamspaces.values()) {
				// the object drops the memberships of a removed user, unless they are a teamspace's only owner
				ts.members.delete(user.id);
			}
			model.users.delete(user.id);
			// A removed member holds nothing, whatever role a stale caller claims: asked by id alone, the mirror says no.
			expect(await stub.visibleNums({ userId: user.id })).toEqual(new Set());
			expect(await stub.pageAccess({ userId: user.id }, live[0]!)).toBeNull();
			return `remove member ${user.id}`;
		}
		case 'trash': {
			const page = pick(random, live);
			await stub.apply(owner, batch([{ op: 'trash', page }]));
			for (const sub of subtreeOf(model, page)) {
				const p = model.pages.get(sub)!;
				if (p.deleted) continue;
				p.deleted = true;
				p.trashRoot = page;
			}
			return `trash ${page}`;
		}
		case 'restore': {
			const roots = ids.filter((id) => model.pages.get(id)!.trashRoot === id && model.pages.get(id)!.deleted);
			if (roots.length === 0) return 'restore (none)';
			const page = pick(random, roots);
			await stub.apply(owner, batch([{ op: 'restore', page }]));
			const p = model.pages.get(page)!;
			if (p.parent && model.pages.get(p.parent)!.deleted) p.parent = null;
			for (const other of model.pages.values()) {
				if (other.trashRoot === page) {
					other.deleted = false;
					other.trashRoot = null;
				}
			}
			return `restore ${page}`;
		}
	}
}

describe('incremental matrix', () => {
	test.each(INCREMENTAL_SEEDS)('seed %i: sets recomputed lazily after every change still equal the model', { timeout: 180_000 }, async (seed) => {
		const model = generate(seed, { pages: 28 + (seed % 5) * 6, teamspaces: 3 + (seed % 3), grants: 8 + (seed % 7) * 2 });
		const { stub, id } = await fresh('incremental');
		await inside(stub, (sql) => load(sql, model));
		const random = prng(seed ^ 0x9e3779b9);
		// Warm every cache: facts and visibility sets of every actor.
		const watched = () => [...askers(model), ...[memberWithToken(model)].filter((x): x is Named => !!x)];
		for (const a of watched()) await stub.visibleNums(a.actor);
		for (let n = 0; n < 30; n++) {
			const what = await step(stub, id, model, random, n);
			const cast = watched();
			for (const a of cast) {
				const expected = visibleSet(model, a.asker);
				if (a.actor.shareToken && a.asker.kind === 'user') for (const x of visibleSet(model, { kind: 'anonymous', token: a.actor.shareToken })) expected.add(x);
				expect([...(await stub.visibleNums(a.actor))].sort((x, y) => x - y), `step ${n} (${what}): visible set of ${a.name}`).toEqual([...expected].sort((x, y) => x - y));
			}
			// A full comparison of the access answers on a rotating subset of actors.
			const subset = cast.filter((_, i) => (i + n) % 4 === 0);
			await compare(stub, model, subset, { all: false, random });
		}
		// The caches were reused, not rebuilt from scratch every time: facts and sets are still there.
		expect(await stub.visibilityCached({ userId: 'own', role: 'owner' })).toBe(true);
	});
});
