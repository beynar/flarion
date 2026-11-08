/**
 * The policy's `create` rule for a page states where the page lives, not only who may edit the parent: a page
 * created under a parent belongs to the parent's teamspace (or to no teamspace when the parent has none).
 *
 * Before 2026-11-08 the rule said `{ parent: 'update' }` and nothing about `teamspaceId`, so a governed create under
 * a parent the actor could edit was accepted with `teamspaceId: null` (a guest) or another teamspace the actor reads
 * (a member). Our raw INSERT (`createPage`) always copied the parent's teamspace, so the hole was in the policy's
 * statement of the rule, not in the commit path; the viborm maintainers' review found it. This test drives the
 * governed `create` itself.
 */
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { createMigrationClient } from 'viborm/migrations';
import { createDurableObjectSqliteClient } from '../../../src/server/db/driver/client';
import { actorFacts, policy } from '../../../src/server/db/policy';
import { WORKSPACE_TABLES, workspaceSchema } from '../../../src/server/db/workspace.schema';
import { testEnv } from '../helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const TEAMSPACES = [
	{ id: 'ts0', defaultLevel: 'update' },
	{ id: 'ts1', defaultLevel: 'update' }
];

async function world<T>(fn: (ctx: { base: Any; as(input: Parameters<typeof actorFacts>[0]): Any }) => Promise<T>): Promise<T> {
	const stub = testEnv.TEST_SQL.getByName('policy-create-' + crypto.randomUUID());
	return runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) => {
		const base: Any = createDurableObjectSqliteClient(state.storage, workspaceSchema);
		const migrations = createMigrationClient(base, { tables: [...WORKSPACE_TABLES] });
		await migrations.push({ consent: (await migrations.push({ dryRun: true })).consent });
		for (const ts of TEAMSPACES) await base.teamspace.create({ data: { id: ts.id, name: ts.id, privacy: 'open', defaultLevel: ts.defaultLevel, createdBy: 'owner' } });
		let num = 1;
		const page = (id: string, parentId: string | null, teamspaceId: string | null) =>
			base.page.create({ data: { id, num: num++, parentId, teamspaceId, rank: 'a', createdById: 'owner' } });
		await page('A', null, 'ts0'); // a page of ts0
		await page('B', null, 'ts1'); // a page of ts1
		await page('Q', null, null); // somebody's Private page
		await page('QQ', 'Q', null);
		// The guest edits A (in ts0) and Q (Private, no teamspace); the member edits everything through the teamspaces.
		const grant = (id: string, pageId: string) =>
			base.grant.create({ data: { id, pageId, subjectKind: 'user', subjectId: 'guest', subjectKey: 'user:guest', level: 'update', createdBy: 'owner' } });
		await grant('g-a', 'A');
		await grant('g-q', 'Q');
		const governed = (policy as Any)(base);
		return fn({ base, as: (input) => governed.$as(actorFacts(input)) });
	});
}

const guest = { userId: 'guest', role: 'guest', memberships: [], teamspaces: [] } as const;
const member = {
	userId: 'member',
	role: 'member',
	memberships: TEAMSPACES.map((t) => ({ teamspaceId: t.id, role: 'member' })),
	teamspaces: TEAMSPACES
} as const;

let n = 100;
const create = (db: Any, parentId: string, teamspaceId: string | null | undefined, by: string) =>
	db.page.create({ data: { id: `n${n}`, num: n++, parentId, ...(teamspaceId === undefined ? {} : { teamspaceId }), rank: 'a', createdById: by } });

const refused = async (run: Promise<unknown>) => {
	const error = await run.then(() => null, (e: Error) => e);
	expect(error, 'the create must be refused').not.toBeNull();
	expect(error!.constructor.name).toBe('ForbiddenError');
};

test('a member cannot create a page under a parent with another teamspace, or none', async () => {
	await world(async ({ as, base }) => {
		const db = as(member);
		// the correct teamspace is accepted
		const ok = await create(db, 'A', 'ts0', 'member');
		expect(ok.teamspaceId).toBe('ts0');
		// ...a teamspace the member reads and edits in, but is not the parent's, is refused
		await refused(create(db, 'A', 'ts1', 'member'));
		// ...so is no teamspace at all, set or left out
		await refused(create(db, 'A', null, 'member'));
		await refused(create(db, 'A', undefined, 'member'));
		expect(await base.page.count({ where: { parentId: 'A' } })).toBe(1);
	});
});

test('a guest cannot create a page under a shared page with no teamspace, or the wrong one', async () => {
	await world(async ({ as, base }) => {
		const db = as(guest);
		// A is in ts0: a page without a teamspace under it was accepted before the rule stated the equality
		await refused(create(db, 'A', null, 'guest'));
		await refused(create(db, 'A', undefined, 'guest'));
		// the wrong or a missing teamspace
		await refused(create(db, 'A', 'ts1', 'guest'));
		await refused(create(db, 'A', 'zz', 'guest'));
		// the right one: a guest cannot read teamspaces, so the governed create is still refused (viborm's R4,
		// `createPage` is raw for this reason; widening `teamspace.read` is a separate decision)
		await refused(create(db, 'A', 'ts0', 'guest'));
		expect(await base.page.count({ where: { parentId: 'A' } })).toBe(0);
		// Q is Private (no teamspace): a subpage is Private too, and nothing else is accepted
		const ok = await create(db, 'Q', null, 'guest');
		expect(ok.teamspaceId).toBeNull();
		await refused(create(db, 'Q', 'ts0', 'guest'));
		await refused(create(db, 'Q', 'ts1', 'guest'));
		expect(await base.page.count({ where: { parentId: 'Q' } })).toBe(2); // QQ and the one above
	});
});

test('creates at the root keep their own rules', async () => {
	await world(async ({ as }) => {
		const root = (db: Any, teamspaceId: string | null, by: string) =>
			db.page.create({ data: { id: `r${n}`, num: n++, parentId: null, teamspaceId, rank: 'a', createdById: by } });
		// a member adds a root to a teamspace where they edit, and to their own Private section
		expect((await root(as(member), 'ts1', 'member')).teamspaceId).toBe('ts1');
		expect((await root(as(member), null, 'member')).teamspaceId).toBeNull();
		// a guest adds no root anywhere
		await refused(root(as(guest), null, 'guest'));
		await refused(root(as(guest), 'ts0', 'guest'));
	});
});
