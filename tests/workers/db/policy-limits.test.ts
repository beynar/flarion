import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { createClient } from 'viborm';
import { createMigrationClient } from 'viborm/migrations';
import { SQLiteAdapter, type DatabaseAdapter } from 'viborm/adapters';
import type { QueryExecutionContext, QueryResult } from 'viborm/driver';
import { DurableObjectSqliteDriver } from '../../../src/server/db/do-sqlite-driver';
import { actorFacts, grantSubjectKey, joinedPolicy, policy, sketchPolicy, type ActorInput } from '../../../src/server/db/policy';
import { WORKSPACE_TABLES, workspaceSchema } from '../../../src/server/db/workspace.schema';
import { testEnv } from '../helpers';

interface Statement { sql: string; params: number; bytes: number; ms: number; rows: number; error?: string }

class MeasuringDriver extends DurableObjectSqliteDriver {
	statements: Statement[] = [];
	protected override async execute<T>(
		client: DurableObjectStorage,
		sql: string,
		params: unknown[],
		context?: QueryExecutionContext
	): Promise<QueryResult<T>> {
		const start = performance.now();
		try {
			const result = await super.execute<T>(client, sql, params, context);
			this.statements.push({ sql, params: params.length, bytes: new TextEncoder().encode(sql).length, ms: performance.now() - start, rows: result.rows.length });
			return result;
		} catch (error) {
			this.statements.push({ sql, params: params.length, bytes: new TextEncoder().encode(sql).length, ms: performance.now() - start, rows: -1, error: String((error as Error).message) });
			throw error;
		}
	}
}


// ----- seeded workspace -----

const PAGE_COUNT = 4000;
const USERS = Array.from({ length: 10 }, (_, i) => `u${i}`);
const TEAMSPACES = [
	{ id: 'ts0', privacy: 'open', level: 'update' },
	{ id: 'ts1', privacy: 'closed', level: 'comment' },
	{ id: 'ts2', privacy: 'private', level: 'read' },
	{ id: 'ts3', privacy: 'open', level: 'read' },
	{ id: 'ts4', privacy: 'closed', level: 'full' }
];

function prng(seed: number) {
	let x = seed;
	return () => {
		x = (x * 1664525 + 1013904223) % 4294967296;
		return x / 4294967296;
	};
}

/** Roots in teamspaces and private sections, a branching tree, then deep chains. Returns max depth. */
function seed(storage: DurableObjectStorage): { depth: number; ids: string[]; deep: string } {
	const random = prng(42);
	const sql = storage.sql;
	const pages: { id: string; parent: string | null; ts: string | null; creator: string; depth: number }[] = [];
	const add = (parent: (typeof pages)[number] | null, ts: string | null, creator: string) => {
		const page = { id: `p${pages.length}`, parent: parent?.id ?? null, ts, creator, depth: (parent?.depth ?? -1) + 1 };
		pages.push(page);
		return page;
	};
	for (const ts of TEAMSPACES) for (let i = 0; i < 40; i++) add(null, ts.id, USERS[i % USERS.length]!);
	for (let i = 0; i < 100; i++) add(null, null, USERS[i % USERS.length]!);
	for (let i = 0; pages.length < PAGE_COUNT - 800 && i < pages.length; i++) {
		const parent = pages[i]!;
		const children = Math.floor(random() * 4);
		for (let c = 0; c < children && pages.length < PAGE_COUNT - 800; c++) add(parent, parent.ts, parent.creator);
	}
	// deep chains: 16 chains of 50 pages under random roots
	let deep = pages[0]!;
	for (let chain = 0; chain < 16; chain++) {
		let parent = pages[Math.floor(random() * 300)]!;
		for (let d = 0; d < 50; d++) parent = add(parent, parent.ts, parent.creator);
		deep = parent;
	}
	storage.transactionSync(() => {
		for (const ts of TEAMSPACES)
			sql.exec('INSERT INTO teamspace (id, name, privacy, default_level, created_by) VALUES (?,?,?,?,?)', ts.id, ts.id, ts.privacy, ts.level, 'u0');
		TEAMSPACES.forEach((ts, t) => {
			for (let k = 0; k < 4; k++)
				sql.exec('INSERT INTO teamspace_member (teamspace_id, user_id, role) VALUES (?,?,?)', ts.id, USERS[(t + k) % USERS.length]!, k === 0 ? 'owner' : 'member');
		});
		pages.forEach((p, num) =>
			sql.exec('INSERT INTO page (id, num, parent_id, rank, teamspace_id, created_by) VALUES (?,?,?,?,?,?)', p.id, num + 1, p.parent, String(num).padStart(6, '0'), p.ts, p.creator)
		);
		for (let g = 0; g < 300; g++) {
			const kind = (['user', 'workspace', 'teamspace', 'public'] as const)[g % 4]!;
			const page = pages[Math.floor(random() * pages.length)]!;
			const level = (['read', 'comment', 'update', 'full'] as const)[Math.floor(random() * 4)]!;
			const team = kind === 'teamspace' ? TEAMSPACES[g % TEAMSPACES.length]!.id : null;
			const subjectId = kind === 'user' ? USERS[g % USERS.length]! : team;
			const token = kind === 'public' ? `tok-${g}` : null;
			sql.exec(
				'INSERT INTO "grant" (id, page_id, subject_kind, subject_id, teamspace_id, subject_key, level, token, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
				`g${g}`, page.id, kind, subjectId, team, grantSubjectKey(kind, subjectId, token), level, token, 'u0'
			);
		}
	});
	return { depth: Math.max(...pages.map((p) => p.depth)), ids: pages.map((p) => p.id), deep: deep.id };
}

