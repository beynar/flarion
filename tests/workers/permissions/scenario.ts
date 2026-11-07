/**
 * Random workspaces for the permission matrix: users of every role, teamspaces of every privacy and
 * default level, a random tree, and grants of every kind. `generate` builds the reference `Model`;
 * `load` writes the same state into a Workspace DO with raw SQL (so `created_by` can be anyone).
 */
import { rankAfter } from '../../../src/lib/shared/sort-keys';
import { grantSubjectKey } from '../../../src/server/db/policy';
import { LEVELS, type Level, type MGrant, type Model, type Role } from './model';

export function prng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
export type Random = ReturnType<typeof prng>;
export const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
export const chance = (random: Random, p: number) => random() < p;

export const USERS: { id: string; role: Role }[] = [
	{ id: 'own', role: 'owner' },
	{ id: 'adm', role: 'admin' },
	{ id: 'm1', role: 'member' },
	{ id: 'm2', role: 'member' },
	{ id: 'm3', role: 'member' },
	{ id: 'm4', role: 'member' },
	{ id: 'g1', role: 'guest' },
	{ id: 'g2', role: 'guest' }
];
const NON_GUESTS = USERS.filter((u) => u.role !== 'guest').map((u) => u.id);

export interface Options {
	pages?: number;
	teamspaces?: number;
	grants?: number;
}

/** A random `Model`. Pages are listed parents-first, so `num` order is creation order. */
export function generate(seed: number, options: Options = {}): Model {
	const random = prng(seed);
	const model: Model = { users: new Map(USERS.map((u) => [u.id, { ...u }])), teamspaces: new Map(), pages: new Map(), grants: [] };

	const privacies = ['open', 'closed', 'private'] as const;
	for (let i = 0; i < (options.teamspaces ?? 4); i++) {
		const members = new Map<string, 'owner' | 'member'>();
		for (const id of NON_GUESTS) if (chance(random, 0.45)) members.set(id, chance(random, 0.25) ? 'owner' : 'member');
		if (![...members.values()].includes('owner')) members.set(pick(random, NON_GUESTS), 'owner');
		model.teamspaces.set(`ts${i}`, { id: `ts${i}`, privacy: privacies[i % 3]!, level: pick(random, LEVELS), members });
	}
	const teamspaceIds = [...model.teamspaces.keys()];

	const count = options.pages ?? 48;
	const ids: string[] = [];
	for (let n = 1; n <= count; n++) {
		const id = `p${n}`;
		const parent = n > 3 && chance(random, 0.75) ? pick(random, ids) : null;
		const parentPage = parent ? model.pages.get(parent)! : null;
		const teamspace = parentPage ? parentPage.teamspace : chance(random, 0.7) ? pick(random, teamspaceIds) : null;
		// Pages under a Private root are made by anyone: the creator of the root still owns the whole branch.
		const createdBy = parentPage && parentPage.teamspace === null && chance(random, 0.7) ? parentPage.createdBy : pick(random, NON_GUESTS);
		model.pages.set(id, { id, num: n, parent, teamspace, createdBy, deleted: false, trashRoot: null });
		ids.push(id);
	}
	// A few trashed subtrees.
	for (let i = 0; i < 2; i++) {
		const root = pick(random, ids);
		for (const sub of subtreeIds(model, root)) {
			const page = model.pages.get(sub)!;
			if (page.deleted) continue;
			page.deleted = true;
			page.trashRoot = root;
		}
	}

	const total = options.grants ?? 18;
	const kinds = ['user', 'teamspace', 'workspace', 'public'] as const;
	for (let g = 0; g < total; g++) {
		const kind = pick(random, kinds);
		const base = { id: `g${g}`, page: pick(random, ids), level: pick(random, LEVELS), revoked: chance(random, 0.15) };
		const grant: MGrant =
			kind === 'user'
				? { ...base, kind, subject: pick(random, USERS.map((u) => u.id)), token: null }
				: kind === 'teamspace'
					? { ...base, kind, subject: pick(random, teamspaceIds), token: null }
					: kind === 'workspace'
						? { ...base, kind, subject: null, token: null }
						: { ...base, kind, subject: null, token: `tok-${seed}-${g}` };
		model.grants.push(grant);
	}
	return model;
}

function subtreeIds(model: Model, root: string): string[] {
	const out = [root];
	for (let i = 0; i < out.length; i++) for (const p of model.pages.values()) if (p.parent === out[i]) out.push(p.id);
	return out;
}

/** Writes the model into a fresh Workspace DO's tables. */
export function load(sql: SqlStorage, model: Model): void {
	// Valid, increasing rank keys (`createPage` ranks a new page after its last sibling).
	const keys: string[] = [];
	for (let i = 0, last: string | null = null; i <= model.pages.size; i++) keys.push((last = rankAfter(last)));
	const rankOf = (n: number) => keys[n]!;
	for (const u of model.users.values()) sql.exec('INSERT INTO member (user_id, role, name) VALUES (?, ?, ?)', u.id, u.role, u.id);
	for (const ts of model.teamspaces.values()) {
		sql.exec('INSERT INTO teamspace (id, name, privacy, default_level, created_by) VALUES (?, ?, ?, ?, ?)', ts.id, ts.id, ts.privacy, ts.level, 'own');
		for (const [user, role] of ts.members) sql.exec('INSERT INTO teamspace_member (teamspace_id, user_id, role, rank) VALUES (?, ?, ?, ?)', ts.id, user, role, '');
	}
	const stamp = new Date().toISOString();
	for (const p of model.pages.values()) {
		sql.exec(
			'INSERT INTO page (id, num, parent_id, rank, teamspace_id, created_by, deleted_at, trash_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			p.id,
			p.num,
			p.parent,
			rankOf(p.num),
			p.teamspace,
			p.createdBy,
			p.deleted ? stamp : null,
			p.trashRoot
		);
	}
	for (const g of model.grants) {
		sql.exec(
			'INSERT INTO "grant" (id, page_id, subject_kind, subject_id, teamspace_id, subject_key, level, token, created_by, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			g.id,
			g.page,
			g.kind,
			g.subject,
			g.kind === 'teamspace' ? g.subject : null,
			grantSubjectKey(g.kind, g.subject, g.token),
			g.level,
			g.token,
			'own',
			g.revoked ? stamp : null
		);
	}
	sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('nextPageNum', ?)", String(model.pages.size + 1));
}

export type { Level };