interface Measure { sql?: string; error?: string; name: string; statements: number; maxParams: number; maxBytes: number; ms: number; rows: number }

type Base = ReturnType<typeof makeBase>;
const makeBase = (driver: MeasuringDriver) => createClient({ schema: workspaceSchema, driver });

const actorInputs = {
	member: { userId: 'u1', role: 'member' },
	admin: { userId: 'u0', role: 'admin' },
	guest: { userId: 'u9', role: 'guest' },
	anonymous: { role: 'anonymous', shareToken: 'tok-3' },
	'member with a share token': { userId: 'u1', role: 'member', shareToken: 'tok-3' },
	'teamspace owner': { userId: 'u0', role: 'member' }
} as const satisfies Record<string, Pick<ActorInput, 'userId' | 'role' | 'shareToken'>>;

/** The actor facts of one request, built the way the Workspace DO will: from `teamspace_member` rows. */
function actorFor(storage: DurableObjectStorage, input: Pick<ActorInput, 'userId' | 'role' | 'shareToken'>) {
	const memberships = input.userId
		? storage.sql
				.exec<{ teamspaceId: string; role: string }>('SELECT teamspace_id AS teamspaceId, role FROM teamspace_member WHERE user_id = ?', input.userId)
				.toArray()
		: [];
	const teamspaces = storage.sql
		.exec<{ id: string; defaultLevel: string }>('SELECT id, default_level AS defaultLevel FROM teamspace')
		.toArray();
	return actorFacts({ ...input, memberships, teamspaces });
}

async function workspace<T>(fn: (ctx: { driver: MeasuringDriver; base: Base; state: DurableObjectState; seeded: ReturnType<typeof seed>; measure: <R>(name: string, run: () => Promise<R>, rows?: (r: R) => number) => Promise<R> ; results: Measure[] }) => Promise<T>) {
	const stub = testEnv.TEST_SQL.getByName('spike-' + crypto.randomUUID());
	return runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
		const driver = new MeasuringDriver(state.storage);
		const base = makeBase(driver);
		const migrations = createMigrationClient(base, { tables: [...WORKSPACE_TABLES] });
		await migrations.push({ consent: (await migrations.push({ dryRun: true })).consent });
		const seeded = seed(state.storage);
		const results: Measure[] = [];
		const measure = async <R>(name: string, run: () => Promise<R>, rows: (r: R) => number = (r) => (Array.isArray(r) ? r.length : 1)) => {
			driver.statements = [];
			const start = performance.now();
			let result: R;
			try { result = await run(); } finally {
				const stmts = driver.statements;
				results.push({ name, statements: stmts.length, maxParams: Math.max(0, ...stmts.map((s) => s.params)), maxBytes: Math.max(0, ...stmts.map((s) => s.bytes)), ms: Math.round((performance.now() - start) * 10) / 10, rows: -1, error: stmts.find((x) => x.error)?.error, sql: stmts.find((x) => x.error)?.sql });
			}
			results[results.length - 1]!.rows = rows(result);
			return result;
		};
		return fn({ driver, base, state, seeded, measure, results });
	});
}


/* The governed client's generics are enormous; the spike only needs its runtime surface. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Governed = any;
type Policy = typeof policy | typeof sketchPolicy;

const LIMITS = { params: 100, bytes: 100_000 };

/** The largest reads and the write checks of the policy, as one workload. */
async function workload(
	{ base, state, seeded, measure }: { base: Base; state: DurableObjectState; seeded: ReturnType<typeof seed>; measure: Parameters<Parameters<typeof workspace>[0]>[0]['measure'] },
	p: Policy
) {
	const db = (p as unknown as (b: never) => Governed)(base as never);
	const as = (name: keyof typeof actorInputs) => db.$as(actorFor(state.storage, actorInputs[name]));
	const result: Record<string, unknown> = {};
	for (const name of Object.keys(actorInputs) as (keyof typeof actorInputs)[]) {
		const rows = (await measure(`page.findMany(num) as ${name}`, () => as(name).page.findMany({ select: { num: true } }))) as unknown[];
		result[name] = rows.length;
	}
	const member = as('member');
	const owner = as('teamspace owner');
	await measure('page.can(read) on a depth-50 page', () => member.page.can('read', { id: seeded.deep }));
	await measure('page.can([read, comment, update, full]) on a depth-50 page', () => member.page.can(['read', 'comment', 'update', 'full'], { id: seeded.deep }));
	await measure('page.can([...]) member with a share token', () => as('member with a share token').page.can(['read', 'comment', 'update', 'full'], { id: seeded.deep }));
	// The statements the Workspace DO's access service sends (objects/workspace/access.ts).
	await measure('visibility entry: page.findMany(num, $access) of every live page', () => member.page.findMany({ where: { deletedAt: null }, select: { num: true, $access: true } }));
	const sixty = Array.from({ length: 60 }, (_, i) => seeded.ids[i * 7]!);
	await measure('can(ids): id in 60 ids with $access', () => member.page.findMany({ where: { id: { in: sixty }, deletedAt: null }, select: { id: true, $access: true } }));
	await measure('dirty subtree: num in 60 nums with $access', () => member.page.findMany({ where: { num: { in: Array.from({ length: 60 }, (_, i) => i * 11 + 1) }, deletedAt: null }, select: { num: true, $access: true } }));
	const withToken = as('member with a share token');
	await measure('pageAccess: member with a share token', () => withToken.page.findFirst({ where: { id: seeded.deep, deletedAt: null }, select: { $access: true } }));
	await measure('visibility entry: member with a share token', () => withToken.page.findMany({ where: { deletedAt: null }, select: { num: true, $access: true } }));
	await measure('pageAccess: findFirst id with $access', () => member.page.findFirst({ where: { id: seeded.deep, deletedAt: null }, select: { $access: true } }));
	await measure('page.findMany $access, 50 rows', () => member.page.findMany({ select: { id: true, $access: true }, take: 50 }));
	await measure('page.findMany tree window, take 200', () => member.page.findMany({ select: { id: true, title: true, icon: true, parentId: true }, orderBy: { rank: 'asc' }, take: 200 }));
	await measure('teamspace.findMany', () => member.teamspace.findMany({}));
	await measure('teamspaceMember.findMany', () => member.teamspaceMember.findMany({}));
	await measure('grant.findMany', () => member.grant.findMany({}));
	await measure('page.create (placement under an editable parent)', () => member.page.create({ data: { id: 'new1', num: 9001, rank: 'z', createdById: 'u1', teamspaceId: 'ts0', parentId: 'p1' } }), () => 1);
	await measure('page.update title', () => member.page.update({ where: { id: 'p1' }, data: { title: 'renamed' } }), () => 1);
	await measure('page.update parentId (move, needs full)', () => owner.page.update({ where: { id: 'p3' }, data: { parentId: 'p2' } }), () => 1);
	await measure('page.delete (needs full)', () => owner.page.delete({ where: { id: 'new1' } }), () => 1);
	return result;
}

async function fitsLimits(p: Policy, peakParams: number) {
	await workspace(async (ctx) => {
		await workload(ctx, p).catch((e) => {
			throw new Error(`${String(e)} | ${JSON.stringify(ctx.driver.statements.filter((x) => x.error).map((x) => [x.error, x.sql.slice(0, 300)]))}`);
		});
		for (const m of ctx.results) {
			expect(m.error, `${m.name}: ${m.error}`).toBeUndefined();
			expect(m.maxParams, `${m.name} bound values`).toBeLessThanOrEqual(LIMITS.params);
			expect(m.maxBytes, `${m.name} SQL bytes`).toBeLessThanOrEqual(LIMITS.bytes);
			expect(m.statements, `${m.name} statements`).toBe(1);
		}
		// Headroom, so a rule added in P2 does not silently reach the cap.
		expect(Math.max(...ctx.results.map((m) => m.maxParams))).toBeLessThanOrEqual(peakParams);
		// The visibility set of the biggest actor over 4,000 pages, in one statement.
		const set = ctx.results.find((m) => m.name === 'page.findMany(num) as member')!;
		expect(set.rows).toBeGreaterThan(100);
		expect(set.ms).toBeLessThan(2000);
	});
}

// P2 final: peak 58 (`$access` reads), 62 with a share token; the pin leaves the headroom to the platform's 100.
// 2026-11-08: the page `create` rule states "same teamspace as the parent", and a move (which sets `parentId`) asks it
// of the new row: the peak is now the move, 66 values (it was 56).
test('policy (actor facts): the largest reads and the write checks fit the platform limits', () => fitsLimits(policy, 66));

// The fallback the Worker does not use: its move takes 99 of 100 values since the create rule states the teamspace
// (it was 84). No headroom left, which is the reason `policy` reads actor facts.
test('joinedPolicy (teamspace rows): fits too, with less headroom', () => fitsLimits(joinedPolicy, 99));

// The plan's sketch used to breach SQLite's expression depth on a move; that was viborm's DEFAULT SQL form, not the
// sketch (viborm maintainers' review, 2026-11-08). The driver now asks for `deepExpressions: false`, and the sketch
// moves a page on workerd. The default form is kept below as the reference that still fails.
test("the plan's sketch moves a page now that the adapter is shallow (deepExpressions: false)", async () => {
	await workspace(async (ctx) => {
		const sketch = sketchPolicy(ctx.base as never) as Governed;
		const owner = sketch.$as(actorFor(ctx.state.storage, actorInputs['teamspace owner']));
		await ctx.measure('sketch move', () => owner.page.update({ where: { id: 'p3' }, data: { parentId: 'p2' } }), () => 1);
		const move = ctx.results.at(-1)!;
		expect(move.error).toBeUndefined();
		expect(move.statements).toBe(1);
		expect(move.maxParams).toBeLessThanOrEqual(LIMITS.params);
		expect(move.maxBytes).toBeLessThanOrEqual(LIMITS.bytes);
		// ...but it still needs 97 of 100 bound values to ask four actions of one row (no headroom).
		const member = sketch.$as(actorFor(ctx.state.storage, actorInputs.member));
		await ctx.measure('sketch can x4', () => member.page.can(['read', 'comment', 'update', 'full'], { id: ctx.seeded.deep }));
		expect(ctx.results.at(-1)!.error).toBeUndefined();
		expect(ctx.results.at(-1)!.maxParams).toBeGreaterThan(90);
	});
});

/** viborm's default SQL form (deep expressions), as the driver was configured before 2026-11-08. */
class DeepDriver extends MeasuringDriver {
	override readonly adapter: DatabaseAdapter = new SQLiteAdapter({ temporaryObjects: false });
}

test("with viborm's default (deep) SQL form the plan's sketch still breaches the expression depth on a move", async () => {
	const stub = testEnv.TEST_SQL.getByName('spike-deep-' + crypto.randomUUID());
	await runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
		const driver = new DeepDriver(state.storage);
		const base = makeBase(driver);
		const migrations = createMigrationClient(base, { tables: [...WORKSPACE_TABLES] });
		await migrations.push({ consent: (await migrations.push({ dryRun: true })).consent });
		seed(state.storage);
		const owner = (sketchPolicy as unknown as (b: never) => Governed)(base as never).$as(actorFor(state.storage, actorInputs['teamspace owner']));
		const failure = await owner.page.update({ where: { id: 'p3' }, data: { parentId: 'p2' } }).catch((e: Error) => e);
		expect(failure).toBeInstanceOf(Error);
		expect(driver.statements.find((s) => s.error)?.error).toMatch(/maximum depth 100/);
	});
});

test('all three policies grant exactly the same pages to every kind of actor', async () => {
	await workspace(async ({ base, state }) => {
		const policies = [sketchPolicy, joinedPolicy, policy].map((p) => (p as unknown as (b: never) => Governed)(base as never));
		for (const input of Object.values(actorInputs)) {
			const actor = actorFor(state.storage, input);
			const sets = await Promise.all(
				policies.map(async (db) => ((await db.$as(actor).page.findMany({ select: { num: true } })) as { num: number }[]).map((r) => r.num).sort((x, y) => x - y))
			);
			expect(sets[1]).toEqual(sets[0]);
			expect(sets[2]).toEqual(sets[0]);
		}
		// the roles differ from each other (the comparison above is not vacuous)
		const count = async (name: keyof typeof actorInputs) =>
			((await (policy(base as never) as Governed).$as(actorFor(state.storage, actorInputs[name])).page.findMany({ select: { num: true } })) as unknown[]).length;
		expect(await count('admin')).toBe(PAGE_COUNT);
		expect(await count('member')).toBeGreaterThan(await count('guest'));
		expect(await count('guest')).toBeGreaterThan(await count('anonymous'));
		expect(await count('member with a share token')).toBeGreaterThanOrEqual(await count('member'));
		expect(await count('anonymous')).toBeGreaterThan(0);
	});
});

test('a share on an ancestor reaches the whole subtree, at the shared level and below', async () => {
	await workspace(async ({ base, state }) => {
		const as = (policy(base as never) as Governed).$as(actorFor(state.storage, { userId: 'ux', role: 'guest' }));
		expect(await as.page.findMany({ select: { num: true } })).toEqual([]);
		const root = state.storage.sql.exec<{ id: string }>('SELECT parent_id AS id FROM page WHERE parent_id IS NOT NULL ORDER BY num DESC LIMIT 1 OFFSET 20').one().id;
		state.storage.sql.exec(
			'INSERT INTO "grant" (id, page_id, subject_kind, subject_id, subject_key, level, created_by) VALUES (?,?,?,?,?,?,?)',
			'gx', root, 'user', 'ux', grantSubjectKey('user', 'ux'), 'comment', 'u0'
		);
		const subtree = state.storage.sql
			.exec<{ num: number }>(
				'WITH RECURSIVE t(id) AS (SELECT id FROM page WHERE id = ? UNION ALL SELECT p.id FROM page p JOIN t ON p.parent_id = t.id) SELECT page.num FROM page JOIN t ON page.id = t.id',
				root
			)
			.toArray()
			.map((r) => r.num)
			.sort((x, y) => x - y);
		const visible = ((await as.page.findMany({ select: { num: true } })) as { num: number }[]).map((r) => r.num).sort((x, y) => x - y);
		expect(visible).toEqual(subtree);
		expect(subtree.length).toBeGreaterThan(1);
		const leaf = ((await base.page.findMany({ where: { num: { in: subtree } }, orderBy: { num: 'desc' }, take: 1 })) as { id: string }[])[0]!;
		expect(await as.page.can(['read', 'comment', 'update', 'full'], { id: leaf.id })).toEqual({ read: true, comment: true, update: false, full: false });
		// a revoked share stops counting
		state.storage.sql.exec('UPDATE "grant" SET deleted_at = ? WHERE id = ?', new Date().toISOString(), 'gx');
		expect(await as.page.findMany({ select: { num: true } })).toEqual([]);
	});
});

test('teamspace default levels and ownership grant access through the policy', async () => {
	await workspace(async ({ base, state }) => {
		const level = async (user: string, id: string) =>
			(policy(base as never) as Governed).$as(actorFor(state.storage, { userId: user, role: 'member' })).page.can(['read', 'comment', 'update', 'full'], { id });
		// p0 is a root of ts0 (default level update; u0 owner, u1..u3 members, u4 outside)
		expect(await level('u1', 'p0')).toMatchObject({ read: true, comment: true, update: true, full: false });
		expect(await level('u0', 'p0')).toMatchObject({ read: true, comment: true, update: true, full: true });
		const outsider = await level('u7', 'p0');
		expect(outsider.update).toBe(false);
		// ts3 is open with default level read (u3 owns it, u4 is a plain member): members read, cannot comment
		const ts3 = state.storage.sql.exec<{ id: string }>("SELECT id FROM page WHERE teamspace_id = 'ts3' AND parent_id IS NULL LIMIT 1").one().id;
		expect(await level('u4', ts3)).toMatchObject({ read: true, comment: false, update: false });
		expect(await level('u3', ts3)).toMatchObject({ full: true });
	});
});
